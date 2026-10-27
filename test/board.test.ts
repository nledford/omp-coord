import { describe, expect, test } from "bun:test";
import { agentEnded, agentStarted, expire, requestSpawn, spawnAllowance, takeNewHolds } from "../src/domain/agents.ts";
import { sendMessage, takeInbox } from "../src/domain/messages.ts";
import { type AgentPolicy, type Board, emptyBoard } from "../src/domain/model.ts";
import { registerSession, removeSession } from "../src/domain/sessions.ts";

const MIN = 60_000;

const policy: AgentPolicy = {
  pools: { work: { cap: 2, agentTypes: [], loadCaps: [] }, short: { cap: 1, agentTypes: ["scout"], loadCaps: [] } },
  defaultPool: "work",
  exempt: ["reviewer"],
  nested: { allow: ["reviewer"], maxRunningPerParent: 1 },
  holdMs: 5 * MIN,
  startTimeoutMs: MIN,
  messagesPerMinute: 3,
  queueSpawns: true,
};

function boardWith(...ids: string[]): Board {
  const board = emptyBoard();
  for (const id of ids) registerSession(board, { id, pid: 1, cwd: "/w", socket: `/s/${id}`, configHash: "h", now: 0 });
  return board;
}

/** Spawns and starts a top-level agent, the way omp does: approval in the parent, then the child's first run. */
function run(board: Board, session: string, agentId: string, agentType = "task", now = 0) {
  const decision = requestSpawn(board, policy, {
    sessionId: session,
    parentAgentId: "Main",
    parentIsSubagent: false,
    agentType,
    spawnKey: agentId,
    now,
  });
  if (decision.allowed)
    agentStarted(board, policy, {
      sessionId: session,
      agentId,
      parentId: "Main",
      parentIsSubagent: false,
      agentType,
      now,
    });
  return decision;
}

function spawn(board: Board, session: string, agentType = "task", now = 0) {
  return requestSpawn(board, policy, {
    sessionId: session,
    parentAgentId: "Main",
    parentIsSubagent: false,
    agentType,
    now,
  });
}

describe("agent cap across sessions", () => {
  test("admits agents from any session until the pool is full, then refuses with a place in line", () => {
    const board = boardWith("a", "b");
    expect(run(board, "a", "A1").allowed).toBe(true);
    expect(run(board, "b", "B1").allowed).toBe(true);

    const refused = spawn(board, "b");
    expect(refused).toMatchObject({ allowed: false, pool: "work", position: 1 });
  });

  test("pools are counted separately and exempt agents are never refused", () => {
    const board = boardWith("a");
    run(board, "a", "A1");
    run(board, "a", "A2");
    expect(spawn(board, "a").allowed).toBe(false);
    expect(run(board, "a", "S1", "scout").allowed).toBe(true);
    expect(spawn(board, "a", "scout").allowed).toBe(false);
    expect(run(board, "a", "R1", "reviewer").allowed).toBe(true);
  });

  test("an agent that ends frees its slot", () => {
    const board = boardWith("a");
    run(board, "a", "A1");
    run(board, "a", "A2");
    agentEnded(board, policy, { sessionId: "a", agentId: "A1", now: 1 });
    expect(spawn(board, "a", "task", 2).allowed).toBe(true);
  });

  test("an approved spawn counts at once, and its first run does not count it twice", () => {
    const board = boardWith("a");
    expect(spawn(board, "a").allowed).toBe(true);
    agentStarted(board, policy, {
      sessionId: "a",
      agentId: "Main.Kid",
      parentId: "Main",
      parentIsSubagent: false,
      agentType: "task",
      now: 1,
    });
    expect(spawn(board, "a").allowed).toBe(true);
    expect(spawn(board, "a").allowed).toBe(false);
  });

  test("an agent whose spawn key is a label rather than its id still claims its approved slot", () => {
    const board = boardWith("a");
    requestSpawn(board, policy, {
      sessionId: "a",
      parentAgentId: "Main",
      parentIsSubagent: false,
      agentType: "task",
      spawnKey: "CleanseDiscovery",
      now: 0,
    });
    agentStarted(board, policy, {
      sessionId: "a",
      agentId: "CleanseDiscovery-2",
      parentId: "Main",
      parentIsSubagent: false,
      agentType: "task",
      now: 1,
    });
    expect(spawn(board, "a", "task", 2).allowed).toBe(true);
    expect(spawn(board, "a", "task", 3).allowed).toBe(false);
  });

  test("an approved spawn that never starts gives its slot back after the start timeout", () => {
    const board = boardWith("a");
    spawn(board, "a");
    spawn(board, "a");
    expect(spawn(board, "a", "task", MIN - 1).allowed).toBe(false);
    expire(board, policy, MIN + 1);
    expect(spawn(board, "a", "task", MIN + 1).allowed).toBe(true);
  });
});

