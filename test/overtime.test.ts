import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardStore } from "../src/adapters/sqlite/store.ts";
import { formatAgents, formatStats } from "../src/adapters/text/report.ts";
import { Coordinator } from "../src/app/coordinator.ts";
import { ConfigError, parseConfig } from "../src/config.ts";
import { stats } from "../src/domain/history.ts";
import type { Board } from "../src/domain/model.ts";
import { agentList } from "../src/domain/overview.ts";
import { FakeClock, FakeLiveness, MemoryRepository } from "./support/fakes.ts";

const MIN = 60_000;

function setup(runtimeNoticeMinutes?: number | null) {
  const config = parseConfig(
    {
      scope: "t",
      agents: {
        pools: { work: { cap: 4 } },
        exempt: ["reviewer"],
        ...(runtimeNoticeMinutes === undefined ? {} : { runtimeNoticeMinutes }),
      },
    },
    "/t/.omp-coord.json",
  );
  const repo = new MemoryRepository();
  const clock = new FakeClock();
  const coordinator = new Coordinator(config, repo, new FakeLiveness(), clock);
  const me = { id: "me", pid: 1, cwd: "/w", address: "/s/me" };
  coordinator.join(me);
  const start = (agentId: string, agentType = "task") => {
    coordinator.requestSpawn({
      sessionId: "me",
      parentAgentId: "Main",
      parentIsSubagent: false,
      agentType,
      spawnKey: agentId,
    });
    coordinator.agentStarted({ sessionId: "me", agentId, parentId: "Main", parentIsSubagent: false, agentType });
  };
  return { config, repo, clock, coordinator, me, start };
}

describe("agents.runtimeNoticeMinutes", () => {
  test("is off when absent or null, and otherwise a positive whole number of minutes", () => {
    expect(parseConfig({ scope: "p" }, "f").agents).not.toHaveProperty("runtimeNoticeMs");
    expect(parseConfig({ scope: "p", agents: { runtimeNoticeMinutes: null } }, "f").agents).not.toHaveProperty(
      "runtimeNoticeMs",
    );
    expect(parseConfig({ scope: "p", agents: { runtimeNoticeMinutes: 60 } }, "f").agents.runtimeNoticeMs).toBe(
      60 * MIN,
    );
    for (const bad of [0, -5, 1.5, "60"])
      expect(() => parseConfig({ scope: "p", agents: { runtimeNoticeMinutes: bad } }, "f")).toThrow(ConfigError);
    expect(() => parseConfig({ scope: "p", agents: { runtimeNoticeMinutes: 0 } }, "f")).toThrow(
      /agents\.runtimeNoticeMinutes/,
    );
  });
});

