import { describe, expect, test } from "bun:test";
import { formatAgents, formatQueues } from "../src/adapters/text/report.ts";
import { parseConfig } from "../src/config.ts";
import { agentEnded, agentStarted, requestSpawn } from "../src/domain/agents.ts";
import { claim } from "../src/domain/claims.ts";
import { pause } from "../src/domain/control.ts";
import { observeLoad } from "../src/domain/limits.ts";
import { type Board, emptyBoard } from "../src/domain/model.ts";
import { addNote } from "../src/domain/notes.ts";
import { agentList, statusView } from "../src/domain/overview.ts";
import { enqueueJob } from "../src/domain/queues.ts";
import { registerSession, removeSession } from "../src/domain/sessions.ts";

const MIN = 60_000;
const config = parseConfig(
  {
    scope: "demo",
    agents: { pools: { work: { cap: 2 }, short: { cap: 1, agentTypes: ["scout"] } }, exempt: ["reviewer"] },
    queues: { heavy: { slots: 1, lanes: ["front", "normal"] } },
  },
  "/w/.omp-coord.json",
  "h",
);

function join(board: Board, id: string, now = 0, configHash = "h") {
  registerSession(board, { id, pid: 100, cwd: `/w/${id}`, socket: `/s/${id}`, configHash, now });
}

/** Starts an agent as omp does: the spawn check, then its first run. */
function start(board: Board, session: string, id: string, type: string, now: number, parent = "Main") {
  const parentIsSubagent = parent !== "Main";
  const decision = requestSpawn(board, config.agents, {
    sessionId: session,
    parentAgentId: parent,
    parentIsSubagent,
    agentType: type,
    spawnKey: id,
    now,
  });
  expect(decision.allowed).toBe(true);
  agentStarted(board, config.agents, {
    sessionId: session,
    agentId: id,
    parentId: parent,
    parentIsSubagent,
    agentType: type,
    now,
  });
}

describe("agent list", () => {
  test("an empty board has no agents, and says so in text", () => {
    expect(agentList(emptyBoard())).toEqual([]);
    expect(formatAgents(emptyBoard(), 0)).toBe("No agents are running.");
  });

  test("a session's agents show type, parent, pool and state, nested reviewers outside the caps", () => {
    const board = emptyBoard();
    join(board, "a");
    start(board, "a", "Fixer", "task", 0);
    start(board, "a", "Fixer.Check", "reviewer", 1 * MIN, "Fixer");
    start(board, "a", "Looker", "scout", 2 * MIN);
    requestSpawn(board, config.agents, {
      sessionId: "a",
      parentAgentId: "Main",
      parentIsSubagent: false,
      agentType: "task",
      spawnKey: "Pending",
      now: 3 * MIN,
    });

    expect(agentList(board)).toEqual([
      { id: "Fixer", type: "task", parent: "Main", session: "A", pool: "work", state: "running", since: 0 },
      { id: "Fixer.Check", type: "reviewer", parent: "Fixer", session: "A", pool: null, state: "running", since: MIN },
      { id: "Looker", type: "scout", parent: "Main", session: "A", pool: "short", state: "running", since: 2 * MIN },
      { id: "Pending", type: "task", parent: "Main", session: "A", pool: "work", state: "starting", since: 3 * MIN },
    ]);
    expect(formatAgents(board, 5 * MIN).split("\n")).toEqual([
      "Agents (4):",
      "  A  Fixer        task      parent Main   pool work         running   5 min",
      "  A  Fixer.Check  reviewer  parent Fixer  outside the caps  running   4 min",
      "  A  Looker       scout     parent Main   pool short        running   3 min",
      "  A  Pending      task      parent Main   pool work         starting  2 min",
    ]);
  });

  test("agents are listed by session letter, then by start; a starting agent without an id has none", () => {
    const board = emptyBoard();
    join(board, "a");
    join(board, "b");
    start(board, "b", "FromB", "task", 0);
    start(board, "a", "FromA", "task", 5);
    requestSpawn(board, config.agents, {
      sessionId: "a",
      parentAgentId: "Main",
      parentIsSubagent: false,
      agentType: "reviewer",
      now: 6,
    });
    expect(agentList(board).map(a => [a.session, a.id])).toEqual([
      ["A", "FromA"],
      ["A", null],
      ["B", "FromB"],
    ]);
    expect(formatAgents(board, 7_000)).toContain("(no id yet)");
  });

  test("ages under a minute are in seconds and past an hour in hours", () => {
    const board = emptyBoard();
    join(board, "a");
    start(board, "a", "Old", "task", 0);
    start(board, "a", "New", "task", 3_600_000 + 5 * MIN - 30_000);
    const [old, fresh] = formatAgents(board, 3_600_000 + 5 * MIN)
      .split("\n")
      .slice(1);
    expect(old).toEndWith("1 h 5 min");
    expect(fresh).toEndWith("30 s");
  });
});

