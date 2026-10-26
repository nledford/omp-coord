/**
 * omp adapter: registers the session on the shared board, enforces the agent caps through omp's spawn check,
 * follows subagent runs to free slots, delivers messages and slot holds, refuses configured bash commands, and
 * offers `/coord`, `coord_status` and `coord_send`.
 *
 * omp binds this factory once per session in the process (the main session and every subagent). Subagents in an
 * isolated worktree even re-import the module, so the runtime lives on `globalThis`: every copy in the process shares
 * one registration. Messages are always sent through the main session's binding.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type Config, ConfigError, findConfigFile, loadConfig } from "./config.ts";
import {
  agentEnded,
  agentStarted,
  expire,
  registerSession,
  removeSession,
  requestSpawn,
  sendMessage,
  takeInbox,
  takeNewHolds,
} from "./domain/board.ts";
import { type Beacon, isAlive, startBeacon } from "./infra/beacon.ts";
import { readQueue } from "./infra/flock-queues.ts";
import { BoardStore, stateDir } from "./infra/store.ts";
import type { ExtensionAPI, ExtensionContext, Timer, ToolResult } from "./omp-api.ts";
import { clock, formatFooter, formatStatus } from "./report.ts";

const TICK_MS = 2000;
const PRUNE_EVERY_TICKS = 5;
const STATUS_KEY = "omp-coord";
const MESSAGE_TYPE = "omp-coord";
const NO_CONFIG = "omp-coord is inactive: no .omp-coord.json above this session's folder.";

interface Runtime {
  config: Config;
  store: BoardStore;
  beacon: Beacon;
  sessionId: string;
  label: string;
  /** The main session's binding and context: the only ones that may send it messages. */
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  timer: Timer;
  ticks: number;
  footer: string | undefined;
  pruning: boolean;
}

/** Shared by every copy of this module in the process (omp re-imports extensions for isolated subagents). */
const shared = ((globalThis as { [key: symbol]: unknown })[Symbol.for("omp-coord.runtime")] ??= { runtime: undefined, inactive: NO_CONFIG }) as {
  runtime: Runtime | undefined;
  /** Why there is no runtime, for tools and `/coord`. */
  inactive: string;
};