describe("runtime notices", () => {
  test("nothing happens while the limit is off", () => {
    const { clock, coordinator, me, start } = setup();
    start("A1");
    clock.t += 1000 * MIN;
    expect(coordinator.tick(me).overtime).toEqual([]);
  });

  test("a run past the limit gets one notice, and one more at twice the limit, then no more", () => {
    const { clock, coordinator, me, start, repo } = setup(30);
    start("A1");
    clock.t += 29 * MIN;
    expect(coordinator.tick(me).overtime).toEqual([]);
    clock.t += 2 * MIN;
    expect(coordinator.tick(me).overtime).toEqual([
      { agentId: "A1", agentType: "task", pool: "work", minutes: 31, noticeAtMinutes: 30, notice: 1 },
    ]);
    clock.t += 10 * MIN;
    expect(coordinator.tick(me).overtime).toEqual([]);
    clock.t += 20 * MIN;
    expect(coordinator.tick(me).overtime).toEqual([
      { agentId: "A1", agentType: "task", pool: "work", minutes: 61, noticeAtMinutes: 60, notice: 2 },
    ]);
    clock.t += 600 * MIN;
    expect(coordinator.tick(me).overtime).toEqual([]);
    const events = repo.log.filter(e => e.type === "run_overtime");
    expect(events.map(e => e.data)).toEqual([
      { agentId: "A1", agentType: "task", pool: "work", minutes: 31, notice: 1 },
      { agentId: "A1", agentType: "task", pool: "work", minutes: 61, notice: 2 },
    ]);
  });

  test("exempt and nested agents are counted; a starting agent is not; another session's agent is left to its session", () => {
    const { clock, coordinator, me, start } = setup(10);
    start("R1", "reviewer");
    start("A1");
    coordinator.requestSpawn({
      sessionId: "me",
      parentAgentId: "A1",
      parentIsSubagent: true,
      agentType: "reviewer",
      spawnKey: "A1.Check",
    });
    coordinator.agentStarted({
      sessionId: "me",
      agentId: "A1.Check",
      parentId: "A1",
      parentIsSubagent: true,
      agentType: "reviewer",
    });
    coordinator.requestSpawn({
      sessionId: "me",
      parentAgentId: "Main",
      parentIsSubagent: false,
      agentType: "task",
      spawnKey: "Starting",
    });
    coordinator.join({ id: "other", pid: 2, cwd: "/w", address: "/s/other" });
    coordinator.requestSpawn({ sessionId: "other", parentAgentId: "Main", parentIsSubagent: false, agentType: "task" });
    coordinator.agentStarted({
      sessionId: "other",
      agentId: "Theirs",
      parentId: "Main",
      parentIsSubagent: false,
      agentType: "task",
    });
    clock.t += 11 * MIN;
    const mine = coordinator.tick(me).overtime;
    expect(mine.map(n => [n.agentId, n.pool])).toEqual([
      ["R1", null],
      ["A1", "work"],
      ["A1.Check", null],
    ]);
    expect(
      coordinator.tick({ id: "other", pid: 2, cwd: "/w", address: "/s/other" }).overtime.map(n => n.agentId),
    ).toEqual(["Theirs"]);
  });

  test("an agent first seen past twice the limit gets the second notice only", () => {
    const { clock, coordinator, me, start } = setup(10);
    start("A1");
    clock.t += 25 * MIN;
    expect(coordinator.tick(me).overtime.map(n => n.notice)).toEqual([2]);
  });

  test("a run that ended and was revived counts from its new start", () => {
    const { clock, coordinator, me, start } = setup(10);
    start("A1");
    clock.t += 11 * MIN;
    expect(coordinator.tick(me).overtime).toHaveLength(1);
    coordinator.agentEnded({ sessionId: "me", agentId: "A1" });
    coordinator.agentStarted({
      sessionId: "me",
      agentId: "A1",
      parentId: "Main",
      parentIsSubagent: false,
      agentType: "task",
    });
    clock.t += 5 * MIN;
    expect(coordinator.tick(me).overtime).toEqual([]);
    clock.t += 6 * MIN;
    expect(coordinator.tick(me).overtime.map(n => n.notice)).toEqual([1]);
  });

  test("a notice already sent is kept on the slot through the store, and not repeated by a later tick", () => {
    const db = join(mkdtempSync(join(tmpdir(), "omp-coord-")), "scope.db");
    const config = parseConfig(
      { scope: "t", agents: { pools: { work: { cap: 4 } }, runtimeNoticeMinutes: 10 } },
      "/t/.omp-coord.json",
    );
    const clock = new FakeClock();
    const me = { id: "me", pid: 1, cwd: "/w", address: "/s/me" };
    const first = new BoardStore(db);
    const a = new Coordinator(config, first, new FakeLiveness(), clock);
    a.join(me);
    a.requestSpawn({
      sessionId: "me",
      parentAgentId: "Main",
      parentIsSubagent: false,
      agentType: "task",
      spawnKey: "A1",
    });
    a.agentStarted({ sessionId: "me", agentId: "A1", parentId: "Main", parentIsSubagent: false, agentType: "task" });
    clock.t += 11 * MIN;
    expect(a.tick(me).overtime).toHaveLength(1);
    first.close();

    const second = new BoardStore(db);
    const b = new Coordinator(config, second, new FakeLiveness(), clock);
    expect(b.board().slots[0]?.overtimeNotices).toBe(1);
    expect(b.tick(me).overtime).toEqual([]);
    clock.t += 10 * MIN;
    expect(b.tick(me).overtime.map(n => n.notice)).toEqual([2]);
    second.close();
  });

  test("a board made before notices were recorded gains the column", () => {
    const db = join(mkdtempSync(join(tmpdir(), "omp-coord-")), "scope.db");
    new BoardStore(db).close();
    const old = new Database(db);
    old.exec("ALTER TABLE slots DROP COLUMN notices");
    old.close();
    const store = new BoardStore(db);
    expect(store.read().slots).toEqual([]);
    store.transact(b => {
      b.sessions.push({
        id: "a",
        label: "A",
        pid: 1,
        cwd: "/w",
        socket: "/s",
        startedAt: 0,
        configHash: "h",
        ports: undefined,
      });
      b.slots.push({
        sessionId: "a",
        agentId: "K",
        parentId: "Main",
        agentType: "task",
        pool: "work",
        state: "running",
        since: 1,
        overtimeNotices: 2,
      });
    });
    expect(store.read().slots.map(s => s.overtimeNotices)).toEqual([2]);
    store.close();
  });
});

