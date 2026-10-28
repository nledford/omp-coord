/**
 * Board persistence shared by every omp process in one scope: SQLite tables for the current state, plus an
 * append-only event log. Each change loads the state, applies a pure board transition, writes the state back and
 * appends the transition's events, all in one `BEGIN IMMEDIATE` transaction, so concurrent sessions never lose
 * each other's updates.
 *
 * The tables are meant to be read by other tools too (`sqlite3 <scope>.db 'select * from slots'`); see docs/event-log.md.
 */
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BoardRepository } from "../../app/ports.ts";
import { type Board, type BoardEvent, emptyBoard, type Note } from "../../domain/model.ts";

/** How long the event log keeps events. */
export interface Retention {
  maxAgeMs: number;
  maxEvents: number;
}

export const DEFAULT_RETENTION: Retention = { maxAgeMs: 30 * 24 * 3_600_000, maxEvents: 100_000 };

const PRUNE_INTERVAL_MS = 3_600_000;
/** Notes loaded with the board; enough for numbering and recent display. */
const NOTES_LOADED = 50;

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,
  label       TEXT NOT NULL UNIQUE,
  pid         INTEGER NOT NULL,
  cwd         TEXT NOT NULL,
  socket      TEXT NOT NULL,
  started_at  INTEGER NOT NULL,
  config_hash TEXT NOT NULL,
  ports_from  INTEGER,
  ports_to    INTEGER,
  omp_session TEXT
) STRICT;
CREATE TABLE slots (
  id         INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  agent_id   TEXT,
  parent_id  TEXT NOT NULL,
  agent_type TEXT NOT NULL,
  pool       TEXT,
  state      TEXT NOT NULL CHECK (state IN ('starting', 'running')),
  since      INTEGER NOT NULL,
  unqueued   TEXT CHECK (unqueued IN ('revived', 'eval')),
  omp_session TEXT
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
  id       INTEGER PRIMARY KEY,
  from_id  TEXT NOT NULL,
  to_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  to_agent TEXT,
  text     TEXT NOT NULL,
  sent_at  INTEGER NOT NULL
) STRICT;
CREATE TABLE sent (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  at         INTEGER NOT NULL
) STRICT;
CREATE TABLE jobs (
  id         TEXT PRIMARY KEY,
  queue      TEXT NOT NULL,
  owner      TEXT,
  lane       TEXT NOT NULL,
  priority   INTEGER NOT NULL,
  key        TEXT,
  command    TEXT NOT NULL,
  agent      TEXT,
  socket     TEXT NOT NULL,
  pid        INTEGER NOT NULL,
  state      TEXT NOT NULL CHECK (state IN ('waiting', 'running', 'superseded')),
  since      INTEGER NOT NULL,
  started_at INTEGER
) STRICT;
CREATE TABLE queue_served (
  queue TEXT NOT NULL,
  owner TEXT,
  at    INTEGER NOT NULL
) STRICT;
CREATE TABLE pause (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  by_session TEXT,
  reason     TEXT NOT NULL,
  since      INTEGER NOT NULL
) STRICT;
CREATE TABLE claims (
  kind       TEXT NOT NULL CHECK (kind IN ('branch', 'worktree', 'pr')),
  target     TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  agent_id   TEXT NOT NULL,
  note       TEXT NOT NULL,
  since      INTEGER NOT NULL,
  PRIMARY KEY (kind, target)
) STRICT;
CREATE TABLE agent_ports (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  agent_id   TEXT NOT NULL,
  from_port  INTEGER NOT NULL,
  to_port    INTEGER NOT NULL,
  PRIMARY KEY (session_id, agent_id)
) STRICT;
CREATE TABLE machine_load (
  id    INTEGER PRIMARY KEY CHECK (id = 1),
  value REAL NOT NULL,
  at    INTEGER NOT NULL
) STRICT;
CREATE TABLE notes (
  id     INTEGER PRIMARY KEY,
  at     INTEGER NOT NULL,
  label  TEXT,
  author TEXT NOT NULL,
  text   TEXT NOT NULL
) STRICT;
CREATE TABLE events (
  id         INTEGER PRIMARY KEY,
  at         INTEGER NOT NULL,
  type       TEXT NOT NULL,
  session_id TEXT,
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

export class BoardStore implements BoardRepository {
  readonly #db: Database;
  readonly #retention: Retention;

  constructor(path: string, retention: Retention = DEFAULT_RETENTION) {
    this.#retention = retention;
    this.#db = new Database(path, { create: true, strict: true });
    chmodSync(path, 0o600);
    this.#db.exec("PRAGMA busy_timeout = 5000");
    // Switching a new database to WAL needs a lock that busy_timeout does not wait for, so sessions opening a new
    // scope at the same moment retry briefly. WAL is then recorded in the file and later opens find it set.
    for (let attempt = 1; ; attempt++) {
      try {
        this.#db.exec("PRAGMA journal_mode = WAL");
        break;
      } catch (error) {
        const busy = typeof error === "object" && error !== null && "code" in error && error.code === "SQLITE_BUSY";
        if (!busy || attempt >= 100) throw error;
        Bun.sleepSync(20 + Math.floor(Math.random() * 30));
      }
    }
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
      .query<
        { at: number; type: BoardEvent["type"]; session_id: string | null; label: string | null; data: string },
        [number]
      >("SELECT at, type, session_id, label, data FROM events WHERE at >= ? ORDER BY id")
      .all(since)
      .map(r => ({ at: r.at, type: r.type, sessionId: r.session_id, label: r.label, data: JSON.parse(r.data) }));
  }

  /** Applies the retention policy: drops events older than the age limit, then the oldest beyond the count limit. */
  pruneEvents(now: number): void {
    this.#db.query("DELETE FROM events WHERE at < ?").run(now - this.#retention.maxAgeMs);
    this.#db
      .query("DELETE FROM events WHERE id <= (SELECT id FROM events ORDER BY id DESC LIMIT 1 OFFSET ?)")
      .run(this.#retention.maxEvents);
    // The decision log follows the same age limit.
    this.#db.query("DELETE FROM notes WHERE at < ?").run(now - this.#retention.maxAgeMs);
    this.#db
      .query(
        "INSERT INTO meta (key, value) VALUES ('events_pruned_at', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      )
      .run(String(now));
  }

  notes(limit: number): Note[] {
    return this.#db
      .query<Note, [number]>("SELECT * FROM (SELECT * FROM notes ORDER BY id DESC LIMIT ?) ORDER BY id")
      .all(limit);
  }

  close(): void {
    this.#db.close();
  }

  #migrate(): void {
    const version = this.#db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0;
    if (version === SCHEMA_VERSION) {
      this.#addColumns();
      return;
    }
    if (version !== 0) {
      throw new Error(
        `the board database has schema ${version}, but this omp-coord reads schema ${SCHEMA_VERSION}; update omp-coord`,
      );
    }
    this.#db.exec(SCHEMA);
    this.#db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  /**
   * Nullable columns added after schema 1 was released, without a version bump: a board made by an older omp-coord
   * gets them here, and an older omp-coord still running (an omp session not yet restarted) keeps reading and
   * writing the board, ignoring them (its saves write null there, which readers show as unknown).
   */
  #addColumns(): void {
    const has = (table: string, column: string) =>
      this.#db
        .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
        .all()
        .some(c => c.name === column);
    if (!has("jobs", "agent")) this.#db.exec("ALTER TABLE jobs ADD COLUMN agent TEXT");
    if (!has("slots", "unqueued"))
      this.#db.exec("ALTER TABLE slots ADD COLUMN unqueued TEXT CHECK (unqueued IN ('revived', 'eval'))");
    if (!has("sessions", "omp_session")) this.#db.exec("ALTER TABLE sessions ADD COLUMN omp_session TEXT");
    if (!has("slots", "omp_session")) this.#db.exec("ALTER TABLE slots ADD COLUMN omp_session TEXT");
  }

  #maybePruneEvents(now: number): void {
    const last = Number(
      this.#db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'events_pruned_at'").get()?.value ?? 0,
    );
    if (now - last >= PRUNE_INTERVAL_MS) this.pruneEvents(now);
  }

  #load(): Board {
    const db = this.#db;
    return {
      ...emptyBoard(),
      sessions: db
        .query<
          {
            id: string;
            label: string;
            pid: number;
            cwd: string;
            socket: string;
            started_at: number;
            config_hash: string;
            ports_from: number | null;
            ports_to: number | null;
            omp_session: string | null;
          },
          []
        >("SELECT * FROM sessions")
        .all()
        .map(r => ({
          id: r.id,
          label: r.label,
          pid: r.pid,
          cwd: r.cwd,
          socket: r.socket,
          startedAt: r.started_at,
          configHash: r.config_hash,
          ports: r.ports_from === null || r.ports_to === null ? undefined : { from: r.ports_from, to: r.ports_to },
          ...(r.omp_session ? { ompSessionId: r.omp_session } : {}),
        })),
      slots: db
        .query<
          {
            session_id: string;
            agent_id: string | null;
            parent_id: string;
            agent_type: string;
            pool: string | null;
            state: "starting" | "running";
            since: number;
            unqueued: "revived" | "eval" | null;
            omp_session: string | null;
          },
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
          ...(r.unqueued ? { unqueued: r.unqueued } : {}),
          ...(r.omp_session ? { ompSessionId: r.omp_session } : {}),
        })),
      waitlist: db
        .query<{ session_id: string; pool: string; since: number; hold_until: number | null; notified: number }, []>(
          "SELECT * FROM tickets",
        )
        .all()
        .map(r => ({
          sessionId: r.session_id,
          pool: r.pool,
          since: r.since,
          holdUntil: r.hold_until ?? undefined,
          notified: r.notified === 1,
        })),
      messages: db
        .query<{ from_id: string; to_id: string; to_agent: string | null; text: string; sent_at: number }, []>(
          "SELECT * FROM messages ORDER BY id",
        )
        .all()
        .map(r => ({
          fromId: r.from_id,
          toId: r.to_id,
          toAgent: r.to_agent ?? undefined,
          text: r.text,
          sentAt: r.sent_at,
        })),
      sent: db
        .query<{ session_id: string; at: number }, []>("SELECT * FROM sent")
        .all()
        .map(r => ({ sessionId: r.session_id, at: r.at })),
      jobs: db
        .query<
          {
            id: string;
            queue: string;
            owner: string | null;
            lane: string;
            priority: number;
            key: string | null;
            command: string;
            agent: string | null;
            socket: string;
            pid: number;
            state: "waiting" | "running" | "superseded";
            since: number;
            started_at: number | null;
          },
          []
        >("SELECT * FROM jobs")
        .all()
        .map(r => ({
          id: r.id,
          queue: r.queue,
          owner: r.owner,
          lane: r.lane,
          priority: r.priority,
          key: r.key ?? undefined,
          command: r.command,
          agent: r.agent ?? undefined,
          socket: r.socket,
          pid: r.pid,
          state: r.state,
          since: r.since,
          startedAt: r.started_at ?? undefined,
        })),
      served: db.query<{ queue: string; owner: string | null; at: number }, []>("SELECT * FROM queue_served").all(),
      pause: (() => {
        const r = db
          .query<{ by_session: string | null; reason: string; since: number }, []>("SELECT * FROM pause")
          .get();
        return r ? { by: r.by_session, reason: r.reason, since: r.since } : undefined;
      })(),
      claims: db
        .query<
          {
            kind: "branch" | "worktree" | "pr";
            target: string;
            session_id: string;
            agent_id: string;
            note: string;
            since: number;
          },
          []
        >("SELECT * FROM claims")
        .all()
        .map(r => ({
          kind: r.kind,
          target: r.target,
          sessionId: r.session_id,
          agentId: r.agent_id,
          note: r.note,
          since: r.since,
        })),
      agentPorts: db
        .query<{ session_id: string; agent_id: string; from_port: number; to_port: number }, []>(
          "SELECT * FROM agent_ports",
        )
        .all()
        .map(r => ({ sessionId: r.session_id, agentId: r.agent_id, from: r.from_port, to: r.to_port })),
      load: db.query<{ value: number; at: number }, []>("SELECT value, at FROM machine_load").get() ?? undefined,
      // The most recent notes only: older ones stay in the table, for SQL, until history retention drops them.
      notes: db
        .query<{ id: number; at: number; label: string | null; author: string; text: string }, []>(
          `SELECT * FROM (SELECT * FROM notes ORDER BY id DESC LIMIT ${NOTES_LOADED}) ORDER BY id`,
        )
        .all(),
    };
  }

  /**
   * Replaces the state tables with the board (a few dozen rows at most) and appends its events. Notes are append-only:
   * only new ones are written, and old ones stay until retention removes them.
   */
  #save(board: Board): void {
    const db = this.#db;
    for (const table of [
      "sent",
      "messages",
      "tickets",
      "slots",
      "claims",
      "agent_ports",
      "sessions",
      "jobs",
      "queue_served",
      "pause",
      "machine_load",
    ]) {
      db.exec(`DELETE FROM ${table}`);
    }

    const session = db.query(
      "INSERT INTO sessions (id, label, pid, cwd, socket, started_at, config_hash, ports_from, ports_to, omp_session) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const s of board.sessions)
      session.run(
        s.id,
        s.label,
        s.pid,
        s.cwd,
        s.socket,
        s.startedAt,
        s.configHash,
        s.ports?.from ?? null,
        s.ports?.to ?? null,
        s.ompSessionId ?? null,
      );
    const slot = db.query(
      "INSERT INTO slots (session_id, agent_id, parent_id, agent_type, pool, state, since, unqueued, omp_session) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const s of board.slots)
      slot.run(
        s.sessionId,
        s.agentId ?? null,
        s.parentId,
        s.agentType,
        s.pool,
        s.state,
        s.since,
        s.unqueued ?? null,
        s.ompSessionId ?? null,
      );
    const ticket = db.query(
      "INSERT INTO tickets (session_id, pool, since, hold_until, notified) VALUES (?, ?, ?, ?, ?)",
    );
    for (const t of board.waitlist) ticket.run(t.sessionId, t.pool, t.since, t.holdUntil ?? null, t.notified ? 1 : 0);
    const message = db.query("INSERT INTO messages (from_id, to_id, to_agent, text, sent_at) VALUES (?, ?, ?, ?, ?)");
    for (const m of board.messages) message.run(m.fromId, m.toId, m.toAgent ?? null, m.text, m.sentAt);
    const sent = db.query("INSERT INTO sent (session_id, at) VALUES (?, ?)");
    for (const x of board.sent) sent.run(x.sessionId, x.at);
    const job = db.query(
      "INSERT INTO jobs (id, queue, owner, lane, priority, key, command, agent, socket, pid, state, since, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const j of board.jobs) {
      job.run(
        j.id,
        j.queue,
        j.owner,
        j.lane,
        j.priority,
        j.key ?? null,
        j.command,
        j.agent ?? null,
        j.socket,
        j.pid,
        j.state,
        j.since,
        j.startedAt ?? null,
      );
    }
    const served = db.query("INSERT INTO queue_served (queue, owner, at) VALUES (?, ?, ?)");
    for (const s of board.served) served.run(s.queue, s.owner, s.at);
    if (board.pause)
      db.query("INSERT INTO pause (id, by_session, reason, since) VALUES (1, ?, ?, ?)").run(
        board.pause.by,
        board.pause.reason,
        board.pause.since,
      );
    const claim = db.query(
      "INSERT INTO claims (kind, target, session_id, agent_id, note, since) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const c of board.claims) claim.run(c.kind, c.target, c.sessionId, c.agentId, c.note, c.since);
    const ports = db.query("INSERT INTO agent_ports (session_id, agent_id, from_port, to_port) VALUES (?, ?, ?, ?)");
    for (const p of board.agentPorts) ports.run(p.sessionId, p.agentId, p.from, p.to);
    if (board.load)
      db.query("INSERT INTO machine_load (id, value, at) VALUES (1, ?, ?)").run(board.load.value, board.load.at);
    const note = db.query("INSERT OR IGNORE INTO notes (id, at, label, author, text) VALUES (?, ?, ?, ?, ?)");
    for (const n of board.notes) note.run(n.id, n.at, n.label, n.author, n.text);

    const event = db.query("INSERT INTO events (at, type, session_id, label, data) VALUES (?, ?, ?, ?, ?)");
    for (const e of board.events) event.run(e.at, e.type, e.sessionId, e.label, JSON.stringify(e.data));
    board.events = [];
  }
}
