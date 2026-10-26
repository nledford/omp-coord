/**
 * `omp-coord doctor`: checks that the scope is healthy and says what to do about anything that is not. Read-only
 * unless asked to fix; fixing only removes what processes that are gone left behind.
 */
import type { Config } from "../config.ts";
import { pauseReason } from "../domain/control.ts";
import { currentLoad } from "../domain/limits.ts";
import type { Coordinator } from "./coordinator.ts";
import type { Liveness } from "./ports.ts";

export interface Finding {
  level: "ok" | "warn" | "error";
  text: string;
}

export interface DoctorFacts {
  config: Config;
  /** Unix permission bits of the state folder (should be 0o700). */
  stateDirMode: number;
  /** Socket files present in the state folder. */
  socketFiles: string[];
  /** Whether `omp-coord` resolves on PATH, and whether `bun` does. */
  cliOnPath: boolean;
  bunOnPath: boolean;
  now: number;
}

export async function doctor(coordinator: Coordinator, liveness: Liveness, facts: DoctorFacts, fix: boolean): Promise<Finding[]> {
  const out: Finding[] = [];
  const { config } = facts;
  out.push({ level: "ok", text: `config ${config.source} (scope ${config.scope}, hash ${config.hash})` });

  out.push(
    (facts.stateDirMode & 0o077) === 0
      ? { level: "ok", text: "state folder is private to you" }
      : { level: "error", text: `state folder is readable by others (mode ${(facts.stateDirMode & 0o777).toString(8)}); run chmod 700 on it` },
  );
  if (!facts.bunOnPath) out.push({ level: "warn", text: "bun is not on PATH: agents' queued commands cannot be rewritten to run through queues" });
  if (!facts.cliOnPath) out.push({ level: "warn", text: "omp-coord is not on PATH: run `bun link` in the omp-coord folder, or call it by path" });

  const board = coordinator.board();
  const differing = board.sessions.filter(s => s.configHash !== config.hash);
  out.push(
    differing.length
      ? { level: "warn", text: `sessions ${differing.map(s => s.label).join(", ")} read a different .omp-coord.json than ${config.source}; caps and rules disagree until they use the same file` }
      : { level: "ok", text: `${board.sessions.length} session(s) on the board, all with this config` },
  );

  const alive = await Promise.all([...board.sessions.map(s => liveness.isAlive(s.socket)), ...board.jobs.map(j => liveness.isAlive(j.socket))]);
  const deadCount = alive.filter(a => !a).length;
  if (deadCount && fix) {
    const dropped = await coordinator.prune("");
    out.push({ level: "ok", text: `dropped ${dropped.sessions} session(s) and ${dropped.jobs} job(s) whose process was gone` });
  } else if (deadCount) {
    out.push({ level: "warn", text: `${deadCount} session(s) or job(s) on the board have no live process; a running session drops them within 10 s, or run doctor --fix` });
  }

  const known = new Set([...board.sessions.map(s => s.socket), ...board.jobs.map(j => j.socket)]);
  const unknown = facts.socketFiles.filter(f => !known.has(f));
  const stale: string[] = [];
  for (const f of unknown) if (!(await liveness.isAlive(f))) stale.push(f);
  if (stale.length && fix) {
    for (const f of stale) liveness.forget(f);
    out.push({ level: "ok", text: `removed ${stale.length} socket file(s) nothing listens on` });
  } else if (stale.length) {
    out.push({ level: "warn", text: `${stale.length} socket file(s) nothing listens on; doctor --fix removes them` });
  }

  const paused = pauseReason(board);
  if (paused) out.push({ level: "warn", text: `${paused}; \`omp-coord resume\` or /coord resume lifts it` });
  const load = currentLoad(board, facts.now);
  out.push({ level: "ok", text: load === undefined ? "no recent load reading (no session or runner active)" : `load ${load}` });
  return out;
}
