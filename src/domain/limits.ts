/**
 * Load-aware limits: while the machine's load average is above a threshold, a pool's cap or a queue's slots drop to
 * the configured lower value. Every session and runner records the load it measures; the latest fresh reading
 * applies to everyone, since they share one machine.
 */
import type { Board } from "./model.ts";

/** At load above `above`, at most `limit` (agents of a pool, or jobs of a queue). */
export interface LoadLimit {
  above: number;
  limit: number;
}

/** A reading older than this is ignored: nobody measured lately, so the configured limits apply. */
export const LOAD_FRESH_MS = 2 * 60_000;

export function observeLoad(board: Board, value: number, now: number): void {
  board.load = { value, at: now };
}

/** The load to act on, or undefined when there is no fresh reading. */
export function currentLoad(board: Board, now: number): number | undefined {
  return board.load && now - board.load.at <= LOAD_FRESH_MS ? board.load.value : undefined;
}

/** `normal`, lowered by every rule whose threshold the current load exceeds. */
export function limitUnderLoad(normal: number, rules: LoadLimit[], load: number | undefined): number {
  if (load === undefined) return normal;
  return rules.filter(r => load > r.above).reduce((cap, r) => Math.min(cap, r.limit), normal);
}
