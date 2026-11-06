/**
 * omp adapter: maps omp's events, tools and commands onto the application's use cases (`app/coordinator.ts`):
 * registers the session on the shared board, enforces the agent caps through omp's spawn check, follows subagent
 * runs to free slots, delivers messages (to the session or one of its subagents) and slot holds, guards claimed
 * branches, worktrees and PRs, applies command rules to agents' bash calls, and offers `/coord` and the `coord_*`
 * tools.
 *
 * This file wires the hooks and runs the session's life (start, the 2 s tick, stop). The rest is beside it:
 * `guards.ts` (spawn cap, writes, claims, commands), `board.ts` (`/coord` and the tools), `notices.ts` (what is
 * delivered to agents and the user) and `runtime.ts` (the state they share).
 *
 * omp binds this factory once per session in the process (the main session and every subagent). Subagents in an
 * isolated worktree even re-import the module, so the runtime lives on `globalThis` (`runtime.ts`).
 */
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Coordinator } from "../../app/coordinator.ts";
import type { Listener } from "../../app/ports.ts";
import { type Config, ConfigError, findConfigFile, loadConfig } from "../../config.ts";
import { spawnAllowance } from "../../domain/agents.ts";
import { osLoad } from "../os/load.ts";
import { BoardStore, stateDir } from "../sqlite/store.ts";
import { formatFooter } from "../text/report.ts";
import { startBeacon, unixLiveness } from "../unix/beacon.ts";
import type { ExtensionAPI, ExtensionContext } from "./api.ts";
import { registerBoard, registerMainTools } from "./board.ts";
import { checkSpawn, checkToolCall } from "./guards.ts";
import { announceStart, deliverNotices } from "./notices.ts";
import {
  describe,
  guarded,
  isTrackedSubagent,
  notify,
  ompSessionIdOf,
  type Runtime,
  refreshQueue,
  scratchFor,
  shared,
  syncMainSession,
} from "./runtime.ts";
import { loadSettingHandle, type SpawnQueue, spawnQueue } from "./spawn-queue.ts";

const TICK_MS = 2000;
const PRUNE_EVERY_TICKS = 5;
const STATUS_KEY = "omp-coord";

