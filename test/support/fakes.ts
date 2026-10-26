/** In-memory stand-ins for the application's ports. */
import type { BoardRepository, Clock, Listener, Liveness } from "../../src/app/ports.ts";
import { type Board, type BoardEvent, type Note, emptyBoard } from "../../src/domain/model.ts";

/** Same contract as the SQLite store: a change that throws leaves the board and the log unchanged. */
export class MemoryRepository implements BoardRepository {
  board: Board = emptyBoard();
  log: BoardEvent[] = [];

  transact<T>(change: (board: Board) => T): T {
    const draft = structuredClone(this.board);
    const result = change(draft);
    this.log.push(...draft.events);
    this.board = { ...draft, events: [] };
    return result;
  }

  read(): Board {
    return structuredClone(this.board);
  }

  events(since = 0): BoardEvent[] {
    return this.log.filter(e => e.at >= since);
  }

  notes(limit: number): Note[] {
    return this.board.notes.slice(-limit);
  }

  close(): void {}
}

/** Addresses listed in `dead` are gone; everything else is alive. */
export class FakeLiveness implements Liveness {
  readonly dead = new Set<string>();
  readonly forgotten: string[] = [];

  async isAlive(address: string): Promise<boolean> {
    return !this.dead.has(address);
  }

  forget(address: string): void {
    this.forgotten.push(address);
  }
}

export class FakeClock implements Clock {
  constructor(public t = 1_000_000) {}
  now(): number {
    return this.t;
  }
}

export function fakeListener(address: string, log: string[]): Listener {
  log.push(`listen ${address}`);
  return { address, stop: () => log.push(`stop ${address}`) };
}
