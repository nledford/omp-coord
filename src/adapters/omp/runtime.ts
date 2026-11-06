/**
 * What every part of the omp adapter shares: the per-process runtime on `globalThis`, and the small helpers that
 * touch it (notices to the user, guarded calls, tool results, delivering a message to a binding).
 *
 * omp binds the extension factory once per session in the process (the main session and every subagent). Subagents in
 * an isolated worktree even re-import the modules, so the runtime lives on `globalThis`: every copy in the process
 * shares one registration, and every binding is kept so a message can reach the subagent it is for.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Coordinator } from "../../app/coordinator.ts";
import type { Listener } from "../../app/ports.ts";
import type { Config } from "../../config.ts";
import { spawnAllowance } from "../../domain/agents.ts";
import type { BoardStore } from "../sqlite/store.ts";
import type { ExtensionAPI, ExtensionContext, Timer, ToolResult } from "./api.ts";
import type { SpawnQueue } from "./spawn-queue.ts";

export const MESSAGE_TYPE = "omp-coord";
const NO_CONFIG = "omp-coord is inactive: no .omp-coord.json above this session's folder.";

export interface Runtime {
  config: Config;
  store: BoardStore;
  coordinator: Coordinator;
  listener: Listener;
  sessionId: string;
  label: string;
  /** omp's id for the main conversation, as agents' bash calls carry it (`PI_SESSION_ID`). */
  ompSessionId: string | undefined;
  /** The main session's binding and context: messages for the session go through them. */
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  timer: Timer;
  ticks: number;
  footer: string | undefined;
  pruning: boolean;
  /** Drives omp's spawn queue (`agents.queueSpawns`); undefined when off or unavailable. */
  queue: SpawnQueue | undefined;
  /** Whether spawns past the cap wait in omp's queue, or why not; shown in coord_status and /coord. */
  queueNote: string;
  /** Agents first started by an eval spawn (workpool workers): their later runs are marked "eval" too. */
  evalAgents: Set<string>;
}

interface Shared {
  runtime: Runtime | undefined;
  /** Why there is no runtime, for tools and `/coord`. */
  inactive: string;
  /** Each subagent's binding, by agent id: a message for that subagent is sent through it. */
  bindings: Map<string, ExtensionAPI>;
  /** Main-session bindings that shut down, so a `start` for one that awaited across its own shutdown gives up. */
  shutDown: WeakSet<ExtensionAPI>;
}

/** Shared by every copy of this module in the process (omp re-imports extensions for isolated subagents). */
export const shared: Shared = (() => {
  const store = globalThis as { [key: symbol]: Shared | undefined };
  const key = Symbol.for("omp-coord.runtime");
  store[key] ??= {
    runtime: undefined,
    inactive: NO_CONFIG,
    bindings: new Map(),
    shutDown: new WeakSet(),
  };
  // a copy made by an older version of this module in the same process has no set yet
  store[key].shutDown ??= new WeakSet();
  return store[key];
})();

/** Records the main conversation's omp session id on the board when it is not the one already there. */
export function syncMainSession(rt: Runtime, ctx: ExtensionContext): void {
  const id = ompSessionIdOf(ctx);
  if (id === undefined || id === rt.ompSessionId) return;
  guarded(rt, "record the session id", () => {
    rt.coordinator.bindOmpSession(rt.sessionId, id);
    rt.ompSessionId = id;
  });
}

/** omp's id for the conversation this context belongs to: what its bash calls carry as `PI_SESSION_ID`. */
export function ompSessionIdOf(ctx: ExtensionContext): string | undefined {
  return ctx.sessionManager?.getSessionId?.() || undefined;
}

/** `<scratch>/<session letter>[/<agent id>]`, created on first use; undefined when the scope has no scratch root. */
export function scratchFor(rt: Runtime, agentId?: string): string | undefined {
  const root = rt.config.resources.scratch;
  if (!root) return undefined;
  const dir = agentId && agentId !== "Main" ? join(root, rt.label, agentId) : join(root, rt.label);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Sets omp's spawn queue to what the caps allow this session now (a no-op when the queue isn't driven). */
export function refreshQueue(rt: Runtime): void {
  if (!rt.queue) return;
  const queue = rt.queue;
  guarded(rt, "size omp's spawn queue", () =>
    queue.apply(spawnAllowance(rt.coordinator.board(), rt.config.agents, rt.sessionId, Date.now())),
  );
}

/** A tool's error answer when omp-coord is not active in this session (`shared.inactive` says why). */
export function inactive(): ToolResult {
  return text(shared.inactive, true);
}

/** Delivers `content` through `binding` as an aside that starts a turn when the session is idle. */
export function deliver(binding: ExtensionAPI, content: string): void {
  binding.sendMessage(
    { customType: MESSAGE_TYPE, content, display: true, attribution: "agent" },
    { deliverAs: "aside", triggerTurn: true },
  );
}

/** Shows `message` in the session's UI; a session without a UI shows nothing. */
export function notify(rt: Runtime, message: string, type: "info" | "warning" | "error"): void {
  if (rt.ctx.hasUI) rt.ctx.ui.notify(message, type);
}

/** Subagents whose runs hold slots. The advisor is an observer, not an agent that does work. */
export function isTrackedSubagent(ctx: ExtensionContext): boolean {
  return ctx.agent.kind === "sub" && ctx.agent.id !== "advisor" && ctx.agent.name !== "advisor";
}

/** Runs `fn`; a failure becomes a notice ("omp-coord could not <what>") instead of reaching omp's hook runner. */
export function guarded(rt: Runtime, what: string, fn: () => void): void {
  try {
    fn();
  } catch (error) {
    notify(rt, `omp-coord could not ${what}: ${describe(error)}`, "error");
  }
}

/** A tool answer holding one text block; `isError` marks it as a failure. */
export function text(body: string, isError = false): ToolResult {
  return isError
    ? { content: [{ type: "text", text: body }], isError: true }
    : { content: [{ type: "text", text: body }] };
}

/** The message of an error, or what any other thrown value stringifies to. */
export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
