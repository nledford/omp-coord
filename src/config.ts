/**
 * `.omp-coord.json`: which sessions coordinate (the scope) and the rules they share. Found by walking up from the
 * session's working directory (so every worktree under a checkout shares the checkout's file), or named by the
 * `OMP_COORD_CONFIG` environment variable. Without one, the extension stays inactive.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { AgentPolicy } from "./domain/board.ts";
import type { QueuePolicy, Queues } from "./domain/queues.ts";

export const CONFIG_FILE = ".omp-coord.json";

/** What happens to an agent's bash command that matches `pattern`: refused with a reason, or run through a queue. */
export type CommandRule =
  | { pattern: RegExp; action: "refuse"; reason: string }
  | { pattern: RegExp; action: "queue"; queue: string; lane: string | undefined };

export interface Config {
  /** Sessions share caps, the line, queues and messages only within one scope. */
  scope: string;
  /** Where the file was read from. */
  source: string;
  agents: AgentPolicy;
  /** Rules for agents' bash commands, first match wins. */
  commands: CommandRule[];
  /** Build and test queues, machine-wide within the scope. */
  queues: Queues;
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

  const queues: Queues = {};
  for (const [name, value] of Object.entries(obj(root.queues ?? {}, "queues", fail))) {
    const q = obj(value, `queues.${name}`, fail);
    if (!/^[A-Za-z0-9._-]+$/.test(name)) fail(`queues.${name}`, "is not a valid queue name: use letters, digits, '.', '_' and '-'");
    const order = q.order ?? "fifo";
    if (order !== "fifo" && order !== "fair-share" && order !== "priority") fail(`queues.${name}.order`, `must be "fifo", "fair-share" or "priority"`);
    const onDuplicate = q.onDuplicate ?? "refuse";
    if (onDuplicate !== "refuse" && onDuplicate !== "supersede") fail(`queues.${name}.onDuplicate`, `must be "refuse" or "supersede"`);
    const lanes = strList(q.lanes ?? ["normal"], `queues.${name}.lanes`, fail);
    if (lanes.length === 0 || new Set(lanes).size !== lanes.length) fail(`queues.${name}.lanes`, "must list at least one lane, each once");
    queues[name] = {
      slots: count(q.slots, `queues.${name}.slots`, fail),
      order: order as QueuePolicy["order"],
      lanes,
      agingMs: q.agingMinutes === undefined ? null : count(q.agingMinutes, `queues.${name}.agingMinutes`, fail) * 60_000,
      onDuplicate: onDuplicate as QueuePolicy["onDuplicate"],
    };
  }

  const commands = list(root.commands ?? [], "commands", fail).map((r, i): CommandRule => {
    const field = `commands[${i}]`;
    const rule = obj(r, field, fail);
    const patternText = str(rule.pattern, `${field}.pattern`, fail);
    let pattern: RegExp;
    try {
      pattern = new RegExp(patternText);
    } catch (e) {
      return fail(`${field}.pattern`, `is not a valid regular expression (${e instanceof Error ? e.message : e})`);
    }
    if (rule.action === "refuse") return { pattern, action: "refuse", reason: str(rule.reason, `${field}.reason`, fail) };
    if (rule.action !== "queue") return fail(`${field}.action`, `must be "refuse" or "queue"`);
    const queue = str(rule.queue, `${field}.queue`, fail);
    const policy = queues[queue];
    if (!policy) return fail(`${field}.queue`, `names no queue (${Object.keys(queues).join(", ") || "none defined"})`);
    const lane = rule.lane === undefined ? undefined : str(rule.lane, `${field}.lane`, fail);
    if (lane !== undefined && !policy.lanes.includes(lane)) fail(`${field}.lane`, `names no lane of queue ${queue} (${policy.lanes.join(", ")})`);
    return { pattern, action: "queue", queue, lane };
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
    commands,
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
