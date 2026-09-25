import { DurableObject } from 'cloudflare:workers';
import { addTeam, buzz, GameError, hostCommand, initialState, timeout, view, type GameState } from './state';
import type { ClientMessage, ServerMessage } from './protocol';
import type { Env } from './worker';
const ROOM_TTL_MS = 6 * 60 * 60 * 1000;

type Snapshot = { game: GameState; hostToken: string | null; createdAt: number | null; expired: boolean; tokens: Array<[string, string]>; pendingReadmission: string[] };
type Session = { role: 'host'; token: string } | { role: 'team'; teamId: string };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
export class Room extends DurableObject<Env> {
  private game: GameState = initialState();
  private operations: Promise<void> = Promise.resolve();
  private pendingError: unknown = null;
  private hostToken: string | null = null;
  private createdAt: number | null = null;
  private expired = false;
  private tokens = new Map<string, string>();
  private pendingReadmission = new Set<string>();
  private sessions = new Map<WebSocket, Session>();
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get<Snapshot>('room');
      if (!saved) return;
      this.game = saved.game;
      this.hostToken = saved.hostToken;
      this.createdAt = saved.createdAt;
      this.expired = saved.expired;
      this.tokens = new Map(saved.tokens);
      this.pendingReadmission = new Set(saved.pendingReadmission);
      // WebSockets are not hibernated. On a new instance every old connection is gone.
      this.game.hostConnected = false;
      for (const team of this.game.teams) team.connected = false;
      if (!this.expired && this.createdAt !== null && Date.now() >= this.createdAt + ROOM_TTL_MS) await this.expire();
      else {
        if (this.game.buzzerDeadline !== null) timeout(this.game, Date.now());
        await this.save();
      }
    });
  }
  private async save() {
    const snapshot: Snapshot = {
      game: this.game, hostToken: this.hostToken, createdAt: this.createdAt,
      expired: this.expired, tokens: [...this.tokens], pendingReadmission: [...this.pendingReadmission],
    };
    await this.ctx.storage.put('room', snapshot);
    const next = this.expired || this.createdAt === null ? null : Math.min(this.createdAt + ROOM_TTL_MS, this.game.buzzerDeadline ?? Infinity);
    if (next !== null) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1, next));
    else if (await this.ctx.storage.getAlarm() !== null) await this.ctx.storage.deleteAlarm();
  }
  private enqueue(operation: () => Promise<void>) {
    const task = this.operations.then(operation);
    this.operations = task.catch(error => { this.pendingError = error; console.error('Room operation failed', error); });
    return task;
  }
  private async ready() {
    await this.operations;
    if (this.pendingError !== null) throw this.pendingError;
  }
  async alarm() {
    await this.ready();
    if (this.createdAt !== null && Date.now() >= this.createdAt + ROOM_TTL_MS) { await this.expire(); return; }
    if (timeout(this.game, Date.now())) this.broadcast();
    await this.save();
  }
  async fetch(request: Request): Promise<Response> {
    await this.ready();
    const url = new URL(request.url);
    if (url.pathname !== '/init' && (this.expired || (this.createdAt !== null && Date.now() - this.createdAt >= ROOM_TTL_MS))) {
      await this.expire();
      return url.pathname === '/ws' && url.searchParams.get('role') === 'team' && request.headers.get('Upgrade')?.toLowerCase() === 'websocket' ? this.teamJoinError('expired', 'Room expired. Create a new game.') : json({ error: 'Room expired. Create a new game.', code: 'expired' }, 410);
    }
    if (url.pathname === '/init' && request.method === 'POST') {
      if (this.hostToken || this.expired) return json({ error: 'Room exists' }, 409);
      const body = await request.json() as { hostToken?: unknown };
      if (typeof body.hostToken !== 'string' || body.hostToken.length < 32) return json({ error: 'Invalid host token' }, 400);
      this.hostToken = body.hostToken; this.createdAt = Date.now();
      await this.save();
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
    server.addEventListener('message', event => { void this.enqueue(() => this.handleMessage(server, event.data)); });
    server.addEventListener('close', () => { void this.enqueue(() => this.disconnect(server)); });
    server.addEventListener('error', () => { void this.enqueue(() => this.disconnect(server)); });
    await this.save();
    this.send(server, { type: 'welcome', role: session.role, ...(session.role === 'team' ? { teamId: session.teamId, reconnectToken: welcomeToken } : {}), state: view(this.game, session.role === 'host') });
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
  private async expire() {
    if (this.expired) return;
    this.expired = true;
    this.hostToken = null;
    this.tokens.clear();
    this.pendingReadmission.clear();
    this.game.buzzerDeadline = null;
    await this.save();
    for (const ws of this.sessions.keys()) {
      this.send(ws, { type: 'error', code: 'expired', message: 'Room expired. Create a new game.' });
      try { ws.close(1000, 'Room expired'); } catch { /* already gone */ }
    }
    this.sessions.clear();
  }
  private send(ws: WebSocket, message: ServerMessage) { try { ws.send(JSON.stringify(message)); } catch { void this.enqueue(() => this.disconnect(ws)); } }
  private broadcast() { for (const [ws, session] of this.sessions) this.send(ws, { type: 'state', state: view(this.game, session.role === 'host') }); }
  private async disconnect(ws: WebSocket) {
    const session = this.sessions.get(ws); if (!session) return;
    this.sessions.delete(ws);
    if (session.role === 'host') this.game.hostConnected = false;
    else {
      const team = this.game.teams.find(t => t.id === session.teamId); if (team) team.connected = false;
      if (this.game.phase === 'buzzed' && this.game.buzzQueue[0] === session.teamId) {
        this.game.buzzerDeadline = Date.now(); timeout(this.game, Date.now());
      } else this.game.buzzQueue = this.game.buzzQueue.filter(id => id !== session.teamId);
    }
    this.game.version++; await this.save(); this.broadcast();
  }
  private async handleMessage(ws: WebSocket, data: string | ArrayBuffer) {
    const session = this.sessions.get(ws); if (!session) return;
    if (this.expired || (this.createdAt !== null && Date.now() - this.createdAt >= ROOM_TTL_MS)) { await this.expire(); return; }
    try {
      if (typeof data !== 'string') throw new GameError('message', 'Invalid message');
      if (data.length > 100000) throw new GameError('size', 'Board or message is too large (100 KB maximum).');
      // A delayed timer callback must not make an expired answer window actionable.
      // Settle the deadline before accepting a buzz or an adjudication.
      if (this.game.buzzerDeadline !== null && Date.now() >= this.game.buzzerDeadline) {
        if (timeout(this.game, Date.now())) { await this.save(); this.broadcast(); }
      }
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
      await this.save(); this.broadcast();
    } catch (error) {
      const e = error instanceof GameError ? error : new GameError('message', 'Invalid message');
      this.send(ws, { type: 'error', code: e.code, message: e.message });
    }
  }
}
