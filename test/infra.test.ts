import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardStore } from "../src/adapters/sqlite/store.ts";
import { isAlive, startBeacon } from "../src/adapters/unix/beacon.ts";
import type { Board } from "../src/domain/model.ts";
import { registerSession } from "../src/domain/sessions.ts";

const ROOT = join(import.meta.dir, "..");
const freshDb = () => join(mkdtempSync(join(tmpdir(), "omp-coord-")), "scope.db");
const join_ =
  (id: string, now = 0) =>
  (b: Board) =>
    registerSession(b, { id, pid: 1, cwd: "/w", socket: `/s/${id}`, configHash: "h", now });

describe("board store", () => {
  test("sessions changing the board at the same time never lose each other's changes or events", async () => {
    const db = freshDb();
    new BoardStore(db).close();
    const writer = (tag: string) =>
      Bun.spawn(
        [
          "bun",
          "-e",
          `import { BoardStore } from "${ROOT}/src/adapters/sqlite/store.ts";
           import { registerSession } from "${ROOT}/src/domain/sessions.ts";
           const s = new BoardStore(${JSON.stringify(db)});
           s.transact(b => registerSession(b, { id: "${tag}", pid: 1, cwd: "/w", socket: "/s", configHash: "h", now: Date.now() }));
           for (let i = 0; i < 150; i++) s.transact(b => { b.sent.push({ sessionId: "${tag}", at: i }); });`,
        ],
        { stderr: "inherit" },
      );
    const writers = ["a", "b", "c"].map(writer);
    expect(await Promise.all(writers.map(w => w.exited))).toEqual([0, 0, 0]);
    const store = new BoardStore(db);
    expect(store.read().sent).toHaveLength(450);
    expect(
      store
        .events()
        .map(e => e.label)
        .sort(),
    ).toEqual(["A", "B", "C"]);
  });

  test("a change that throws leaves the board and the log as they were", () => {
    const store = new BoardStore(freshDb());
    store.transact(join_("a"));
    expect(() =>
      store.transact(b => {
        join_("b")(b);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(store.read().sessions.map(s => s.label)).toEqual(["A"]);
    expect(store.events().map(e => e.label)).toEqual(["A"]);
  });

  test("the database refuses a board that breaks its constraints, and nothing is saved", () => {
    const store = new BoardStore(freshDb());
    store.transact(join_("a"));
    expect(() =>
      store.transact(b =>
        b.slots.push({
          sessionId: "ghost",
          agentId: "X",
          parentId: "Main",
          agentType: "task",
          pool: "work",
          state: "running",
          since: 0,
        }),
      ),
    ).toThrow(/FOREIGN KEY/);
    expect(store.read().slots).toEqual([]);
  });

  test("the board round-trips through the tables", () => {
    const store = new BoardStore(freshDb());
    store.transact(b => {
      join_("a")(b);
      b.slots.push({
        sessionId: "a",
        agentId: undefined,
        parentId: "Main",
        agentType: "task",
        pool: null,
        state: "starting",
        since: 5,
      });
      b.waitlist.push({ sessionId: "a", pool: "work", since: 6, holdUntil: undefined, notified: true });
      b.messages.push({ fromId: "gone", toId: "a", toAgent: "Kid", text: "hi", sentAt: 7 });
    });
    const b = store.read();
    expect(b.slots).toEqual([
      {
        sessionId: "a",
        agentId: undefined,
        parentId: "Main",
        agentType: "task",
        pool: null,
        state: "starting",
        since: 5,
      },
    ]);
    expect(b.waitlist).toEqual([{ sessionId: "a", pool: "work", since: 6, holdUntil: undefined, notified: true }]);
    expect(b.messages).toEqual([{ fromId: "gone", toId: "a", toAgent: "Kid", text: "hi", sentAt: 7 }]);
    expect(b.events).toEqual([]);
  });

  test("a job keeps the agent that queued it, and a board made before jobs recorded one gains the column", () => {
    const db = freshDb();
    new BoardStore(db).close();
    // the board as omp-coord 0.2.x made it: no agent column, and a job saved without one
    const old = new Database(db);
    old.exec("ALTER TABLE jobs DROP COLUMN agent");
    old.close();
    const store = new BoardStore(db);
    const job = (id: string, agent: string | undefined) => ({
      id,
      queue: "heavy",
      owner: "a",
      agent,
      lane: "normal",
      priority: 0,
      key: `w ${id}`,
      command: "cargo x",
      socket: `/s/${id}`,
      pid: 1,
      state: "waiting" as const,
      since: 1,
      startedAt: undefined,
    });
    store.transact(b => {
      join_("a")(b);
      b.jobs.push(job("j1", "WaveImport"), job("j2", undefined));
    });
    expect(store.read().jobs.map(j => [j.id, j.agent])).toEqual([
      ["j1", "WaveImport"],
      ["j2", undefined],
    ]);
    // an older omp-coord still running saves the whole board without the column (DELETE, then INSERT by name): every
    // recorded agent is dropped until no older session is left; the board stays readable
    const older = new Database(db);
    older.exec("DELETE FROM jobs");
    older.exec(
      "INSERT INTO jobs (id, queue, owner, lane, priority, key, command, socket, pid, state, since) VALUES ('j1', 'heavy', 'a', 'normal', 0, 'w j1', 'cargo x', '/s/j1', 1, 'waiting', 1)",
    );
    older.close();
    expect(new BoardStore(db).read().jobs.map(j => [j.id, j.agent])).toEqual([["j1", undefined]]);
  });

  test("a slot holding no place in omp's queue stays marked, and a board made before slots recorded it gains the column", () => {
    const db = freshDb();
    new BoardStore(db).close();
    const old = new Database(db);
    old.exec("ALTER TABLE slots DROP COLUMN unqueued");
    old.close();
    const store = new BoardStore(db);
    const slot = {
      sessionId: "a",
      parentId: "Main",
      agentType: "task",
      pool: "work",
      state: "running" as const,
      since: 1,
    };
    store.transact(b => {
      join_("a")(b);
      b.slots.push(
        { ...slot, agentId: "Old", unqueued: "revived" },
        { ...slot, agentId: "W", unqueued: "eval" },
        { ...slot, agentId: "New" },
      );
    });
    expect(store.read().slots.map(s => [s.agentId, s.unqueued])).toEqual([
      ["Old", "revived"],
      ["W", "eval"],
      ["New", undefined],
    ]);
  });

  test("the omp session ids of the main session and a subagent round-trip, and a board made before they were recorded gains the columns", () => {
    const db = freshDb();
    new BoardStore(db).close();
    const old = new Database(db);
    old.exec("ALTER TABLE sessions DROP COLUMN omp_session");
    old.exec("ALTER TABLE slots DROP COLUMN omp_session");
    old.close();
    const store = new BoardStore(db);
    store.transact(b => {
      join_("a")(b);
      for (const s of b.sessions) s.ompSessionId = "omp-main";
      b.slots.push({
        sessionId: "a",
        agentId: "Kid",
        parentId: "Main",
        agentType: "task",
        pool: "work",
        state: "running",
        since: 1,
        ompSessionId: "omp-kid",
      });
    });
    const b = store.read();
    expect(b.sessions.map(s => s.ompSessionId)).toEqual(["omp-main"]);
    expect(b.slots.map(s => s.ompSessionId)).toEqual(["omp-kid"]);
  });

  test("pause, claims, ports, load and notes round-trip; notes are kept when no longer in the loaded window", () => {
    const store = new BoardStore(freshDb());
    store.transact(b => {
      join_("a")(b);
      b.pause = { by: "a", reason: "merging", since: 1 };
      b.claims.push({ kind: "branch", target: "fix-x", sessionId: "a", agentId: "Main", note: "n", since: 2 });
      b.agentPorts.push({ sessionId: "a", agentId: "X", from: 18700, to: 18709 });
      b.load = { value: 12.5, at: 3 };
      b.notes.push({ id: 1, at: Date.now(), label: "A", author: "Main", text: "ship it" });
    });
    const b = store.read();
    expect(b.pause).toEqual({ by: "a", reason: "merging", since: 1 });
    expect(b.claims).toEqual([
      { kind: "branch", target: "fix-x", sessionId: "a", agentId: "Main", note: "n", since: 2 },
    ]);
    expect(b.agentPorts).toEqual([{ sessionId: "a", agentId: "X", from: 18700, to: 18709 }]);
    expect(b.load).toEqual({ value: 12.5, at: 3 });
    expect(store.notes(10).map(n => n.text)).toEqual(["ship it"]);

    store.transact(b => {
      b.pause = undefined;
      b.notes = [];
    });
    expect(store.read().pause).toBeUndefined();
    expect(store.notes(10).map(n => n.text)).toEqual(["ship it"]);
  });

  test("the event log keeps events within the age limit and at most the newest N", () => {
    const now = Date.now();
    const db = freshDb();
    const store = new BoardStore(db, { maxAgeMs: 1000, maxEvents: 3 });
    store.transact(b => {
      for (const [i, id] of ["a", "b", "c", "d", "e"].entries()) join_(id, now - 2000 + i * 500)(b);
    });
    store.pruneEvents(now);
    expect(store.events().map(e => e.label)).toEqual(["C", "D", "E"]);

    const tighter = new BoardStore(db, { maxAgeMs: 1000, maxEvents: 2 });
    expect(tighter.events().map(e => e.label)).toEqual(["D", "E"]);
  });

  test("events about build jobs started outside any omp session are kept with no session", () => {
    const store = new BoardStore(freshDb());
    store.transact(b =>
      b.events.push({ at: Date.now(), type: "job_queued", sessionId: null, label: null, data: { job: "j1" } }),
    );
    expect(store.events().map(e => [e.type, e.sessionId])).toEqual([["job_queued", null]]);
  });

  test("several sessions opening a new database at once all get a working board", async () => {
    const db = freshDb();
    const opener = (i: number) =>
      Bun.spawn(
        [
          "bun",
          "-e",
          `import { BoardStore } from "${ROOT}/src/adapters/sqlite/store.ts";
           import { registerSession } from "${ROOT}/src/domain/sessions.ts";
           new BoardStore(${JSON.stringify(db)}).transact(b => registerSession(b, { id: "s${i}", pid: 1, cwd: "/w", socket: "/s", configHash: "h", now: Date.now() }));`,
        ],
        { stderr: "inherit" },
      );
    const openers = Array.from({ length: 8 }, (_, i) => opener(i));
    expect(await Promise.all(openers.map(o => o.exited))).toEqual(Array(8).fill(0));
    expect(new BoardStore(db).read().sessions).toHaveLength(8);
  });

  test("a database with a different schema is refused rather than misread", () => {
    const db = freshDb();
    new BoardStore(db).close();
    const raw = new Database(db);
    raw.exec("PRAGMA user_version = 99");
    raw.close();
    expect(() => new BoardStore(db)).toThrow(/schema 99/);
  });
});

describe("session liveness", () => {
  test("a live session answers; a stopped one and a missing one do not", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "omp-coord-")), "s.sock");
    const beacon = startBeacon(path);
    expect(await isAlive(path)).toBe(true);
    beacon.stop();
    expect(await isAlive(path)).toBe(false);
  });

  test("a session whose process was killed reads as gone, though its socket file is left behind", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "omp-coord-")), "s.sock");
    const child = Bun.spawn([
      "bun",
      "-e",
      `import { startBeacon } from "${ROOT}/src/adapters/unix/beacon.ts"; startBeacon(${JSON.stringify(path)}); console.log("up"); setInterval(() => {}, 1000);`,
    ]);
    const reader = child.stdout.getReader();
    await reader.read();
    expect(await isAlive(path)).toBe(true);
    child.kill("SIGKILL");
    await child.exited;
    expect(existsSync(path)).toBe(true);
    expect(await isAlive(path)).toBe(false);
  });
});

describe("job meta in the store", () => {
  const job = (id: string, meta: Record<string, string> | undefined) => ({
    id,
    queue: "heavy",
    owner: "a",
    agent: undefined,
    lane: "normal",
    priority: 0,
    key: undefined,
    meta,
    command: "cargo x",
    socket: `/s/${id}`,
    pid: 1,
    state: "waiting" as const,
    since: 1,
    startedAt: undefined,
  });

  test("a job's meta survives a save, and a board made before the column existed gains it", () => {
    const db = freshDb();
    new BoardStore(db).close();
    const old = new Database(db);
    old.exec("ALTER TABLE jobs DROP COLUMN meta");
    old.close();
    const store = new BoardStore(db);
    store.transact(b => {
      join_("a")(b);
      b.jobs.push(job("j1", { fp: "abc", intent: "failfirst" }), job("j2", undefined));
    });
    expect(store.read().jobs.map(j => [j.id, j.meta])).toEqual([
      ["j1", { fp: "abc", intent: "failfirst" }],
      ["j2", undefined],
    ]);
  });
});
