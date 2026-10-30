/**
 * Runtime notices: an agent that keeps running past `agents.runtimeNoticeMinutes` is told once to stop at a clean
 * point, and its session is told once; the same again at twice the limit, then nothing more. Nothing is stopped.
 */
import { type AgentPolicy, type Board, emit } from "./model.ts";

const MINUTE = 60_000;

export interface OvertimeNotice {
  agentId: string;
  agentType: string;
  pool: string | null;
  /** Whole minutes the run has lasted. */
  minutes: number;
  /** The limit this notice marks: the configured minutes, or twice that. */
  noticeAtMinutes: number;
  /** 1 at the limit, 2 at twice the limit. */
  notice: 1 | 2;
}

/** What one process has sent, by run (session, agent, slot start): the highest notice number. */
export type SentNotices = Map<string, 1 | 2>;

export interface OvertimeResult {
  due: OvertimeNotice[];
  /** Runs of the session that still hold a slot: what the sender's memory keeps. */
  live: Set<string>;
  /** What to record in the sender's memory once the board change is saved, not before: a failed save sends nothing. */
  sent: [key: string, notice: 1 | 2][];
}

/**
 * Notices now due for the running agents of one session (the session that owns them delivers them). Each is marked
 * on the agent's slot, so a later tick or another process of the same version never sends it again. The sender also
 * keeps `sent` in memory (read here, written by the caller after the save): an older omp-coord that shares the board
 * rewrites slots without the mark, and the notice must not go out again every tick; the mark is put back. An agent
 * already past twice the limit when first seen gets the second notice only. Time counts from the slot's `since`: the
 * approval of its spawn, or the start of a revived run, which starts a new count.
 */
export function dueOvertimeNotices(
  board: Board,
  policy: AgentPolicy,
  sessionId: string,
  now: number,
  sent: ReadonlyMap<string, 1 | 2>,
): OvertimeResult {
  const due: OvertimeNotice[] = [];
  const live = new Set<string>();
  const marks: OvertimeResult["sent"] = [];
  const limit = policy.runtimeNoticeMs;
  if (limit === undefined) return { due, live, sent: marks };
  for (const slot of board.slots) {
    if (slot.sessionId !== sessionId || slot.state !== "running" || slot.agentId === undefined) continue;
    const key = `${slot.sessionId}\0${slot.agentId}\0${slot.since}`;
    live.add(key);
    const ran = now - slot.since;
    const notice = ran >= 2 * limit ? 2 : ran >= limit ? 1 : 0;
    const done = Math.max(slot.overtimeNotices ?? 0, sent.get(key) ?? 0);
    if (done > 0) slot.overtimeNotices = done as 1 | 2;
    if (notice === 0 || done >= notice) continue;
    slot.overtimeNotices = notice;
    marks.push([key, notice]);
    const found: OvertimeNotice = {
      agentId: slot.agentId,
      agentType: slot.agentType,
      pool: slot.pool,
      minutes: Math.floor(ran / MINUTE),
      noticeAtMinutes: Math.round((limit * notice) / MINUTE),
      notice,
    };
    due.push(found);
    emit(board, now, "run_overtime", sessionId, {
      agentId: found.agentId,
      agentType: found.agentType,
      pool: found.pool,
      minutes: found.minutes,
      notice,
    });
  }
  return { due, live, sent: marks };
}