describe("holding a freed slot for the oldest refused session", () => {
  test("a freed slot is held for the session refused first; others are refused until it is used", () => {
    const board = boardWith("a", "b");
    run(board, "a", "A1");
    run(board, "a", "A2");
    expect(spawn(board, "b", "task", 1).allowed).toBe(false);

    agentEnded(board, policy, { sessionId: "a", agentId: "A1", now: 2 });
    expect(takeNewHolds(board, "b")).toEqual([{ pool: "work", until: 2 + policy.holdMs }]);
    expect(takeNewHolds(board, "b")).toEqual([]);

    expect(spawn(board, "a", "task", 3)).toMatchObject({ allowed: false, position: 2 });
    expect(spawn(board, "b", "task", 4).allowed).toBe(true);
    expect(spawn(board, "b", "task", 5)).toMatchObject({ allowed: false, position: 2 });
  });

  test("refused sessions are served in the order they were first refused", () => {
    const board = boardWith("a", "b", "c");
    run(board, "a", "A1");
    run(board, "a", "A2");
    spawn(board, "c", "task", 1);
    spawn(board, "b", "task", 2);
    expect(spawn(board, "c", "task", 3)).toMatchObject({ allowed: false, position: 1 });
    expect(spawn(board, "b", "task", 4)).toMatchObject({ allowed: false, position: 2 });

    agentEnded(board, policy, { sessionId: "a", agentId: "A1", now: 5 });
    expect(takeNewHolds(board, "c")).toHaveLength(1);
    expect(takeNewHolds(board, "b")).toHaveLength(0);
  });

  test("an unused hold expires and passes to the next session in line", () => {
    const board = boardWith("a", "b", "c");
    run(board, "a", "A1");
    run(board, "a", "A2");
    spawn(board, "b", "task", 1);
    spawn(board, "c", "task", 2);
    agentEnded(board, policy, { sessionId: "a", agentId: "A1", now: 3 });
    takeNewHolds(board, "b");

    expire(board, policy, 3 + policy.holdMs + 1);
    expect(takeNewHolds(board, "c")).toHaveLength(1);
    expect(spawn(board, "b", "task", 3 + policy.holdMs + 2)).toMatchObject({ allowed: false, position: 2 });
  });
});

