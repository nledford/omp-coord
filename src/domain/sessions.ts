/** Sessions on the board: each registers under a letter (A, B, …) and leaves with everything it held. */
import { grantHolds } from "./agents.ts";
import { type AgentPolicy, type Board, emit } from "./model.ts";

const LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** Adds a session under the first free letter and returns the letter. Re-registering an id keeps its letter. */
export function registerSession(
  board: Board,
  s: { id: string; pid: number; cwd: string; socket: string; now: number },
): string {
  const existing = board.sessions.find(x => x.id === s.id);
  if (existing) return existing.label;
  const taken = new Set(board.sessions.map(x => x.label));
  const label = [...LABELS].find(l => !taken.has(l));
  if (!label) throw new Error(`${LABELS.length} sessions are already registered`);
  board.sessions.push({ id: s.id, label, pid: s.pid, cwd: s.cwd, socket: s.socket, startedAt: s.now });
  emit(board, s.now, "session_joined", s.id, { pid: s.pid, cwd: s.cwd });
  return label;
}

/** Removes a session that ended or died: its slots free, it leaves the line, messages to it are dropped. */
export function removeSession(board: Board, policy: AgentPolicy, sessionId: string, now: number): void {
  if (board.sessions.some(s => s.id === sessionId)) emit(board, now, "session_left", sessionId);
  board.sessions = board.sessions.filter(s => s.id !== sessionId);
  board.slots = board.slots.filter(s => s.sessionId !== sessionId);
  board.waitlist = board.waitlist.filter(t => t.sessionId !== sessionId);
  board.messages = board.messages.filter(m => m.toId !== sessionId);
  board.sent = board.sent.filter(m => m.sessionId !== sessionId);
  // Its fair-share history goes too; it would only grow, since a session id is never reused.
  board.served = board.served.filter(s => s.owner !== sessionId);
  grantHolds(board, policy, now);
}
