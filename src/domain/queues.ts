/**
 * Build and test queues: each queue runs at most `slots` jobs at once across every process of the scope. Jobs wait in lanes (earlier lanes
 * first); within a lane the queue's order decides who goes next:
 *
 * - `fifo`: oldest first. Priority is ignored.
 * - `fair-share`: owners (omp sessions, or "outside omp") take turns: the owner served longest ago goes next. Within
 *   one owner, higher priority first. Priority never lets one session jump another.
 * - `priority`: higher priority first across everyone, oldest first on ties.
 *
 * With `agingMs`, every `agingMs` of waiting adds 1 to a job's priority, so a low-priority job cannot wait forever
 * behind others in its lane. Lanes are strict: an earlier lane always goes first.
 * Pure transitions over the shared `Board` (`model.ts`).
 */
import { currentLoad, type LoadLimit, limitUnderLoad } from "./limits.ts";
import { type Board, type Job, emit } from "./model.ts";

/** Priorities run from -MAX_PRIORITY to MAX_PRIORITY. */
export const MAX_PRIORITY = 1_000_000;

export interface QueuePolicy {
  slots: number;
  order: "fifo" | "fair-share" | "priority";
  /** Lane names, first served first. The last one is the default. */
  lanes: string[];
  agingMs: number | null;
  /** A job whose key matches a waiting job: refuse it, or let it replace the waiting one in its place. */
  onDuplicate: "refuse" | "supersede";
  /** Longest a job's command may run before it is stopped, or null for no limit. */
  timeoutMs: number | null;
  /** Fewer slots while the machine is under load. */
  loadSlots: LoadLimit[];
}

/** A queue's slots now: lowered under load, 0 while paused. */
export function slotsOf(board: Board, policy: QueuePolicy, now: number): number {
  if (board.pause) return 0;
  return limitUnderLoad(policy.slots, policy.loadSlots, currentLoad(board, now));
}

export type Queues = Record<string, QueuePolicy>;

export interface JobRequest {
  id: string;
  queue: string;
  owner: string | null;
  lane?: string;
  priority: number;
  key?: string;
  command: string;
  socket: string;
  pid: number;
  now: number;
}

export type EnqueueResult = { ok: true } | { ok: false; reason: string };

/** Puts a job in line (or starts it at once when a slot is free). */
export function enqueueJob(board: Board, queues: Queues, req: JobRequest): EnqueueResult {
  const policy = Object.hasOwn(queues, req.queue) ? queues[req.queue] : undefined;
  if (!policy) return refuse(board, req, `no queue "${req.queue}"; queues: ${Object.keys(queues).join(", ") || "none"}`);
  const lane = req.lane ?? policy.lanes.at(-1) ?? "normal";
  if (!policy.lanes.includes(lane)) return refuse(board, req, `no lane "${lane}" in queue ${req.queue}; lanes: ${policy.lanes.join(", ")}`);

  let since = req.now;
  if (req.key !== undefined) {
    const same = board.jobs.filter(j => j.queue === req.queue && j.key === req.key && j.state !== "superseded");
    if (same.some(j => j.state === "running")) return refuse(board, req, `already running: ${req.key}; wait for it`);
    const waiting = same.find(j => j.state === "waiting");
    if (waiting && policy.onDuplicate === "refuse") return refuse(board, req, `already in line: ${req.key}; not queuing it twice`);
    if (waiting) {
      waiting.state = "superseded";
      since = waiting.since;
      emit(board, req.now, "job_superseded", waiting.owner, { job: waiting.id, queue: req.queue, by: req.id });
    }
  }

  board.jobs.push({
    id: req.id,
    queue: req.queue,
    owner: req.owner,
    lane,
    priority: req.priority,
    key: req.key,
    command: req.command,
    socket: req.socket,
    pid: req.pid,
    state: "waiting",
    since,
    startedAt: undefined,
  });
  emit(board, req.now, "job_queued", req.owner, {
    job: req.id,
    queue: req.queue,
    lane,
    priority: req.priority,
    ...(req.key === undefined ? {} : { key: req.key }),
  });
  schedule(board, queues, req.now);
  return { ok: true };
}

function refuse(board: Board, req: JobRequest, reason: string): EnqueueResult {
  emit(board, req.now, "job_refused", req.owner, { queue: req.queue, reason });
  return { ok: false, reason };
}

/**
 * A job's runner is done with it: its command finished (with its exit code, `timedOut` when the queue's time limit
 * stopped it), or it left the line before starting.
 */
export function jobEnded(board: Board, queues: Queues, j: { id: string; exitCode: number | null; timedOut?: boolean; now: number }): void {
  const job = board.jobs.find(x => x.id === j.id);
  if (!job) return;
  board.jobs = board.jobs.filter(x => x !== job);
  if (job.state === "running") {
    emit(board, j.now, "job_ended", job.owner, {
      job: job.id,
      queue: job.queue,
      exitCode: j.exitCode,
      ranMs: j.now - (job.startedAt ?? j.now),
      ...(j.timedOut ? { timedOut: true } : {}),
    });
  } else if (job.state === "waiting") {
    emit(board, j.now, "job_withdrawn", job.owner, { job: job.id, queue: job.queue, waitedMs: j.now - job.since });
  }
  schedule(board, queues, j.now);
}

