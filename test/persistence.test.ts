import { describe, expect, it, vi } from 'vitest';
import { env, runInDurableObject, runDurableObjectAlarm } from 'cloudflare:test';
import type { Room } from '../src/room';

const wait = () => new Promise(resolve => setTimeout(resolve, 15));
const board = { categories: [{ id: 'c', name: 'Category', cells: [{ id: 'q', question: 'Q', answer: 'A', value: 200, dailyDouble: false }] }] };
async function socket(room: DurableObjectStub<Room>, query: string) {
  const result = await room.fetch(new Request(`https://room/ws?${query}`, { headers: { Upgrade: 'websocket' } }));
  expect(result.status).toBe(101);
  const ws = result.webSocket!; ws.accept();
  const received: Array<Record<string, unknown>> = [];
  ws.addEventListener('message', e => { received.push(JSON.parse(e.data as string) as Record<string, unknown>); });
  await wait();
  return { ws, received, welcome: received.find(e => e.type === 'welcome')! };
}
const send = async (client: { ws: WebSocket }, payload: unknown) => { client.ws.send(JSON.stringify(payload)); await wait(); };
const current = (client: { received: Array<Record<string, unknown>> }) => [...client.received].reverse().find(e => e.state)?.state as { phase: string; teams: Array<{ id: string; score: number; connected: boolean }>; buzzQueue: string[]; buzzerDeadline: number | null; hostConnected: boolean; board: Array<{ cells: Array<{ revealed: boolean }> }> };

async function setup() {
  const room = env.ROOM.get(env.ROOM.idFromName(crypto.randomUUID()));
  const hostToken = crypto.randomUUID() + crypto.randomUUID();
  expect((await room.fetch(new Request('https://room/init', { method: 'POST', body: JSON.stringify({ hostToken }) }))).status).toBe(200);
  const host = await socket(room, `role=host&token=${hostToken}`);
  const a = await socket(room, 'role=team&name=Alpha');
  const b = await socket(room, 'role=team&name=Beta');
  await send(host, { type: 'load_board', board });
  return { room, hostToken, host, a, b };
}

