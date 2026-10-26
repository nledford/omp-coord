/**
 * Runs one command through a queue: joins the line, waits for a slot (dropping jobs whose runner died, rejoining if
 * this runner was wrongly judged dead), runs the command, and leaves the queue with its exit code.
 */
import { type Queues, dropJobs, enqueueJob, jobEnded, positionOf, schedule } from "../domain/queues.ts";
import type { BoardRepository, Clock, Listener, Liveness } from "./ports.ts";

/** Exit status when the job was not run: refused, or superseded by a newer job with the same key. */
export const EXIT_NOT_RUN = 75;

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
}

export interface RunnerPorts {
  repo: BoardRepository;
  liveness: Liveness;
  clock: Clock;
  /** Starts answering on this job's liveness address (again, after a false "dead" verdict removed it). */
  listen(): Listener;
  sleep(ms: number): Promise<void>;
  /** Runs the command once the slot is held; resolves with its exit status. */
  execute(): Promise<number>;
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
    const request = { ...spec, socket: listener.address };
    const join = () => p.repo.transact(b => enqueueJob(b, queues, { ...request, now: p.clock.now() }));
    const leave = (exitCode: number | null) => p.repo.transact(b => jobEnded(b, queues, { id: spec.id, exitCode, now: p.clock.now() }));

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
      const mine = p.repo.transact(b => {
        const now = p.clock.now();
        schedule(b, queues, now);
        return {
          state: b.jobs.find(j => j.id === spec.id)?.state,
          position: positionOf(b, queues, spec.id, now),
          running: b.jobs.filter(j => j.queue === spec.queue && j.state === "running").length,
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
        p.report(
          `omp-coord: waiting for a ${spec.queue} slot: #${mine.position} in line, ${mine.running}/${queues[spec.queue]?.slots} running (job ${spec.id})`,
        );
        said = mine.position;
      }
      await p.sleep(POLL_MS);
    }
    if (said !== -1) p.report(`omp-coord: got a ${spec.queue} slot after ${Math.round((p.clock.now() - since) / 1000)} s`);

    const code = await p.execute();
    leave(code);
    return code;
  } finally {
    listener.stop();
  }
}