describe("an older omp-coord sharing the board", () => {
  test("rewriting the slot without its mark does not make the notice go out again, and the mark comes back", () => {
    const { clock, coordinator, me, start, repo } = setup(10);
    start("A1");
    clock.t += 11 * MIN;
    expect(coordinator.tick(me).overtime).toHaveLength(1);
    // an older build saves the board: its slots have no notices column
    repo.board.slots = repo.board.slots.map(({ overtimeNotices: _dropped, ...rest }) => rest);
    expect(coordinator.tick(me).overtime).toEqual([]);
    expect(repo.board.slots[0]?.overtimeNotices).toBe(1);
    repo.board.slots = repo.board.slots.map(({ overtimeNotices: _dropped, ...rest }) => rest);
    clock.t += 10 * MIN;
    expect(coordinator.tick(me).overtime.map(n => n.notice)).toEqual([2]);
  });
});

describe("a tick whose save failed", () => {
  test("delivers nothing and sends the notice on the next tick", () => {
    const { clock, coordinator, me, start, repo } = setup(10);
    start("A1");
    clock.t += 11 * MIN;
    const transact = repo.transact.bind(repo);
    repo.transact = <T>(change: (board: Board) => T): T => {
      return transact(b => {
        change(b);
        throw new Error("disk full");
      });
    };
    expect(() => coordinator.tick(me)).toThrow("disk full");
    repo.transact = transact;
    expect(coordinator.tick(me).overtime.map(n => n.notice)).toEqual([1]);
  });
});

describe("reports", () => {
  test("stats count the notices per day, and the line appears only when there were some", () => {
    const { clock, coordinator, me, start, repo } = setup(10);
    start("A1");
    expect(formatStats(stats(repo.log, 0).days)).not.toContain("overtime");
    clock.t += 11 * MIN;
    coordinator.tick(me);
    clock.t += 10 * MIN;
    coordinator.tick(me);
    const days = stats(repo.log, 0).days;
    expect(days[0]?.overtimeNotices).toBe(2);
    expect(formatStats(days)).toContain(", 2 overtime notices");
  });

  test("an agent past a notice is marked in the agent list, and the JSON field is null until then", () => {
    const { clock, coordinator, me, start, repo } = setup(10);
    start("A1");
    expect(agentList(repo.board)[0]?.overtimeNotices).toBeNull();
    clock.t += 11 * MIN;
    coordinator.tick(me);
    expect(agentList(repo.board)[0]?.overtimeNotices).toBe(1);
    expect(formatAgents(repo.board, clock.t)).toContain("(past runtime notice 1)");
  });
});