describe("revived agents", () => {
  test("a revived agent takes a slot even over the cap, and nothing new starts until the total is under it", () => {
    const board = boardWith("a");
    run(board, "a", "A1");
    run(board, "a", "A2");
    agentEnded(board, policy, { sessionId: "a", agentId: "A1", now: 1 });
    run(board, "a", "A3", "task", 2);

    const revived = agentStarted(board, policy, {
      sessionId: "a",
      agentId: "A1",
      parentId: "Main",
      parentIsSubagent: false,
      agentType: "task",
      now: 3,
    });
    expect(revived).toEqual({ pool: "work", used: 3, cap: 2 });
    agentEnded(board, policy, { sessionId: "a", agentId: "A2", now: 4 });
    expect(spawn(board, "a", "task", 5).allowed).toBe(false);
    agentEnded(board, policy, { sessionId: "a", agentId: "A3", now: 6 });
    expect(spawn(board, "a", "task", 7).allowed).toBe(true);
  });

  test("an agent a subagent started stays outside the caps when revived after its parent went idle", () => {
    const scoutsNest: AgentPolicy = { ...policy, nested: { allow: ["scout"], maxRunningPerParent: 1 } };
    const board = boardWith("a");
    run(board, "a", "A1");
    requestSpawn(board, scoutsNest, {
      sessionId: "a",
      parentAgentId: "A1",
      parentIsSubagent: true,
      agentType: "scout",
      spawnKey: "A1.S",
      now: 1,
    });
    agentStarted(board, scoutsNest, {
      sessionId: "a",
      agentId: "A1.S",
      parentId: "A1",
      parentIsSubagent: true,
      agentType: "scout",
      now: 2,
    });
    agentEnded(board, scoutsNest, { sessionId: "a", agentId: "A1.S", now: 3 });
    agentEnded(board, scoutsNest, { sessionId: "a", agentId: "A1", now: 4 });

    expect(
      agentStarted(board, scoutsNest, {
        sessionId: "a",
        agentId: "A1.S",
        parentId: "A1",
        parentIsSubagent: true,
        agentType: "scout",
        now: 5,
      }),
    ).toBeNull();
    expect(run(board, "a", "S1", "scout", 6).allowed).toBe(true);
  });
});

describe("revival while a sibling is starting", () => {
  test("a revived agent does not take a sibling's approved slot, so each is logged truthfully", () => {
    const board = boardWith("a");
    run(board, "a", "X");
    agentEnded(board, policy, { sessionId: "a", agentId: "X", now: 1 });
    requestSpawn(board, policy, {
      sessionId: "a",
      parentAgentId: "Main",
      parentIsSubagent: false,
      agentType: "task",
      spawnKey: "Y",
      now: 2,
    });
    board.events = [];

    agentStarted(board, policy, {
      sessionId: "a",
      agentId: "X",
      parentId: "Main",
      parentIsSubagent: false,
      agentType: "task",
      now: 3,
    });
    agentStarted(board, policy, {
      sessionId: "a",
      agentId: "Y",
      parentId: "Main",
      parentIsSubagent: false,
      agentType: "task",
      now: 4,
    });
    expect(board.events.map(e => [e.data.agentId, e.data.revived])).toEqual([
      ["X", true],
      ["Y", false],
    ]);
  });
});

describe("agents started by subagents", () => {
  function nested(board: Board, parent: string, agentType: string, now = 0) {
    return requestSpawn(board, policy, {
      sessionId: "a",
      parentAgentId: parent,
      parentIsSubagent: true,
      agentType,
      now,
    });
  }

  test("a subagent may not start a worker", () => {
    const board = boardWith("a");
    run(board, "a", "A1");
    expect(nested(board, "A1", "task")).toMatchObject({ allowed: false });
  });

  test("a subagent may run one reviewer at a time, outside the caps", () => {
    const board = boardWith("a");
    run(board, "a", "A1");
    run(board, "a", "A2");
    expect(nested(board, "A1", "reviewer").allowed).toBe(true);
    agentStarted(board, policy, {
      sessionId: "a",
      agentId: "A1.R",
      parentId: "A1",
      parentIsSubagent: true,
      agentType: "reviewer",
      now: 1,
    });
    expect(nested(board, "A1", "reviewer", 2).allowed).toBe(false);
    expect(nested(board, "A2", "reviewer", 2).allowed).toBe(true);

    agentEnded(board, policy, { sessionId: "a", agentId: "A1.R", now: 3 });
    expect(nested(board, "A1", "reviewer", 4).allowed).toBe(true);
  });
});

describe("sessions", () => {
  test("each session gets the first free letter, and a letter is reused once its session is gone", () => {
    const board = emptyBoard();
    const reg = (id: string) =>
      registerSession(board, { id, pid: 1, cwd: "/w", socket: `/s/${id}`, configHash: "h", now: 0 });
    expect([reg("x"), reg("y"), reg("z")]).toEqual(["A", "B", "C"]);
    removeSession(board, policy, "y", 1);
    expect(reg("w")).toBe("B");
  });

  test("a session that is gone frees its slots and leaves the line, and the next in line gets the hold", () => {
    const board = boardWith("a", "b", "c");
    run(board, "a", "A1");
    run(board, "a", "A2");
    spawn(board, "a", "task", 1);
    spawn(board, "b", "task", 2);

    removeSession(board, policy, "a", 3);
    expect(takeNewHolds(board, "b")).toHaveLength(1);
    expect(spawn(board, "c", "task", 4).allowed).toBe(true);
  });
});

