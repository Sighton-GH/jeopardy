import type { HostCommand, PublicCell, RoomSettings, ServerMessage, Team, View } from '../src/protocol';
import leaderMedalUrl from './brand/leader-medal.svg?url';

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ADJUST_STEPS = [100, 500];

let socket: WebSocket | undefined;
let state: View | undefined;
let welcomed = false;
let retries = 0;
let reconnectTimer: number | undefined;

const query = new URLSearchParams(location.search);
let code = (query.get('host') ?? query.get('code') ?? '').trim().toUpperCase();
let token = (query.get('token') ?? '').trim();
if (!code || !token) {
  const saved = sessionStorage.getItem('host:last');
  if (saved) {
    try {
      const parsed = JSON.parse(saved) as { code?: unknown; token?: unknown };
      if (!code && typeof parsed.code === 'string') code = parsed.code;
      if (!token && typeof parsed.token === 'string') token = parsed.token;
    } catch { /* ignore corrupt storage */ }
  }
}

function send(command: HostCommand) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(command));
}

function showGate(error: string) {
  el('gate').hidden = false;
  el<HTMLInputElement>('gate-code').value = code;
  el<HTMLInputElement>('gate-token').value = token;
  el('gate-err').textContent = error;
}

function connect() {
  if (!/^[0-9]{6}$/.test(code) || !token) { showGate(''); return; }
  el('gate').hidden = true;
  window.clearTimeout(reconnectTimer);
  socket?.close();
  welcomed = false;
  el('notice').textContent = 'Connecting…';
  const roomCode = el('room-code');
  const joinLabel = document.createElement('span');
  joinLabel.className = 'join-label';
  joinLabel.textContent = `Join at ${location.host}`;
  const codeValue = document.createElement('strong');
  codeValue.className = 'join-code';
  codeValue.textContent = `${code.slice(0, 3)} ${code.slice(3)}`;
  roomCode.replaceChildren(joinLabel, codeValue);
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const params = new URLSearchParams({ role: 'host', token });
  socket = new WebSocket(`${protocol}//${location.host}/api/rooms/${code}/ws?${params}`);
  socket.onmessage = event => {
    const msg = JSON.parse(event.data as string) as ServerMessage;
    if (msg.type === 'pong') return;
    if (msg.type === 'error') { el('notice').textContent = msg.message; return; }
    welcomed = true;
    retries = 0;

    el('notice').textContent = '';
    state = msg.state;
    document.body.classList.toggle('slxca-theme', state.theme === 'slxca-2026');
    document.title = state.theme === 'slxca-2026' ? 'SLxCA Jeopardy - Host' : 'Sighton Jeopardy - Host';
    document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.setAttribute('href', state.theme === 'slxca-2026' ? '/brand/slxca-26.webp' : '/brand/sighton-logo.svg');
    render();
  };
  socket.onclose = event => {
    el('notice').textContent = 'Connection lost. Reconnecting…';
    if (event.reason === 'Host reconnected') { showGate('This host link is open on another screen.'); return; }
    if (!welcomed) { showGate('Could not open this room. Check the code and host link.'); return; }
    retries += 1;
    reconnectTimer = window.setTimeout(connect, Math.min(1000 * 2 ** (retries - 1), 8000));
  };
}

el<HTMLFormElement>('gate-form').onsubmit = event => {
  event.preventDefault();
  code = el<HTMLInputElement>('gate-code').value.trim().toUpperCase();
  token = el<HTMLInputElement>('gate-token').value.trim();
  if (!/^[0-9]{6}$/.test(code) || !token) { el('gate-err').textContent = 'Enter the 6-digit room code and host token.'; return; }
  history.replaceState(null, '', location.pathname);
  sessionStorage.setItem('host:last', JSON.stringify({ code, token }));
  retries = 0;
  connect();
};

if (code && token) {
  history.replaceState(null, '', location.pathname);
  sessionStorage.setItem('host:last', JSON.stringify({ code, token }));
  connect();
} else showGate('');