describe("status view", () => {
  test("an empty board lists the configured pools and queues with nothing in them", () => {
    expect(statusView(emptyBoard(), config, 50)).toEqual({
      generatedAt: 50,
      scope: { name: "demo", source: "/w/.omp-coord.json" },
      paused: null,
      load: null,
      sessions: [],
      pools: [
        { name: "work", used: 0, cap: 2, configuredCap: 2 },
        { name: "short", used: 0, cap: 1, configuredCap: 1 },
      ],
      line: [],
      agents: [],
      claims: [],
      queues: [{ name: "heavy", order: "fifo", slots: 1, configuredSlots: 1, running: [], waiting: [] }],
      notes: [],
    });
  });

  test("one populated board, field by field: the shape scripts rely on", () => {
    const board = emptyBoard();
    join(board, "a", 0);
    join(board, "b", 10, "other");
    start(board, "a", "Fixer", "task", MIN);
    start(board, "a", "Fixer.Check", "reviewer", 2 * MIN, "Fixer");
    start(board, "b", "Other", "task", 3 * MIN);
    // A third `work` agent is refused, which puts session B in line.
    expect(
      requestSpawn(board, config.agents, {
        sessionId: "b",
        parentAgentId: "Main",
        parentIsSubagent: false,
        agentType: "task",
        now: 4 * MIN,
      }).allowed,
    ).toBe(false);
    claim(board, { sessionId: "a", agentId: "Fixer", kind: "branch", target: "fix-x", note: "wip", now: 5 * MIN });
    addNote(board, { sessionId: "a", author: "Main", text: "ship #1 first", now: 6 * MIN });
    addNote(board, { sessionId: null, author: "nledford", text: "freeze main", now: 7 * MIN });
    observeLoad(board, 3.5, 11 * MIN);
    const job = (id: string, owner: string | null, lane: string, now: number) =>
      enqueueJob(board, config.queues, {
        id,
        queue: "heavy",
        owner,
        lane,
        priority: id === "j3" ? 4 : 0,
        ...(id === "j1" ? { key: "w ci", agent: "Fixer" } : {}),
        command: `cargo ${id}`,
        socket: `/s/${id}`,
        pid: 9,
        now,
      });
    job("j1", "a", "normal", 8 * MIN);
    job("j2", null, "normal", 9 * MIN);
    job("j3", "b", "front", 10 * MIN);

    const view = statusView(board, config, 12 * MIN);

    expect(view).toEqual({
      generatedAt: 12 * MIN,
      scope: { name: "demo", source: "/w/.omp-coord.json" },
      paused: null,
      load: 3.5,
      sessions: [
        {
          letter: "A",
          id: "a",
          folder: "/w/a",
          pid: 100,
          since: 0,
          agents: { pools: { work: 1, short: 0 }, outsideCaps: 1 },
          ports: null,
          differentConfig: false,
        },
        {
          letter: "B",
          id: "b",
          folder: "/w/b",
          pid: 100,
          since: 10,
          agents: { pools: { work: 1, short: 0 }, outsideCaps: 0 },
          ports: null,
          differentConfig: true,
        },
      ],
      pools: [
        { name: "work", used: 2, cap: 2, configuredCap: 2 },
        { name: "short", used: 0, cap: 1, configuredCap: 1 },
      ],
      line: [{ pool: "work", session: "B", position: 1, since: 4 * MIN, heldUntil: null }],
      agents: [
        { id: "Fixer", type: "task", parent: "Main", session: "A", pool: "work", state: "running", since: MIN },
        {
          id: "Fixer.Check",
          type: "reviewer",
          parent: "Fixer",
          session: "A",
          pool: null,
          state: "running",
          since: 2 * MIN,
        },
        { id: "Other", type: "task", parent: "Main", session: "B", pool: "work", state: "running", since: 3 * MIN },
      ],
      claims: [{ kind: "branch", target: "fix-x", session: "A", agent: "Fixer", note: "wip", since: 5 * MIN }],
      queues: [
        {
          name: "heavy",
          order: "fifo",
          slots: 1,
          configuredSlots: 1,
          running: [
            {
              id: "j1",
              session: "A",
              owner: "a",
              lane: "normal",
              priority: 0,
              key: "w ci",
              command: "cargo j1",
              agent: "Fixer",
              state: "running",
              queuedAt: 8 * MIN,
              startedAt: 8 * MIN,
              position: null,
            },
          ],
          waiting: [
            {
              id: "j3",
              session: "B",
              owner: "b",
              lane: "front",
              priority: 4,
              key: null,
              command: "cargo j3",
              agent: null,
              state: "waiting",
              queuedAt: 10 * MIN,
              startedAt: null,
              position: 1,
            },
            {
              id: "j2",
              session: null,
              owner: null,
              lane: "normal",
              priority: 0,
              key: null,
              command: "cargo j2",
              agent: null,
              state: "waiting",
              queuedAt: 9 * MIN,
              startedAt: null,
              position: 2,
            },
          ],
        },
      ],
      notes: [
        { id: 1, at: 6 * MIN, session: "A", author: "Main", text: "ship #1 first" },
        { id: 2, at: 7 * MIN, session: null, author: "nledford", text: "freeze main" },
      ],
    });
    // The view is plain JSON: nothing is lost or turned into null by a round trip except what is already null.
    expect(JSON.parse(JSON.stringify(view))).toEqual(view);
  });

  test("only the latest three notes are carried, oldest first", () => {
    const board = emptyBoard();
    for (const n of [1, 2, 3, 4]) addNote(board, { sessionId: null, author: "u", text: `n${n}`, now: n });
    expect(statusView(board, config, 9).notes.map(n => n.id)).toEqual([2, 3, 4]);
  });

  test("a job whose session ended keeps its owner id but has no letter; a pause names its session", () => {
    const board = emptyBoard();
    join(board, "a");
    enqueueJob(board, config.queues, {
      id: "j",
      queue: "heavy",
      owner: "gone",
      priority: 0,
      command: "make",
      socket: "/s/j",
      pid: 1,
      now: 0,
    });
    pause(board, { by: "a", reason: "merging", now: 5 });
    const view = statusView(board, config, 9);
    expect(view.queues[0]?.running[0]).toMatchObject({ session: null, owner: "gone" });
    expect(view.paused).toEqual({ by: "A", byId: "a", reason: "merging", since: 5 });
    expect(view.queues[0]?.slots).toBe(0);
    removeSession(board, config.agents, "a", 20);
    expect(statusView(board, config, 21).paused).toEqual({ by: null, byId: "a", reason: "merging", since: 5 });
    pause(board, { by: null, reason: "from a terminal", now: 22 });
    expect(statusView(board, config, 23).paused).toMatchObject({ by: null, byId: null });
    expect(view.pools.map(p => [p.cap, p.configuredCap])).toEqual([
      [0, 2],
      [0, 1],
    ]);
  });
});

