/**
 * omp adapter: maps omp's events, tools and commands onto the application's use cases (`app/coordinator.ts`):
 * registers the session on the shared board, enforces the agent caps through omp's spawn check, follows subagent
 * runs to free slots, delivers messages (to the session or one of its subagents) and slot holds, guards claimed
 * branches, worktrees and PRs, applies command rules to agents' bash calls, and offers `/coord` and the `coord_*`
 * tools.
 *
 * omp binds this factory once per session in the process (the main session and every subagent). Subagents in an
 * isolated worktree even re-import the module, so the runtime lives on `globalThis`: every copy in the process shares
 * one registration, and every binding is kept so a message can reach the subagent it is for.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Coordinator } from "../../app/coordinator.ts";
import type { Listener } from "../../app/ports.ts";
import { type Config, ConfigError, findConfigFile, loadConfig } from "../../config.ts";
import { decideCommand, withAgent } from "../../domain/commands.ts";
import type { Claim } from "../../domain/model.ts";
import { osLoad } from "../os/load.ts";
import { BoardStore, stateDir } from "../sqlite/store.ts";
import {
  clock,
  formatAgents,
  formatFooter,
  formatInterrupted,
  formatNotes,
  formatStats,
  formatStatus,
} from "../text/report.ts";
import { startBeacon, unixLiveness } from "../unix/beacon.ts";
import type { ExtensionAPI, ExtensionContext, Timer, ToolResult } from "./api.ts";

/**
 * How agents' queued commands start the runner: the omp binary itself runs the CLI adapter as Bun
 * (`BUN_BE_BUN=1`, as omp does for its own `bun install`), so no separate Bun install is needed.
 */
const RUNNER = { argv: [process.execPath, join(import.meta.dir, "..", "cli", "cli.ts")], env: { BUN_BE_BUN: "1" } };

const TICK_MS = 2000;
const PRUNE_EVERY_TICKS = 5;
const STATUS_KEY = "omp-coord";
const MESSAGE_TYPE = "omp-coord";
const NO_CONFIG = "omp-coord is inactive: no .omp-coord.json above this session's folder.";
const DAY = 86_400_000;
const CLAIM_KINDS: Claim["kind"][] = ["branch", "worktree", "pr"];

interface Runtime {
  config: Config;
  store: BoardStore;
  coordinator: Coordinator;
  listener: Listener;
  sessionId: string;
  label: string;
  /** The main session's binding and context: messages for the session go through them. */
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  timer: Timer;
  ticks: number;
  footer: string | undefined;
  pruning: boolean;
}

interface Shared {
  runtime: Runtime | undefined;
  /** Why there is no runtime, for tools and `/coord`. */
  inactive: string;
  /** Each subagent's binding, by agent id: a message for that subagent is sent through it. */
  bindings: Map<string, ExtensionAPI>;
}

/** Shared by every copy of this module in the process (omp re-imports extensions for isolated subagents). */
const shared: Shared = (() => {
  const store = globalThis as { [key: symbol]: Shared | undefined };
  const key = Symbol.for("omp-coord.runtime");
  store[key] ??= { runtime: undefined, inactive: NO_CONFIG, bindings: new Map() };
  return store[key];
})();

