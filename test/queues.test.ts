import { describe, expect, test } from "bun:test";
import { type Board, emptyBoard } from "../src/domain/model.ts";
import {
  dropJobs,
  enqueueJob,
  jobEnded,
  orderWaiting,
  positionOf,
  type QueuePolicy,
  setJobPriority,
} from "../src/domain/queues.ts";
import { registerSession, removeSession } from "../src/domain/sessions.ts";

const MIN = 60_000;

const base: QueuePolicy = {
  slots: 1,
  order: "fifo",
  lanes: ["front", "normal"],
  agingMs: null,
  onDuplicate: "refuse",
  timeoutMs: null,
  loadSlots: [],
};
const queues = (p: Partial<QueuePolicy> = {}) => ({ heavy: { ...base, ...p } });

let next = 0;
function enqueue(
  board: Board,
  q: ReturnType<typeof queues>,
  j: { owner?: string | null; lane?: string; priority?: number; key?: string; now?: number },
) {
  const id = `j${++next}`;
  const r = enqueueJob(board, q, {
    id,
    queue: "heavy",
    owner: j.owner === undefined ? "a" : j.owner,
    ...(j.lane === undefined ? {} : { lane: j.lane }),
    priority: j.priority ?? 0,
    ...(j.key === undefined ? {} : { key: j.key }),
    command: "cargo xtask ci",
    socket: `/s/${id}`,
    pid: 1,
    now: j.now ?? 0,
  });
  return { id, ...r };
}

const state = (board: Board, id: string) => board.jobs.find(j => j.id === id)?.state;
const waitingOrder = (board: Board, q: ReturnType<typeof queues>, now = 0) =>
  orderWaiting(q.heavy, "heavy", board, now).map(j => j.id);

describe("a queue runs at most its slots at once", () => {
  test("the first job starts at once; the next waits until it ends, then starts", () => {
    const board = emptyBoard();
    const q = queues();
    const a = enqueue(board, q, { now: 0 });
    const b = enqueue(board, q, { now: 1 });
    expect([state(board, a.id), state(board, b.id)]).toEqual(["running", "waiting"]);
    expect(positionOf(board, q, b.id, 1)).toBe(1);

    jobEnded(board, q, { id: a.id, exitCode: 0, now: 5 });
    expect(state(board, b.id)).toBe("running");
  });

  test("a job whose runner died frees its slot for the next", () => {
    const board = emptyBoard();
    const q = queues();
    const a = enqueue(board, q, {});
    const b = enqueue(board, q, { now: 1 });
    dropJobs(board, q, [a.id], 2);
    expect(state(board, a.id)).toBeUndefined();
    expect(state(board, b.id)).toBe("running");
  });
});

describe("lanes", () => {
  test("the front lane goes first, first come first served within each lane", () => {
    const board = emptyBoard();
    const q = queues();
    enqueue(board, q, { now: 0 });
    const n1 = enqueue(board, q, { now: 1 });
    const f1 = enqueue(board, q, { lane: "front", now: 2 });
    const n2 = enqueue(board, q, { now: 3 });
    const f2 = enqueue(board, q, { lane: "front", now: 4 });
    expect(waitingOrder(board, q)).toEqual([f1.id, f2.id, n1.id, n2.id]);
  });

  test("an unknown lane or queue is refused", () => {
    const board = emptyBoard();
    expect(enqueue(board, queues(), { lane: "vip" })).toMatchObject({ ok: false });
    expect(
      enqueueJob(board, queues(), {
        id: "x",
        queue: "nope",
        owner: "a",
        priority: 0,
        command: "c",
        socket: "/s",
        pid: 1,
        now: 0,
      }),
    ).toMatchObject({ ok: false });
  });
});

describe("duplicate jobs", () => {
  test("a second job with the same key is refused while one waits or runs", () => {
    const board = emptyBoard();
    const q = queues();
    enqueue(board, q, { key: "/w/one ci" });
    expect(enqueue(board, q, { key: "/w/one ci" })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/already running/),
    });
    enqueue(board, q, { key: "/w/two ci" });
    expect(enqueue(board, q, { key: "/w/two ci" })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/already in line/),
    });
  });

  test("with supersede, a new job replaces the waiting one with the same key and keeps its place", () => {
    const board = emptyBoard();
    const q = queues({ onDuplicate: "supersede" });
    enqueue(board, q, {});
    const old = enqueue(board, q, { key: "k", now: 1 });
    const other = enqueue(board, q, { now: 2 });
    const fresh = enqueue(board, q, { key: "k", now: 3 });
    expect(fresh.ok).toBe(true);
    expect(state(board, old.id)).toBe("superseded");
    expect(waitingOrder(board, q)).toEqual([fresh.id, other.id]);
  });
});

