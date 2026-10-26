/**
 * What the application needs from the outside world. Adapters implement these (`adapters/sqlite`, `adapters/unix`,
 * the runner's process spawning); tests use in-memory fakes.
 */
import type { Board, BoardEvent, Note } from "../domain/model.ts";

/** The shared board of one scope. Every change runs `change` on the current board and saves it atomically. */
export interface BoardRepository {
  transact<T>(change: (board: Board) => T): T;
  read(): Board;
  /** Event log, oldest first, from `since` on. */
  events(since?: number): BoardEvent[];
  /** The newest `limit` decision-log notes, oldest first. */
  notes(limit: number): Note[];
  close(): void;
}

/** Whether the process behind a liveness address (a Unix socket path) still runs. */
export interface Liveness {
  /** False only when certainly gone; errors and slow answers count as alive. */
  isAlive(address: string): Promise<boolean>;
  /** Removes what a process that is gone left behind at its address. */
  forget(address: string): void;
}

/** A liveness address this process answers on while it runs. */
export interface Listener {
  readonly address: string;
  stop(): void;
}

export interface Clock {
  now(): number;
}

/** The machine's 1-minute load average, or undefined where the platform has none. */
export interface LoadProbe {
  load(): number | undefined;
}
