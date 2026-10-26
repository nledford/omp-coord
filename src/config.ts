/**
 * `.omp-coord.json`: which sessions coordinate (the scope) and the rules they share. Found by walking up from the
 * session's working directory (so every worktree under a checkout shares the checkout's file), or named by the
 * `OMP_COORD_CONFIG` environment variable. Without one, the extension stays inactive.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { AgentPolicy } from "./domain/board.ts";

export const CONFIG_FILE = ".omp-coord.json";

export interface CommandRule {
  pattern: RegExp;
  reason: string;
}

export interface QueueDir {
  name: string;
  /** Folder of a `flock`-based slot queue: `<n>.lock` files and a `queue/` folder of tickets. */
  dir: string;
  slots: number;
}

export interface Config {
  /** Sessions share caps, the line and messages only within one scope. */
  scope: string;
  /** Where the file was read from. */
  source: string;
  agents: AgentPolicy;
  /** Bash commands refused to agents, each with the reason they are told. */
  refuseCommands: CommandRule[];
  queues: QueueDir[];
  /** Retention of the event log. */
  history: { maxAgeMs: number; maxEvents: number };
}

export class ConfigError extends Error {}

export function findConfigFile(cwd: string, env: Record<string, string | undefined> = process.env): string | undefined {
  const named = env.OMP_COORD_CONFIG;
  if (named) return resolve(cwd, named);
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const candidate = join(dir, CONFIG_FILE);
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) return undefined;
  }
}

export function loadConfig(path: string): Config {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new ConfigError(`${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return parseConfig(raw, path);
}

/** Validates a parsed config file. Errors name the offending field. */
export function parseConfig(raw: unknown, source: string): Config {
  const fail = (field: string, problem: string): never => {
    throw new ConfigError(`${source}: ${field} ${problem}`);
  };
  const root = obj(raw, "the file", fail);
  const scope = str(root.scope, "scope", fail);
  if (!/^[A-Za-z0-9._-]+$/.test(scope)) fail("scope", "may contain only letters, digits, '.', '_' and '-'");

  const agents = obj(root.agents ?? {}, "agents", fail);
  const poolsRaw = obj(agents.pools ?? { work: { cap: 8 } }, "agents.pools", fail);
  const pools: AgentPolicy["pools"] = {};
  const claimed = new Map<string, string>();
  for (const [name, value] of Object.entries(poolsRaw)) {
    const p = obj(value, `agents.pools.${name}`, fail);
    const agentTypes = agentTypeList(p.agentTypes ?? [], `agents.pools.${name}.agentTypes`, fail);
    for (const t of agentTypes) {
      const other = claimed.get(t);
      if (other) fail(`agents.pools.${name}.agentTypes`, `lists "${t}", which pool ${other} already lists`);
      claimed.set(t, name);
    }
    pools[name] = { cap: count(p.cap, `agents.pools.${name}.cap`, fail), agentTypes };
  }
  if (Object.keys(pools).length === 0) fail("agents.pools", "needs at least one pool");

  const defaultPool = agents.defaultPool === undefined ? Object.keys(pools)[0] : str(agents.defaultPool, "agents.defaultPool", fail);
  if (defaultPool === undefined || !(defaultPool in pools)) fail("agents.defaultPool", `must name a pool (${Object.keys(pools).join(", ")})`);

  const exempt = agentTypeList(agents.exempt ?? [], "agents.exempt", fail);
  for (const t of exempt) if (claimed.has(t)) fail("agents.exempt", `lists "${t}", which pool ${claimed.get(t)} also lists`);

  const nested = obj(agents.nested ?? {}, "agents.nested", fail);
  const messages = obj(root.messages ?? {}, "messages", fail);
  const history = obj(root.history ?? {}, "history", fail);

  const refuseCommands = list(root.refuseCommands ?? [], "refuseCommands", fail).map((r, i) => {
    const rule = obj(r, `refuseCommands[${i}]`, fail);
    const pattern = str(rule.pattern, `refuseCommands[${i}].pattern`, fail);
    let regex: RegExp;
    try {
      regex = new RegExp(pattern);
    } catch (e) {
      return fail(`refuseCommands[${i}].pattern`, `is not a valid regular expression (${e instanceof Error ? e.message : e})`);
    }
    return { pattern: regex, reason: str(rule.reason, `refuseCommands[${i}].reason`, fail) };
  });

  const queues = list(root.queues ?? [], "queues", fail).map((q, i) => {
    const queue = obj(q, `queues[${i}]`, fail);
    return {
      name: str(queue.name, `queues[${i}].name`, fail),
      dir: resolve(dirname(source), str(queue.dir, `queues[${i}].dir`, fail)),
      slots: count(queue.slots, `queues[${i}].slots`, fail),
    };
  });

  return {
    scope,
    source,
    agents: {
      pools,
      defaultPool: defaultPool as string,
      exempt,
      nested: {
        allow: agentTypeList(nested.allow ?? exempt, "agents.nested.allow", fail),
        maxRunningPerParent: count(nested.maxRunningPerParent ?? 1, "agents.nested.maxRunningPerParent", fail, 0),
      },
      holdMs: count(agents.holdMinutes ?? 5, "agents.holdMinutes", fail) * 60_000,
      startTimeoutMs: count(agents.startTimeoutSeconds ?? 120, "agents.startTimeoutSeconds", fail) * 1000,
      messagesPerMinute: count(messages.perMinute ?? 10, "messages.perMinute", fail),
    },
    refuseCommands,
    queues,
    history: {
      maxAgeMs: count(history.retentionDays ?? 30, "history.retentionDays", fail) * 24 * 3_600_000,
      maxEvents: count(history.maxEvents ?? 100_000, "history.maxEvents", fail),
    },
  };
}

type Fail = (field: string, problem: string) => never;

function obj(v: unknown, field: string, fail: Fail): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return fail(field, "must be an object");
  return v as Record<string, unknown>;
}

function list(v: unknown, field: string, fail: Fail): unknown[] {
  if (!Array.isArray(v)) return fail(field, "must be a list");
  return v;
}

function str(v: unknown, field: string, fail: Fail): string {
  if (typeof v !== "string" || v.trim() === "") return fail(field, "must be a non-empty string");
  return v;
}

function strList(v: unknown, field: string, fail: Fail): string[] {
  return list(v, field, fail).map((x, i) => str(x, `${field}[${i}]`, fail));
}

function count(v: unknown, field: string, fail: Fail, min = 1): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min) return fail(field, `must be a whole number of at least ${min}`);
  return v;
}

/** omp reports agent types lowercased (`ctx.agent.name`), so configured ones are compared lowercased too. */
function agentTypeList(v: unknown, field: string, fail: Fail): string[] {
  return strList(v, field, fail).map(t => t.toLowerCase());
}
