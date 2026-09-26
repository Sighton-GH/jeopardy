/** Create-game flow: upload a spreadsheet, validate it, create the room, load the board, hand off to the host view. */
import type { BoardInput, ServerMessage } from '../src/protocol';
import { BoardParseError, parseBoardFile } from '../src/parse_board';

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let board: BoardInput | null = null;

const setStatus = (text: string) => { el('status').textContent = text; };
function showIssues(issues: string[]) {
  const list = el('errors');
  list.replaceChildren(...issues.map(issue => {
    const item = document.createElement('li');
    item.textContent = issue;
    return item;
  }));
  list.hidden = issues.length === 0;
}

function renderPreview(parsed: BoardInput) {
  el('cats').replaceChildren(...parsed.categories.map(category => {
    const row = document.createElement('div');
    row.className = 'cat';
    const name = document.createElement('span');
    name.textContent = category.name;
    const meta = document.createElement('span');
    const doubles = category.cells.filter(cell => cell.dailyDouble).length;
    meta.textContent = `${category.cells.length} clues`;
    if (doubles > 0) {
      const dd = document.createElement('span');
      dd.className = 'dd';
      dd.textContent = ` · ${doubles} daily double${doubles > 1 ? 's' : ''}`;
      meta.append(dd);
    }
    row.append(name, meta);
    return row;
  }));
  el('preview').hidden = false;
  el('theme-label').textContent = parsed.theme === 'slxca-2026' ? 'SLxCA 2026 theme' : 'Sighton Jeopardy theme';
}

async function handleFile(file: File) {
  board = null;
  document.body.classList.remove('slxca-theme');
  document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.setAttribute('href', '/brand/sighton-logo.svg');
  setStatus('');
  showIssues([]);
  el('preview').hidden = true;
  setStatus('Reading your file…');
  try {
    const parsed = await parseBoardFile(file.name, new Uint8Array(await file.arrayBuffer()));
    board = parsed;
    document.body.classList.toggle('slxca-theme', parsed.theme === 'slxca-2026');
    document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.setAttribute('href', parsed.theme === 'slxca-2026' ? '/brand/slxca-26.webp' : '/brand/sighton-logo.svg');
    setStatus('');
    renderPreview(parsed);
  } catch (error) {
    setStatus('');
    if (error instanceof BoardParseError) showIssues(error.issues);
    else showIssues(['Could not read that file. Re-save it as .xlsx or .csv and try again.']);
  }
}

/** Open the host socket, send load_board, and resolve once the room echoes the loaded board. */
function loadBoard(hostUrl: string, parsed: BoardInput): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = new URL(hostUrl);
    const token = url.searchParams.get('token');
    const code = url.searchParams.get('host');
    if (!token || !code) { reject(new Error('The room link came back incomplete. Try again.')); return; }
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${location.host}/api/rooms/${code}/ws?${new URLSearchParams({ role: 'host', token })}`);
    const timer = setTimeout(() => { socket.close(); reject(new Error('The room is not responding. Try again.')); }, 10000);
    const finish = (error?: Error) => { clearTimeout(timer); socket.close(); if (error) reject(error); else resolve(); };
    socket.onmessage = event => {
      const msg = JSON.parse(event.data as string) as ServerMessage;
      if (msg.type === 'welcome') socket.send(JSON.stringify({ type: 'load_board', board: parsed }));
      else if (msg.type === 'state' && msg.state.board.length === parsed.categories.length) finish();
      else if (msg.type === 'error') finish(new Error(msg.message));
    };
    socket.onerror = () => finish(new Error('Could not connect to the room. Try again.'));
  });
}

async function createGame() {
  if (!board) return;
  const button = el<HTMLButtonElement>('create');
  button.disabled = true;
  showIssues([]);
  setStatus('Creating game…');
  try {
    const res = await fetch('/api/rooms', { method: 'POST' });
    if (!res.ok) throw new Error('Could not create a room. Try again.');
    const { hostUrl } = await res.json() as { hostUrl: string };
    setStatus('Loading your board…');
    await loadBoard(hostUrl, board);
    setStatus('Board loaded. Opening your host board…');
    setTimeout(() => { location.href = hostUrl; }, 300);
  } catch (error) {
    setStatus('');
    showIssues([error instanceof Error ? error.message : 'Something went wrong. Try again.']);
    button.disabled = false;
  }
}

const drop = el('drop');
const input = el<HTMLInputElement>('file');
el('choose').onclick = () => input.click();
input.onchange = () => { const file = input.files?.[0]; if (file) void handleFile(file); input.value = ''; };
drop.ondragover = event => { event.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = event => {
  event.preventDefault();
  drop.classList.remove('over');
  const file = event.dataTransfer?.files[0];
  if (file) void handleFile(file);
};
el('create').onclick = () => void createGame();
el('template').onclick = event => {
  event.preventDefault();
  const csv = [
    'round,cat,value,q,a,dd,theme',
    '1,Category One,200,Your first clue,The answer,no,',
    '1,Category One,400,Your second clue,The answer,no,',
    '1,Category Two,200,A clue in another category,The answer,yes,',
  ].join('\n');
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  link.download = 'jeopardy-board-template.csv';
  link.click();
  URL.revokeObjectURL(link.href);
};
