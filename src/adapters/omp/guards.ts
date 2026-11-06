/**
 * The omp adapter's guards: the agent cap at spawn time, and what an agent's tool call may do: write into a protected
 * checkout, change a claimed branch, worktree or PR, run state-changing `git` in a protected checkout, or run a command
 * a `commands` rule refuses or queues. Each answers a `block` with the reason, or lets the call through (undefined).
 */
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Coordinator } from "../../app/coordinator.ts";
import { decideCommand, MAX_CHECKED_COMMAND } from "../../domain/commands.ts";
import {
  canonicalWith,
  decideWrite,
  type GuardFacts,
  gitChange,
  resolveCwd,
  type WriteDecision,
  type WriteGuard,
  writeTargets,
} from "../../domain/protect.ts";
import type { ExtensionContext, SpawnEvent, ToolCallEvent } from "./api.ts";
import { describe, guarded, notify, type Runtime, refreshQueue, shared, syncMainSession } from "./runtime.ts";

/**
 * How agents' queued commands start the runner: the omp binary itself runs the CLI adapter as Bun
 * (`BUN_BE_BUN=1`, as omp does for its own `bun install`), so no separate Bun install is needed.
 */
const RUNNER = {
  argv: [process.execPath, join(import.meta.dir, "..", "cli", "cli.ts")],
  env: { BUN_BE_BUN: "1" },
};

type Block = { block: true; reason: string };

/** `before_subagent_spawn`: the agent cap. Blocks a spawn that would go over it. */
export function checkSpawn(event: SpawnEvent, ctx: ExtensionContext): Block | undefined {
  const rt = shared.runtime;
  if (!rt) return undefined;
  let decision: ReturnType<Coordinator["requestSpawn"]>;
  try {
    decision = rt.coordinator.requestSpawn({
      sessionId: rt.sessionId,
      parentAgentId: ctx.agent.id,
      parentIsSubagent: ctx.agent.kind === "sub",
      agentType: event.agent.toLowerCase(),
      ...(event.spawnKey === undefined ? {} : { spawnKey: event.spawnKey }),
      ...(event.invocationKind === undefined ? {} : { invocationKind: event.invocationKind }),
    });
    if (event.invocationKind === "eval" && event.spawnKey !== undefined) rt.evalAgents.add(event.spawnKey);
  } catch (error) {
    // The cap is a shared agreement, not a security boundary: a broken board must not stop all work.
    notify(
      rt,
      `omp-coord could not check the agent cap, so ${event.agent} starts unchecked: ${describe(error)}`,
      "error",
    );
    return undefined;
  }
  // outside the decision: a failure here must never turn a refusal into a start
  refreshQueue(rt);
  if (decision.allowed) return undefined;
  notify(rt, `omp-coord refused ${event.agent} from ${ctx.agent.id}: ${decision.reason}`, "warning");
  return { block: true, reason: `omp-coord: ${decision.reason}` };
}

/** `tool_call`: file writes and bash commands. The result is a block, a rewritten bash input, or nothing. */
export function checkToolCall(
  event: ToolCallEvent,
  ctx: ExtensionContext,
): Block | { input: Record<string, unknown> } | undefined {
  const rt = shared.runtime;
  if (!rt) return undefined;
  if (event.toolName !== "bash") return guardWrite(rt, event, ctx);
  const command = event.input?.command;
  if (typeof command !== "string") return undefined;
  // the id must be on the board before the command can reach `omp-coord run`, whatever event announced a switch
  if (ctx.agent.kind === "main") syncMainSession(rt, ctx);

  const cwd = callCwd(ctx, event.input?.cwd);
  try {
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
      // a subagent has no coord_send: it asks through its parent
      const ask = ctx.agent.kind === "main" ? "ask that session with coord_send" : "tell your parent";
      return {
        block: true,
        reason: `omp-coord: ${held.kind} ${held.target} is claimed by session ${holder} (${held.agentId})${held.note ? `: ${held.note}` : ""}. Leave it alone; ${ask} if you need it.`,
      };
    }
  } catch (error) {
    notify(rt, `omp-coord could not check claims: ${describe(error)}`, "error");
  }
  const gitHeld = guardGit(rt, ctx, command, cwd);
  if (gitHeld) return gitHeld;

  const decision = decideCommand(
    rt.config.commands,
    command,
    { ...RUNNER, owner: rt.sessionId, config: rt.config.source },
    ctx.agent.kind,
  );
  if (decision.kind === "refuse") return { block: true, reason: `omp-coord: ${decision.reason}` };
  // Only a queued command is rewritten. Which agent runs it needs no rewrite: omp gives every bash call its agent's
  // session id (`PI_SESSION_ID`), and the board maps that id to the agent (`session_start`, `agent_start`).
  if (decision.kind === "queue") return { input: { ...event.input, command: decision.command } };
  return undefined;
}

