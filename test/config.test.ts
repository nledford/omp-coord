import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, findConfigFile, parseConfig } from "../src/config.ts";

describe("config", () => {
  test("a minimal file gets one work pool of 8, and subagents may start only the exempt types", () => {
    const c = parseConfig({ scope: "proj", agents: { exempt: ["reviewer"] } }, "/x/.omp-coord.json");
    expect(c.agents.pools).toEqual({ work: { cap: 8, agentTypes: [], loadCaps: [] } });
    expect(c.agents.defaultPool).toBe("work");
    expect(c.agents.nested).toEqual({ allow: ["reviewer"], maxRunningPerParent: 1 });
  });

  test("agent types match omp's lowercased names whatever case the file uses", () => {
    const c = parseConfig(
      { scope: "p", agents: { pools: { work: { cap: 8 }, short: { cap: 2, agentTypes: ["Scout"] } }, exempt: ["Reviewer"] } },
      "f",
    );
    expect(c.agents.pools.short?.agentTypes).toEqual(["scout"]);
    expect(c.agents.exempt).toEqual(["reviewer"]);
    expect(c.agents.nested.allow).toEqual(["reviewer"]);
  });

  test("the event log keeps 30 days and 100,000 events unless the file says otherwise", () => {
    expect(parseConfig({ scope: "p" }, "f").history).toEqual({ maxAgeMs: 30 * 86_400_000, maxEvents: 100_000 });
    expect(parseConfig({ scope: "p", history: { retentionDays: 7, maxEvents: 500 } }, "f").history).toEqual({
      maxAgeMs: 7 * 86_400_000,
      maxEvents: 500,
    });
    expect(() => parseConfig({ scope: "p", history: { retentionDays: 0 } }, "f")).toThrow(/history\.retentionDays/);
  });

  test("errors name the field that is wrong", () => {
    expect(() => parseConfig({ scope: "p", agents: { pools: { work: { cap: 0 } } } }, "f")).toThrow(
      new ConfigError("f: agents.pools.work.cap must be a whole number of at least 1"),
    );
    expect(() => parseConfig({ scope: "p", commands: [{ pattern: "(", action: "refuse", reason: "r" }] }, "f")).toThrow(/commands\[0\]\.pattern/);
  });

  test("an agent type may belong to only one pool, and not also be exempt", () => {
    const pools = { work: { cap: 8, agentTypes: ["scout"] }, short: { cap: 2, agentTypes: ["scout"] } };
    expect(() => parseConfig({ scope: "p", agents: { pools } }, "f")).toThrow(/"scout"/);
    expect(() =>
      parseConfig({ scope: "p", agents: { pools: { short: { cap: 2, agentTypes: ["scout"] } }, exempt: ["scout"] } }, "f"),
    ).toThrow(/agents\.exempt/);
  });

  test("the default pool must exist", () => {
    expect(() => parseConfig({ scope: "p", agents: { defaultPool: "nope" } }, "f")).toThrow(/agents\.defaultPool/);
  });

  test("queues default to FIFO in one lane, refusing duplicates", () => {
    const c = parseConfig({ scope: "p", queues: { heavy: { slots: 2 } } }, "f");
    expect(c.queues.heavy).toEqual({ slots: 2, order: "fifo", lanes: ["normal"], agingMs: null, onDuplicate: "refuse", timeoutMs: null, loadSlots: [] });
    expect(() => parseConfig({ scope: "p", queues: { heavy: { slots: 2, order: "lifo" } } }, "f")).toThrow(/queues\.heavy\.order/);
  });

  test("load limits, time limits and resources are read, with ports checked for sense", () => {
    const c = parseConfig(
      {
        scope: "p",
        agents: { pools: { work: { cap: 8, loadCaps: [{ above: 150, cap: 4 }] } } },
        queues: { heavy: { slots: 2, timeoutMinutes: 120, loadSlots: [{ above: 150, slots: 0 }] } },
        resources: { ports: { from: 18700, to: 18999, perSession: 100 }, scratch: "scratch" },
      },
      "/cfg/.omp-coord.json",
    );
    expect(c.agents.pools.work?.loadCaps).toEqual([{ above: 150, limit: 4 }]);
    expect(c.queues.heavy).toMatchObject({ timeoutMs: 120 * 60_000, loadSlots: [{ above: 150, limit: 0 }] });
    expect(c.resources).toEqual({ ports: { from: 18700, to: 18999, perSession: 100, perAgent: 10 }, scratch: "/cfg/scratch" });
    expect(() => parseConfig({ scope: "p", resources: { ports: { from: 19000, to: 18000, perSession: 10 } } }, "f")).toThrow(/resources\.ports/);
  });

  test("a command rule must name a queue and lane that exist", () => {
    const queues = { test: { slots: 3, lanes: ["front", "normal"] } };
    expect(() => parseConfig({ scope: "p", queues, commands: [{ pattern: "x", action: "queue", queue: "heavy" }] }, "f")).toThrow(
      /commands\[0\]\.queue/,
    );
    expect(() => parseConfig({ scope: "p", queues, commands: [{ pattern: "x", action: "queue", queue: "test", lane: "vip" }] }, "f")).toThrow(
      /commands\[0\]\.lane/,
    );
  });

  test("a worktree below the checkout finds the checkout's file; the environment variable wins", () => {
    const root = mkdtempSync(join(tmpdir(), "omp-coord-"));
    const deep = join(root, ".claude", "worktrees", "w1", "src");
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(root, ".omp-coord.json"), "{}");
    expect(findConfigFile(deep, {})).toBe(join(root, ".omp-coord.json"));
    expect(findConfigFile(deep, { OMP_COORD_CONFIG: "/elsewhere.json" })).toBe("/elsewhere.json");
  });
});