export default function ompCoord(pi: ExtensionAPI): void {
  pi.setLabel("omp-coord");

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.agent.kind !== "main") {
      shared.bindings.set(ctx.agent.id, pi);
      return;
    }
    registerMainTools(pi);
    const rt = shared.runtime;
    if (rt) {
      rt.pi = pi;
      rt.ctx = ctx;
      syncMainSession(rt, ctx);
      return;
    }
    await start(pi, ctx);
  });

  // omp keeps one process across /new, /resume and /fork, giving the main conversation a new id without a new
  // `session_start`: its bash calls carry that id from now on.
  for (const event of ["session_switch", "session_branch"] as const)
    pi.on(event, (_event, ctx) => {
      const rt = shared.runtime;
      if (rt && ctx.agent.kind === "main") syncMainSession(rt, ctx);
    });

  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.agent.kind !== "main") {
      if (shared.bindings.get(ctx.agent.id) === pi) shared.bindings.delete(ctx.agent.id);
      return;
    }
    shared.shutDown.add(pi);
    if (shared.runtime?.pi === pi) stop(shared.runtime);
  });

  pi.on("before_subagent_spawn", (event, ctx) => checkSpawn(event, ctx));

  pi.on("agent_start", (_event, ctx) => {
    const rt = shared.runtime;
    if (!rt || !isTrackedSubagent(ctx)) return;
    guarded(rt, "record an agent run", () => {
      const ompSessionId = ompSessionIdOf(ctx);
      const parentId = ctx.agent.parentId ?? "Main";
      const count = rt.coordinator.agentStarted({
        sessionId: rt.sessionId,
        agentId: ctx.agent.id,
        parentId,
        parentIsSubagent: parentId !== "Main",
        agentType: ctx.agent.name.toLowerCase(),
        evalWorker: rt.evalAgents.has(ctx.agent.id),
        ...(ompSessionId === undefined ? {} : { ompSessionId }),
      });
      refreshQueue(rt);
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
    guarded(rt, "free an agent slot", () => {
      rt.coordinator.agentEnded({ sessionId: rt.sessionId, agentId: ctx.agent.id });
      refreshQueue(rt);
    });
  });

  pi.on("tool_call", (event, ctx) => checkToolCall(event, ctx));

  registerBoard(pi);
}

async function start(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  // a binding started again after an earlier shutdown starts fresh
  shared.shutDown.delete(pi);
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

  // whether spawns past the cap wait in omp's queue, and why not, for the session-start notice
  let queue: SpawnQueue | undefined;
  let queueNote = "Spawns past the cap are refused (agents.queueSpawns is off).";
  if (config.agents.queueSpawns) {
    const handle = await loadSettingHandle();
    // this session ended (switched or reloaded) while the handle loaded: don't join the board for it
    if (shared.shutDown.has(pi)) return;
    const scope = pi.pi?.settings;
    queue = typeof handle === "string" ? undefined : spawnQueue(handle, scope);
    queueNote = queue
      ? "While this is the only session, spawns past the cap wait in omp's queue and start as slots free; with others, they are refused and this session holds a place in line."
      : `Spawns past the cap are refused: ${typeof handle === "string" ? handle : "omp gave the extension no settings scope"}.`;
  }
  const ompSessionId = ompSessionIdOf(ctx);
  let joined: Pick<Runtime, "store" | "coordinator" | "listener" | "sessionId" | "label">;
  try {
    joined = openSession(config, ctx.cwd, ompSessionId);
  } catch (error) {
    shared.inactive = `omp-coord is off: ${describe(error)}`;
    ctx.ui.notify(shared.inactive, "error");
    return;
  }

  const rt: Runtime = {
    config,
    ...joined,
    ompSessionId,
    pi,
    ctx,
    timer: undefined,
    ticks: 0,
    footer: undefined,
    pruning: false,
    queue,
    queueNote,
    evalAgents: new Set(),
  };
  shared.runtime = rt;
  // Commands this session's agents run (e.g. a `just` recipe calling `omp-coord run`) see these.
  process.env.OMP_COORD_SESSION = rt.sessionId;
  const me = rt.coordinator.board().sessions.find(s => s.id === rt.sessionId);
  if (me?.ports) process.env.OMP_COORD_PORTS = `${me.ports.from}-${me.ports.to}`;
  const scratch = scratchFor(rt);
  if (scratch) process.env.OMP_COORD_SCRATCH = scratch;
  rt.timer = ctx.setInterval(() => tick(rt), TICK_MS);
  refreshQueue(rt);
  await prune(rt);
  announceStart(rt, me?.ports !== undefined);
}

/** Opens the scope's board, starts this session's liveness socket and registers it; undoes both on failure. */
function openSession(
  config: Config,
  cwd: string,
  ompSessionId: string | undefined,
): Pick<Runtime, "store" | "coordinator" | "listener" | "sessionId" | "label"> {
  const dir = stateDir();
  mkdirSync(join(dir, "s"), { recursive: true, mode: 0o700 });
  const store = new BoardStore(join(dir, `${config.scope}.db`), config.history);
  let listener: Listener | undefined;
  try {
    const coordinator = new Coordinator(config, store, unixLiveness, Date, osLoad);
    const sessionId = randomBytes(6).toString("hex");
    listener = startBeacon(join(dir, "s", `${sessionId}.sock`));
    const label = coordinator.join(identity(sessionId, cwd, listener, ompSessionId));
    return { store, coordinator, listener, sessionId, label };
  } catch (error) {
    listener?.stop();
    store.close();
    throw error;
  }
}

function identity(sessionId: string, cwd: string, listener: Listener, ompSessionId: string | undefined) {
  return {
    id: sessionId,
    pid: process.pid,
    cwd,
    address: listener.address,
    ...(ompSessionId === undefined ? {} : { ompSessionId }),
  };
}

function stop(rt: Runtime): void {
  shared.runtime = undefined;
  rt.queue?.release();
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
  const { label, inbox, holds, overtime, board } = rt.coordinator.tick(
    identity(rt.sessionId, rt.ctx.cwd, rt.listener, rt.ompSessionId),
  );
  rt.label = label;
  rt.queue?.apply(spawnAllowance(board, rt.config.agents, rt.sessionId, now));
  deliverNotices(rt, { inbox, holds, overtime });

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
