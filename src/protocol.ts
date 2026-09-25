/** Wire protocol v1. Every client message is JSON; invalid messages receive an error. */
export type Phase = 'lobby' | 'board' | 'question-showing' | 'buzz-open' | 'buzzed' | 'resolving';
export interface Cell { id: string; question: string; answer: string; value: number; dailyDouble: boolean; revealed: boolean }
export interface Category { id: string; name: string; cells: Cell[] }
export interface Team { id: string; name: string; score: number; connected: boolean }
export interface PublicCell extends Omit<Cell, 'answer' | 'question'> { question?: string; answer?: string }
export interface PublicCategory extends Omit<Category, 'cells'> { cells: PublicCell[] }
export interface View { phase: Phase; teams: Team[]; board: PublicCategory[]; selectedCellId: string | null; buzzQueue: string[]; lockedOut: string[]; buzzerDeadline: number | null; hostConnected: boolean; version: number }
export interface BoardInput { categories: Array<{ id: string; name: string; cells: Array<{ id: string; question: string; answer: string; value: number; dailyDouble: boolean }> }> }
export type HostCommand =
  | { type: 'load_board'; board: BoardInput }
  | { type: 'pick_cell'; cellId: string }
  | { type: 'arm_buzzers' }
  | { type: 'correct' }
  | { type: 'wrong' }
  | { type: 'back_to_board' }
  | { type: 'adjust_score'; teamId: string; delta: number };
export type ClientMessage = HostCommand | { type: 'buzz' } | { type: 'ping' };
export type ServerMessage =
  | { type: 'welcome'; role: 'host' | 'team'; teamId?: string; reconnectToken?: string; state: View }
  | { type: 'state'; state: View }
  | { type: 'error'; code: string; message: string }
  | { type: 'pong' };