/**
 * The `protect` guard for the file tools (`edit`, `write`, `ast_edit`, `apply_patch`): a write into a protected
 * checkout is blocked with a reason naming the resolved path.
 */
function guardWrite(rt: Runtime, event: ToolCallEvent, ctx: ExtensionContext): Block | undefined {
  if (!rt.config.protect) return undefined;
  let targets: string[] | undefined;
  try {
    targets = writeTargets(event.toolName, event.input ?? {});
  } catch (error) {
    notify(rt, `omp-coord could not read a ${event.toolName} call: ${describe(error)}`, "error");
    return undefined;
  }
  if (!targets || targets.length === 0) return undefined;
  return refuseProtected(rt, ctx, event.toolName, targets, ctx.cwd, (guard, facts) =>
    decideWrite(guard, ctx.agent.kind, event.toolName, targets, facts),
  );
}

/** The folder a bash call runs in: its `cwd` as omp reads it (`~` expanded, relative to omp's folder), else omp's. */
function callCwd(ctx: ExtensionContext, inputCwd: unknown): string {
  return typeof inputCwd === "string" ? resolveCwd(ctx.cwd, inputCwd, homedir()) : ctx.cwd;
}

/**
 * The `protect` guard for a bash command's state-changing `git`: it must not run in a protected checkout. A command
 * over the length cap is left to `decideCommand`, which refuses it while a refuse rule exists.
 */
function guardGit(rt: Runtime, ctx: ExtensionContext, command: string, cwd: string): Block | undefined {
  if (!rt.config.protect || command.length > MAX_CHECKED_COMMAND || !/\bgit\b/.test(command)) return undefined;
  return refuseProtected(rt, ctx, "bash", [], cwd, (guard, facts) =>
    gitChange(guard, ctx.agent.kind, command, cwd, facts),
  );
}

/**
 * Judges a call with the disk's facts and blocks it on a refusal. Like every guard here it fails open: a check that
 * throws lets the call run, with a notice; but once the decision is "refuse", failing to log it never lets the call
 * through.
 */
function refuseProtected(
  rt: Runtime,
  ctx: ExtensionContext,
  tool: string,
  shown: string[],
  cwd: string,
  judge: (guard: WriteGuard, facts: GuardFacts) => WriteDecision,
): Block | undefined {
  const guard = rt.config.protect;
  if (!guard) return undefined;
  let decision: WriteDecision;
  try {
    decision = judge(guard, {
      cwd,
      home: homedir(),
      canonical: canonicalWith(p => {
        try {
          return realpathSync(p);
        } catch {
          return undefined;
        }
      }),
      hasGitEntry: dir => existsSync(join(dir, ".git")),
    });
  } catch (error) {
    notify(rt, `omp-coord could not check a ${tool} call: ${describe(error)}`, "error");
    return undefined;
  }
  if (decision.kind === "allow") return undefined;
  guarded(rt, "record a refused call", () =>
    rt.coordinator.recordWriteRefused(rt.sessionId, ctx.agent.id, tool, decision.shown ?? shown),
  );
  return { block: true, reason: `omp-coord: ${decision.reason}` };
}
