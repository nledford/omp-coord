/**
 * Pause and drain: while paused, no new agent that takes a slot is approved and no queued job starts, in any session.
 * Agents and jobs already running go on. Refused sessions keep their place in line; resuming hands out slots in order.
 */
import { grantHolds } from "./agents.ts";
import { type AgentPolicy, type Board, emit, labelOf } from "./model.ts";
import { type Queues, schedule } from "./queues.ts";

export function pause(board: Board, p: { by: string | null; reason: string; now: number }): void {
  board.pause = { by: p.by, reason: p.reason.trim() || "no reason given", since: p.now };
  emit(board, p.now, "paused", p.by, { reason: board.pause.reason });
}

export function resume(board: Board, policy: AgentPolicy, queues: Queues, r: { by: string | null; now: number }): void {
  if (!board.pause) return;
  emit(board, r.now, "resumed", r.by, { pausedMs: r.now - board.pause.since });
  board.pause = undefined;
  grantHolds(board, policy, r.now);
  schedule(board, queues, r.now);
}

/** "paused by session A: merging tools (since 14:02)" style text, without the time. */
export function pauseReason(board: Board): string | undefined {
  const p = board.pause;
  if (!p) return undefined;
  const who = p.by === null ? "from a terminal" : `by session ${labelOf(board, p.by) ?? "(ended)"}`;
  return `paused ${who}: ${p.reason}`;
}
