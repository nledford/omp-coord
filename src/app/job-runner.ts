/**
 * Runs one command through a queue: joins the line, waits for a slot (dropping jobs whose runner died, rejoining if
 * this runner was wrongly judged dead), runs the command within the queue's time limit, and leaves the queue with
 * its exit code.
 */
import { pauseReason } from "../domain/control.ts";
import { observeLoad } from "../domain/limits.ts";
import { type Queues, dropJobs, enqueueJob, jobEnded, positionOf, schedule, slotsOf } from "../domain/queues.ts";
import type { BoardRepository, Clock, Listener, Liveness, LoadProbe } from "./ports.ts";

/** Exit status when the job was not run: refused, or superseded by a newer job with the same key. */
export const EXIT_NOT_RUN = 75;
/** Exit status when the time limit stopped the command (as `timeout(1)`). */
export const EXIT_TIMED_OUT = 124;

export interface JobSpec {
  id: string;
  queue: string;
  owner: string | null;
  lane?: string;
  priority: number;
  key?: string;
  /** For display. */
  command: string;
  pid: number;
  /** Overrides the queue's time limit; null for none. */
  timeoutMs?: number | null;
}

export interface RunnerPorts {
  repo: BoardRepository;
  liveness: Liveness;
  clock: Clock;
  load: LoadProbe;
  /** Starts answering on this job's liveness address (again, after a false "dead" verdict removed it). */
  listen(): Listener;
  sleep(ms: number): Promise<void>;
  /**
   * Runs the command once the slot is held; resolves with its exit status. With a time limit, stops it when the
   * limit passes and reports `timedOut`.
   */
  execute(timeoutMs: number | null): Promise<{ code: number; timedOut: boolean }>;
  /** A signal asked this runner to stop, if any; checked while waiting. */
  stopRequested(): number | undefined;
  /** Progress for the person or agent waiting. */
  report(line: string): void;
}

export const POLL_MS = 1000;
const LIVENESS_EVERY_POLLS = 5;

export async function runJob(spec: JobSpec, queues: Queues, p: RunnerPorts): Promise<number> {
  let listener = p.listen();
  try {
    const { timeoutMs: ownTimeout, ...fields } = spec;
    const request = { ...fields, socket: listener.address };
    const join = () => p.repo.transact(b => enqueueJob(b, queues, { ...request, now: p.clock.now() }));
    const leave = (exitCode: number | null, timedOut = false) =>
      p.repo.transact(b => jobEnded(b, queues, { id: spec.id, exitCode, timedOut, now: p.clock.now() }));

    const queued = join();
    if (!queued.ok) {
      p.report(`omp-coord: ${queued.reason}`);
      return EXIT_NOT_RUN;
    }

    const since = p.clock.now();
    let said = -1;
    for (let poll = 0; ; poll++) {
      const stop = p.stopRequested();
      if (stop !== undefined) {
        leave(null);
        return stop;
      }
      if (poll % LIVENESS_EVERY_POLLS === LIVENESS_EVERY_POLLS - 1) {
        const others = p.repo.read().jobs.filter(j => j.id !== spec.id);
        const alive = await Promise.all(others.map(j => p.liveness.isAlive(j.socket)));
        const dead = others.filter((_, i) => !alive[i]).map(j => j.id);
        if (dead.length) p.repo.transact(b => dropJobs(b, queues, dead, p.clock.now()));
      }
      // The time is read inside the transaction: fair share compares it with other runners' turns.
      const load = p.load.load();
      const mine = p.repo.transact(b => {
        const now = p.clock.now();
        if (load !== undefined) observeLoad(b, load, now);
        schedule(b, queues, now);
        const policy = queues[spec.queue];
        return {
          state: b.jobs.find(j => j.id === spec.id)?.state,
          position: positionOf(b, queues, spec.id, now),
          running: b.jobs.filter(j => j.queue === spec.queue && j.state === "running").length,
          slots: policy ? slotsOf(b, policy, now) : 0,
          paused: pauseReason(b),
        };
      });
      if (mine.state === "running") break;
      if (mine.state === "superseded") {
        p.report("omp-coord: a newer job with the same key replaced this one; not running it");
        leave(null);
        return EXIT_NOT_RUN;
      }
      if (mine.state === undefined) {
        // Another process judged this runner dead (it was unreachable for a moment) and may have removed its
        // address. Answer again, then join the line again.
        listener.stop();
        listener = p.listen();
        const again = join();
        if (!again.ok) {
          p.report(`omp-coord: ${again.reason}`);
          return EXIT_NOT_RUN;
        }
        continue;
      }
      if (mine.position !== said) {
        const why = mine.paused ? ` (${mine.paused})` : "";
        p.report(`omp-coord: waiting for a ${spec.queue} slot: #${mine.position} in line, ${mine.running}/${mine.slots} running${why} (job ${spec.id})`);
        said = mine.position;
      }
      await p.sleep(POLL_MS);
    }
    if (said !== -1) p.report(`omp-coord: got a ${spec.queue} slot after ${Math.round((p.clock.now() - since) / 1000)} s`);

    const timeoutMs = ownTimeout === undefined ? (queues[spec.queue]?.timeoutMs ?? null) : ownTimeout;
    const { code, timedOut } = await p.execute(timeoutMs);
    if (timedOut) p.report(`omp-coord: stopped after the ${spec.queue} time limit of ${Math.round((timeoutMs ?? 0) / 60_000)} min`);
    leave(code, timedOut);
    return timedOut ? EXIT_TIMED_OUT : code;
  } finally {
    listener.stop();
  }
}
