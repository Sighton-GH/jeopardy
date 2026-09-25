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
    hostCommand(s, { type: 'wrong' }, 2000); expect(s.teams[0]?.score).toBe(-200); expect(s.buzzQueue).toEqual(['t2']); expect(s.buzzerDeadline).toBe(17000);
    expect(() => buzz(s, 't1', 2001)).toThrow(); hostCommand(s, { type: 'correct' }, 3000);
    expect(s.teams[1]?.score).toBe(200); expect(s.board[0]?.cells[0]?.revealed).toBe(true);
    hostCommand(s, { type: 'back_to_board' }, 3001); expect(s.phase).toBe('board');
    expect(() => hostCommand(s, { type: 'pick_cell', cellId: 'q1' }, 3002)).toThrow();
  });
  it('times out active answerer without penalty and reopens buzzers', () => { const s = setup(); buzz(s, 't1', 100); expect(timeout(s, 15099)).toBe(false); expect(timeout(s, 15100)).toBe(true); expect(s.phase).toBe('buzz-open'); expect(s.teams[0]?.score).toBe(0); expect(s.lockedOut).toEqual(['t1']); });
  it('validates malformed board and score adjustments', () => { const s = initialState(); expect(() => hostCommand(s, { type: 'load_board', board: { categories: [] } }, 0)).toThrow(); addTeam(s, 't', 'Team'); hostCommand(s, { type: 'adjust_score', teamId: 't', delta: -300 }, 0); expect(s.teams[0]?.score).toBe(-300); expect(() => hostCommand(s, { type: 'adjust_score', teamId: 't', delta: 2.5 }, 0)).toThrow(); });
});
