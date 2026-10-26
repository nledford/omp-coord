/**
 * Read-only view of a `flock`-based slot queue, as kept by scripts like lightcraft-local's `slots.sh`:
 * `<dir>/<n>.lock` for n = 1..slots (held while a job runs; may hold the holder's description) and `<dir>/queue/`
 * with one ticket file per waiter, named so that sorting by name gives the order of service and ending in `-<pid>`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { QueueDir } from "../config.ts";

export interface QueueView {
  name: string;
  slots: number;
  /** Held slots, with what the holder wrote into the lock file (may be empty). */
  running: { slot: number; holder: string }[];
  /** Tickets in order of service. `alive: false` marks a ticket whose process is gone (the scripts drop those). */
  waiting: { ticket: string; holder: string; ageSeconds: number; alive: boolean }[];
  /** Set when the queue could not be read (e.g. `flock` is missing). */
  problem?: string;
}

export async function readQueue(q: QueueDir, now = Date.now()): Promise<QueueView> {
  const view: QueueView = { name: q.name, slots: q.slots, running: [], waiting: [] };
  if (!existsSync(q.dir)) return view;

  const flock = Bun.which("flock");
  if (!flock) {
    view.problem = "flock is not installed (brew install flock), so held slots cannot be read";
  } else {
    for (let slot = 1; slot <= q.slots; slot++) {
      const file = join(q.dir, `${slot}.lock`);
      if (!existsSync(file)) continue;
      // `-n` takes the lock only if it is free and lets go at once; a waiter trying the same instant just retries.
      const probe = Bun.spawn([flock, "-n", file, "true"], { stdout: "ignore", stderr: "ignore" });
      if ((await probe.exited) !== 0) view.running.push({ slot, holder: readText(file) });
    }
  }

  const queueDir = join(q.dir, "queue");
  if (existsSync(queueDir)) {
    for (const ticket of readdirSync(queueDir).sort()) {
      const file = join(queueDir, ticket);
      const pid = Number(ticket.slice(ticket.lastIndexOf("-") + 1));
      let ageSeconds = 0;
      try {
        ageSeconds = Math.max(0, Math.round((now - statSync(file).mtimeMs) / 1000));
      } catch {
        continue; // served and removed while we read
      }
      view.waiting.push({ ticket, holder: readText(file), ageSeconds, alive: Number.isInteger(pid) && pid > 0 && processExists(pid) });
    }
  }
  return view;
}

function readText(file: string): string {
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return typeof e === "object" && e !== null && "code" in e && e.code === "EPERM";
  }
}
