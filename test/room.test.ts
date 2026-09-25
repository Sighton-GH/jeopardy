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