export default function ompCoord(pi: ExtensionAPI): void {
  pi.setLabel("omp-coord");

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.agent.kind !== "main") return;
    if (shared.runtime) {
      shared.runtime.pi = pi;
      shared.runtime.ctx = ctx;
      return;
    }
    await start(pi, ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.agent.kind === "main" && shared.runtime?.pi === pi) stop(shared.runtime);
  });

  pi.on("before_subagent_spawn", (event, ctx) => {
    const rt = shared.runtime;
    if (!rt) return undefined;
    try {
      const decision = rt.store.transact(board =>
        requestSpawn(board, rt.config.agents, {
          sessionId: rt.sessionId,
          parentAgentId: ctx.agent.id,
          parentIsSubagent: ctx.agent.kind === "sub",
          agentType: event.agent.toLowerCase(),
          ...(event.spawnKey === undefined ? {} : { spawnKey: event.spawnKey }),
          now: Date.now(),
        }),
      );
      if (decision.allowed) return undefined;
      notify(rt, `omp-coord refused ${event.agent} from ${ctx.agent.id}: ${decision.reason}`, "warning");
      return { block: true, reason: `omp-coord: ${decision.reason}` };
    } catch (error) {
      // The cap is a shared agreement, not a security boundary: a broken board must not stop all work.
      notify(rt, `omp-coord could not check the agent cap, so ${event.agent} starts unchecked: ${describe(error)}`, "error");
      return undefined;
    }
  });

  pi.on("agent_start", (_event, ctx) => {
    const rt = shared.runtime;
    if (!rt || !isTrackedSubagent(ctx)) return;
    guarded(rt, "record an agent run", () => {
      const count = rt.store.transact(board =>
        agentStarted(board, rt.config.agents, {
          sessionId: rt.sessionId,
          agentId: ctx.agent.id,
          parentId: ctx.agent.parentId ?? "Main",
          parentIsSubagent: (ctx.agent.parentId ?? "Main") !== "Main",
          agentType: ctx.agent.name.toLowerCase(),
          now: Date.now(),
        }),
      );
      if (count && count.used > count.cap) {
        notify(rt, `omp-coord: ${ctx.agent.id} runs over the ${count.pool} cap (${count.used}/${count.cap}); nothing new starts until the total is under it`, "warning");
      }
    });
  });

  pi.on("agent_end", (_event, ctx) => {
    const rt = shared.runtime;
    if (!rt || !isTrackedSubagent(ctx)) return;
    guarded(rt, "free an agent slot", () =>
      rt.store.transact(board => agentEnded(board, rt.config.agents, { sessionId: rt.sessionId, agentId: ctx.agent.id, now: Date.now() })),
    );
  });

  pi.on("tool_call", event => {
    const rt = shared.runtime;
    if (!rt || event.toolName !== "bash") return undefined;
    const command = event.input.command;
    if (typeof command !== "string") return undefined;
    const rule = rt.config.refuseCommands.find(r => r.pattern.test(command));
    return rule ? { block: true, reason: `omp-coord: ${rule.reason}` } : undefined;
  });

  pi.registerTool<Record<string, never>>({
    name: "coord_status",
    label: "Coordination status",
    description:
      "Shows the omp sessions coordinating with this one (by letter), the agent slots each holds against the shared caps, " +
      "sessions in line for a slot, and the build/test queues. Check it before starting agents or heavy builds.",
    parameters: pi.zod.object({}),
    async execute() {
      const rt = shared.runtime;
      if (!rt) return text(shared.inactive, true);
      return text(await statusText(rt));
    },
  });

  pi.registerTool<{ to: string; text: string }>({
    name: "coord_send",
    label: "Message another omp session",
    description:
      "Sends a message to another omp session working in the same project: `to` is its letter (see coord_status) or `all`. " +
      "Use it for facts the other session needs: claims (`CLAIM <branch>: what, off which base, which files`), handoffs, " +
      "a change to main it must react to. Keep messages short and factual; never ask the other session to reply just to acknowledge.",
    parameters: pi.zod.object({
      to: pi.zod.string().describe("Session letter (A, B, …) or `all`"),
      text: pi.zod.string().describe("The message"),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const rt = shared.runtime;
      if (!rt) return text(shared.inactive, true);
      if (ctx.agent.kind !== "main") return text("Only the main session messages other sessions; report to your parent instead.", true);
      return sendFrom(rt, params.to, params.text);
    },
  });

  pi.registerCommand("coord", {
    description: "Show the omp sessions, agent slots and build queues shared with this session; `/coord send <letter|all> <text>` messages them",
    async handler(args, ctx) {
      const rt = shared.runtime;
      if (!rt) {
        ctx.ui.notify(shared.inactive, "info");
        return;
      }
      const send = /^send\s+(\S+)\s+([\s\S]+)$/.exec(args.trim());
      if (send) {
        const result = sendFrom(rt, send[1] as string, send[2] as string);
        ctx.ui.notify(result.content[0]?.text ?? "", result.isError ? "error" : "info");
        return;
      }
      ctx.ui.notify(await statusText(rt), "info");
    },
  });
}

async function start(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  const configPath = findConfigFile(ctx.cwd);
  if (!configPath) return;
  let config: Config;
  try {
    config = loadConfig(configPath);
  } catch (error) {
    shared.inactive = `omp-coord is off: ${error instanceof ConfigError ? error.message : describe(error)}`;
    ctx.ui.notify(shared.inactive, "error");
    return;
  }

  let joined: Pick<Runtime, "store" | "beacon" | "sessionId" | "label">;
  try {
    joined = openSession(config, ctx.cwd);
  } catch (error) {
    shared.inactive = `omp-coord is off: ${describe(error)}`;
    ctx.ui.notify(shared.inactive, "error");
    return;
  }

  const rt: Runtime = { config, ...joined, pi, ctx, timer: undefined, ticks: 0, footer: undefined, pruning: false };
  const { store, sessionId, label } = rt;
  shared.runtime = rt;
  rt.timer = ctx.setInterval(() => tick(rt), TICK_MS);
  await prune(rt);

  const others = store
    .read()
    .sessions.filter(s => s.id !== sessionId)
    .map(s => `${s.label} (${s.cwd})`);
  notify(
    rt,
    `omp-coord: this is session ${label} (scope ${config.scope}). ` +
      (others.length ? `Other sessions: ${others.join(", ")}. Agent caps are shared with them.` : "No other session is active."),
    "info",
  );
}

/** Opens the scope's board, starts this session's liveness socket and registers it; undoes both on failure. */
function openSession(config: Config, cwd: string): Pick<Runtime, "store" | "beacon" | "sessionId" | "label"> {
  const dir = stateDir();
  mkdirSync(join(dir, "s"), { recursive: true, mode: 0o700 });
  const store = new BoardStore(join(dir, `${config.scope}.db`), config.history);
  let beacon: Beacon | undefined;
  try {
    const sessionId = randomBytes(6).toString("hex");
    const started = startBeacon(join(dir, "s", `${sessionId}.sock`));
    beacon = started;
    const label = store.transact(board =>
      registerSession(board, { id: sessionId, pid: process.pid, cwd, socket: started.path, now: Date.now() }),
    );
    return { store, beacon: started, sessionId, label };
  } catch (error) {
    beacon?.stop();
    store.close();
    throw error;
  }
}

