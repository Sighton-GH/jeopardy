import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Room } from '../src/room';
const sleep = () => new Promise(resolve => setTimeout(resolve, 10));
async function connect(room: DurableObjectStub<Room>, query: string) {
  const response = await room.fetch(new Request(`https://room/ws?${query}`, { headers: { Upgrade: 'websocket' } }));
  if (response.status !== 101 || !response.webSocket) throw new Error(await response.text());
  const ws = response.webSocket; ws.accept(); return ws;
}
function messages(ws: WebSocket) { const out: Array<Record<string, unknown>> = []; ws.addEventListener('message', e => out.push(JSON.parse(e.data as string) as Record<string, unknown>)); return out; }
describe('room Durable Object', () => {
  it('allows host refresh, rejects stale adjudication, and reconnects a team with changed case', async () => {
    const room = env.ROOM.get(env.ROOM.idFromName(crypto.randomUUID()));
    const token = 'b'.repeat(40);
    await room.fetch(new Request('https://room/init', { method: 'POST', body: JSON.stringify({ hostToken: token }) }));
    const oldHost = await connect(room, `role=host&token=${token}`);
    const host = await connect(room, `role=host&token=${token}`);
    const events = messages(host);
    const one = await connect(room, 'role=team&name=Blue');
    const oneEvents = messages(one);
    await sleep();
    const welcome = oneEvents.find(e => e.type === 'welcome') as { reconnectToken: string; teamId: string };
    expect(welcome.reconnectToken).toBeTruthy();
    one.close(); await sleep();
    const again = await connect(room, `role=team&name=bLUE&reconnect=${welcome.reconnectToken}`);
    const two = await connect(room, 'role=team&name=Red');
    const twoEvents = messages(two); await sleep();
    const red = (twoEvents.find(e => e.type === 'welcome') as { teamId: string }).teamId;
    host.send(JSON.stringify({ type: 'load_board', board: { categories: [{ id: 'cat', name: 'Facts', cells: [{ id: 'cell', question: 'Clue', answer: 'Secret', value: 200, dailyDouble: false }] }] } }));
    host.send(JSON.stringify({ type: 'pick_cell', cellId: 'cell' }));
    host.send(JSON.stringify({ type: 'arm_buzzers' }));
    await sleep();
    again.send(JSON.stringify({ type: 'buzz' })); await sleep();
    two.send(JSON.stringify({ type: 'buzz' })); await sleep();
    again.close(); await sleep();
    host.send(JSON.stringify({ type: 'correct', teamId: welcome.teamId })); await sleep();
    expect(events.some(e => e.type === 'error' && e.code === 'stale')).toBe(true);
    host.send(JSON.stringify({ type: 'correct', teamId: red })); await sleep();
    const last = [...events].reverse().find(e => e.type === 'state' && (e.state as { phase: string }).phase === 'resolving');
    expect((last?.state as { teams: { id: string; score: number }[] }).teams.find(t => t.id === red)?.score).toBe(200);
    host.close(); oldHost.close(); two.close();
  });
  it('re-admits a disconnected team from a fresh device and invalidates its old token', async () => {
    const room = env.ROOM.get(env.ROOM.idFromName(crypto.randomUUID()));
    const token = 'c'.repeat(40);
    await room.fetch(new Request('https://room/init', { method: 'POST', body: JSON.stringify({ hostToken: token }) }));
    const host = await connect(room, `role=host&token=${token}`);
    const team = await connect(room, 'role=team&name=Blue');
    const events = messages(team); await sleep();
    const welcome = events.find(e => e.type === 'welcome') as { teamId: string; reconnectToken: string };
    team.close(); await sleep();
    host.send(JSON.stringify({ type: 'readmit_team', teamId: welcome.teamId })); await sleep();
    const fresh = await connect(room, 'role=team&name=blue');
    const freshEvents = messages(fresh); await sleep();
    expect((freshEvents.find(e => e.type === 'welcome') as { teamId: string }).teamId).toBe(welcome.teamId);
    const stale = await room.fetch(new Request(`https://room/ws?role=team&name=Blue&reconnect=${welcome.reconnectToken}`, { headers: { Upgrade: 'websocket' } }));
    expect(stale.status).toBe(101);
    const staleSocket = stale.webSocket!; staleSocket.accept();
    const rejected = messages(staleSocket); await sleep();
    expect(rejected.some(e => e.type === 'error' && e.code === 'auth')).toBe(true);
    host.close(); fresh.close();
  });
  it('sends join rejection reasons through upgraded sockets', async () => {
    const room = env.ROOM.get(env.ROOM.idFromName(crypto.randomUUID()));
    const token = 'd'.repeat(40);
    await room.fetch(new Request('https://room/init', { method: 'POST', body: JSON.stringify({ hostToken: token }) }));
    const host = await connect(room, `role=host&token=${token}`);
    const one = await connect(room, 'role=team&name=Blue');
    async function rejected(query: string, code: string, detail: string) {
      const res = await room.fetch(new Request(`https://room/ws?${query}`, { headers: { Upgrade: 'websocket' } }));
      expect(res.status).toBe(101);
      const ws = res.webSocket!; ws.accept(); const events = messages(ws); await sleep();
      expect(events.some(e => e.type === 'error' && e.code === code && String(e.message).includes(detail))).toBe(true);
    }
    await rejected('role=team&name=blue', 'name', 'taken');
    for (let i = 2; i <= 10; i++) await connect(room, `role=team&name=Team${i}`);
    await rejected('role=team&name=Extra', 'full', 'full');
    host.send(JSON.stringify({ type: 'load_board', board: { categories: [{ id: 'c', name: 'Cat', cells: [{ id: 'q', question: 'Q', answer: 'A', value: 200, dailyDouble: false }] }] } }));
    host.send(JSON.stringify({ type: 'pick_cell', cellId: 'q' })); await sleep();
    await rejected('role=team&name=Late', 'phase', 'during a question');
    host.close(); one.close();
  });
  it('authenticates host, limits team commands, broadcasts redacted state', async () => {
    const room = env.ROOM.get(env.ROOM.idFromName(crypto.randomUUID()));
    const token = 'a'.repeat(40);
    expect((await room.fetch(new Request('https://room/init', { method: 'POST', body: JSON.stringify({ hostToken: token }) }))).status).toBe(200);
    expect((await room.fetch(new Request('https://room/ws?role=host&token=wrong', { headers: { Upgrade: 'websocket' } }))).status).toBe(400);
    const host = await connect(room, `role=host&token=${token}`); const hostEvents = messages(host);
    const team = await connect(room, 'role=team&name=Blue'); const teamEvents = messages(team);
    await sleep();
    team.send(JSON.stringify({ type: 'adjust_score', teamId: 'any', delta: 999 }));
    await sleep(); expect(teamEvents.some(m => m.type === 'error' && m.code === 'role')).toBe(true);
    host.send(JSON.stringify({ type: 'load_board', board: { categories: [{ id: 'c', name: 'Facts', cells: [{ id: 'q', question: 'Clue', answer: 'Secret answer', value: 100, dailyDouble: false }] }] } }));
    await sleep(); expect(hostEvents.some(m => JSON.stringify(m).includes('Secret answer'))).toBe(true);
    expect(JSON.stringify(teamEvents)).not.toContain('Secret answer');
    host.send(JSON.stringify({ type: 'pick_cell', cellId: 'q' })); host.send(JSON.stringify({ type: 'arm_buzzers' }));
    await sleep(); team.send(JSON.stringify({ type: 'buzz' })); await sleep();
    expect(teamEvents.some(m => m.type === 'state' && (m.state as { phase: string }).phase === 'buzzed')).toBe(true);
    host.close(); team.close();
  });
});