describe("messages", () => {
  test("a message reaches only the named session, once", () => {
    const board = boardWith("a", "b", "c");
    expect(sendMessage(board, policy, { from: "a", to: "B", text: "CLAIM x", now: 0 })).toEqual({
      ok: true,
      delivered: ["B"],
    });
    expect(takeInbox(board, "c")).toEqual([]);
    expect(takeInbox(board, "b")).toEqual([{ from: "A", toAgent: undefined, text: "CLAIM x", sentAt: 0 }]);
    expect(takeInbox(board, "b")).toEqual([]);
  });

  test("a message to all reaches every other session", () => {
    const board = boardWith("a", "b", "c");
    expect(sendMessage(board, policy, { from: "a", to: "all", text: "main moved", now: 0 })).toEqual({
      ok: true,
      delivered: ["B", "C"],
    });
    expect(takeInbox(board, "a")).toEqual([]);
  });

  test("a message to an unknown or own session is refused", () => {
    const board = boardWith("a", "b");
    expect(sendMessage(board, policy, { from: "a", to: "Q", text: "hi", now: 0 })).toMatchObject({ ok: false });
    expect(sendMessage(board, policy, { from: "a", to: "A", text: "hi", now: 0 })).toMatchObject({ ok: false });
  });

  test("a session that sends too fast is refused until a minute has passed", () => {
    const board = boardWith("a", "b");
    for (let i = 0; i < 3; i++)
      expect(sendMessage(board, policy, { from: "a", to: "B", text: `m${i}`, now: i }).ok).toBe(true);
    expect(sendMessage(board, policy, { from: "a", to: "B", text: "m3", now: 10 })).toMatchObject({ ok: false });
    expect(sendMessage(board, policy, { from: "a", to: "B", text: "m4", now: MIN + 1 }).ok).toBe(true);
  });
});

describe("event log", () => {
  const log = (board: Board) => board.events.map(e => [e.type, e.label, e.data] as const);

  test("a refusal, the hold that follows, and its use record who waited and for how long", () => {
    const board = boardWith("a", "b");
    run(board, "a", "A1");
    run(board, "a", "A2");
    board.events = [];

    spawn(board, "b", "task", 10);
    agentEnded(board, policy, { sessionId: "a", agentId: "A1", now: 20 });
    spawn(board, "b", "task", 30);

    expect(log(board)).toEqual([
      ["spawn_refused", "B", { agentType: "task", pool: "work", position: 1, used: 2, cap: 2 }],
      ["run_ended", "A", { agentId: "A1", pool: "work", ranMs: 20 }],
      ["hold_granted", "B", { pool: "work", until: 20 + policy.holdMs, waitedMs: 10 }],
      ["hold_used", "B", { pool: "work", waitedMs: 20 }],
      ["spawn_approved", "B", { agentType: "task", pool: "work", nested: false }],
    ]);
  });

  test("unused holds and approvals that never start are recorded when they lapse", () => {
    const board = boardWith("a", "b");
    run(board, "a", "A1");
    spawn(board, "a", "task", 0);
    spawn(board, "b", "task", 1);
    agentEnded(board, policy, { sessionId: "a", agentId: "A1", now: 2 });
    board.events = [];

    expire(board, policy, policy.holdMs + MIN);
    expect(log(board).map(([type, label]) => [type, label])).toEqual([
      ["start_expired", "A"],
      ["hold_expired", "B"],
    ]);
  });

  test("a revival over the cap is recorded as such", () => {
    const board = boardWith("a");
    run(board, "a", "A1");
    run(board, "a", "A2");
    agentEnded(board, policy, { sessionId: "a", agentId: "A1", now: 1 });
    run(board, "a", "A3", "task", 2);
    board.events = [];

    agentStarted(board, policy, {
      sessionId: "a",
      agentId: "A1",
      parentId: "Main",
      parentIsSubagent: false,
      agentType: "task",
      now: 3,
    });
    expect(log(board)).toEqual([
      ["run_started", "A", { agentId: "A1", agentType: "task", pool: "work", used: 3, cap: 2, revived: true }],
    ]);
  });

  test("sessions joining and leaving, and messages, are recorded without the message text", () => {
    const board = emptyBoard();
    registerSession(board, { id: "a", pid: 1, cwd: "/w", socket: "/s/a", configHash: "h", now: 0 });
    registerSession(board, { id: "b", pid: 2, cwd: "/w", socket: "/s/b", configHash: "h", now: 0 });
    sendMessage(board, policy, { from: "a", to: "all", text: "secret plan", now: 1 });
    removeSession(board, policy, "b", 2);

    expect(log(board)).toEqual([
      ["session_joined", "A", { pid: 1, cwd: "/w" }],
      ["session_joined", "B", { pid: 2, cwd: "/w" }],
      ["message_sent", "A", { to: ["B"], chars: 11 }],
      ["session_left", "B", {}],
    ]);
  });
});