describe("fair share across sessions", () => {
  test("sessions take turns, so a session with many jobs does not crowd out one with a single job", () => {
    const board = emptyBoard();
    const q = queues({ order: "fair-share" });
    enqueue(board, q, { owner: "a", now: 0 });
    const a2 = enqueue(board, q, { owner: "a", now: 1 });
    const a3 = enqueue(board, q, { owner: "a", now: 2 });
    const a4 = enqueue(board, q, { owner: "a", now: 3 });
    const b1 = enqueue(board, q, { owner: "b", now: 4 });
    expect(waitingOrder(board, q)).toEqual([b1.id, a2.id, a3.id, a4.id]);
  });

  test("within a session, higher priority goes first; across sessions it changes nothing", () => {
    const board = emptyBoard();
    const q = queues({ order: "fair-share" });
    enqueue(board, q, { owner: "c", now: 0 });
    const a1 = enqueue(board, q, { owner: "a", now: 1 });
    const a2 = enqueue(board, q, { owner: "a", priority: 5, now: 2 });
    const b1 = enqueue(board, q, { owner: "b", now: 3 });
    expect(waitingOrder(board, q)).toEqual([a2.id, b1.id, a1.id]);
  });

  test("a session may reorder only its own waiting jobs, and the change is logged", () => {
    const board = emptyBoard();
    const q = queues({ order: "fair-share" });
    enqueue(board, q, { owner: "c" });
    const a1 = enqueue(board, q, { owner: "a", now: 1 });
    const a2 = enqueue(board, q, { owner: "a", now: 2 });
    expect(setJobPriority(board, { id: a2.id, sessionId: "b", priority: 9, now: 3 })).toMatchObject({ ok: false });
    expect(setJobPriority(board, { id: a2.id, sessionId: "a", priority: 9, now: 3 })).toEqual({ ok: true });
    expect(waitingOrder(board, q, 3)).toEqual([a2.id, a1.id]);
    expect(board.events.at(-1)).toMatchObject({ type: "job_reprioritized", data: { job: a2.id, priority: 9 } });
  });
});

describe("priority order with aging", () => {
  test("higher priority goes first, but waiting raises priority so nothing waits forever", () => {
    const board = emptyBoard();
    const q = queues({ order: "priority", agingMs: 10 * MIN });
    enqueue(board, q, {});
    const old = enqueue(board, q, { priority: 0, now: 0 });
    const urgent = enqueue(board, q, { priority: 3, now: 25 * MIN });
    expect(waitingOrder(board, q, 25 * MIN)).toEqual([urgent.id, old.id]);
    expect(waitingOrder(board, q, 40 * MIN)).toEqual([old.id, urgent.id]);
  });
});

describe("event log", () => {
  test("queueing, starting and ending record how long a job waited and ran", () => {
    const board = emptyBoard();
    const q = queues();
    const a = enqueue(board, q, { key: "k", now: 0 });
    const b = enqueue(board, q, { now: 10 });
    jobEnded(board, q, { id: a.id, exitCode: 3, now: 30 });
    expect(board.events.map(e => [e.type, e.data.job])).toEqual([
      ["job_queued", a.id],
      ["job_started", a.id],
      ["job_queued", b.id],
      ["job_ended", a.id],
      ["job_started", b.id],
    ]);
    expect(board.events[3]?.data).toMatchObject({ exitCode: 3, ranMs: 30 });
    expect(board.events[4]?.data).toMatchObject({ waitedMs: 20 });
  });

  test("a job from outside any omp session is logged with no session", () => {
    const board = emptyBoard();
    enqueue(board, queues(), { owner: null });
    expect(board.events[0]).toMatchObject({ type: "job_queued", sessionId: null, label: null });
  });
});

describe("fair-share history", () => {
  test("a session that ends takes its turn history with it", () => {
    const board = emptyBoard();
    registerSession(board, { id: "s", pid: 1, cwd: "/w", socket: "/s/s", configHash: "h", now: 0 });
    const a = enqueue(board, queues({ order: "fair-share" }), { owner: "s" });
    jobEnded(board, queues({ order: "fair-share" }), { id: a.id, exitCode: 0, now: 1 });
    expect(board.served).toHaveLength(1);
    removeSession(
      board,
      {
        pools: {},
        defaultPool: "work",
        exempt: [],
        nested: { allow: [], maxRunningPerParent: 1 },
        holdMs: 1,
        startTimeoutMs: 1,
        messagesPerMinute: 1,
      },
      "s",
      2,
    );
    expect(board.served).toEqual([]);
  });
});
