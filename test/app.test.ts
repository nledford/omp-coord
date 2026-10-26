import { describe, expect, test } from "bun:test";
import { Coordinator } from "../src/app/coordinator.ts";
import { EXIT_NOT_RUN, type RunnerPorts, runJob } from "../src/app/job-runner.ts";
import { parseConfig } from "../src/config.ts";
import { enqueueJob } from "../src/domain/queues.ts";
import { registerSession } from "../src/domain/sessions.ts";
import { FakeClock, FakeLiveness, MemoryRepository, fakeListener } from "./support/fakes.ts";

const config = parseConfig({ scope: "t", agents: { pools: { work: { cap: 1 } } }, queues: { heavy: { slots: 1 } } }, "/t/.omp-coord.json");

function setup() {
  const repo = new MemoryRepository();
  const liveness = new FakeLiveness();
  const clock = new FakeClock();
  return { repo, liveness, clock, coordinator: new Coordinator(config, repo, liveness, clock) };
}

const me = { id: "me", pid: 1, cwd: "/w", address: "/s/me" };

describe("a session pruning the board", () => {
  test("drops sessions and jobs whose process is gone, frees their slots, and clears what they left behind", async () => {
    const { repo, liveness, clock, coordinator } = setup();
    coordinator.join(me);
    coordinator.join({ id: "other", pid: 2, cwd: "/w", address: "/s/other" });
    coordinator.requestSpawn({ sessionId: "other", parentAgentId: "Main", parentIsSubagent: false, agentType: "task", spawnKey: "X" });
    repo.transact(b =>
      enqueueJob(b, config.queues, { id: "j", queue: "heavy", owner: null, priority: 0, command: "c", socket: "/s/job-j", pid: 3, now: clock.now() }),
    );
    liveness.dead.add("/s/other").add("/s/job-j");

    expect(await coordinator.prune("me")).toEqual({ sessions: 1, jobs: 1 });
    expect(repo.board.sessions.map(s => s.id)).toEqual(["me"]);
    expect(repo.board.slots).toEqual([]);
    expect(repo.board.jobs).toEqual([]);
    expect(liveness.forgotten.sort()).toEqual(["/s/job-j", "/s/other"]);
  });

  test("a session that stopped while checking writes nothing", async () => {
    const { repo, liveness, coordinator } = setup();
    coordinator.join(me);
    coordinator.join({ id: "other", pid: 2, cwd: "/w", address: "/s/other" });
    liveness.dead.add("/s/other");
    await coordinator.prune("me", () => false);
    expect(repo.board.sessions).toHaveLength(2);
    expect(liveness.forgotten).toEqual([]);
  });

  test("the tick re-registers a session another session dropped, under a letter", () => {
    const { repo, coordinator } = setup();
    expect(coordinator.tick(me).label).toBe("A");
    repo.transact(b => registerSession(b, { id: "x", pid: 2, cwd: "/w", socket: "/s/x", now: 0 }));
    repo.board.sessions = repo.board.sessions.filter(s => s.id !== "me");
    expect(coordinator.tick(me).label).toBe("A");
    expect(repo.board.sessions.map(s => s.id).sort()).toEqual(["me", "x"]);
  });
});

describe("running a job through a queue", () => {
  function runner(repo: MemoryRepository, liveness: FakeLiveness, clock: FakeClock, over: Partial<RunnerPorts> = {}) {
    const log: string[] = [];
    let n = 0;
    const ports: RunnerPorts = {
      repo,
      liveness,
      clock,
      listen: () => fakeListener(`/s/job-${++n}`, log),
      sleep: async ms => {
        clock.t += ms;
      },
      execute: async () => {
        log.push("execute");
        return 3;
      },
      stopRequested: () => undefined,
      report: line => log.push(line),
      ...over,
    };
    return { ports, log };
  }
  const spec = { id: "mine", queue: "heavy", owner: null, priority: 0, command: "make", pid: 1 };

  test("waits while the slot is taken, drops a holder whose runner died, then runs and leaves with the exit code", async () => {
    const { repo, liveness, clock } = setup();
    repo.transact(b =>
      enqueueJob(b, config.queues, { id: "holder", queue: "heavy", owner: null, priority: 0, command: "c", socket: "/s/holder", pid: 2, now: clock.now() }),
    );
    liveness.dead.add("/s/holder");
    const { ports, log } = runner(repo, liveness, clock);

    expect(await runJob(spec, config.queues, ports)).toBe(3);
    expect(log.filter(l => !l.startsWith("omp-coord: waiting"))).toEqual(["listen /s/job-1", "omp-coord: got a heavy slot after 4 s", "execute", "stop /s/job-1"]);
    expect(repo.board.jobs).toEqual([]);
    expect(repo.events().map(e => e.type)).toContain("job_lost");
  });

  test("a stop while waiting leaves the line without running the command", async () => {
    const { repo, liveness, clock } = setup();
    repo.transact(b =>
      enqueueJob(b, config.queues, { id: "holder", queue: "heavy", owner: null, priority: 0, command: "c", socket: "/s/holder", pid: 2, now: clock.now() }),
    );
    let polls = 0;
    const { ports, log } = runner(repo, liveness, clock, { stopRequested: () => (++polls > 2 ? 130 : undefined) });
    expect(await runJob(spec, config.queues, ports)).toBe(130);
    expect(log).not.toContain("execute");
    expect(repo.board.jobs.map(j => j.id)).toEqual(["holder"]);
    expect(repo.events().map(e => e.type)).toContain("job_withdrawn");
  });

  test("a runner wrongly dropped from the board answers again and rejoins the line", async () => {
    const { repo, liveness, clock } = setup();
    repo.transact(b =>
      enqueueJob(b, config.queues, { id: "holder", queue: "heavy", owner: null, priority: 0, command: "c", socket: "/s/holder", pid: 2, now: clock.now() }),
    );
    let dropped = false;
    const { ports, log } = runner(repo, liveness, clock, {
      sleep: async ms => {
        clock.t += ms;
        if (!dropped) {
          dropped = true;
          repo.board.jobs = repo.board.jobs.filter(j => j.id !== "mine");
        } else {
          repo.board.jobs = repo.board.jobs.filter(j => j.id !== "holder");
        }
      },
    });
    expect(await runJob(spec, config.queues, ports)).toBe(3);
    expect(log.filter(l => l.startsWith("listen") || l.startsWith("stop"))).toEqual(["listen /s/job-1", "stop /s/job-1", "listen /s/job-2", "stop /s/job-2"]);
  });

  test("a duplicate of a running job is not run", async () => {
    const { repo, liveness, clock } = setup();
    repo.transact(b =>
      enqueueJob(b, config.queues, { id: "first", queue: "heavy", owner: null, priority: 0, key: "k", command: "c", socket: "/s/f", pid: 2, now: clock.now() }),
    );
    const { ports, log } = runner(repo, liveness, clock);
    expect(await runJob({ ...spec, key: "k" }, config.queues, ports)).toBe(EXIT_NOT_RUN);
    expect(log).toContain("omp-coord: already running: k; wait for it");
  });
});