describe("how many of a session's own spawns may run at once (omp's spawn queue)", () => {
  const allowance = (board: Board, session: string, now = 0) => spawnAllowance(board, policy, session, now);

  test("an idle session alone may start the default pool's cap; each running agent keeps its place", () => {
    const board = boardWith("a");
    expect(allowance(board, "a")).toBe(2);
    run(board, "a", "A1");
    expect(allowance(board, "a")).toBe(2);
    run(board, "a", "A2");
    expect(allowance(board, "a")).toBe(2);
  });

  test("another session's agents take from the free slots, not from this session's running ones", () => {
    const board = boardWith("a", "b");
    run(board, "a", "A1");
    run(board, "b", "B1");
    expect(allowance(board, "a")).toBe(1);
    expect(allowance(board, "b")).toBe(1);
  });

  test("with every slot taken by others it is 1, never 0, which omp reads as unlimited", () => {
    const board = boardWith("a", "b");
    run(board, "b", "B1");
    run(board, "b", "B2");
    expect(allowance(board, "a")).toBe(1);
  });

  test("a slot held for this session counts; a free slot held for another doesn't", () => {
    const board = boardWith("a", "b");
    run(board, "b", "B1");
    run(board, "b", "B2");
    expect(spawn(board, "a").allowed).toBe(false);
    agentEnded(board, policy, { sessionId: "b", agentId: "B1", now: MIN });
    expect(allowance(board, "a", MIN)).toBe(1);
    expect(allowance(board, "b", MIN)).toBe(1);
    run(board, "a", "A1", "task", MIN);
    expect(allowance(board, "a", MIN)).toBe(1);
  });

  test("while another session waits in line, a slot that frees is not this session's to count", () => {
    const board = boardWith("a", "b");
    run(board, "a", "A1");
    run(board, "a", "A2");
    expect(spawn(board, "b").allowed).toBe(false);
    agentEnded(board, policy, { sessionId: "a", agentId: "A2", now: MIN });
    expect(allowance(board, "a", MIN)).toBe(1);
  });

  test("top-level reviewers hold a place too; other pools' free slots and subagents' reviewers don't add any", () => {
    const board = boardWith("a");
    run(board, "a", "R1", "reviewer");
    expect(allowance(board, "a")).toBe(3);
    requestSpawn(board, policy, {
      sessionId: "a",
      parentAgentId: "R1",
      parentIsSubagent: true,
      agentType: "reviewer",
      now: 0,
    });
    expect(allowance(board, "a")).toBe(3);
  });

  test("while paused only the running agents keep their places", () => {
    const board = boardWith("a");
    run(board, "a", "A1");
    board.pause = { by: null, reason: "maintenance", since: 0 };
    expect(allowance(board, "a")).toBe(1);
  });
});