setInterval(() => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' })); }, 25000);

const teamName = (id: string | undefined) => state?.teams.find(t => t.id === id)?.name ?? '';

function selectedCell(): { cell: PublicCell; category: string } | undefined {
  if (!state?.selectedCellId) return undefined;
  for (const category of state.board)
    for (const cell of category.cells)
      if (cell.id === state.selectedCellId) return { cell, category: category.name };
  return undefined;
}

function renderBoard() {
  const board = el('board');
  board.replaceChildren();
  if (state?.phase === 'complete') {
    board.classList.add('placeholder', 'complete-board');
    document.body.classList.add('game-complete');
    const wrap = document.createElement('div');
    wrap.className = 'final-standings';
    const heading = document.createElement('h1'); heading.textContent = '🏆 Final standings'; wrap.append(heading);
    const winner = [...state.teams].sort((a,b) => b.score - a.score)[0];
    if (winner) { const champ = document.createElement('h2'); champ.className = 'winner'; champ.textContent = `Congratulations, ${winner.name}!`; wrap.append(champ); }
    for (const [index, team] of [...state.teams].sort((a, b) => b.score - a.score).entries()) {
      const row = document.createElement('div'); row.className = 'final-team';
      const name = document.createElement('span'); name.textContent = `${index + 1}. ${team.name}`;
      const score = document.createElement('strong'); score.textContent = team.score.toLocaleString();
      row.append(name, score); wrap.append(row);
    }
    const again = document.createElement('a'); again.href = '/'; again.className = 'new-game'; again.textContent = 'Create a new game'; wrap.append(again);
    board.replaceChildren(wrap);
    el('clues-left').textContent = 'Final standings';
    return;
  }
  board.classList.remove('complete-board');
  document.body.classList.remove('game-complete');
  if (!state || state.board.length === 0) {
    board.classList.add('placeholder');
    const hold = document.createElement('div');
    hold.className = 'hold';
    hold.textContent = state ? 'Waiting for the board' : 'Connecting';
    board.append(hold);
    el('clues-left').textContent = '';
    return;
  }
  board.classList.remove('placeholder');
  const categories = state.board;
  const rows = Math.max(...categories.map(c => c.cells.length));
  board.style.setProperty('--board-cols', String(categories.length));
  board.style.setProperty('--board-rows', String(rows + 1));
  for (const category of categories) {
    const tile = document.createElement('div');
    tile.className = 'tile category';
    tile.textContent = category.name;
    board.append(tile);
  }
  let remaining = 0;
  for (let row = 0; row < rows; row++) {
    for (const category of categories) {
      const cell = category.cells[row];
      if (!cell) { const gap = document.createElement('div'); gap.className = 'tile empty'; board.append(gap); continue; }
      if (!cell.revealed) remaining += 1;
      const tile = document.createElement('button');
      tile.className = cell.revealed ? 'tile empty' : 'tile value';
      // Keep daily doubles hidden until the cell is picked.
      tile.textContent = cell.revealed ? '' : `$${cell.value.toLocaleString()}`;
      tile.setAttribute('aria-label', `${category.name} for $${cell.value.toLocaleString()}`);
      tile.disabled = cell.revealed || state.phase !== 'board';
      tile.onclick = () => send({ type: 'pick_cell', cellId: cell.id });
      board.append(tile);
    }
  }
  el('clues-left').textContent = `${remaining} clue${remaining === 1 ? '' : 's'} remaining`;
}

function renderReveal() {
  const picked = selectedCell();
  el('reveal').hidden = !picked;
  if (!picked || !state) return;
  el('reveal-kicker').textContent = `${picked.category} · ${picked.cell.value.toLocaleString()}`;
  el('reveal-clue').textContent = picked.cell.question ?? '';
  const answer = el('reveal-answer');
  answer.hidden = state.phase !== 'resolving' || !picked.cell.answer;
  el('reveal-answer-text').textContent = picked.cell.answer ?? '';
  const buzzed = el('reveal-buzzed');
  const answering = state.buzzQueue[0];
  if (state.phase === 'buzzed' && answering) {
    buzzed.hidden = false;
    buzzed.replaceChildren('BUZZED IN  ');
    const name = document.createElement('b');
    name.textContent = teamName(answering).toUpperCase();
    buzzed.append(name);
  } else if (state.phase === 'buzz-open') {
    buzzed.hidden = false;
    buzzed.textContent = 'BUZZERS OPEN';
  } else if (state.phase === 'resolving') {
    buzzed.hidden = false;
    buzzed.textContent = picked.cell.answer ? `ANSWER: ${picked.cell.answer.toUpperCase()}` : 'RESOLVED';
  } else buzzed.hidden = true;
}

function fitClue() {
  const slide = el('reveal');
  if (slide.hidden) return;
  const clue = el('reveal-clue');
  const slideHeight = slide.clientHeight;
  const reserved = el('reveal-buzzed').hidden ? 140 : 200;
  const answerReserved = el('reveal-answer').hidden ? 0 : 35;
  clue.style.maxHeight = `${Math.max(80, slideHeight - reserved - answerReserved)}px`;
  clue.style.overflow = 'hidden';
  const maxSize = Math.min(57, Math.max(24, slide.clientWidth * (matchMedia('(max-width: 700px)').matches ? 0.063 : 0.05)));
  let low = 12;
  let high = maxSize;
  for (let i = 0; i < 9; i++) {
    const mid = (low + high) / 2;
    clue.style.fontSize = `${mid}px`;
    if (clue.scrollHeight > clue.clientHeight + 1 || clue.scrollWidth > clue.clientWidth + 1) high = mid;
    else low = mid;
  }
  clue.style.fontSize = `${low}px`;
  if (clue.scrollHeight > clue.clientHeight + 1) clue.style.overflowY = 'auto';
}

function renderScores() {
  const scores = el('scores');
  scores.replaceChildren();
  if (!state || state.teams.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'queue';
    empty.textContent = 'No teams yet';
    scores.append(empty);
    return;
  }
  const ranked = [...state.teams].sort((a, b) => b.score - a.score);
  ranked.forEach((team: Team, index: number) => {
    const row = document.createElement('div');
    row.className = 'score';
    if (index === 0) row.classList.add('lead');
    if (!team.connected) row.classList.add('disconnected');
    const name = document.createElement('span');
    if (index === 0) {
      const medal = document.createElement('img');
      medal.className = 'leader-medal';
      medal.src = leaderMedalUrl;
      medal.alt = 'Leading team';
      name.append(medal);
    }
    name.append(document.createTextNode(team.name));
    const adjust = document.createElement('span');
    adjust.className = 'adj';
    if (!team.connected) {
      const restore = document.createElement('button');
      restore.type = 'button';
      restore.className = 'readmit';
      restore.textContent = 'Re-admit';
      restore.setAttribute('aria-label', `Re-admit ${team.name}`);
      restore.onclick = () => {
        if (window.confirm(`Let a new device take over ${team.name}? The old reconnect link will stop working.`)) send({ type: 'readmit_team', teamId: team.id });
      };
      row.append(restore);
    }
    for (const step of ADJUST_STEPS) for (const delta of [-step, step]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = delta > 0 ? `+${step}` : `-${step}`;
      button.setAttribute('aria-label', `${delta > 0 ? 'Add' : 'Subtract'} ${step} ${delta > 0 ? 'to' : 'from'} ${team.name}`);
      button.onclick = () => send({ type: 'adjust_score', teamId: team.id, delta });
      adjust.append(button);
    }
    const score = document.createElement('strong');
    score.textContent = team.score.toLocaleString();
    row.append(name, adjust, score);
    scores.append(row);
  });
}

function renderBuzzers() {
  if (!state) return;
  const answering = state.buzzQueue[0];
  const hint = el('status-hint'), main = el('status-main'), sub = el('status-sub');
  switch (state.phase) {
    case 'lobby': hint.textContent = 'SETUP'; main.textContent = 'Lobby'; sub.textContent = 'Waiting for the board'; break;
    case 'board': hint.textContent = 'BOARD'; main.textContent = 'Choosing'; sub.textContent = 'Pick the next clue'; break;
    case 'question-showing': hint.textContent = 'CLUE'; main.textContent = 'Reading'; sub.textContent = 'Arm buzzers when ready'; break;
    case 'buzz-open': hint.textContent = 'OPEN'; main.textContent = 'Buzzers open'; sub.textContent = 'Waiting for a buzz'; break;
    case 'buzzed': hint.textContent = 'BUZZED IN'; main.textContent = teamName(answering) || '-'; sub.textContent = 'Answering now'; break;
    case 'complete': hint.textContent = 'FINISHED'; main.textContent = 'Game over'; sub.textContent = 'Final standings'; break;
    case 'resolving': hint.textContent = 'RESOLVED'; main.textContent = 'Clue done'; sub.textContent = 'Back to board'; break;
  }
  const queue = el('queue');
  queue.replaceChildren();
  const waiting = state.buzzQueue.slice(1).map(teamName).filter(Boolean);
  if (waiting.length) {
    const line = document.createElement('div');
    line.replaceChildren('Up next: ');
    const names = document.createElement('b');
    names.textContent = waiting.join(', ');
    line.append(names);
    queue.append(line);
  }
  const locked = state.lockedOut.map(teamName).filter(Boolean);
  if (locked.length) {
    const line = document.createElement('div');
    line.className = 'lock';
    line.textContent = `Locked out: ${locked.join(', ')}`;
    queue.append(line);
  }
}

function renderControls() {
  const phase = state?.phase;
  const visible = phase === 'question-showing' || phase === 'buzz-open' || phase === 'buzzed' || phase === 'resolving';
  el('slide-controls').hidden = !(phase === 'question-showing' || phase === 'buzzed' || phase === 'resolving');
  const actions: Array<[string, boolean]> = [
    ['cmd-arm', phase === 'question-showing'],
    ['cmd-correct', phase === 'buzzed'],
    ['cmd-wrong', phase === 'buzzed'],
    ['cmd-resolved-back', phase === 'resolving'],
  ];
  el<HTMLButtonElement>('cmd-back').disabled = !visible;
  for (const [id, show] of actions) {
    const button = el<HTMLButtonElement>(id);
    button.hidden = !show;
    button.disabled = !show;
  }
}

el<HTMLButtonElement>('cmd-arm').onclick = () => send({ type: 'arm_buzzers' });
el<HTMLButtonElement>('cmd-correct').onclick = () => { const teamId = state?.buzzQueue[0]; if (teamId) send({ type: 'correct', teamId }); };
el<HTMLButtonElement>('cmd-wrong').onclick = () => { const teamId = state?.buzzQueue[0]; if (teamId) send({ type: 'wrong', teamId }); };
el<HTMLButtonElement>('cmd-back').onclick = () => send({ type: 'back_to_board' });
el<HTMLButtonElement>('cmd-resolved-back').onclick = () => send({ type: 'back_to_board' });

const settingsDialog = el<HTMLDialogElement>('settings-dialog');
el<HTMLButtonElement>('settings-open').onclick = () => {
  if (!state) return;
  el<HTMLInputElement>('set-max').value = String(state.settings.maxPlayers);
  el<HTMLInputElement>('set-max').min = String(Math.max(1, state.teams.length));
  el<HTMLInputElement>('set-answer').value = String(state.settings.answerSeconds);
  el<HTMLInputElement>('set-auto').checked = state.settings.autoReading;
  el<HTMLInputElement>('set-reading').value = String(state.settings.readingSecondsPerWord);
  settingsDialog.showModal();
  el<HTMLButtonElement>('settings-open').setAttribute('aria-expanded', 'true');
};
settingsDialog.onclose = () => el<HTMLButtonElement>('settings-open').setAttribute('aria-expanded', 'false');
el<HTMLButtonElement>('settings-close').onclick = () => settingsDialog.close();
el<HTMLFormElement>('settings-form').onsubmit = event => {
  event.preventDefault();
  const settings: RoomSettings = {
    maxPlayers: Number(el<HTMLInputElement>('set-max').value),
    answerSeconds: Number(el<HTMLInputElement>('set-answer').value),
    autoReading: el<HTMLInputElement>('set-auto').checked,
    readingSecondsPerWord: Number(el<HTMLInputElement>('set-reading').value),
  };
  send({ type: 'update_settings', settings });
  settingsDialog.close();
};
el<HTMLButtonElement>('end-game').onclick = () => {
  if (!state || state.phase === 'complete' || state.phase === 'lobby') return;
  if (window.confirm('End this game for everyone and show final standings? This cannot be undone.')) {
    send({ type: 'end_game' }); settingsDialog.close();
  }
};
function tick() {
  const deadline = state?.buzzerDeadline;
  const show = typeof deadline === 'number';
  const text = show ? `00:${String(Math.max(0, Math.ceil(((deadline as number) - Date.now()) / 1000))).padStart(2, '0')}` : '';
  const reading = state?.phase === 'question-showing' && state.readingDeadline != null && state.readingDuration != null;
  const bar = el('reading-bar'); bar.hidden = !reading;
  if (reading && state?.readingDeadline && state.readingDuration) {
    const remaining = Math.max(0, state.readingDeadline - Date.now());
    el('reading-fill').style.width = `${Math.min(100, 100 * remaining / (state.readingDuration * 1000))}%`;
    bar.setAttribute('aria-valuenow', String(Math.round(100 * remaining / (state.readingDuration * 1000))));
  }
  for (const id of ['reveal-clock', 'status-clock']) {
    const clock = el(id);
    clock.hidden = !show;
    if (show) clock.textContent = text;
  }
}

function render() {
  renderBoard();
  renderReveal();
  renderScores();
  renderBuzzers();
  renderControls();
  requestAnimationFrame(fitClue);
  tick();
}

new ResizeObserver(() => requestAnimationFrame(fitClue)).observe(el('reveal'));
setInterval(tick, 200);
render();
