/**
 * Board persistence shared by every omp process in one scope: SQLite tables for the current state, plus an
 * append-only event log. Each change loads the state, applies a pure board transition, writes the state back and
 * appends the transition's events, all in one `BEGIN IMMEDIATE` transaction, so concurrent sessions never lose
 * each other's updates.
 *
 * The tables are meant to be read by other tools too (`sqlite3 <scope>.db 'select * from slots'`); see the README.
 */
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Board, type BoardEvent, emptyBoard } from "../domain/board.ts";

/** How long the event log keeps events. */
export interface Retention {
  maxAgeMs: number;
  maxEvents: number;
}

export const DEFAULT_RETENTION: Retention = { maxAgeMs: 30 * 24 * 3_600_000, maxEvents: 100_000 };

const SCHEMA_VERSION = 1;
const PRUNE_INTERVAL_MS = 3_600_000;

const SCHEMA = `
CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  label      TEXT NOT NULL UNIQUE,
  pid        INTEGER NOT NULL,
  cwd        TEXT NOT NULL,
  socket     TEXT NOT NULL,
  started_at INTEGER NOT NULL
) STRICT;
CREATE TABLE slots (
  id         INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  agent_id   TEXT,
  parent_id  TEXT NOT NULL,
  agent_type TEXT NOT NULL,
  pool       TEXT,
  state      TEXT NOT NULL CHECK (state IN ('starting', 'running')),
  since      INTEGER NOT NULL
) STRICT;
CREATE TABLE tickets (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  pool       TEXT NOT NULL,
  since      INTEGER NOT NULL,
  hold_until INTEGER,
  notified   INTEGER NOT NULL CHECK (notified IN (0, 1)),
  PRIMARY KEY (session_id, pool)
) STRICT;
CREATE TABLE messages (
  id      INTEGER PRIMARY KEY,
  from_id TEXT NOT NULL,
  to_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  text    TEXT NOT NULL,
  sent_at INTEGER NOT NULL
) STRICT;
CREATE TABLE sent (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  at         INTEGER NOT NULL
) STRICT;
CREATE TABLE events (
  id         INTEGER PRIMARY KEY,
  at         INTEGER NOT NULL,
  type       TEXT NOT NULL,
  session_id TEXT NOT NULL,
  label      TEXT,
  data       TEXT NOT NULL
) STRICT;
CREATE INDEX events_at ON events (at);
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
`;

