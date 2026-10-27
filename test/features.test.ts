import { describe, expect, test } from "bun:test";
import { agentEnded, agentStarted, requestSpawn } from "../src/domain/agents.ts";
import { claim, claimConflict, release } from "../src/domain/claims.ts";
import { pause, resume } from "../src/domain/control.ts";
import { interrupted, stats } from "../src/domain/history.ts";
import { observeLoad } from "../src/domain/limits.ts";
import { sendMessage, takeInbox } from "../src/domain/messages.ts";
import { type AgentPolicy, type Board, type BoardEvent, emptyBoard } from "../src/domain/model.ts";
import { addNote } from "../src/domain/notes.ts";
import { agentPorts } from "../src/domain/ports.ts";
import { enqueueJob, jobEnded, type QueuePolicy } from "../src/domain/queues.ts";
import { registerSession, removeSession } from "../src/domain/sessions.ts";

const MIN = 60_000;
const policy: AgentPolicy = {
  pools: { work: { cap: 2, agentTypes: [], loadCaps: [{ above: 100, limit: 1 }] } },
  defaultPool: "work",
  exempt: ["reviewer"],
  nested: { allow: ["reviewer"], maxRunningPerParent: 1 },
  holdMs: 5 * MIN,
  startTimeoutMs: MIN,
  messagesPerMinute: 10,
  queueSpawns: true,
};
const queues: Record<string, QueuePolicy> = {
  heavy: {
    slots: 2,
    order: "fifo",
    lanes: ["normal"],
    agingMs: null,
    onDuplicate: "refuse",
    timeoutMs: null,
    loadSlots: [{ above: 100, limit: 1 }],
  },
};

function boardWith(...ids: string[]): Board {
  const b = emptyBoard();
  for (const id of ids)
    registerSession(b, { id, pid: 1, cwd: `/w/${id}`, socket: `/s/${id}`, configHash: "h", now: 0 });
  return b;
}
const spawn = (b: Board, session: string, agentType = "task", now = 0) =>
  requestSpawn(b, policy, { sessionId: session, parentAgentId: "Main", parentIsSubagent: false, agentType, now });
const job = (b: Board, id: string, now = 0) =>
  enqueueJob(b, queues, {
    id,
    queue: "heavy",
    owner: null,
    priority: 0,
    command: "c",
    socket: `/s/${id}`,
    pid: 1,
    now,
  });

describe("pause and drain", () => {
  test("while paused, new agents and queued jobs wait; running ones go on; resuming lets them start", () => {
    const b = boardWith("a");
    job(b, "j1");
    pause(b, { by: "a", reason: "merging tools", now: 1 });
    expect(spawn(b, "a", "task", 2)).toMatchObject({
      allowed: false,
      reason: expect.stringMatching(/paused by session A: merging tools/),
    });
    expect(spawn(b, "a", "reviewer", 2).allowed).toBe(true);
    job(b, "j2", 3);
    expect(b.jobs.map(j => j.state)).toEqual(["running", "waiting"]);

    resume(b, policy, queues, { by: "a", now: 4 });
    expect(b.jobs.map(j => j.state)).toEqual(["running", "running"]);
    expect(b.waitlist.find(t => t.sessionId === "a")?.holdUntil).toBe(4 + policy.holdMs);
    expect(b.events.map(e => e.type)).toContain("paused");
  });

  test("a slot held for a session when the pause starts stays held through it, with the full hold time after", () => {
    const one: AgentPolicy = { ...policy, pools: { work: { cap: 1, agentTypes: [], loadCaps: [] } } };
    const b = boardWith("a", "b", "c");
    requestSpawn(b, one, { sessionId: "a", parentAgentId: "Main", parentIsSubagent: false, agentType: "task", now: 0 });
    agentStarted(b, one, {
      sessionId: "a",
      agentId: "A1",
      parentId: "Main",
      parentIsSubagent: false,
      agentType: "task",
      now: 0,
    });
    for (const s of ["b", "c"])
      requestSpawn(b, one, { sessionId: s, parentAgentId: "Main", parentIsSubagent: false, agentType: "task", now: 1 });
    agentEnded(b, one, { sessionId: "a", agentId: "A1", now: 2 });
    expect(b.waitlist.find(t => t.sessionId === "b")?.holdUntil).toBe(2 + one.holdMs);

    pause(b, { by: null, reason: "merging", now: 3 });
    agentEnded(b, one, { sessionId: "a", agentId: "none", now: 60 * MIN }); // a tick long after the hold would have run out
    resume(b, one, {}, { by: null, now: 61 * MIN });
    expect(b.waitlist.map(t => [t.sessionId, t.holdUntil])).toEqual([
      ["b", 61 * MIN + one.holdMs],
      ["c", undefined],
    ]);
    expect(
      requestSpawn(b, one, {
        sessionId: "b",
        parentAgentId: "Main",
        parentIsSubagent: false,
        agentType: "task",
        now: 62 * MIN,
      }).allowed,
    ).toBe(true);
  });
});