export default function ompCoord(pi: ExtensionAPI): void {
  pi.setLabel("omp-coord");

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.agent.kind !== "main") {
      shared.bindings.set(ctx.agent.id, pi);
      return;
    }
    if (shared.runtime) {
      shared.runtime.pi = pi;
      shared.runtime.ctx = ctx;
      return;
    }
    await start(pi, ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.agent.kind !== "main") {
      if (shared.bindings.get(ctx.agent.id) === pi) shared.bindings.delete(ctx.agent.id);
      return;
    }
    if (shared.runtime?.pi === pi) stop(shared.runtime);
  });

  pi.on("before_subagent_spawn", (event, ctx) => {
    const rt = shared.runtime;
    if (!rt) return undefined;
    try {
      const decision = rt.coordinator.requestSpawn({
        sessionId: rt.sessionId,
        parentAgentId: ctx.agent.id,
        parentIsSubagent: ctx.agent.kind === "sub",
        agentType: event.agent.toLowerCase(),
        ...(event.spawnKey === undefined ? {} : { spawnKey: event.spawnKey }),
      });
      if (decision.allowed) return undefined;
      notify(rt, `omp-coord refused ${event.agent} from ${ctx.agent.id}: ${decision.reason}`, "warning");
      return { block: true, reason: `omp-coord: ${decision.reason}` };
    } catch (error) {
      // The cap is a shared agreement, not a security boundary: a broken board must not stop all work.
      notify(
        rt,
        `omp-coord could not check the agent cap, so ${event.agent} starts unchecked: ${describe(error)}`,
        "error",
      );
      return undefined;
    }
  });

  pi.on("agent_start", (_event, ctx) => {
    const rt = shared.runtime;
    if (!rt || !isTrackedSubagent(ctx)) return;
    guarded(rt, "record an agent run", () => {
      const parentId = ctx.agent.parentId ?? "Main";
      const count = rt.coordinator.agentStarted({
        sessionId: rt.sessionId,
        agentId: ctx.agent.id,
        parentId,
        parentIsSubagent: parentId !== "Main",
        agentType: ctx.agent.name.toLowerCase(),
      });
      if (count && count.used > count.cap) {
        notify(
          rt,
          `omp-coord: ${ctx.agent.id} runs over the ${count.pool} cap (${count.used}/${count.cap}); nothing new starts until the total is under it`,
          "warning",
        );
      }
    });
  });

  pi.on("agent_end", (_event, ctx) => {
    const rt = shared.runtime;
    if (!rt || !isTrackedSubagent(ctx)) return;
    guarded(rt, "free an agent slot", () =>
      rt.coordinator.agentEnded({ sessionId: rt.sessionId, agentId: ctx.agent.id }),
    );
  });

  pi.on("tool_call", (event, ctx) => {
    const rt = shared.runtime;
    if (!rt || event.toolName !== "bash") return undefined;
    const command = event.input.command;
    if (typeof command !== "string") return undefined;

    try {
      const cwd = typeof event.input.cwd === "string" ? resolve(ctx.cwd, event.input.cwd) : ctx.cwd;
      const held = rt.coordinator.checkCommand({
        sessionId: rt.sessionId,
        command,
        cwd,
        home: homedir(),
        // A worktree's top folder holds `.git` (a folder in the main checkout, a file in linked worktrees).
        isWorktreeRoot: dir => existsSync(join(dir, ".git")),
      });
      if (held) {
        const holder = rt.coordinator.board().sessions.find(s => s.id === held.sessionId)?.label ?? "?";
        return {
          block: true,
          reason: `omp-coord: ${held.kind} ${held.target} is claimed by session ${holder} (${held.agentId})${held.note ? `: ${held.note}` : ""}. Leave it alone; ask that session with coord_send if you need it.`,
        };
      }
    } catch (error) {
      notify(rt, `omp-coord could not check claims: ${describe(error)}`, "error");
    }

    const decision = decideCommand(rt.config.commands, command, {
      ...RUNNER,
      owner: rt.sessionId,
      config: rt.config.source,
    });
    if (decision.kind === "refuse") return { block: true, reason: `omp-coord: ${decision.reason}` };
    // Every agent of a session shares the omp process's environment, so the agent's id reaches `omp-coord run` (and
    // the queue lines) through the command itself.
    const run = decision.kind === "queue" ? decision.command : command;
    return { input: { ...event.input, command: withAgent(ctx.agent.id, run) } };
  });

  const inactive = () => text(shared.inactive, true);

  pi.registerTool<Record<string, never>>({
    name: "coord_status",
    label: "Coordination status",
    description:
      "Shows the omp sessions coordinating with this one (by letter), the agent slots each holds against the shared caps, " +
      "sessions in line for a slot, claims, the build/test queues and the latest decisions. Check it before starting agents or heavy builds.",
    parameters: pi.zod.object({}),
    async execute() {
      const rt = shared.runtime;
      return rt ? text(statusText(rt)) : inactive();
    },
  });

  pi.registerTool<{ to: string; text: string }>({
    name: "coord_send",
    label: "Message another omp session",
    description:
      "Sends a message to another omp session working in the same project: `to` is its letter (see coord_status), " +
      "`<letter>/<agent id>` for one of its subagents, or `all`. Use it for facts the other session needs: handoffs, a change " +
      "to main it must react to, a question about something it claimed. Keep messages short and factual; never ask the " +
      "other session to reply just to acknowledge.",
    parameters: pi.zod.object({
      to: pi.zod.string().describe("Session letter (A, B, …), `B/<agent id>`, or `all`"),
      text: pi.zod.string().describe("The message"),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const rt = shared.runtime;
      if (!rt) return inactive();
      if (ctx.agent.kind !== "main")
        return text("Only the main session messages other sessions; report to your parent instead.", true);
      return sendFrom(rt, params.to, params.text);
    },
  });

  pi.registerTool<{ kind: string; target: string; note?: string }>({
    name: "coord_claim",
    label: "Claim a branch, worktree or PR",
    description:
      "Claims a branch, a worktree (absolute path) or a PR (number) for this session before working on it. Other sessions' " +
      "agents are then refused git and gh commands that would change it, until this session releases it or ends. Refused " +
      "when another session holds it.",
    parameters: pi.zod.object({
      kind: pi.zod.string().describe("branch, worktree or pr"),
      target: pi.zod.string().describe("Branch name, worktree path, or PR number"),
      note: pi.zod.string().optional().describe("What you do with it, off which base, which files"),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const rt = shared.runtime;
      if (!rt) return inactive();
      const kind = claimKind(params.kind);
      if (!kind) return text(`kind must be ${CLAIM_KINDS.join(", ")}`, true);
      const r = rt.coordinator.claim({
        sessionId: rt.sessionId,
        agentId: ctx.agent.id,
        kind,
        target: params.target,
        note: params.note ?? "",
        cwd: ctx.cwd,
      });
      return r.ok ? text(`Claimed ${kind} ${params.target}.`) : text(`Not claimed: ${r.reason}.`, true);
    },
  });

  pi.registerTool<{ kind: string; target: string }>({
    name: "coord_release",
    label: "Release a claim",
    description: "Releases a branch, worktree or PR this session claimed, once the work on it is done or handed over.",
    parameters: pi.zod.object({
      kind: pi.zod.string().describe("branch, worktree or pr"),
      target: pi.zod.string().describe("Branch name, worktree path, or PR number"),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const rt = shared.runtime;
      if (!rt) return inactive();
      const kind = claimKind(params.kind);
      if (!kind) return text(`kind must be ${CLAIM_KINDS.join(", ")}`, true);
      const r = rt.coordinator.release({ sessionId: rt.sessionId, kind, target: params.target, cwd: ctx.cwd });
      return r.ok ? text(`Released ${kind} ${params.target}.`) : text(`Not released: ${r.reason}.`, true);
    },
  });

  pi.registerTool<{ text: string }>({
    name: "coord_note",
    label: "Record a decision",
    description:
      "Adds a short entry to the decision log every session sees: a decision the user made, with who and when, or a fact " +
      "all sessions must keep to. Not for progress reports or messages to one session (use coord_send).",
    parameters: pi.zod.object({
      text: pi.zod.string().describe("The decision, e.g. 'User, 14:05: ship #2913 before #2914'"),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const rt = shared.runtime;
      if (!rt) return inactive();
      const r = rt.coordinator.note(rt.sessionId, ctx.agent.id, params.text);
      return r.ok ? text(`Recorded as decision #${r.note.id}.`) : text(`Not recorded: ${r.reason}.`, true);
    },
  });

  pi.registerTool<Record<string, never>>({
    name: "coord_resources",
    label: "Ports and scratch folder",
    description:
      "Gives the calling agent its own block of ports and its own scratch folder, so it never collides with other agents " +
      "or sessions (e.g. for a server or a control port). The same agent always gets the same ones.",
    parameters: pi.zod.object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const rt = shared.runtime;
      if (!rt) return inactive();
      const lines: string[] = [];
      if (rt.config.resources.ports) {
        const r = rt.coordinator.agentPorts(rt.sessionId, ctx.agent.id);
        lines.push(r.ok ? `Ports: ${r.ports.from}–${r.ports.to} (yours alone)` : `No ports: ${r.reason}`);
      }
      const scratch = scratchFor(rt, ctx.agent.id);
      if (scratch) lines.push(`Scratch folder: ${scratch}`);
      return lines.length
        ? text(lines.join("\n"))
        : text("This scope hands out no ports or scratch folders (resources in .omp-coord.json).", true);
    },
  });

  pi.registerTool<{ job: string; priority: string }>({
    name: "coord_job_priority",
    label: "Reorder this session's queued jobs",
    description:
      "Changes the priority of one of this session's jobs waiting in a build/test queue (job ids are in coord_status). " +
      "Higher goes first among this session's own jobs; it never moves them ahead of other sessions' jobs in fair-share queues. " +
      "Use it when one waiting job matters more than another, e.g. a fix for an approved PR over a trial build.",
    parameters: pi.zod.object({
      job: pi.zod.string().describe("Job id from coord_status"),
      priority: pi.zod.string().describe("Whole number; 0 is normal, higher goes first"),
    }),
    async execute(_id, params) {
      const rt = shared.runtime;
      if (!rt) return inactive();
      const priority = Number(params.priority);
      if (params.priority.trim() === "" || Number.isNaN(priority)) return text("priority must be a whole number", true);
      const result = rt.coordinator.setJobPriority(rt.sessionId, params.job, priority);
      return result.ok
        ? text(`Job ${params.job} now has priority ${priority}.`)
        : text(`Not changed: ${result.reason}.`, true);
    },
  });

  pi.registerCommand("coord", {
    description:
      "Coordination with other omp sessions: `/coord` status; `agents`; `send <letter|B/agent|all> <text>`; `pause [reason]`, `resume`; " +
      "`claim <branch|worktree|pr> <target> [note]`, `release <kind> <target>`; `note <text>`, `notes [n]`; `stats [days]`; `interrupted [hours]`",
    async handler(args, ctx) {
      const rt = shared.runtime;
      if (!rt) {
        ctx.ui.notify(shared.inactive, "info");
        return;
      }
      const [sub = "", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const tail = args.trim().slice(sub.length).trim();
      const say = (r: ToolResult) => ctx.ui.notify(r.content[0]?.text ?? "", r.isError ? "error" : "info");
      try {
        switch (sub) {
          case "":
            return ctx.ui.notify(statusText(rt), "info");
          case "agents":
            return ctx.ui.notify(formatAgents(rt.coordinator.board(), Date.now()), "info");
          case "send": {
            const m = /^(\S+)\s+([\s\S]+)$/.exec(tail);
            return say(
              m
                ? sendFrom(rt, m[1] as string, m[2] as string)
                : text("usage: /coord send <letter|B/agent|all> <text>", true),
            );
          }
          case "pause":
            rt.coordinator.pause(rt.sessionId, tail);
            return ctx.ui.notify(
              "Paused: no new agent or queued job starts in any session until /coord resume.",
              "warning",
            );
          case "resume":
            return ctx.ui.notify(rt.coordinator.resume(rt.sessionId) ? "Resumed." : "Was not paused.", "info");
          case "claim":
          case "release": {
            const kind = claimKind(rest[0] ?? "");
            const target = rest[1];
            if (!kind || !target)
              return say(
                text(
                  `usage: /coord ${sub} <${CLAIM_KINDS.join("|")}> <target>${sub === "claim" ? " [note]" : ""}`,
                  true,
                ),
              );
            const r =
              sub === "claim"
                ? rt.coordinator.claim({
                    sessionId: rt.sessionId,
                    agentId: "Main",
                    kind,
                    target,
                    note: rest.slice(2).join(" "),
                    cwd: ctx.cwd,
                  })
                : rt.coordinator.release({ sessionId: rt.sessionId, kind, target, cwd: ctx.cwd });
            return say(
              r.ok ? text(`${sub === "claim" ? "Claimed" : "Released"} ${kind} ${target}.`) : text(r.reason, true),
            );
          }
          case "note": {
            const r = rt.coordinator.note(rt.sessionId, "user", tail);
            return say(r.ok ? text(`Recorded as decision #${r.note.id}.`) : text(r.reason, true));
          }
          case "notes":
            return ctx.ui.notify(formatNotes(rt.coordinator.notes(count(rest[0], 20))), "info");
          case "stats":
            return ctx.ui.notify(formatStats(rt.coordinator.stats(count(rest[0], 7) * DAY)), "info");
          case "interrupted":
            return ctx.ui.notify(formatInterrupted(rt.coordinator.interrupted(count(rest[0], 24) * 3_600_000)), "info");
          default:
            return say(text(`unknown /coord subcommand "${sub}"`, true));
        }
      } catch (error) {
        say(text(`omp-coord: ${describe(error)}`, true));
      }
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

  let joined: Pick<Runtime, "store" | "coordinator" | "listener" | "sessionId" | "label">;
  try {
    joined = openSession(config, ctx.cwd);
  } catch (error) {
    shared.inactive = `omp-coord is off: ${describe(error)}`;
    ctx.ui.notify(shared.inactive, "error");
    return;
  }

  const rt: Runtime = { config, ...joined, pi, ctx, timer: undefined, ticks: 0, footer: undefined, pruning: false };
  shared.runtime = rt;
  // Commands this session's agents run (e.g. a `just` recipe calling `omp-coord run`) see these.
  process.env.OMP_COORD_SESSION = rt.sessionId;
  const me = rt.coordinator.board().sessions.find(s => s.id === rt.sessionId);
  if (me?.ports) process.env.OMP_COORD_PORTS = `${me.ports.from}-${me.ports.to}`;
  const scratch = scratchFor(rt);
  if (scratch) process.env.OMP_COORD_SCRATCH = scratch;
  rt.timer = ctx.setInterval(() => tick(rt), TICK_MS);
  await prune(rt);

  const board = rt.coordinator.board();
  const others = board.sessions.filter(s => s.id !== rt.sessionId);
  const differing = others.filter(s => s.configHash !== config.hash).map(s => s.label);
  const pausedNote = board.pause ? " The scope is PAUSED (see /coord)." : "";
  notify(
    rt,
    `omp-coord: this is session ${rt.label} (scope ${config.scope}). ` +
      (others.length
        ? `Other sessions: ${others.map(s => `${s.label} (${s.cwd})`).join(", ")}. Agent caps are shared with them.`
        : "No other session is active.") +
      pausedNote,
    "info",
  );
  if (differing.length) {
    notify(
      rt,
      `omp-coord: sessions ${differing.join(", ")} read a different .omp-coord.json than ${config.source}; their caps and rules differ from this session's.`,
      "warning",
    );
  }
  if (config.resources.ports && !me?.ports) {
    notify(
      rt,
      "omp-coord: every block of resources.ports is held by other sessions, so this session and its agents get no ports.",
      "warning",
    );
  }
}

/** Opens the scope's board, starts this session's liveness socket and registers it; undoes both on failure. */
function openSession(
  config: Config,
  cwd: string,
): Pick<Runtime, "store" | "coordinator" | "listener" | "sessionId" | "label"> {
  const dir = stateDir();
  mkdirSync(join(dir, "s"), { recursive: true, mode: 0o700 });
  const store = new BoardStore(join(dir, `${config.scope}.db`), config.history);
  let listener: Listener | undefined;
  try {
    const coordinator = new Coordinator(config, store, unixLiveness, Date, osLoad);
    const sessionId = randomBytes(6).toString("hex");
    listener = startBeacon(join(dir, "s", `${sessionId}.sock`));
    const label = coordinator.join(identity(sessionId, cwd, listener));
    return { store, coordinator, listener, sessionId, label };
  } catch (error) {
    listener?.stop();
    store.close();
    throw error;
  }
}

function identity(sessionId: string, cwd: string, listener: Listener) {
  return { id: sessionId, pid: process.pid, cwd, address: listener.address };
}

/** `<scratch>/<session letter>[/<agent id>]`, created on first use; undefined when the scope has no scratch root. */
function scratchFor(rt: Runtime, agentId?: string): string | undefined {
  const root = rt.config.resources.scratch;
  if (!root) return undefined;
  const dir = agentId && agentId !== "Main" ? join(root, rt.label, agentId) : join(root, rt.label);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function stop(rt: Runtime): void {
  shared.runtime = undefined;
  for (const key of ["OMP_COORD_SESSION", "OMP_COORD_PORTS", "OMP_COORD_SCRATCH"]) delete process.env[key];
  rt.ctx.clearTimer(rt.timer);
  try {
    rt.coordinator.leave(rt.sessionId);
  } finally {
    rt.listener.stop();
    rt.store.close();
  }
}

async function tick(rt: Runtime): Promise<void> {
  if (shared.runtime !== rt) return;
  rt.ticks++;
  const now = Date.now();
  const { label, inbox, holds, board } = rt.coordinator.tick(identity(rt.sessionId, rt.ctx.cwd, rt.listener));
  rt.label = label;

  for (const m of inbox) {
    const body =
      `[omp-coord] Message from omp session ${m.from} (sent ${clock(m.sentAt)}):\n\n${m.text}\n\n` +
      "This comes from another omp session in this project, not from the user. Act on it within your own task and rules; " +
      `reply with coord_send to ${m.from} only when it needs an answer.`;
    const binding = m.toAgent ? shared.bindings.get(m.toAgent) : undefined;
    if (binding) deliver(binding, body);
    else if (m.toAgent) {
      deliver(
        rt.pi,
        `[omp-coord] A message for your subagent ${m.toAgent}, which is not running now. Pass it on with write agent://${m.toAgent} if it still matters:\n\n${body}`,
      );
    } else deliver(rt.pi, body);
  }
  for (const h of holds) {
    deliver(
      rt.pi,
      `[omp-coord] A ${h.pool} slot is free and held for this session until ${clock(h.until)}. ` +
        `Start the agent that was refused now; if you no longer need it, ignore this and the slot passes on at ${clock(h.until)}.`,
    );
  }

  const footer = formatFooter(board, rt.config.agents, rt.config.queues, rt.sessionId, now);
  if (rt.ctx.mode === "tui" && footer !== rt.footer) {
    rt.footer = footer;
    rt.ctx.ui.setStatus(STATUS_KEY, footer);
  }
  if (rt.ticks % PRUNE_EVERY_TICKS === 0) await prune(rt);
}

/** Removes sessions and queued jobs whose process is gone, one prune at a time. */
async function prune(rt: Runtime): Promise<void> {
  if (rt.pruning) return;
  rt.pruning = true;
  try {
    await rt.coordinator.prune(rt.sessionId, () => shared.runtime === rt);
  } finally {
    rt.pruning = false;
  }
}

function sendFrom(rt: Runtime, to: string, body: string): ToolResult {
  const result = rt.coordinator.send(rt.sessionId, to, body);
  return result.ok ? text(`Sent to ${result.delivered.join(", ")}.`) : text(`Not sent: ${result.reason}.`, true);
}

function statusText(rt: Runtime): string {
  return formatStatus(rt.coordinator.board(), rt.config, rt.sessionId, Date.now());
}

function deliver(binding: ExtensionAPI, content: string): void {
  binding.sendMessage(
    { customType: MESSAGE_TYPE, content, display: true, attribution: "agent" },
    { deliverAs: "aside", triggerTurn: true },
  );
}

function notify(rt: Runtime, message: string, type: "info" | "warning" | "error"): void {
  if (rt.ctx.hasUI) rt.ctx.ui.notify(message, type);
}

function claimKind(word: string): Claim["kind"] | undefined {
  const k = word.trim().toLowerCase();
  return CLAIM_KINDS.find(x => x === k);
}

function count(word: string | undefined, fallback: number): number {
  const n = Number(word);
  return word !== undefined && Number.isSafeInteger(n) && n > 0 ? n : fallback;
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
  return isError
    ? { content: [{ type: "text", text: body }], isError: true }
    : { content: [{ type: "text", text: body }] };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