describe("status view: ports, held slots and load", () => {
  const tuned = parseConfig(
    {
      scope: "demo",
      agents: { pools: { work: { cap: 2, loadCaps: [{ above: 2, cap: 1 }] } } },
      queues: { heavy: { slots: 2, loadSlots: [{ above: 2, slots: 1 }] } },
      resources: { ports: { from: 18000, to: 18099, perSession: 50 } },
    },
    "/w/.omp-coord.json",
    "h",
  );

  test("a session's port range, a slot held for the session in line, and caps lowered under load", () => {
    const board = emptyBoard();
    registerSession(
      board,
      { id: "a", pid: 1, cwd: "/w/a", socket: "/s/a", configHash: "h", now: 0 },
      tuned.resources.ports,
    );
    registerSession(
      board,
      { id: "b", pid: 1, cwd: "/w/b", socket: "/s/b", configHash: "h", now: 0 },
      tuned.resources.ports,
    );
    for (const id of ["One", "Two"]) {
      requestSpawn(board, tuned.agents, {
        sessionId: "a",
        parentAgentId: "Main",
        parentIsSubagent: false,
        agentType: "task",
        spawnKey: id,
        now: 1,
      });
      agentStarted(board, tuned.agents, {
        sessionId: "a",
        agentId: id,
        parentId: "Main",
        parentIsSubagent: false,
        agentType: "task",
        now: 1,
      });
    }
    requestSpawn(board, tuned.agents, {
      sessionId: "b",
      parentAgentId: "Main",
      parentIsSubagent: false,
      agentType: "task",
      now: 2,
    });
    agentEnded(board, tuned.agents, { sessionId: "a", agentId: "One", now: 3 });
    observeLoad(board, 5, 3);

    const view = statusView(board, tuned, 4);

    expect(view.sessions.map(s => s.ports)).toEqual([
      { from: 18000, to: 18049 },
      { from: 18050, to: 18099 },
    ]);
    expect(view.line).toEqual([
      { pool: "work", session: "B", position: 1, since: 2, heldUntil: 3 + tuned.agents.holdMs },
    ]);
    expect(view.load).toBe(5);
    expect(view.pools).toEqual([{ name: "work", used: 1, cap: 1, configuredCap: 2 }]);
    expect(view.queues[0]).toMatchObject({ slots: 1, configuredSlots: 2 });
  });
});

