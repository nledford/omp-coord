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
 *
 * An agent revived since, from a session in the same folder, is no longer listed, and neither are its nested
 * helpers (they aren't restarted; reviving the parent covers them); a session with nothing left is left out. A
 * revival is a run that started without a spawn approval (`revived` in the event) by an id that session hadn't run
 * before: a new agent that reuses the name was spawned, so it doesn't hide the old one. A session whose folder is
 * unknown (its join event pruned) never hides anything.
 */
export function interrupted(events: BoardEvent[], since: number): InterruptedSession[] {
  const cwd = new Map<string, string>();
  const running = new Map<string, Map<string, { id: string; type: string; startedAt: number }>>();
  const seen = new Map<string, Set<string>>();
  // The latest revival per folder and agent id.
  const revivedAt = new Map<string, number>();
  const result: InterruptedSession[] = [];
  for (const e of events) {
    if (e.sessionId === null) continue;
    const runs = running.get(e.sessionId) ?? new Map();
    running.set(e.sessionId, runs);
    if (e.type === "session_joined" && typeof e.data.cwd === "string") cwd.set(e.sessionId, e.data.cwd);
    if (e.type === "run_started") {
      const id = String(e.data.agentId);
      runs.set(id, { id, type: String(e.data.agentType), startedAt: e.at });
      const own = seen.get(e.sessionId) ?? new Set<string>();
      seen.set(e.sessionId, own);
      const folder = cwd.get(e.sessionId);
      if (folder !== undefined && e.data.revived === true && !own.has(id)) revivedAt.set(`${folder}\u0000${id}`, e.at);
      own.add(id);
    }
    if (e.type === "run_ended") runs.delete(String(e.data.agentId));
    if (e.type === "session_left") {
      if (e.at >= since && runs.size)
        result.push({ label: e.label, cwd: cwd.get(e.sessionId), leftAt: e.at, agents: [...runs.values()] });
      running.delete(e.sessionId);
    }
  }
  const revivedSince = (folder: string | undefined, id: string, leftAt: number): boolean =>
    folder !== undefined && (revivedAt.get(`${folder}\u0000${id}`) ?? 0) > leftAt;
  return result
    .map(s => ({
      ...s,
      agents: s.agents.filter(a => {
        const top = a.id.split(".")[0] ?? a.id;
        return !revivedSince(s.cwd, a.id, s.leftAt) && !revivedSince(s.cwd, top, s.leftAt);
      }),
    }))
    .filter(s => s.agents.length > 0);
}

export interface QueueDay {
  started: number;
  avgWaitMs: number;
  maxWaitMs: number;
  ended: number;
  /** Ended with a nonzero exit code, a signal, or a timeout. */
  failed: number;
  timedOut: number;
  /** Present when any failed job of the day carried `--meta` tags. */
  ofFailures?: { repeats: number; intended: number };
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

/**
 * Per queue and day: failures that repeat an unchanged failure (a failed job with `meta.fp` equal to that of an
 * earlier failed job of the same queue in the window, with no successful job of that `fp` in between) and failures
 * marked `meta.intent == "failfirst"`.
 */
export function stats(events: BoardEvent[], since: number): { days: DayStats[] } {
  // Per queue: fingerprints whose latest outcome was a failure.
  const failing = new Map<string, Set<string>>();
  // Tags seen at queue time, for a job_ended that lost them (an older omp-coord still running rewrote the job without them).
  const queuedMeta = new Map<string, unknown>();
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
    // Tags are indexed from the whole log, so a job queued before the window still explains its end inside it.
    if (e.type === "job_queued") {
      if (e.data.meta === undefined) queuedMeta.delete(String(e.data.job));
      else queuedMeta.set(String(e.data.job), e.data.meta);
    }
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
      const failed = e.data.exitCode !== 0 || e.data.timedOut === true;
      if (failed) q.failed++;
      if (e.data.timedOut === true) q.timedOut++;
      const jobId = String(e.data.job);
      const meta = e.data.meta ?? queuedMeta.get(jobId);
      queuedMeta.delete(jobId);
      if (typeof meta === "object" && meta !== null) {
        const tags = meta as Record<string, unknown>;
        const fp = typeof tags.fp === "string" ? tags.fp : undefined;
        const queueName = String(e.data.queue);
        const set = failing.get(queueName) ?? new Set<string>();
        failing.set(queueName, set);
        if (failed) {
          const counts = q.ofFailures ?? { repeats: 0, intended: 0 };
          q.ofFailures = counts;
          if (fp !== undefined) {
            if (set.has(fp)) counts.repeats++;
            set.add(fp);
          }
          if (tags.intent === "failfirst") counts.intended++;
        } else if (fp !== undefined) {
          set.delete(fp);
        }
      }
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