describe("load-aware limits", () => {
  test("under high load the lower caps apply; a stale reading is ignored", () => {
    const b = boardWith("a");
    observeLoad(b, 150, 0);
    expect(spawn(b, "a", "task", 1).allowed).toBe(true);
    expect(spawn(b, "a", "task", 2)).toMatchObject({ allowed: false, reason: expect.stringMatching(/load 150/) });
    job(b, "j1", 3);
    job(b, "j2", 3);
    expect(b.jobs.map(j => j.state)).toEqual(["running", "waiting"]);

    observeLoad(b, 20, 4);
    job(b, "j3", 5);
    expect(b.jobs.map(j => j.state)).toEqual(["running", "running", "waiting"]);
    const stale = boardWith("x");
    observeLoad(stale, 500, 0);
    expect(
      requestSpawn(stale, policy, {
        sessionId: "x",
        parentAgentId: "Main",
        parentIsSubagent: false,
        agentType: "task",
        now: 10 * MIN,
      }).allowed,
    ).toBe(true);
    expect(
      requestSpawn(stale, policy, {
        sessionId: "x",
        parentAgentId: "Main",
        parentIsSubagent: false,
        agentType: "task",
        now: 10 * MIN,
      }).allowed,
    ).toBe(true);
  });
});

describe("claims", () => {
  test("a claim is exclusive to its session, ends with it, and can be released", () => {
    const b = boardWith("a", "b");
    expect(claim(b, { sessionId: "a", agentId: "Main", kind: "branch", target: "fix-x", note: "", now: 0 })).toEqual({
      ok: true,
    });
    expect(
      claim(b, { sessionId: "b", agentId: "Main", kind: "branch", target: "fix-x", note: "", now: 1 }),
    ).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/session A/),
    });
    expect(release(b, { sessionId: "b", kind: "branch", target: "fix-x", now: 2 })).toMatchObject({ ok: false });
    removeSession(b, policy, "a", 3);
    expect(claim(b, { sessionId: "b", agentId: "Main", kind: "branch", target: "fix-x", note: "", now: 4 })).toEqual({
      ok: true,
    });
  });

  test("git and gh commands that change another session's claimed branch, worktree or PR are refused", () => {
    const b = boardWith("a", "b");
    claim(b, {
      sessionId: "a",
      agentId: "W1",
      kind: "worktree",
      target: "/repo/.claude/worktrees/w1",
      note: "",
      now: 0,
    });
    claim(b, { sessionId: "a", agentId: "Main", kind: "branch", target: "fix-x", note: "", now: 0 });
    claim(b, { sessionId: "a", agentId: "Main", kind: "pr", target: "2913", note: "", now: 0 });
    const by = (command: string, cwd = "/repo") => claimConflict(b, { sessionId: "b", command, cwd })?.target;

    expect(by("git commit -am wip", "/repo/.claude/worktrees/w1/src")).toBe("/repo/.claude/worktrees/w1");
    expect(by("cd .claude/worktrees/w1 && git rebase origin/main")).toBe("/repo/.claude/worktrees/w1");
    expect(by("git -C /repo/.claude/worktrees/w1 push fork HEAD")).toBe("/repo/.claude/worktrees/w1");
    expect(by("git push fork fix-x")).toBe("fix-x");
    expect(by("git push --force-with-lease fork fix-x:fix-x")).toBe("fix-x");
    expect(by("gh pr edit 2913 --body-file b.md")).toBe("2913");
    expect(by("gh pr comment #2913 -b hi")).toBe("2913");

    expect(by("git status", "/repo/.claude/worktrees/w1")).toBeUndefined();
    expect(by("git log fix-x")).toBeUndefined();
    expect(by("gh pr view 2913")).toBeUndefined();
    expect(by("git push fork fix-xy")).toBeUndefined();
    expect(claimConflict(b, { sessionId: "a", command: "git push fork fix-x", cwd: "/repo" })).toBeUndefined();
  });

  test("the guard sees force-pushes, flags before a PR number, PR URLs and gh api writes", () => {
    const b = boardWith("a", "b");
    claim(b, { sessionId: "a", agentId: "Main", kind: "branch", target: "fix-x", note: "", now: 0 });
    claim(b, { sessionId: "a", agentId: "Main", kind: "pr", target: "2913", note: "", now: 0 });
    const by = (command: string) => claimConflict(b, { sessionId: "b", command, cwd: "/repo" })?.target;

    expect(by("git push fork +fix-x")).toBe("fix-x");
    expect(by("git push fork +HEAD:fix-x")).toBe("fix-x");
    expect(by("gh pr merge --squash 2913")).toBe("2913");
    expect(by("gh pr review --approve 2913")).toBe("2913");
    expect(by("gh pr merge https://github.com/o/r/pull/2913")).toBe("2913");
    expect(by("gh api -X PATCH repos/o/r/pulls/2913 -f title=x")).toBe("2913");
    expect(by("gh api repos/o/r/issues/2913/comments -f body=hi")).toBe("2913");

    expect(by("gh api repos/o/r/pulls/2913")).toBeUndefined();
    expect(by("gh api -X GET repos/o/r/pulls/2913/files -f per_page=100")).toBeUndefined();
    expect(by("gh api --method=GET repos/o/r/pulls/2913/files -F per_page=100")).toBeUndefined();
    expect(by("gh pr merge --squash 2914 && echo 2913")).toBeUndefined();
    expect(by('gh pr comment 100 --body "fixes the 2913 regression"')).toBeUndefined();
    expect(by("gh pr comment 100 -b 'Supersedes #2913 and more'")).toBeUndefined();
    expect(by('gh pr edit 100 --title="Port 2913 fix"')).toBeUndefined();
    expect(by('gh pr edit 2913 --title "Port 100 fix"')).toBe("2913");
  });

  test("the guard leaves alone commit messages, nested worktrees and commands that cd out of a claimed worktree", () => {
    const b = boardWith("a", "b");
    claim(b, { sessionId: "a", agentId: "Main", kind: "branch", target: "docs", note: "", now: 0 });
    claim(b, { sessionId: "a", agentId: "Main", kind: "worktree", target: "/repo", note: "", now: 0 });
    const roots = new Set(["/repo", "/repo/.claude/worktrees/b1"]);
    const by = (command: string, cwd: string) =>
      claimConflict(b, { sessionId: "b", command, cwd, home: "/home/u", isWorktreeRoot: d => roots.has(d) })?.target;
    const mine = "/repo/.claude/worktrees/b1";

    expect(by('git commit -m "docs: tidy readme"', mine)).toBeUndefined();
    expect(by("git commit -am 'docs: tidy'", mine)).toBeUndefined();
    expect(by("git commit --message=docs", mine)).toBeUndefined();
    expect(by("git commit -am wip", `${mine}/src`)).toBeUndefined();
    expect(by(`cd ${mine} && git commit -am wip`, "/repo")).toBeUndefined();

    expect(by("git commit -am wip", "/repo/src")).toBe("/repo");
    expect(by(`cd ${mine} && git -C /repo commit -am wip`, "/tmp")).toBe("/repo");
    expect(by("git branch -m docs old-docs", mine)).toBe("docs");
    expect(by("git checkout -m docs", mine)).toBe("docs");
    expect(by("git switch -m docs", mine)).toBe("docs");
    expect(by("git push fork docs", mine)).toBe("docs");
    expect(by("/usr/bin/git commit -am wip", "/repo/src")).toBe("/repo");
    expect(by("cd /repo; git commit -am wip", "/tmp")).toBe("/repo");
    expect(by(`cd ${mine}&&git commit -am wip`, "/repo")).toBeUndefined();
  });

  test("cd to the home folder resolves through it", () => {
    const b = boardWith("a", "b");
    claim(b, { sessionId: "a", agentId: "Main", kind: "worktree", target: "/home/u/repo/wt", note: "", now: 0 });
    const by = (command: string) => claimConflict(b, { sessionId: "b", command, cwd: "/tmp", home: "/home/u" })?.target;
    expect(by("cd ~/repo/wt && git commit -am wip")).toBe("/home/u/repo/wt");
    expect(by('cd "$HOME/repo/wt" && git commit -am wip')).toBe("/home/u/repo/wt");
    expect(
      claimConflict(b, {
        sessionId: "b",
        command: "cd && cd repo/wt && git commit -am wip",
        cwd: "/tmp",
        home: "/home/u",
      })?.target,
    ).toBe("/home/u/repo/wt");
  });
});

