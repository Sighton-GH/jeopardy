import { DurableObject } from 'cloudflare:workers';
import { addTeam, buzz, GameError, hostCommand, initialState, timeout, view, type GameState } from './state';
import type { ClientMessage, ServerMessage } from './protocol';
import type { Env } from './worker';

type Session = { role: 'host'; token: string } | { role: 'team'; teamId: string };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
export class Room extends DurableObject<Env> {
  private game: GameState = initialState();
  private hostToken: string | null = null;
  private tokens = new Map<string, string>();
  private sessions = new Map<WebSocket, Session>();
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/init' && request.method === 'POST') {
      if (this.hostToken) return json({ error: 'Room exists' }, 409);
      const body = await request.json() as { hostToken?: unknown };
      if (typeof body.hostToken !== 'string' || body.hostToken.length < 32) return json({ error: 'Invalid host token' }, 400);
      this.hostToken = body.hostToken; return json({ ok: true });
    }
    if (url.pathname !== '/ws' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'Not found' }, 404);
    if (!this.hostToken) return json({ error: 'Room not found' }, 404);
    const role = url.searchParams.get('role');
    let session: Session;
    let welcomeToken: string | undefined;
    try {
      if (role === 'host') {
        if (url.searchParams.get('token') !== this.hostToken) throw new GameError('auth', 'Invalid host link');
        if ([...this.sessions.values()].some(s => s.role === 'host')) throw new GameError('host', 'Host already connected');
        session = { role: 'host', token: this.hostToken }; this.game.hostConnected = true;
      } else if (role === 'team') {
        const name = url.searchParams.get('name') ?? '';
        const reconnect = url.searchParams.get('reconnect');
        const match = reconnect && [...this.tokens.entries()].find(([, token]) => token === reconnect);
        if (reconnect && !match) throw new GameError('auth', 'Invalid reconnect');
        if (match) {
          const team = this.game.teams.find(t => t.id === match[0]);
          if (!team || team.name !== name || team.connected) throw new GameError('auth', 'Invalid reconnect');
          team.connected = true; session = { role: 'team', teamId: team.id }; welcomeToken = reconnect!; this.game.version++;
        } else {
          const teamId = crypto.randomUUID();
          addTeam(this.game, teamId, name);
          welcomeToken = crypto.randomUUID(); this.tokens.set(teamId, welcomeToken); session = { role: 'team', teamId };
        }
      } else throw new GameError('role', 'Invalid role');
    } catch (error) {
      const e = error instanceof GameError ? error : new GameError('message', 'Invalid request');
      return json({ error: e.message, code: e.code }, 400);
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
    try {
      if (typeof data !== 'string' || data.length > 100000) throw new GameError('message', 'Invalid message');
      const msg = JSON.parse(data) as ClientMessage;
      if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') throw new GameError('message', 'Invalid message');
      if (msg.type === 'ping') { this.send(ws, { type: 'pong' }); return; }
      if (session.role === 'host') {
        if (msg.type === 'buzz') throw new GameError('role', 'Host cannot buzz');
        hostCommand(this.game, msg, Date.now());
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
    if (deadline) setTimeout(() => { if (timeout(this.game, Date.now())) { this.broadcast(); this.schedule(); } }, Math.max(0, deadline - Date.now()));
  }
}