describe("queue lines", () => {
  test("a job reads as its session and agent and its key; one without them as the session and its command", () => {
    const board = emptyBoard();
    join(board, "a");
    const enqueue = (id: string, extra: object, now: number) =>
      enqueueJob(board, config.queues, {
        id,
        queue: "heavy",
        owner: "a",
        priority: 0,
        command: `/home/u/.cache/tools/0123abcd/scripts/ci.sh ${id}`,
        socket: `/s/${id}`,
        pid: 9,
        now,
        ...extra,
      });
    enqueue("j1", { key: "rebase-2204 ci", agent: "WaveUIPanels" }, MIN);
    enqueue("j2", {}, 2 * MIN);
    const queued = board.events.filter(e => e.type === "job_queued").map(e => e.data.agent);
    expect(queued).toEqual(["WaveUIPanels", undefined]);
    const lines = formatQueues(board, config.queues, 3 * MIN);
    expect(lines.find(l => l.includes("j1"))).toMatch(/session A\/WaveUIPanels\s.*\srebase-2204 ci$/);
    expect(lines.find(l => l.includes("j1"))).not.toContain("scripts/ci.sh");
    expect(lines.find(l => l.includes("j2"))).toMatch(/session A\s.*scripts\/ci\.sh j2$/);
  });
});
