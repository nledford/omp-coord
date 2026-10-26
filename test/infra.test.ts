import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAlive, startBeacon } from "../src/infra/beacon.ts";
import { type Board, registerSession } from "../src/domain/board.ts";
import { BoardStore } from "../src/infra/store.ts";

const ROOT = join(import.meta.dir, "..");
const freshDb = () => join(mkdtempSync(join(tmpdir(), "omp-coord-")), "scope.db");
const join_ = (id: string, now = 0) => (b: Board) =>
  registerSession(b, { id, pid: 1, cwd: "/w", socket: `/s/${id}`, now });

describe("board store", () => {
  test("sessions changing the board at the same time never lose each other's changes or events", async () => {
    const db = freshDb();
    new BoardStore(db).close();
    const writer = (tag: string) =>
      Bun.spawn(
        [
          "bun",
          "-e",
          `import { BoardStore } from "${ROOT}/src/infra/store.ts";
           import { registerSession } from "${ROOT}/src/domain/board.ts";
           const s = new BoardStore(${JSON.stringify(db)});
           s.transact(b => registerSession(b, { id: "${tag}", pid: 1, cwd: "/w", socket: "/s", now: Date.now() }));
           for (let i = 0; i < 150; i++) s.transact(b => { b.sent.push({ sessionId: "${tag}", at: i }); });`,
        ],
        { stderr: "inherit" },
      );
    const writers = ["a", "b", "c"].map(writer);
    expect(await Promise.all(writers.map(w => w.exited))).toEqual([0, 0, 0]);
    const store = new BoardStore(db);
    expect(store.read().sent).toHaveLength(450);
    expect(store.events().map(e => e.label).sort()).toEqual(["A", "B", "C"]);
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
    expect(() => store.transact(b => b.slots.push({ sessionId: "ghost", agentId: "X", parentId: "Main", agentType: "task", pool: "work", state: "running", since: 0 }))).toThrow(
      /FOREIGN KEY/,
    );
    expect(store.read().slots).toEqual([]);
  });

  test("the board round-trips through the tables", () => {
    const store = new BoardStore(freshDb());
    store.transact(b => {
      join_("a")(b);
      b.slots.push({ sessionId: "a", agentId: undefined, parentId: "Main", agentType: "task", pool: null, state: "starting", since: 5 });
      b.waitlist.push({ sessionId: "a", pool: "work", since: 6, holdUntil: undefined, notified: true });
      b.messages.push({ fromId: "gone", toId: "a", text: "hi", sentAt: 7 });
    });
    const b = store.read();
    expect(b.slots).toEqual([{ sessionId: "a", agentId: undefined, parentId: "Main", agentType: "task", pool: null, state: "starting", since: 5 }]);
    expect(b.waitlist).toEqual([{ sessionId: "a", pool: "work", since: 6, holdUntil: undefined, notified: true }]);
    expect(b.messages).toEqual([{ fromId: "gone", toId: "a", text: "hi", sentAt: 7 }]);
    expect(b.events).toEqual([]);
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

  test("a database from before the tables (one JSON row) is replaced by the tables", () => {
    const db = freshDb();
    const raw = new Database(db);
    raw.exec("CREATE TABLE board (id INTEGER PRIMARY KEY CHECK (id = 1), doc TEXT NOT NULL)");
    raw.exec(`INSERT INTO board VALUES (1, '{"sessions":[{"id":"old"}]}')`);
    raw.close();

    const store = new BoardStore(db);
    store.transact(join_("a"));
    expect(store.read().sessions.map(s => s.label)).toEqual(["A"]);
    const check = new Database(db, { readonly: true });
    expect(check.query("SELECT name FROM sqlite_master WHERE name = 'board'").all()).toEqual([]);
    expect(check.query("PRAGMA user_version").get()).toEqual({ user_version: 1 });
  });

  test("several sessions opening a new database at once all get a working board", async () => {
    const db = freshDb();
    const opener = (i: number) =>
      Bun.spawn(
        [
          "bun",
          "-e",
          `import { BoardStore } from "${ROOT}/src/infra/store.ts";
           import { registerSession } from "${ROOT}/src/domain/board.ts";
           new BoardStore(${JSON.stringify(db)}).transact(b => registerSession(b, { id: "s${i}", pid: 1, cwd: "/w", socket: "/s", now: Date.now() }));`,
        ],
        { stderr: "inherit" },
      );
    const openers = Array.from({ length: 8 }, (_, i) => opener(i));
    expect(await Promise.all(openers.map(o => o.exited))).toEqual(Array(8).fill(0));
    expect(new BoardStore(db).read().sessions).toHaveLength(8);
  });

  test("a database from a newer version is refused rather than misread", () => {
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
      `import { startBeacon } from "${ROOT}/src/infra/beacon.ts"; startBeacon(${JSON.stringify(path)}); console.log("up"); setInterval(() => {}, 1000);`,
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
