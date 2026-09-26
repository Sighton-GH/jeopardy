import type { BoardInput, Category, GameTheme, HostCommand, Phase, RoomSettings, Team, View } from './protocol';

export const DEFAULT_SETTINGS: RoomSettings = { maxPlayers: 10, answerSeconds: 15, autoReading: true, readingSecondsPerWord: 0.45 };
const settingsOf = (s: GameState) => s.settings ?? DEFAULT_SETTINGS;
const words = (text: string) => text.trim().split(/\s+/).length;
export const readingSeconds = (text: string, secondsPerWord: number) => Math.min(60, Math.max(5, Math.round(words(text) * secondsPerWord)));
export class GameError extends Error { constructor(public code: string, message: string) { super(message); } }
export interface GameState {
  theme: GameTheme; phase: Phase; teams: Team[]; board: Category[]; selectedCellId: string | null;
  buzzQueue: string[]; lockedOut: string[]; buzzerDeadline: number | null;
  hostConnected: boolean; version: number; settings: RoomSettings; readingDeadline: number | null; readingDuration: number | null;
}
export function initialState(): GameState { return { theme: 'sighton', phase: 'lobby', teams: [], board: [], selectedCellId: null, buzzQueue: [], lockedOut: [], buzzerDeadline: null, hostConnected: false, version: 0, settings: { ...DEFAULT_SETTINGS }, readingDeadline: null, readingDuration: null }; }
const fail = (code: string, message: string): never => { throw new GameError(code, message); };
export function selected(s: GameState) { return s.board.flatMap(c => c.cells).find(c => c.id === s.selectedCellId); }
export function view(s: GameState, host: boolean): View {
  return { ...s, settings: settingsOf(s), readingDeadline: s.readingDeadline ?? null, readingDuration: s.readingDuration ?? null, board: s.board.map(c => ({ id: c.id, name: c.name, cells: c.cells.map(cell => {
    const { question, answer, ...rest } = cell;
    const visible = s.selectedCellId === cell.id;
    return host ? { ...rest, question, answer } : { ...rest, dailyDouble: visible ? cell.dailyDouble : false, ...(visible ? { question } : {}) };
  }) })) };
}
export function validateBoard(input: BoardInput): Category[] {
  if (!input || !Array.isArray(input.categories) || input.categories.length < 1 || input.categories.length > 10) fail('board', 'Board needs 1-10 categories');
  const ids = new Set<string>();
  return input.categories.map(category => {
    if (!category || typeof category.id !== 'string' || !category.id.trim() || category.id.length > 80 || typeof category.name !== 'string' || !category.name.trim() || category.name.length > 100 || !Array.isArray(category.cells) || category.cells.length < 1 || category.cells.length > 10) fail('board', 'Invalid category');
    if (ids.has(category.id)) fail('board', 'Duplicate ID'); ids.add(category.id);
    return { id: category.id, name: category.name.trim(), cells: category.cells.map(cell => {
      if (!cell || typeof cell.id !== 'string' || !cell.id.trim() || cell.id.length > 80 || ids.has(cell.id) || typeof cell.question !== 'string' || !cell.question.trim() || cell.question.length > 1500 || typeof cell.answer !== 'string' || !cell.answer.trim() || cell.answer.length > 1000 || !Number.isSafeInteger(cell.value) || cell.value <= 0 || cell.value > 100000 || typeof cell.dailyDouble !== 'boolean') fail('board', 'Invalid cell');
      ids.add(cell.id); return { ...cell, revealed: false };
    }) };
  });
}
export function addTeam(s: GameState, id: string, name: string): void {
  name = name.trim();
  if (s.phase !== 'lobby' && s.phase !== 'board') fail('phase', 'Cannot add a team during a question');
  if (!name || name.length > 30) fail('name', 'Team name must be 1-30 characters');
  if (s.teams.length >= settingsOf(s).maxPlayers) fail('full', 'Room is full');
  if (s.teams.some(t => t.name.toLocaleLowerCase() === name.toLocaleLowerCase())) fail('name', 'Team name is taken');
  s.teams.push({ id, name, score: 0, connected: true }); s.version++;
}
export function buzz(s: GameState, teamId: string, now: number): void {
  if (s.phase !== 'buzz-open' && s.phase !== 'buzzed') fail('phase', 'Buzzers are not open');
  if (!s.teams.some(t => t.id === teamId && t.connected)) fail('team', 'Team is not connected');
  if (s.lockedOut.includes(teamId) || s.buzzQueue.includes(teamId)) fail('locked', 'Already buzzed this question');
  s.buzzQueue.push(teamId);
  if (s.phase === 'buzz-open') { s.phase = 'buzzed'; s.buzzerDeadline = now + settingsOf(s).answerSeconds * 1000; }
  s.version++;
}
function advance(s: GameState, now: number) {
  s.buzzQueue.shift();
  if (s.buzzQueue.length) { s.phase = 'buzzed'; s.buzzerDeadline = now + settingsOf(s).answerSeconds * 1000; }
  else { s.phase = 'buzz-open'; s.buzzerDeadline = null; }
}
export function readingTimeout(s: GameState, now: number): boolean {
  if (s.phase !== 'question-showing' || s.readingDeadline == null || now < s.readingDeadline) return false;
  s.phase = 'buzz-open'; s.readingDeadline = null; s.readingDuration = null; s.version++;
  return true;
}
export function timeout(s: GameState, now: number): boolean {
  if (s.phase !== 'buzzed' || s.buzzerDeadline === null || now < s.buzzerDeadline) return false;
  const first = s.buzzQueue[0]; if (first && !s.lockedOut.includes(first)) s.lockedOut.push(first);
  advance(s, now); s.version++; return true; // no automatic score penalty on timeout
}
export function hostCommand(s: GameState, command: HostCommand, now: number): void {
  switch (command.type) {
    case 'load_board':
      if (s.phase !== 'lobby' && s.phase !== 'board') fail('phase', 'Cannot replace board mid-question');
      if (command.board.theme !== undefined && command.board.theme !== 'sighton' && command.board.theme !== 'slxca-2026') fail('board', 'Invalid board theme');
      s.board = validateBoard(command.board);
      s.theme = command.board.theme === 'slxca-2026' ? 'slxca-2026' : 'sighton'; s.phase = 'board'; s.selectedCellId = null; s.buzzQueue = []; s.lockedOut = []; s.buzzerDeadline = null; s.readingDeadline = null; s.readingDuration = null; break;
    case 'pick_cell': {
      if (s.phase !== 'board') fail('phase', 'Return to board first');
      const cell = s.board.flatMap(c => c.cells).find(c => c.id === command.cellId);
      if (!cell || cell.revealed) throw new GameError('cell', 'Cell unavailable');
      s.selectedCellId = cell.id; s.phase = 'question-showing'; s.buzzQueue = []; s.lockedOut = []; s.buzzerDeadline = null;
      s.readingDuration = settingsOf(s).autoReading ? readingSeconds(cell.question, settingsOf(s).readingSecondsPerWord) : null;
      s.readingDeadline = s.readingDuration === null ? null : now + s.readingDuration * 1000; break;
    }
    case 'arm_buzzers':
      if (s.phase !== 'question-showing') fail('phase', 'Cannot arm buzzers');
      if (selected(s)?.revealed) fail('phase', 'Question is already resolved');
      s.phase = 'buzz-open'; s.buzzerDeadline = null; s.readingDeadline = null; s.readingDuration = null; break;
    case 'correct': {
      if (s.phase !== 'buzzed') fail('phase', 'No active answer');
      if (command.teamId !== s.buzzQueue[0]) fail('stale', 'Answerer changed. Check the current team.');
      const cell = selected(s), team = s.teams.find(t => t.id === command.teamId);
      if (!cell || !team) throw new GameError('state', 'Missing cell or team');
      if (!Number.isSafeInteger(team.score + cell.value)) fail('score', 'Score exceeds the safe range');
      team.score += cell.value; cell.revealed = true; s.phase = 'resolving'; s.buzzerDeadline = null; s.buzzQueue = []; break;
    }
    case 'wrong': {
      if (s.phase !== 'buzzed') fail('phase', 'No active answer');
      if (command.teamId !== s.buzzQueue[0]) fail('stale', 'Answerer changed. Check the current team.');
      const cell = selected(s), team = s.teams.find(t => t.id === command.teamId);
      if (!cell || !team) throw new GameError('state', 'Missing cell or team');
      if (!Number.isSafeInteger(team.score - cell.value)) fail('score', 'Score exceeds the safe range');
      team.score -= cell.value; s.lockedOut.push(team.id); advance(s, now); break;
    }
    case 'back_to_board':
      if (s.phase === 'lobby' || s.phase === 'complete') fail('phase', 'No active clue');
      if (s.selectedCellId && s.phase !== 'question-showing') { const cell = selected(s); if (cell) cell.revealed = true; }
      s.phase = s.board.length && s.board.every(category => category.cells.every(cell => cell.revealed)) ? 'complete' : 'board'; s.selectedCellId = null; s.buzzQueue = []; s.lockedOut = []; s.buzzerDeadline = null; s.readingDeadline = null; s.readingDuration = null; break;
    case 'end_game': {
      if (s.phase === 'complete' || s.phase === 'lobby') fail('phase', 'No game to end');
      s.phase = 'complete'; s.selectedCellId = null; s.buzzerDeadline = null; s.readingDeadline = null; s.readingDuration = null; s.buzzQueue = []; break;
    }
    case 'update_settings': {
      const { maxPlayers, answerSeconds, autoReading, readingSecondsPerWord } = command.settings ?? {} as RoomSettings;
      if (!Number.isInteger(maxPlayers) || maxPlayers < Math.max(1, s.teams.length) || maxPlayers > 10 ||
          !Number.isInteger(answerSeconds) || answerSeconds < 5 || answerSeconds > 120 ||
          typeof autoReading !== 'boolean' || typeof readingSecondsPerWord !== 'number' ||
          !Number.isFinite(readingSecondsPerWord) || readingSecondsPerWord < 0.2 || readingSecondsPerWord > 2)
        fail('settings', 'Invalid settings or max players below current teams');
      s.settings = { maxPlayers, answerSeconds, autoReading, readingSecondsPerWord };
      // An active reading countdown keeps its original deadline; new settings apply to the next clue.
      break;
    }
    case 'readmit_team': {
      const team = s.teams.find(t => t.id === command.teamId);
      if (!team || team.connected) fail('team', 'Choose a disconnected team to re-admit');
      break;
    }
    case 'adjust_score': {
      if (!Number.isSafeInteger(command.delta) || Math.abs(command.delta) > 100000) fail('score', 'Invalid adjustment');
      const team = s.teams.find(t => t.id === command.teamId);
      if (!team || !Number.isSafeInteger(team.score + command.delta)) throw new GameError('team', 'Invalid team or score');
      team.score += command.delta; break;
    }
    default: fail('message', 'Unknown host command');
  }
  s.version++;
}