describe('durable room state', () => {
  it('stores board, scores, tokens, queue, deadline, and expiry in the real SQLite-backed DO', async () => {
    const { room, hostToken, host, a, b } = await setup();
    await send(host, { type: 'adjust_score', teamId: a.welcome.teamId, delta: -500 });
    await send(host, { type: 'pick_cell', cellId: 'q' });
    await send(host, { type: 'arm_buzzers' });
    await send(a, { type: 'buzz' }); await send(b, { type: 'buzz' });
    const snapshot = await runInDurableObject(room, async (_instance, state) => state.storage.get<{
      hostToken: string; game: { phase: string; teams: Array<{ id: string; score: number }>; buzzQueue: string[]; buzzerDeadline: number | null; board: unknown[] }; tokens: Array<[string, string]>; createdAt: number;
    }>('room'));
    expect(snapshot?.hostToken).toBe(hostToken);
    expect(snapshot?.game.phase).toBe('buzzed');
    expect(snapshot?.game.buzzQueue).toEqual([a.welcome.teamId, b.welcome.teamId]);
    expect(snapshot?.game.teams.find(t => t.id === a.welcome.teamId)?.score).toBe(-500);
    expect(snapshot?.game.buzzerDeadline).toBeGreaterThan(Date.now());
    expect(snapshot?.game.board).toHaveLength(1);
    expect(snapshot?.tokens).toContainEqual([a.welcome.teamId, a.welcome.reconnectToken]);
    const alarm = await runInDurableObject(room, async (_instance, state) => state.storage.getAlarm());
    expect(alarm).toBe(snapshot?.game.buzzerDeadline);
    expect(snapshot?.createdAt).toBeGreaterThan(0);
    host.ws.close(); a.ws.close(); b.ws.close();
  });
  it('does not broadcast an alarm-advanced queue until the storage write completes', async () => {
    const { room, host, a, b } = await setup();
    await send(host, { type: 'pick_cell', cellId: 'q' }); await send(host, { type: 'arm_buzzers' });
    await send(a, { type: 'buzz' }); await send(b, { type: 'buzz' });
    const deadline = current(host).buzzerDeadline!;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await runInDurableObject(room, async (instance, state) => {
      const original = state.storage.put.bind(state.storage);
      vi.spyOn(state.storage, 'put').mockImplementation(async (...args: Parameters<typeof original>) => {
        await gate;
        return original(...args);
      });
      const now = vi.spyOn(Date, 'now').mockReturnValue(deadline + 1);
      try {
        const beforeCount = host.received.length;
        const alarm = instance.alarm();
        await wait();
        expect(host.received.length).toBe(beforeCount);
        release();
        await alarm;
        await wait();
        expect(current(host).buzzQueue).toEqual([b.welcome.teamId]);
      } finally { release(); now.mockRestore(); vi.restoreAllMocks(); }
    });
    host.ws.close(); a.ws.close(); b.ws.close();
  });
  it('keeps expired rooms closed with persisted expiry and invalidated credentials', async () => {
    const { room, hostToken, host, a, b } = await setup();
    const created = await runInDurableObject(room, async (_instance, state) => (await state.storage.get<{ createdAt: number }>('room'))!.createdAt);
    const now = vi.spyOn(Date, 'now').mockReturnValue(created + 6 * 60 * 60 * 1000 + 1);
    try {
      const expired = await room.fetch(new Request(`https://room/ws?role=host&token=${hostToken}`, { headers: { Upgrade: 'websocket' } }));
      expect(expired.status).toBe(410);
      const snapshot = await runInDurableObject(room, async (_instance, state) => state.storage.get<{ expired: boolean; hostToken: string | null; tokens: Array<[string, string]> }>('room'));
      expect(snapshot).toMatchObject({ expired: true, hostToken: null, tokens: [] });
      expect((await room.fetch(new Request('https://room/init', { method: 'POST', body: JSON.stringify({ hostToken: 'fresh'.repeat(10) }) }))).status).toBe(409);
      expect(await runInDurableObject(room, async (_instance, state) => state.storage.getAlarm())).toBeNull();
    } finally { now.mockRestore(); host.ws.close(); a.ws.close(); b.ws.close(); }
  });
  it('persists pending re-admission and rotated credentials', async () => {
    const { room, host, a, b } = await setup();
    a.ws.close(); await wait();
    await send(host, { type: 'readmit_team', teamId: a.welcome.teamId });
    const pending = await runInDurableObject(room, async (_instance, state) => state.storage.get<{ pendingReadmission: string[]; tokens: Array<[string, string]> }>('room'));
    expect(pending?.pendingReadmission).toContain(a.welcome.teamId);
    expect(pending?.tokens.some(([id]) => id === a.welcome.teamId)).toBe(false);
    const fresh = await socket(room, 'role=team&name=Alpha');
    expect(fresh.welcome.teamId).toBe(a.welcome.teamId);
    expect(fresh.welcome.reconnectToken).not.toBe(a.welcome.reconnectToken);
    const rotated = await runInDurableObject(room, async (_instance, state) => state.storage.get<{ pendingReadmission: string[]; tokens: Array<[string, string]> }>('room'));
    expect(rotated?.pendingReadmission).not.toContain(a.welcome.teamId);
    expect(rotated?.tokens).toContainEqual([a.welcome.teamId, fresh.welcome.reconnectToken]);
    host.ws.close(); fresh.ws.close(); b.ws.close();
  });
  it('persists an adjudication before ack, and an alarm advances expired queue', async () => {
    const { room, host, a, b } = await setup();
    await send(host, { type: 'pick_cell', cellId: 'q' }); await send(host, { type: 'arm_buzzers' });
    await send(a, { type: 'buzz' }); await send(b, { type: 'buzz' });
    await runInDurableObject(room, async (_instance, state) => {
      const snapshot = await state.storage.get<{ game: { buzzerDeadline: number } }>('room');
      snapshot!.game.buzzerDeadline = Date.now() - 1;
      await state.storage.put('room', snapshot);
      await state.storage.setAlarm(Date.now() + 1);
    });
    // The stub keeps its instance in this runtime; force a real alarm after its original deadline.
    await new Promise(resolve => setTimeout(resolve, 15100));
    await runDurableObjectAlarm(room);
    const persisted = await runInDurableObject(room, async (_instance, state) => state.storage.get<{ game: { buzzQueue: string[]; phase: string } }>('room'));
    expect(persisted?.game.buzzQueue).toEqual([b.welcome.teamId]);
    expect(current(host).phase).toBe('buzzed');
    await send(host, { type: 'correct', teamId: b.welcome.teamId });
    const done = await runInDurableObject(room, async (_instance, state) => state.storage.get<{ game: { phase: string; teams: Array<{ id: string; score: number }> } }>('room'));
    expect(done?.game.phase).toBe('resolving');
    expect(done?.game.teams.find(t => t.id === b.welcome.teamId)?.score).toBe(200);
    host.ws.close(); a.ws.close(); b.ws.close();
  }, 30000);
});
