import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, findConfigFile, parseConfig } from "../src/config.ts";

describe("config", () => {
  test("a minimal file gets one work pool of 8, and subagents may start only the exempt types", () => {
    const c = parseConfig({ scope: "proj", agents: { exempt: ["reviewer"] } }, "/x/.omp-coord.json");
    expect(c.agents.pools).toEqual({ work: { cap: 8, agentTypes: [] } });
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
    expect(() => parseConfig({ scope: "p", refuseCommands: [{ pattern: "(", reason: "r" }] }, "f")).toThrow(/refuseCommands\[0\]\.pattern/);
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

  test("queue folders are relative to the config file", () => {
    const c = parseConfig({ scope: "p", queues: [{ name: "heavy", dir: "slots", slots: 2 }] }, "/cfg/.omp-coord.json");
    expect(c.queues[0]?.dir).toBe("/cfg/slots");
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
