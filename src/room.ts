import { DurableObject } from 'cloudflare:workers';
import { addTeam, buzz, GameError, hostCommand, initialState, timeout, view, type GameState } from './state';
import type { ClientMessage, ServerMessage } from './protocol';
import type { Env } from './worker';
const ROOM_TTL_MS = 6 * 60 * 60 * 1000;

type Session = { role: 'host'; token: string } | { role: 'team'; teamId: string };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
export class Room extends DurableObject<Env> {
  private game: GameState = initialState();
  private hostToken: string | null = null;
  private createdAt: number | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private scheduledDeadline: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private tokens = new Map<string, string>();
  private pendingReadmission = new Set<string>();
  private sessions = new Map<WebSocket, Session>();
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/init' && this.createdAt !== null && Date.now() - this.createdAt >= ROOM_TTL_MS) {
      this.expire();
      return url.pathname === '/ws' && url.searchParams.get('role') === 'team' && request.headers.get('Upgrade')?.toLowerCase() === 'websocket' ? this.teamJoinError('expired', 'Room expired. Create a new game.') : json({ error: 'Room expired. Create a new game.', code: 'expired' }, 410);
    }
    if (url.pathname === '/init' && request.method === 'POST') {
      if (this.hostToken) return json({ error: 'Room exists' }, 409);
      const body = await request.json() as { hostToken?: unknown };
      if (typeof body.hostToken !== 'string' || body.hostToken.length < 32) return json({ error: 'Invalid host token' }, 400);
      this.hostToken = body.hostToken; this.createdAt = Date.now();
      this.expiryTimer = setTimeout(() => this.expire(), ROOM_TTL_MS);
      return json({ ok: true });
    }
    if (url.pathname !== '/ws' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'Not found' }, 404);
    if (!this.hostToken) return url.searchParams.get('role') === 'team' ? this.teamJoinError('room', 'Room not found. Check the code.') : json({ error: 'Room not found' }, 404);
    const role = url.searchParams.get('role');
    let session: Session;
    let welcomeToken: string | undefined;
    try {
      if (role === 'host') {
        if (url.searchParams.get('token') !== this.hostToken) throw new GameError('auth', 'Invalid host link');
        // Same bearer token owns the room: replace a stale socket on refresh.
        for (const [ws, existing] of this.sessions) if (existing.role === 'host') {
          this.sessions.delete(ws);
          try { ws.close(1000, 'Host reconnected'); } catch { /* already gone */ }
        }
        session = { role: 'host', token: this.hostToken }; this.game.hostConnected = true;
      } else if (role === 'team') {
        const name = url.searchParams.get('name') ?? '';
        const reconnect = url.searchParams.get('reconnect');
        const match = reconnect && [...this.tokens.entries()].find(([, token]) => token === reconnect);
        if (reconnect && !match) throw new GameError('auth', 'Invalid reconnect');
        if (match) {
          const team = this.game.teams.find(t => t.id === match[0]);
          if (!team || team.name.toLocaleLowerCase() !== name.toLocaleLowerCase() || team.connected) throw new GameError('auth', 'Invalid reconnect');
          team.connected = true; session = { role: 'team', teamId: team.id }; welcomeToken = reconnect!; this.game.version++;
        } else {
          const readmitted = this.game.teams.find(team => this.pendingReadmission.has(team.id) && !team.connected && team.name.toLocaleLowerCase() === name.trim().toLocaleLowerCase());
          if (readmitted) {
            this.pendingReadmission.delete(readmitted.id);
            readmitted.connected = true;
            this.game.version++;
            welcomeToken = crypto.randomUUID(); this.tokens.set(readmitted.id, welcomeToken);
            session = { role: 'team', teamId: readmitted.id };
          } else {
            const teamId = crypto.randomUUID();
            addTeam(this.game, teamId, name);
            welcomeToken = crypto.randomUUID(); this.tokens.set(teamId, welcomeToken); session = { role: 'team', teamId };
          }
        }
      } else throw new GameError('role', 'Invalid role');
    } catch (error) {
      const e = error instanceof GameError ? error : new GameError('message', 'Invalid request');
      return role === 'team' ? this.teamJoinError(e.code, e.message) : json({ error: e.message, code: e.code }, 400);
    }
    const pair = new WebSocketPair(); const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    server.accept(); this.sessions.set(server, session);
    this.send(server, { type: 'welcome', role: session.role, ...(session.role === 'team' ? { teamId: session.teamId, reconnectToken: welcomeToken } : {}), state: view(this.game, session.role === 'host') });
    server.addEventListener('message', event => { this.handleMessage(server, event.data); });
    server.addEventListener('close', () => this.disconnect(server));
    server.addEventListener('error', () => this.disconnect(server));
    this.broadcast();
    return new Response(null, { status: 101, webSocket: client });
  }
  private teamJoinError(code: string, message: string): Response {
    // Browsers cannot read HTTP error bodies from failed WebSocket handshakes.
    // Upgrade first so the phone receives the exact rejection over the socket.
    const pair = new WebSocketPair(); const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    server.accept();
    server.send(JSON.stringify({ type: 'error', code, message }));
    server.close(1008, 'Join rejected');
    return new Response(null, { status: 101, webSocket: client });
  }
  private expire() {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const ws of this.sessions.keys()) {
      this.send(ws, { type: 'error', code: 'expired', message: 'Room expired. Create a new game.' });
      try { ws.close(1000, 'Room expired'); } catch { /* already gone */ }
    }
    this.sessions.clear();
  }
  private send(ws: WebSocket, message: ServerMessage) { try { ws.send(JSON.stringify(message)); } catch { this.disconnect(ws); } }
  private broadcast() { for (const [ws, session] of this.sessions) this.send(ws, { type: 'state', state: view(this.game, session.role === 'host') }); }
  private disconnect(ws: WebSocket) {
    const session = this.sessions.get(ws); if (!session) return;
    this.sessions.delete(ws);
    if (session.role === 'host') this.game.hostConnected = false;
    else {
      const team = this.game.teams.find(t => t.id === session.teamId); if (team) team.connected = false;
      if (this.game.phase === 'buzzed' && this.game.buzzQueue[0] === session.teamId) {
        this.game.buzzerDeadline = Date.now(); timeout(this.game, Date.now()); this.schedule();
      } else this.game.buzzQueue = this.game.buzzQueue.filter(id => id !== session.teamId);
    }
    this.game.version++; this.broadcast();
  }
  private handleMessage(ws: WebSocket, data: string | ArrayBuffer) {
    const session = this.sessions.get(ws); if (!session) return;
    if (this.createdAt !== null && Date.now() - this.createdAt >= ROOM_TTL_MS) { this.expire(); return; }
    try {
      if (typeof data !== 'string') throw new GameError('message', 'Invalid message');
      if (data.length > 100000) throw new GameError('size', 'Board or message is too large (100 KB maximum).');
      const msg = JSON.parse(data) as ClientMessage;
      if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') throw new GameError('message', 'Invalid message');
      if (msg.type === 'ping') { this.send(ws, { type: 'pong' }); return; }
      if (session.role === 'host') {
        if (msg.type === 'buzz') throw new GameError('role', 'Host cannot buzz');
        if (msg.type === 'load_board' && data.length > 85000) throw new GameError('size', 'Board is too large (85 KB maximum). Shorten clues or answers.');
        hostCommand(this.game, msg, Date.now());
        if (msg.type === 'readmit_team') {
          this.tokens.delete(msg.teamId);
          this.pendingReadmission.add(msg.teamId);
        }
      } else {
        if (msg.type !== 'buzz') throw new GameError('role', 'Only host may control the game');
        buzz(this.game, session.teamId, Date.now());
      }
      this.schedule(); this.broadcast();
    } catch (error) {
      const e = error instanceof GameError ? error : new GameError('message', 'Invalid message');
      this.send(ws, { type: 'error', code: e.code, message: e.message });
    }
  }
  private schedule() {
    const deadline = this.game.buzzerDeadline;
    if (deadline === this.scheduledDeadline) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null; this.scheduledDeadline = deadline;
    if (deadline) this.timer = setTimeout(() => {
      this.timer = null; this.scheduledDeadline = null;
      if (this.game.buzzerDeadline === deadline && timeout(this.game, Date.now())) { this.broadcast(); this.schedule(); }
    }, Math.max(0, deadline - Date.now()));
  }
}
