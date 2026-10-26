/** Reports computed from the event log: agents a session left running, and daily statistics. */
import type { BoardEvent } from "./model.ts";

export interface InterruptedSession {
  label: string | null;
  cwd: string | undefined;
  leftAt: number;
  agents: { id: string; type: string; startedAt: number }[];
}

/**
 * Sessions that left (exited, or were found dead) at or after `since` while some of their agents were in a run:
 * those runs started and never ended. Revive them with `write agent://<id>` from a session in the same folder.
 */
export function interrupted(events: BoardEvent[], since: number): InterruptedSession[] {
  const cwd = new Map<string, string>();
  const running = new Map<string, Map<string, { id: string; type: string; startedAt: number }>>();
  const result: InterruptedSession[] = [];
  for (const e of events) {
    if (e.sessionId === null) continue;
    const runs = running.get(e.sessionId) ?? new Map();
    running.set(e.sessionId, runs);
    if (e.type === "session_joined" && typeof e.data.cwd === "string") cwd.set(e.sessionId, e.data.cwd);
    if (e.type === "run_started")
      runs.set(String(e.data.agentId), { id: String(e.data.agentId), type: String(e.data.agentType), startedAt: e.at });
    if (e.type === "run_ended") runs.delete(String(e.data.agentId));
    if (e.type === "session_left") {
      if (e.at >= since && runs.size)
        result.push({ label: e.label, cwd: cwd.get(e.sessionId), leftAt: e.at, agents: [...runs.values()] });
      running.delete(e.sessionId);
    }
  }
  return result;
}

export interface QueueDay {
  started: number;
  avgWaitMs: number;
  maxWaitMs: number;
  ended: number;
  /** Ended with a nonzero exit code, a signal, or a timeout. */
  failed: number;
  timedOut: number;
}

export interface DayStats {
  /** Local date, YYYY-MM-DD. */
  day: string;
  refusals: number;
  holdsUsed: number;
  maxHoldWaitMs: number;
  /** Most agents running at once in each pool. */
  peakAgents: Record<string, number>;
  queues: Record<string, QueueDay>;
}

export function stats(events: BoardEvent[], since: number): { days: DayStats[] } {
  const days = new Map<string, DayStats & { waits: Record<string, number[]> }>();
  const dayOf = (at: number) => {
    const d = new Date(at);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    let s = days.get(key);
    if (!s) {
      s = { day: key, refusals: 0, holdsUsed: 0, maxHoldWaitMs: 0, peakAgents: {}, queues: {}, waits: {} };
      days.set(key, s);
    }
    return s;
  };
  const queueOf = (s: DayStats, q: string) =>
    (s.queues[q] ??= { started: 0, avgWaitMs: 0, maxWaitMs: 0, ended: 0, failed: 0, timedOut: 0 });

  for (const e of events) {
    if (e.at < since) continue;
    const s = dayOf(e.at);
    const n = (k: string) => (typeof e.data[k] === "number" ? (e.data[k] as number) : 0);
    if (e.type === "spawn_refused") s.refusals++;
    if (e.type === "hold_used") {
      s.holdsUsed++;
      s.maxHoldWaitMs = Math.max(s.maxHoldWaitMs, n("waitedMs"));
    }
    if (e.type === "run_started" && typeof e.data.pool === "string") {
      s.peakAgents[e.data.pool] = Math.max(s.peakAgents[e.data.pool] ?? 0, n("used"));
    }
    if (e.type === "job_started") {
      const q = String(e.data.queue);
      queueOf(s, q).started++;
      const waits = s.waits[q] ?? [];
      waits.push(n("waitedMs"));
      s.waits[q] = waits;
    }
    if (e.type === "job_ended") {
      const q = queueOf(s, String(e.data.queue));
      q.ended++;
      if (e.data.exitCode !== 0 || e.data.timedOut === true) q.failed++;
      if (e.data.timedOut === true) q.timedOut++;
    }
  }
  return {
    days: [...days.values()].map(({ waits, ...s }) => {
      for (const [q, w] of Object.entries(waits)) {
        const day = queueOf(s, q);
        day.avgWaitMs = Math.round(w.reduce((a, b) => a + b, 0) / w.length);
        day.maxWaitMs = Math.max(...w);
      }
      return s;
    }),
  };
}