/** Removes jobs whose runner is gone (crashed or killed without cleaning up). */
export function dropJobs(board: Board, queues: Queues, ids: string[], now: number): void {
  for (const job of board.jobs.filter(j => ids.includes(j.id))) {
    emit(board, now, "job_lost", job.owner, { job: job.id, queue: job.queue, state: job.state });
  }
  board.jobs = board.jobs.filter(j => !ids.includes(j.id));
  schedule(board, queues, now);
}

/** Changes a waiting job's priority. Only the session that owns the job may. */
export function setJobPriority(board: Board, r: { id: string; sessionId: string; priority: number; now: number }): EnqueueResult {
  if (!Number.isSafeInteger(r.priority) || Math.abs(r.priority) > MAX_PRIORITY) {
    return { ok: false, reason: `priority must be a whole number from -${MAX_PRIORITY} to ${MAX_PRIORITY}` };
  }
  const job = board.jobs.find(j => j.id === r.id);
  if (!job || job.state !== "waiting") return { ok: false, reason: `no waiting job ${r.id}` };
  if (job.owner !== r.sessionId) return { ok: false, reason: `job ${r.id} belongs to another session` };
  job.priority = r.priority;
  emit(board, r.now, "job_reprioritized", r.sessionId, { job: job.id, queue: job.queue, priority: r.priority });
  return { ok: true };
}

/** Starts waiting jobs while their queue has free slots, in the queue's order. */
export function schedule(board: Board, queues: Queues, now: number): void {
  for (const [name, policy] of Object.entries(queues)) {
    let free = slotsOf(board, policy, now) - board.jobs.filter(j => j.queue === name && j.state === "running").length;
    if (free <= 0) continue;
    for (const job of orderWaiting(policy, name, board, now)) {
      if (free-- <= 0) break;
      job.state = "running";
      job.startedAt = now;
      board.served = board.served.filter(s => !(s.queue === name && s.owner === job.owner));
      board.served.push({ queue: name, owner: job.owner, at: now });
      emit(board, now, "job_started", job.owner, { job: job.id, queue: name, lane: job.lane, waitedMs: now - job.since });
    }
  }
}

/** Waiting jobs of one queue in the order they will start. */
export function orderWaiting(policy: QueuePolicy, queue: string, board: Board, now: number): Job[] {
  const waiting = board.jobs.filter(j => j.queue === queue && j.state === "waiting");
  const effective = (j: Job) => j.priority + (policy.agingMs ? Math.floor((now - j.since) / policy.agingMs) : 0);
  const byPriority = (a: Job, b: Job) => effective(b) - effective(a) || a.since - b.since;
  const ordered: Job[] = [];

  for (const lane of policy.lanes) {
    const inLane = waiting.filter(j => j.lane === lane);
    if (policy.order === "fifo") {
      ordered.push(...inLane.sort((a, b) => a.since - b.since));
    } else if (policy.order === "priority") {
      ordered.push(...inLane.sort(byPriority));
    } else {
      // Fair share: repeatedly take the best job of the owner served longest ago (never served first, then the owner
      // whose oldest job is oldest). Taking a job counts as serving its owner.
      const lastServed = new Map<string | null, number>();
      for (const s of board.served) if (s.queue === queue) lastServed.set(s.owner, s.at);
      const perOwner = new Map<string | null, Job[]>();
      for (const j of inLane) perOwner.set(j.owner, [...(perOwner.get(j.owner) ?? []), j]);
      for (const jobs of perOwner.values()) jobs.sort(byPriority);
      let turn = 0;
      while (perOwner.size > 0) {
        const owners = [...perOwner.entries()].sort(
          ([a, aj], [b, bj]) =>
            (lastServed.get(a) ?? Number.NEGATIVE_INFINITY) - (lastServed.get(b) ?? Number.NEGATIVE_INFINITY) ||
            Math.min(...aj.map(j => j.since)) - Math.min(...bj.map(j => j.since)),
        );
        const [owner, jobs] = owners[0] as [string | null, Job[]];
        ordered.push(jobs.shift() as Job);
        lastServed.set(owner, now + ++turn);
        if (jobs.length === 0) perOwner.delete(owner);
      }
    }
  }
  return ordered;
}

/** A waiting job's place in line (1 = next), or 0 when it is not waiting. */
export function positionOf(board: Board, queues: Queues, id: string, now: number): number {
  const job = board.jobs.find(j => j.id === id);
  const policy = job && Object.hasOwn(queues, job.queue) ? queues[job.queue] : undefined;
  if (!job || !policy || job.state !== "waiting") return 0;
  return orderWaiting(policy, job.queue, board, now).indexOf(job) + 1;
}