/** Folder for the board databases and session sockets; owner-only. */
export function stateDir(env: Record<string, string | undefined> = process.env): string {
  const dir = env.OMP_COORD_STATE_DIR ?? join(homedir(), ".omp", "run", "omp-coord");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

export class BoardStore {
  readonly #db: Database;
  readonly #retention: Retention;

  constructor(path: string, retention: Retention = DEFAULT_RETENTION) {
    this.#retention = retention;
    this.#db = new Database(path, { create: true, strict: true });
    chmodSync(path, 0o600);
    this.#db.exec("PRAGMA busy_timeout = 5000");
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec("PRAGMA foreign_keys = ON");
    this.#db.transaction(() => this.#migrate()).immediate();
    this.pruneEvents(Date.now());
  }

  /**
   * Runs `change` on the current board and saves the result atomically, appending the events it recorded.
   * A throw leaves the board and the log unchanged.
   */
  transact<T>(change: (board: Board) => T): T {
    const run = this.#db.transaction(() => {
      const board = this.#load();
      const result = change(board);
      this.#save(board);
      this.#maybePruneEvents(Date.now());
      return result;
    });
    return run.immediate();
  }

  /** The current board, read in one snapshot so a concurrent save is never half seen. */
  read(): Board {
    return this.#db.transaction(() => this.#load())();
  }

  /** Events oldest first, optionally only those at or after `since`. */
  events(since = 0): BoardEvent[] {
    return this.#db
      .query<{ at: number; type: BoardEvent["type"]; session_id: string; label: string | null; data: string }, [number]>(
        "SELECT at, type, session_id, label, data FROM events WHERE at >= ? ORDER BY id",
      )
      .all(since)
      .map(r => ({ at: r.at, type: r.type, sessionId: r.session_id, label: r.label, data: JSON.parse(r.data) }));
  }

  /** Applies the retention policy: drops events older than the age limit, then the oldest beyond the count limit. */
  pruneEvents(now: number): void {
    this.#db.query("DELETE FROM events WHERE at < ?").run(now - this.#retention.maxAgeMs);
    this.#db
      .query("DELETE FROM events WHERE id <= (SELECT id FROM events ORDER BY id DESC LIMIT 1 OFFSET ?)")
      .run(this.#retention.maxEvents);
    this.#db.query("INSERT INTO meta (key, value) VALUES ('events_pruned_at', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(String(now));
  }

  close(): void {
    this.#db.close();
  }

  #migrate(): void {
    const version = this.#db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
    if (version === SCHEMA_VERSION) return;
    if (version > SCHEMA_VERSION) {
      throw new Error(`the board database has schema ${version}, newer than this omp-coord (${SCHEMA_VERSION}); update omp-coord`);
    }
    // Before version 1 the board was one JSON row. Board state is short-lived (live sessions only), so it is dropped
    // rather than converted; sessions re-register within a tick.
    this.#db.exec("DROP TABLE IF EXISTS board");
    this.#db.exec(SCHEMA);
    this.#db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  #maybePruneEvents(now: number): void {
    const last = Number(this.#db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'events_pruned_at'").get()?.value ?? 0);
    if (now - last >= PRUNE_INTERVAL_MS) this.pruneEvents(now);
  }

  #load(): Board {
    const db = this.#db;
    return {
      ...emptyBoard(),
      sessions: db
        .query<{ id: string; label: string; pid: number; cwd: string; socket: string; started_at: number }, []>("SELECT * FROM sessions")
        .all()
        .map(r => ({ id: r.id, label: r.label, pid: r.pid, cwd: r.cwd, socket: r.socket, startedAt: r.started_at })),
      slots: db
        .query<
          { session_id: string; agent_id: string | null; parent_id: string; agent_type: string; pool: string | null; state: "starting" | "running"; since: number },
          []
        >("SELECT * FROM slots ORDER BY id")
        .all()
        .map(r => ({
          sessionId: r.session_id,
          agentId: r.agent_id ?? undefined,
          parentId: r.parent_id,
          agentType: r.agent_type,
          pool: r.pool,
          state: r.state,
          since: r.since,
        })),
      waitlist: db
        .query<{ session_id: string; pool: string; since: number; hold_until: number | null; notified: number }, []>("SELECT * FROM tickets")
        .all()
        .map(r => ({ sessionId: r.session_id, pool: r.pool, since: r.since, holdUntil: r.hold_until ?? undefined, notified: r.notified === 1 })),
      messages: db
        .query<{ from_id: string; to_id: string; text: string; sent_at: number }, []>("SELECT * FROM messages ORDER BY id")
        .all()
        .map(r => ({ fromId: r.from_id, toId: r.to_id, text: r.text, sentAt: r.sent_at })),
      sent: db
        .query<{ session_id: string; at: number }, []>("SELECT * FROM sent")
        .all()
        .map(r => ({ sessionId: r.session_id, at: r.at })),
    };
  }

  /** Replaces the state tables with the board (a few dozen rows at most) and appends its events. */
  #save(board: Board): void {
    const db = this.#db;
    for (const table of ["sent", "messages", "tickets", "slots", "sessions"]) db.exec(`DELETE FROM ${table}`);

    const session = db.query("INSERT INTO sessions (id, label, pid, cwd, socket, started_at) VALUES (?, ?, ?, ?, ?, ?)");
    for (const s of board.sessions) session.run(s.id, s.label, s.pid, s.cwd, s.socket, s.startedAt);
    const slot = db.query("INSERT INTO slots (session_id, agent_id, parent_id, agent_type, pool, state, since) VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const s of board.slots) slot.run(s.sessionId, s.agentId ?? null, s.parentId, s.agentType, s.pool, s.state, s.since);
    const ticket = db.query("INSERT INTO tickets (session_id, pool, since, hold_until, notified) VALUES (?, ?, ?, ?, ?)");
    for (const t of board.waitlist) ticket.run(t.sessionId, t.pool, t.since, t.holdUntil ?? null, t.notified ? 1 : 0);
    const message = db.query("INSERT INTO messages (from_id, to_id, text, sent_at) VALUES (?, ?, ?, ?)");
    for (const m of board.messages) message.run(m.fromId, m.toId, m.text, m.sentAt);
    const sent = db.query("INSERT INTO sent (session_id, at) VALUES (?, ?)");
    for (const x of board.sent) sent.run(x.sessionId, x.at);

    const event = db.query("INSERT INTO events (at, type, session_id, label, data) VALUES (?, ?, ?, ?, ?)");
    for (const e of board.events) event.run(e.at, e.type, e.sessionId, e.label, JSON.stringify(e.data));
    board.events = [];
  }
}