describe("decision log", () => {
  test("notes are numbered and keep who wrote them", () => {
    const b = boardWith("a");
    addNote(b, { sessionId: "a", author: "Main", text: "  User: ship #2913 first  ", now: 5 });
    addNote(b, { sessionId: null, author: "nledford", text: "freeze main till 6 PM", now: 6 });
    expect(b.notes).toEqual([
      { id: 1, at: 5, label: "A", author: "Main", text: "User: ship #2913 first" },
      { id: 2, at: 6, label: null, author: "nledford", text: "freeze main till 6 PM" },
    ]);
  });
});

describe("port ranges", () => {
  const ports = { from: 18700, to: 18999, perSession: 100, perAgent: 10 };

  test("each session gets its own block, reused once its session is gone", () => {
    const b = emptyBoard();
    const reg = (id: string) =>
      registerSession(b, { id, pid: 1, cwd: "/w", socket: `/s/${id}`, configHash: "h", now: 0 }, ports);
    reg("a");
    reg("b");
    expect(b.sessions.map(s => s.ports)).toEqual([
      { from: 18700, to: 18799 },
      { from: 18800, to: 18899 },
    ]);
    removeSession(b, policy, "a", 1);
    reg("c");
    expect(b.sessions.find(s => s.id === "c")?.ports).toEqual({ from: 18700, to: 18799 });
  });

  test("agents take blocks from their session's range, keep them, and run out with a clear reason", () => {
    const b = emptyBoard();
    registerSession(
      b,
      { id: "a", pid: 1, cwd: "/w", socket: "/s/a", configHash: "h", now: 0 },
      { ...ports, perSession: 20 },
    );
    expect(agentPorts(b, { sessionId: "a", agentId: "X", perAgent: 10 })).toEqual({
      ok: true,
      ports: { from: 18700, to: 18709 },
    });
    expect(agentPorts(b, { sessionId: "a", agentId: "Y", perAgent: 10 })).toEqual({
      ok: true,
      ports: { from: 18710, to: 18719 },
    });
    expect(agentPorts(b, { sessionId: "a", agentId: "X", perAgent: 10 })).toEqual({
      ok: true,
      ports: { from: 18700, to: 18709 },
    });
    expect(agentPorts(b, { sessionId: "a", agentId: "Z", perAgent: 10 })).toMatchObject({ ok: false });
  });
});

