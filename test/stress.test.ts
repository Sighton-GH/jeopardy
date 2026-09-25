import { describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import worker, { type Env } from '../src/worker';
import type { Room } from '../src/room';
import { parseBoardFile } from '../src/parse_board';

type Event = { type: string; code?: string; state?: { phase: string; teams: Array<{ id: string; name: string; score: number; connected: boolean }>; buzzQueue: string[]; lockedOut: string[]; board: Array<{ cells: Array<{ revealed: boolean }> }>; hostConnected: boolean; buzzerDeadline: number | null }; teamId?: string; reconnectToken?: string };
const wait = () => new Promise(resolve => setTimeout(resolve, 12));
const board = { categories: [{ id: 'c', name: 'Category', cells: [{ id: 'q', question: 'Q?', answer: 'A', value: 200, dailyDouble: false }, { id: 'q2', question: 'Q2?', answer: 'A2', value: 400, dailyDouble: true }] }] };
async function setup() {
  const room = env.ROOM.get(env.ROOM.idFromName(crypto.randomUUID())) as DurableObjectStub<Room>;
  const token = crypto.randomUUID() + crypto.randomUUID();
  expect((await room.fetch(new Request('https://room/init', { method: 'POST', body: JSON.stringify({ hostToken: token }) }))).status).toBe(200);
  return { room, token };
}
async function connect(room: DurableObjectStub<Room>, q: string) {
  const res = await room.fetch(new Request(`https://room/ws?${q}`, { headers: { Upgrade: 'websocket' } }));
  expect(res.status).toBe(101); const ws = res.webSocket!; ws.accept();
  const events: Event[] = []; ws.addEventListener('message', e => { events.push(JSON.parse(e.data as string) as Event); });
  await wait();
  return { ws, events, welcome: events.find(e => e.type === 'welcome')! };
}
const send = async (c: { ws: WebSocket }, msg: unknown) => { c.ws.send(JSON.stringify(msg)); await wait(); };
const state = (c: { events: Event[] }) => { const value = [...c.events].reverse().find(e => e.state)?.state; if (!value) throw new Error('No state'); return value; };
const errors = (c: { events: Event[] }) => c.events.filter(e => e.type === 'error').map(e => e.code);
async function game() {
  const { room, token } = await setup();
  const host = await connect(room, `role=host&token=${token}`);
  const a = await connect(room, 'role=team&name=Alpha');
  const b = await connect(room, 'role=team&name=Beta');
  await send(host, { type: 'load_board', board });
  return { room, token, host, a, b };
}
const open = async (host: { ws: WebSocket }) => { await send(host, { type: 'pick_cell', cellId: 'q' }); await send(host, { type: 'arm_buzzers' }); };

describe('stress paths in real workerd Durable Objects and WebSockets', () => {
  it('orders concurrent buzzes once and rejects double buzz, wrong, stale, and correct', async () => {
    const { host, a, b } = await game(); await open(host);
    a.ws.send('{"type":"buzz"}'); b.ws.send('{"type":"buzz"}'); a.ws.send('{"type":"buzz"}'); await wait();
    expect(state(host).buzzQueue).toEqual([a.welcome.teamId, b.welcome.teamId]);
    expect(errors(a)).toContain('locked');
    await send(host, { type: 'wrong', teamId: a.welcome.teamId });
    expect(state(host).teams.find(t => t.id === a.welcome.teamId)?.score).toBe(-200);
    expect(state(host).buzzQueue).toEqual([b.welcome.teamId]);
    await send(host, { type: 'correct', teamId: a.welcome.teamId }); expect(errors(host)).toContain('stale');
    await send(host, { type: 'correct', teamId: b.welcome.teamId });
    expect(state(host).phase).toBe('resolving'); expect(state(host).teams.find(t => t.id === b.welcome.teamId)?.score).toBe(200);
    await send(host, { type: 'correct', teamId: b.welcome.teamId }); expect(errors(host)).toContain('phase');
    await send(host, { type: 'back_to_board' }); expect(state(host).board[0]!.cells[0]!.revealed).toBe(true);
    host.ws.close(); a.ws.close(); b.ws.close();
  });
  it('rejects a buzz or answer after deadline even when its timer callback has not run', async () => {
    const { host, a, b } = await game(); await open(host); await send(a, { type: 'buzz' });
    // Wait the actual answer window, exercising the real workerd timer and socket path.
    await new Promise(resolve => setTimeout(resolve, 15100));
    expect(state(host).lockedOut).toContain(a.welcome.teamId);
    await send(host, { type: 'correct', teamId: a.welcome.teamId }); expect(errors(host)).toContain('phase');
    await send(a, { type: 'buzz' }); expect(errors(a)).toContain('locked');
    await send(b, { type: 'buzz' }); expect(state(host).buzzQueue).toEqual([b.welcome.teamId]);
    host.ws.close(); a.ws.close(); b.ws.close();
  }, 30000);
  it('host refresh, team refresh and disconnect while answering preserve queue and score', async () => {
    const { room, token, host, a, b } = await game(); await open(host);
    const host2 = await connect(room, `role=host&token=${token}`);
    expect(state(host2).phase).toBe('buzz-open');
    await send(a, { type: 'buzz' }); await send(b, { type: 'buzz' });
    const reconnect = a.welcome.reconnectToken!; a.ws.close(); await wait();
    expect(state(host2).buzzQueue).toEqual([b.welcome.teamId]);
    const a2 = await connect(room, `role=team&name=ALPHA&reconnect=${reconnect}`);
    expect(a2.welcome.teamId).toBe(a.welcome.teamId);
    await send(host2, { type: 'correct', teamId: b.welcome.teamId }); expect(state(host2).phase).toBe('resolving');
    host2.ws.close(); await wait(); expect(state(a2).hostConnected).toBe(false);
    const host3 = await connect(room, `role=host&token=${token}`); expect(state(host3).phase).toBe('resolving');
    host.ws.close(); host3.ws.close(); a2.ws.close(); b.ws.close();
  });
  it('rejects duplicate names and late joins, allows a full room and allows joins between clues', async () => {
    const { room, host, a, b } = await game();
    const duplicate = await connect(room, 'role=team&name=%20alpha%20'); expect(errors(duplicate)).toContain('name');
    const rest = []; for (let i = 2; i < 10; i++) rest.push(await connect(room, `role=team&name=T${i}`));
    expect(state(host).teams).toHaveLength(10);
    const extra = await connect(room, 'role=team&name=Extra'); expect(errors(extra)).toContain('full');
    await open(host); const late = await connect(room, 'role=team&name=Late'); expect(errors(late)).toContain('phase');
    await send(host, { type: 'back_to_board' });
    b.ws.close(); await wait();
    const b2 = await connect(room, `role=team&name=Beta&reconnect=${b.welcome.reconnectToken}`);
    expect(b2.welcome.teamId).toBe(b.welcome.teamId);
    host.ws.close(); a.ws.close(); b2.ws.close(); rest.forEach(c => c.ws.close());
  });
  it('enforces host/team roles, malformed and oversized messages, and safe score adjustments', async () => {
    const { host, a, b } = await game();
    a.ws.send('{'); a.ws.send(new Uint8Array([1, 2, 3])); await wait();
    expect(errors(a)).toContain('message');
    await send(a, { type: 'adjust_score', teamId: a.welcome.teamId, delta: 9999 }); expect(errors(a)).toContain('role');
    await send(host, { type: 'buzz' }); expect(errors(host)).toContain('role');
    await send(host, { type: 'adjust_score', teamId: a.welcome.teamId, delta: -500 });
    expect(state(host).teams.find(t => t.id === a.welcome.teamId)?.score).toBe(-500);
    for (const delta of [1.5, '100', 100001, Number.MAX_SAFE_INTEGER]) await send(host, { type: 'adjust_score', teamId: a.welcome.teamId, delta });
    expect(errors(host).filter(e => e === 'score').length).toBeGreaterThanOrEqual(4);
    expect(state(host).teams.find(t => t.id === a.welcome.teamId)?.score).toBe(-500);
    await send(host, { type: 'load_board', board: { categories: [] } }); expect(errors(host)).toContain('board');
    await send(host, { type: 'load_board', board: { categories: [{ id: 'c', name: 'x', cells: [{ ...board.categories[0]!.cells[0]!, question: '<script>alert(1)</script>' }] }] } });
    expect(state(host).board[0]!.cells[0]!.revealed).toBe(false);
    await send(host, { type: 'load_board', payload: 'x'.repeat(100001) }); expect(errors(host)).toContain('size');
    host.ws.close(); a.ws.close(); b.ws.close();
  });
  it('refreshes both sides at every reachable phase without resetting state', async () => {
    const { room, token, host, a, b } = await game();
    let activeHost = host;
    let activeTeam = a;
    for (const phase of ['board', 'question-showing', 'buzz-open', 'buzzed', 'resolving', 'complete']) {
      if (phase === 'question-showing') await send(activeHost, { type: 'pick_cell', cellId: 'q' });
      if (phase === 'buzz-open') await send(activeHost, { type: 'arm_buzzers' });
      if (phase === 'buzzed') await send(b, { type: 'buzz' });
      if (phase === 'resolving') await send(activeHost, { type: 'correct', teamId: b.welcome.teamId });
      if (phase === 'complete') {
        await send(activeHost, { type: 'back_to_board' });
        await send(activeHost, { type: 'pick_cell', cellId: 'q2' });
        await send(activeHost, { type: 'arm_buzzers' });
        await send(activeHost, { type: 'back_to_board' });
        await send(activeHost, { type: 'back_to_board' });
      }
      const oldHost = activeHost;
      activeHost = await connect(room, `role=host&token=${token}`);
      const reconnectToken = activeTeam.welcome.reconnectToken!;
      activeTeam.ws.close(); await wait();
      activeTeam = await connect(room, `role=team&name=Alpha&reconnect=${reconnectToken}`);
      expect(state(activeHost).phase).toBe(phase);
      expect(state(activeTeam).phase).toBe(phase);
      oldHost.ws.close();
    }
    expect(state(activeHost).teams.find(t => t.id === b.welcome.teamId)?.score).toBe(200);
    activeHost.ws.close(); activeTeam.ws.close(); b.ws.close();
  });
  it('orders a burst from all 10 connected teams, excludes every wrong answerer, then finishes', async () => {
    const { room, host, a, b } = await game();
    const others = []; for (let i = 2; i < 10; i++) others.push(await connect(room, `role=team&name=T${i}`));
    const teams = [a, b, ...others]; await open(host);
    teams.forEach(c => c.ws.send('{"type":"buzz"}'));
    await wait();
    const order = state(host).buzzQueue;
    expect(order).toHaveLength(10); expect(new Set(order).size).toBe(10);
    for (const id of order.slice(0, 9)) {
      await send(host, { type: 'wrong', teamId: id });
      expect(state(host).lockedOut).toContain(id);
    }
    expect(state(host).buzzQueue).toEqual([order[9]]);
    await send(host, { type: 'correct', teamId: order[9] });
    expect(state(host).phase).toBe('resolving');
    host.ws.close(); teams.forEach(c => c.ws.close());
  });
  it('rejects a malformed create and invalid WebSocket handshakes without creating a room', async () => {
    const { room } = await setup();
    const init = await room.fetch(new Request('https://room/init', { method: 'POST', body: JSON.stringify({ hostToken: 'z'.repeat(40) }) }));
    expect(init.status).toBe(409);
    const badHost = await room.fetch(new Request('https://room/ws?role=host&token=wrong', { headers: { Upgrade: 'websocket' } }));
    expect(badHost.status).toBe(400);
    const ordinary = await worker.fetch(new Request('https://test.local/api/rooms/BAD/ws'), env as Env);
    expect(ordinary.status).toBe(404);
  });
  it('expires the room after six hours and refuses a late team join', async () => {
    const { room, token } = await setup();
    const host = await connect(room, `role=host&token=${token}`);
    const team = await connect(room, 'role=team&name=Alpha');
    const actualNow = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(actualNow + 6 * 60 * 60 * 1000 + 1000);
    try {
      const late = await connect(room, 'role=team&name=Late');
      expect(errors(late)).toContain('expired');
      expect(errors(team)).toContain('expired');
      expect(errors(host)).toContain('expired');
    } finally { vi.restoreAllMocks(); host.ws.close(); team.ws.close(); }
  });
  it('guards unknown messages, missing board, invalid cell, and command ordering', async () => {
    const { room, token } = await setup();
    const host = await connect(room, `role=host&token=${token}`);
    await send(host, { type: 'arm_buzzers' }); expect(errors(host)).toContain('phase');
    await send(host, { type: 'pick_cell', cellId: 'q' }); expect(errors(host)).toContain('phase');
    await send(host, { type: 'nonsense' }); expect(errors(host)).toContain('message');
    host.ws.send('null'); host.ws.send('[]'); await wait();
    expect(errors(host).filter(e => e === 'message').length).toBeGreaterThanOrEqual(3);
    await send(host, { type: 'load_board', board });
    await send(host, { type: 'pick_cell', cellId: 'missing' }); expect(errors(host)).toContain('cell');
    await send(host, { type: 'pick_cell', cellId: 'q' });
    await send(host, { type: 'load_board', board }); expect(errors(host)).toContain('phase');
    await send(host, { type: 'back_to_board' });
    expect(state(host).board[0]!.cells[0]!.revealed).toBe(false);
    host.ws.close();
    const noRoom = env.ROOM.get(env.ROOM.idFromName(crypto.randomUUID())) as DurableObjectStub<Room>;
    const absent = await connect(noRoom, 'role=team&name=Lost'); expect(errors(absent)).toContain('room');
  });
  it('rate limits room creation per IP in real RATE_LIMIT DO; distinct IP has its own bucket', async () => {
    const ip = crypto.randomUUID();
    const create = (key: string) => worker.fetch(new Request('https://test.local/api/rooms', { method: 'POST', headers: { 'cf-connecting-ip': key } }), env as Env);
    for (let i = 0; i < 12; i++) expect((await create(ip)).status).toBe(201);
    const denied = await create(ip); expect(denied.status).toBe(429); expect(Number(denied.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await create(crypto.randomUUID())).status).toBe(201);
  });
  it('loads a Jeopardy Labs-format CSV into the real host DO, retaining 20 clue cells', async () => {
    const lines = ['round,cat,q,a,dd', ...Array.from({ length: 20 }, (_, i) => `jeopardy,Category ${Math.floor(i / 5) + 1},Question ${i},Answer ${i},false`)];
    const parsed = await parseBoardFile('sample.csv', lines.join('\n'));
    const { room, token } = await setup(); const host = await connect(room, `role=host&token=${token}`);
    await send(host, { type: 'load_board', board: parsed });
    expect(state(host).board).toHaveLength(4); expect(state(host).board.flatMap(c => c.cells)).toHaveLength(20);
    expect(state(host).board.map(c => c.cells.map(cell => cell.revealed))).toEqual(Array.from({ length: 4 }, () => Array(5).fill(false)));
    host.ws.close();
  });
});