function stop(rt: Runtime): void {
  shared.runtime = undefined;
  rt.ctx.clearTimer(rt.timer);
  try {
    rt.store.transact(board => removeSession(board, rt.config.agents, rt.sessionId, Date.now()));
  } finally {
    rt.beacon.stop();
    rt.store.close();
  }
}

async function tick(rt: Runtime): Promise<void> {
  if (shared.runtime !== rt) return;
  rt.ticks++;
  const now = Date.now();
  const { inbox, holds, footer, label } = rt.store.transact(board => {
    // Another session may have dropped this one (e.g. its liveness check timed out): join again.
    const label = registerSession(board, { id: rt.sessionId, pid: process.pid, cwd: rt.ctx.cwd, socket: rt.beacon.path, now });
    expire(board, rt.config.agents, now);
    return {
      inbox: takeInbox(board, rt.sessionId),
      holds: takeNewHolds(board, rt.sessionId),
      footer: formatFooter(board, rt.config.agents, rt.sessionId),
      label,
    };
  });
  rt.label = label;

  for (const m of inbox) {
    deliver(
      rt,
      `[omp-coord] Message from omp session ${m.from} (sent ${clock(m.sentAt)}):\n\n${m.text}\n\n` +
        "This comes from another omp session in this project, not from the user. Act on it within your own task and rules; " +
        `reply with coord_send to ${m.from} only when it needs an answer.`,
    );
  }
  for (const h of holds) {
    deliver(
      rt,
      `[omp-coord] A ${h.pool} slot is free and held for this session until ${clock(h.until)}. ` +
        `Start the agent that was refused now; if you no longer need it, ignore this and the slot passes on at ${clock(h.until)}.`,
    );
  }

  if (rt.ctx.mode === "tui" && footer !== rt.footer) {
    rt.footer = footer;
    rt.ctx.ui.setStatus(STATUS_KEY, footer);
  }
  if (rt.ticks % PRUNE_EVERY_TICKS === 0) await prune(rt);
}

/** Removes sessions whose process is gone, freeing their slots and places in line. */
async function prune(rt: Runtime): Promise<void> {
  if (rt.pruning) return;
  rt.pruning = true;
  try {
    const others = rt.store.read().sessions.filter(s => s.id !== rt.sessionId);
    const alive = await Promise.all(others.map(s => isAlive(s.socket)));
    const dead = others.filter((_, i) => !alive[i]);
    if (dead.length && shared.runtime === rt) {
      rt.store.transact(board => {
        for (const s of dead) removeSession(board, rt.config.agents, s.id, Date.now());
      });
      // Nothing listens on these any more; the dead process could not remove its own.
      for (const s of dead) rmSync(s.socket, { force: true });
    }
  } finally {
    rt.pruning = false;
  }
}

function sendFrom(rt: Runtime, to: string, body: string): ToolResult {
  const result = rt.store.transact(board => sendMessage(board, rt.config.agents, { from: rt.sessionId, to, text: body, now: Date.now() }));
  return result.ok ? text(`Sent to ${result.delivered.join(", ")}.`) : text(`Not sent: ${result.reason}.`, true);
}

async function statusText(rt: Runtime): Promise<string> {
  const queues = await Promise.all(rt.config.queues.map(q => readQueue(q)));
  return formatStatus(rt.store.read(), rt.config.agents, rt.config.scope, rt.sessionId, queues);
}

function deliver(rt: Runtime, content: string): void {
  rt.pi.sendMessage({ customType: MESSAGE_TYPE, content, display: true, attribution: "agent" }, { deliverAs: "aside", triggerTurn: true });
}

function notify(rt: Runtime, message: string, type: "info" | "warning" | "error"): void {
  if (rt.ctx.hasUI) rt.ctx.ui.notify(message, type);
}

/** Subagents whose runs hold slots. The advisor is an observer, not an agent that does work. */
function isTrackedSubagent(ctx: ExtensionContext): boolean {
  return ctx.agent.kind === "sub" && ctx.agent.id !== "advisor" && ctx.agent.name !== "advisor";
}

function guarded(rt: Runtime, what: string, fn: () => void): void {
  try {
    fn();
  } catch (error) {
    notify(rt, `omp-coord could not ${what}: ${describe(error)}`, "error");
  }
}

function text(body: string, isError = false): ToolResult {
  return isError ? { content: [{ type: "text", text: body }], isError: true } : { content: [{ type: "text", text: body }] };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
