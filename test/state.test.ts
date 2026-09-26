import { describe, expect, it } from 'vitest';
import { addTeam, buzz, hostCommand, initialState, timeout, view, type GameState } from '../src/state';
const board = { categories: [{ id: 'c1', name: 'Science', cells: [{ id: 'q1', question: 'What is H2O?', answer: 'Water', value: 200, dailyDouble: false }] }] };
function setup(): GameState {
  const s = initialState(); addTeam(s, 't1', 'One'); addTeam(s, 't2', 'Two');
  hostCommand(s, { type: 'load_board', board }, 100);
  hostCommand(s, { type: 'pick_cell', cellId: 'q1' }, 100);
  hostCommand(s, { type: 'arm_buzzers' }, 100);
  return s;
}
describe('state machine', () => {
  it('limits teams and names', () => { const s = initialState(); addTeam(s, 'a', 'One'); expect(() => addTeam(s, 'b', 'one')).toThrow(); for (let i = 1; i < 10; i++) addTeam(s, `${i}`, `Team ${i}`); expect(() => addTeam(s, 'eleven', 'Eleven')).toThrow(); });
  it('does not disclose answer or unrevealed question to teams', () => { const s = setup(); expect(view(s, false).board[0]?.cells[0]).toMatchObject({ question: 'What is H2O?' }); expect(JSON.stringify(view(s, false))).not.toContain('Water'); expect(view(s, true).board[0]?.cells[0]).toMatchObject({ answer: 'Water' }); });
  it('queues buzzers, penalizes wrong, advances to next, and awards correct', () => {
    const s = setup(); buzz(s, 't1', 1000); buzz(s, 't2', 1001);
    expect(s.buzzQueue).toEqual(['t1', 't2']); expect(s.buzzerDeadline).toBe(16000);
    hostCommand(s, { type: 'wrong', teamId: 't1' }, 2000); expect(s.teams[0]?.score).toBe(-200); expect(s.buzzQueue).toEqual(['t2']); expect(s.buzzerDeadline).toBe(17000);
    expect(() => buzz(s, 't1', 2001)).toThrow(); hostCommand(s, { type: 'correct', teamId: 't2' }, 3000);
    expect(s.teams[1]?.score).toBe(200); expect(s.board[0]?.cells[0]?.revealed).toBe(true);
    hostCommand(s, { type: 'back_to_board' }, 3001); expect(s.phase).toBe('complete');
    expect(() => hostCommand(s, { type: 'pick_cell', cellId: 'q1' }, 3002)).toThrow();
  });
  it('times out active answerer without penalty and reopens buzzers', () => { const s = setup(); buzz(s, 't1', 100); expect(timeout(s, 15099)).toBe(false); expect(timeout(s, 15100)).toBe(true); expect(s.phase).toBe('buzz-open'); expect(s.teams[0]?.score).toBe(0); expect(s.lockedOut).toEqual(['t1']); });
  it('rejects stale adjudication after answerer changes', () => {
    const s = setup(); buzz(s, 't1', 100); buzz(s, 't2', 101);
    timeout(s, 15100);
    expect(s.buzzQueue[0]).toBe('t2');
    expect(() => hostCommand(s, { type: 'correct', teamId: 't1' }, 15101)).toThrow('Answerer changed');
    expect(() => hostCommand(s, { type: 'wrong', teamId: 't1' }, 15101)).toThrow('Answerer changed');
    expect(s.teams.map(t => t.score)).toEqual([0, 0]);
  });
  it('does not consume an unarmed cell and hides daily double until picked', () => {
    const s = initialState();
    hostCommand(s, { type: 'load_board', board: { categories: [{ id: 'c', name: 'Test', cells: [{ id: 'q', question: 'Q', answer: 'A', value: 200, dailyDouble: true }] }] } }, 0);
    expect(view(s, false).board[0]?.cells[0]?.dailyDouble).toBe(false);
    hostCommand(s, { type: 'pick_cell', cellId: 'q' }, 1);
    expect(view(s, false).board[0]?.cells[0]?.dailyDouble).toBe(true);
    hostCommand(s, { type: 'back_to_board' }, 2);
    expect(s.board[0]?.cells[0]?.revealed).toBe(false);
  });
  it('validates malformed board and score adjustments', () => { const s = initialState(); expect(() => hostCommand(s, { type: 'load_board', board: { categories: [] } }, 0)).toThrow(); addTeam(s, 't', 'Team'); hostCommand(s, { type: 'adjust_score', teamId: 't', delta: -300 }, 0); expect(s.teams[0]?.score).toBe(-300); expect(() => hostCommand(s, { type: 'adjust_score', teamId: 't', delta: 2.5 }, 0)).toThrow(); });
});

it('rejects adjudication that would overflow a safe integer score', () => {
  const s = initialState();
  hostCommand(s, { type: 'load_board', board: { categories: [{ id: 'c', name: 'C', cells: [{ id: 'q', question: 'Q', answer: 'A', value: 200, dailyDouble: false }] }] } }, 0);
  addTeam(s, 'a', 'Alpha');
  s.teams[0]!.score = Number.MAX_SAFE_INTEGER - 100;
  hostCommand(s, { type: 'pick_cell', cellId: 'q' }, 0);
  hostCommand(s, { type: 'arm_buzzers' }, 0);
  buzz(s, 'a', 0);
  expect(() => hostCommand(s, { type: 'correct', teamId: 'a' }, 1)).toThrow('safe range');
  expect(s.teams[0]!.score).toBe(Number.MAX_SAFE_INTEGER - 100);
  s.teams[0]!.score = Number.MIN_SAFE_INTEGER + 100;
  expect(() => hostCommand(s, { type: 'wrong', teamId: 'a' }, 1)).toThrow('safe range');
  expect(s.teams[0]!.score).toBe(Number.MIN_SAFE_INTEGER + 100);
});

describe('room theme', () => {
  it('keeps Sighton default and carries event theme in both public and host views', async () => {
    const { initialState, hostCommand, view } = await import('../src/state');
    const game = initialState();
    expect(view(game, false).theme).toBe('sighton');
    const board = { theme: 'slxca-2026' as const, categories: [{ id: 'c1', name: 'A', cells: [{ id: 'a1', question: 'Q', answer: 'A', value: 100, dailyDouble: false }] }] };
    hostCommand(game, { type: 'load_board', board }, Date.now());
    expect(view(game, false).theme).toBe('slxca-2026');
    expect(view(game, true).theme).toBe('slxca-2026');
    hostCommand(game, { type: 'load_board', board: { categories: board.categories } }, Date.now());
    expect(view(game, false).theme).toBe('sighton');
  });
});