describe("messages to another session's subagent", () => {
  test("`B/Name` reaches that agent in session B", () => {
    const b = boardWith("a", "b");
    expect(sendMessage(b, policy, { from: "a", to: "B/RebaseWave1", text: "main moved", now: 0 })).toEqual({
      ok: true,
      delivered: ["B/RebaseWave1"],
    });
    expect(takeInbox(b, "b")).toEqual([{ from: "A", toAgent: "RebaseWave1", text: "main moved", sentAt: 0 }]);
  });
});

describe("history from the event log", () => {
  function log(fill: (b: Board) => void): BoardEvent[] {
    const b = boardWith("a", "b");
    fill(b);
    return b.events;
  }

  test("agents still running when their session left are listed, with the session's folder", () => {
    const events = log(b => {
      spawn(b, "a");
      agentStarted(b, policy, {
        sessionId: "a",
        agentId: "Fix1",
        parentId: "Main",
        parentIsSubagent: false,
        agentType: "task",
        now: 1,
      });
      agentStarted(b, policy, {
        sessionId: "a",
        agentId: "Done",
        parentId: "Main",
        parentIsSubagent: false,
        agentType: "task",
        now: 1,
      });
      agentEnded(b, policy, { sessionId: "a", agentId: "Done", now: 2 });
      removeSession(b, policy, "a", 3);
    });
    expect(interrupted(events, 0)).toEqual([
      { label: "A", cwd: "/w/a", leftAt: 3, agents: [{ id: "Fix1", type: "task", startedAt: 1 }] },
    ]);
  });

  describe("agents revived after their session left", () => {
    // A spawned agent's first run: approval in the parent, then the run (`revived: false`).
    const spawned = (b: Board, sessionId: string, agentId: string, now: number) => {
      spawn(b, sessionId, "task", now);
      start(b, sessionId, agentId, now);
    };
    // A run with no spawn approval, as `write agent://<id>` starts it (`revived: true`).
    const start = (b: Board, sessionId: string, agentId: string, now: number) =>
      agentStarted(b, policy, {
        sessionId,
        agentId,
        parentId: "Main",
        parentIsSubagent: false,
        agentType: "task",
        now,
      });
    const restarted = (b: Board, id: string, cwd: string, now: number) =>
      registerSession(b, { id, pid: 2, cwd, socket: `/s/${id}`, configHash: "h", now });
    const crashed = (b: Board) => {
      spawned(b, "a", "Fix1", 1);
      spawned(b, "a", "Fix2", 1);
      start(b, "a", "Fix1.Rev", 2);
      removeSession(b, policy, "a", 3);
    };

    test("a revived agent and its nested helpers are no longer listed; the rest is", () => {
      const events = log(b => {
        crashed(b);
        restarted(b, "c", "/w/a", 4);
        start(b, "c", "Fix1", 5);
        agentEnded(b, policy, { sessionId: "c", agentId: "Fix1", now: 6 });
      });
      expect(interrupted(events, 0)).toEqual([
        { label: "A", cwd: "/w/a", leftAt: 3, agents: [{ id: "Fix2", type: "task", startedAt: 1 }] },
      ]);
    });

    test("a session whose agents were all revived is left out", () => {
      const events = log(b => {
        crashed(b);
        restarted(b, "c", "/w/a", 4);
        start(b, "c", "Fix1", 5);
        start(b, "c", "Fix2", 5);
      });
      expect(interrupted(events, 0)).toEqual([]);
    });

    const listedA = {
      label: "A",
      cwd: "/w/a" as string | undefined,
      leftAt: 3,
      agents: [
        { id: "Fix1", type: "task", startedAt: 1 },
        { id: "Fix2", type: "task", startedAt: 1 },
        { id: "Fix1.Rev", type: "task", startedAt: 2 },
      ],
    };
    const allListed = [listedA];

    test("a new agent reusing the name, or a revival from another folder, hides nothing", () => {
      const events = log(b => {
        crashed(b);
        // spawned anew in the same folder: not a revival
        restarted(b, "c", "/w/a", 4);
        spawned(b, "c", "Fix1", 5);
        // revived, but from another folder
        start(b, "b", "Fix2", 5);
      });
      expect(interrupted(events, 0)).toEqual(allListed);
    });

    test("a session running its own agent again hides nothing", () => {
      const events = log(b => {
        // a session in the same folder spawned its own Fix1 and Fix2 before A left, and runs them again after
        restarted(b, "c", "/w/a", 0);
        spawned(b, "c", "Fix1", 1);
        spawned(b, "c", "Fix2", 1);
        agentEnded(b, policy, { sessionId: "c", agentId: "Fix1", now: 1 });
        agentEnded(b, policy, { sessionId: "c", agentId: "Fix2", now: 1 });
        crashed(b);
        start(b, "c", "Fix1", 5);
        start(b, "c", "Fix2", 5);
      });
      expect(interrupted(events, 0)).toEqual(allListed);
    });

    test("a revival whose folder is unknown (its join event pruned) hides nothing", () => {
      const events = log(b => {
        crashed(b);
        restarted(b, "c", "/w/a", 4);
        start(b, "c", "Fix1", 5);
        start(b, "c", "Fix2", 5);
      }).filter(e => e.type !== "session_joined");
      expect(interrupted(events, 0)).toEqual([{ ...listedA, cwd: undefined }]);
    });
  });

  test("stats count refusals, waits, peak agents and job outcomes per day", () => {
    const events = log(b => {
      spawn(b, "a", "task", 0);
      agentStarted(b, policy, {
        sessionId: "a",
        agentId: "A1",
        parentId: "Main",
        parentIsSubagent: false,
        agentType: "task",
        now: 0,
      });
      spawn(b, "b", "task", 0);
      agentStarted(b, policy, {
        sessionId: "b",
        agentId: "B1",
        parentId: "Main",
        parentIsSubagent: false,
        agentType: "task",
        now: 0,
      });
      spawn(b, "b", "task", MIN);
      job(b, "j1", 0);
      job(b, "j2", 0);
      job(b, "j3", 0);
      jobEnded(b, queues, { id: "j1", exitCode: 1, now: 2 * MIN });
      jobEnded(b, queues, { id: "j3", exitCode: 0, timedOut: true, now: 5 * MIN });
    });
    const s = stats(events, 0);
    expect(s.days).toHaveLength(1);
    expect(s.days[0]).toMatchObject({ refusals: 1, peakAgents: { work: 2 } });
    expect(s.days[0]?.queues.heavy).toEqual({
      started: 3,
      avgWaitMs: 40_000,
      maxWaitMs: 2 * MIN,
      ended: 2,
      failed: 2,
      timedOut: 1,
    });
  });
});
