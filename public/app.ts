import type { ServerMessage } from '../src/protocol';
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let socket: WebSocket | undefined;
const notice = (text: string) => { el('notice').textContent = text; };
function showRoom(code: string, role: 'host' | 'team') {
  el('room').classList.remove('hidden'); el('room-code').textContent = code;
  el('role').textContent = role === 'host' ? 'HOST ROOM' : 'TEAM ROOM';
  el('host-info').classList.toggle('hidden', role !== 'host');
  el('team-info').classList.toggle('hidden', role !== 'team');
  el('room').scrollIntoView({ behavior: 'smooth' });
}
function connect(code: string, role: 'host' | 'team', params: URLSearchParams) {
  socket?.close();
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${protocol}//${location.host}/api/rooms/${code}/ws?${params}`);
  socket.onmessage = event => {
    const msg = JSON.parse(event.data as string) as ServerMessage;
    if (msg.type === 'error') { notice(msg.message); return; }
    if (msg.type !== 'welcome' && msg.type !== 'state') return;
    if (msg.type === 'welcome' && msg.reconnectToken && msg.teamId) sessionStorage.setItem(`team:${code}:${params.get('name')}`, msg.reconnectToken);
    const state = msg.state;
    el('team-state').textContent = `${state.phase.replaceAll('-', ' ').toUpperCase()}${state.selectedCellId ? ' • Question in play' : ''}`;
    const mine = msg.type === 'welcome' && msg.teamId ? msg.teamId : sessionStorage.getItem(`id:${code}`);
    if (msg.type === 'welcome' && msg.teamId) sessionStorage.setItem(`id:${code}`, msg.teamId);
    const open = state.phase === 'buzz-open' || state.phase === 'buzzed';
    el<HTMLButtonElement>('buzzer').disabled = !open || !mine || state.buzzQueue.includes(mine) || state.lockedOut.includes(mine);
    el('teams').replaceChildren(...state.teams.map(team => { const chip = document.createElement('span'); chip.textContent = `${team.name}: ${team.score}${team.connected ? '' : ' (away)'}`; return chip; }));
  };
  socket.onclose = () => { el<HTMLButtonElement>('buzzer').disabled = true; notice('Disconnected. Refresh to reconnect.'); };
  socket.onerror = () => notice('Could not connect. Check the room code and try again.');
}
const query = new URLSearchParams(location.search);
const hostCode = query.get('host')?.toUpperCase(); const hostToken = query.get('token');
if (hostCode && hostToken) { showRoom(hostCode, 'host'); connect(hostCode, 'host', new URLSearchParams({ role: 'host', token: hostToken })); }
el<HTMLFormElement>('join').onsubmit = event => {
  event.preventDefault(); const code = el<HTMLInputElement>('code').value.trim().toUpperCase(); const name = el<HTMLInputElement>('team').value.trim();
  if (!/^[A-Z2-9]{8}$/.test(code) || !name) return;
  showRoom(code, 'team'); notice('');
  const params = new URLSearchParams({ role: 'team', name });
  const reconnect = sessionStorage.getItem(`team:${code}:${name}`); if (reconnect) params.set('reconnect', reconnect);
  connect(code, 'team', params);
};
el<HTMLButtonElement>('create').onclick = async () => {
  const button = el<HTMLButtonElement>('create'); button.disabled = true; notice('');
  try { const res = await fetch('/api/rooms', { method: 'POST' }); if (!res.ok) throw new Error('Could not create room');
    const { hostUrl } = await res.json() as { hostUrl: string }; location.href = hostUrl;
  } catch { notice('Could not create a room. Try again.'); button.disabled = false; }
};
el<HTMLButtonElement>('copy').onclick = async () => { await navigator.clipboard.writeText(location.href); notice('Host link copied. Keep it private.'); };
el<HTMLButtonElement>('buzzer').onclick = () => { socket?.send(JSON.stringify({ type: 'buzz' })); el<HTMLButtonElement>('buzzer').disabled = true; };
