import type { ServerMessage, View } from '../src/protocol';

const node = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const button = node<HTMLButtonElement>('buzz');
const headline = node('headline');
const detail = node('detail');
const bottom = node('bottom');
const note = node('connection-note');
const query = new URLSearchParams(location.search);
const code = (query.get('code') ?? '').trim().toUpperCase();
const name = (query.get('name') ?? '').trim();
const tokenKey = `team:${code}:${name}`;
const idKey = `id:${code}:${name}`;
let socket: WebSocket | undefined;
let latest: View | undefined;
let teamId = sessionStorage.getItem(idKey);
let pendingBuzz = false;
let retryCount = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let stopped = false;
let terminalError = '';
let everWelcomed = false;

node('room-code').textContent = code ? code.replace(/(.{4})/, '$1 ') : 'ROOM';
node('team-name').textContent = name || 'Your team';

function message(text: string) { note.textContent = text; note.hidden = !text; }
function showWaiting(title: string, text: string, footer = 'Wait for the host to start.') {
  document.body.dataset.state = 'waiting';
  document.body.removeAttribute('data-lock-reason');
  headline.textContent = title;
  detail.textContent = text;
  button.textContent = 'BUZZ';
  button.disabled = true;
  bottom.textContent = footer;
}
function activeClue(state: View): string {
  const category = state.board.find(c => c.cells.some(cell => cell.id === state.selectedCellId));
  const cell = category?.cells.find(c => c.id === state.selectedCellId);
  return category && cell ? `${category.name} · ${cell.value.toLocaleString()} points` : 'Watch the big screen for the clue';
}
function render(state: View) {
  latest = state;
  const mine = state.teams.find(t => t.id === teamId);
  if (mine) {
    node('team-name').textContent = mine.name;
    node('score').textContent = `${mine.score.toLocaleString()} ${Math.abs(mine.score) === 1 ? 'point' : 'points'}`;
  }
  if (!mine || !state.hostConnected) {
    showWaiting(state.hostConnected ? 'Joining your team' : 'Wait for the host', state.hostConnected ? 'Please wait.' : 'Watch the big screen.');
    return;
  }
  if (state.phase === 'complete') {
    showWaiting('Game over', 'Final scores are on the host screen.', 'Thanks for playing.');
    return;
  }
  const first = state.buzzQueue[0] === teamId;
  const queued = state.buzzQueue.includes(teamId!);
  const out = state.lockedOut.includes(teamId!);
  if (queued || out) {
    document.body.dataset.state = 'locked';
    document.body.dataset.lockReason = out ? 'out' : 'buzzed';
    button.disabled = true;
    if (out) {
      headline.textContent = 'Wait for the next clue';
      detail.textContent = 'Your team is out for this question.';
      button.textContent = 'WAIT';
      bottom.textContent = activeClue(state);
    } else if (first) {
      headline.textContent = 'You buzzed first!';
      detail.textContent = 'Answer out loud.';
      button.textContent = "YOU'RE IN";
      const seconds = Math.max(0, Math.ceil(((state.buzzerDeadline ?? Date.now()) - Date.now()) / 1000));
      bottom.textContent = `Answer timer · 00:${String(seconds).padStart(2, '0')}`;
    } else {
      headline.textContent = 'You are in the queue';
      detail.textContent = 'Wait for your turn to answer.';
      button.textContent = 'IN QUEUE';
      bottom.textContent = activeClue(state);
    }
    return;
  }
  if (state.phase === 'buzz-open' || state.phase === 'buzzed') {
    document.body.dataset.state = 'ready';
    document.body.removeAttribute('data-lock-reason');
    headline.textContent = state.phase === 'buzzed' ? 'Join the buzz queue' : 'Buzzers are open!';
    detail.textContent = state.phase === 'buzzed' ? 'Tap to join the queue.' : 'Tap once when you know it.';
    button.textContent = pendingBuzz ? 'SENDING' : 'BUZZ!';
    button.disabled = pendingBuzz || socket?.readyState !== WebSocket.OPEN;
    bottom.textContent = activeClue(state);
    return;
  }
  showWaiting('Wait for the host', state.phase === 'question-showing' ? 'Look at the clue on the big screen.' : 'Watch the big screen.', state.phase === 'question-showing' ? 'Buzzers are closed for now.' : 'Buzzers are closed.');
}
function connect() {
  if (stopped) return;
  pendingBuzz = false;
  terminalError = '';
  showWaiting(retryCount ? 'Reconnecting' : 'Connecting to the game', 'Please wait.');
  const params = new URLSearchParams({ role: 'team', name });
  const token = sessionStorage.getItem(tokenKey);
  if (token) params.set('reconnect', token);
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${location.host}/api/rooms/${code}/ws?${params}`);
  socket = ws;
  ws.onopen = () => { everWelcomed = false; };
  ws.onmessage = event => {
    let data: ServerMessage;
    try { data = JSON.parse(event.data as string) as ServerMessage; } catch { return; }
    if (data.type === 'error') {
      pendingBuzz = false;
      if (!everWelcomed || ['auth', 'full', 'name', 'phase', 'expired'].includes(data.code)) {
        terminalError = data.message;
        stopped = true;
        clearTimeout(retryTimer);
        showWaiting('Could not join', data.message, '');
        message('Go back to join with a new name or code.');
        ws.close();
        return;
      }
      message(data.message);
      if (latest) render(latest);
      return;
    }
    if (data.type === 'welcome') {
      everWelcomed = true;
      if (data.role !== 'team' || !data.teamId || !data.reconnectToken) {
        message('Could not join this team. Return to the join page and try again.');
        stopped = true; ws.close(); return;
      }
      teamId = data.teamId;
      sessionStorage.setItem(idKey, data.teamId);
      sessionStorage.setItem(tokenKey, data.reconnectToken);
      retryCount = 0;
      message('');
    }
    if (data.type === 'welcome' || data.type === 'state') {
      if (pendingBuzz && data.state.buzzQueue.includes(teamId ?? '')) pendingBuzz = false;
      render(data.state);
    }
  };
  ws.onclose = () => {
    if (socket !== ws || stopped) return;
    if (!everWelcomed || terminalError) {
      stopped = true;
      showWaiting('Could not join', terminalError || 'Room unavailable. Check the code.', '');
      message('Go back to join with a new name or code.');
      return;
    }
    pendingBuzz = false;
    showWaiting('Connection lost', 'Trying to reconnect to your team.', 'Buzzing is paused.');
    message('Connection lost. Reconnecting…');
    retryTimer = setTimeout(connect, Math.min(1000 * 2 ** retryCount++, 10000));
  };
  ws.onerror = () => { /* close drives the retry and the visible connection status */ };
}
button.addEventListener('click', () => {
  if (button.disabled || !latest || !teamId || socket?.readyState !== WebSocket.OPEN) return;
  if (latest.phase !== 'buzz-open' && latest.phase !== 'buzzed') return;
  pendingBuzz = true;
  message('');
  render(latest);
  socket.send(JSON.stringify({ type: 'buzz' }));
});
window.addEventListener('pagehide', () => { stopped = true; clearTimeout(retryTimer); socket?.close(); });
window.addEventListener('pageshow', event => {
  if (event.persisted && !terminalError && /^[A-Z2-9]{8}$/.test(code) && name) {
    stopped = false;
    retryCount = 0;
    connect();
  }
});
setInterval(() => { if (latest?.phase === 'buzzed' && latest.buzzQueue[0] === teamId) render(latest); }, 250);
if (!/^[A-Z2-9]{8}$/.test(code) || !name || name.length > 30) {
  stopped = true;
  showWaiting('Missing game details', 'Check the room code and team name.');
  message('No game was joined.');
} else connect();
