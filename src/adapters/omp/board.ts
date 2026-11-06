/**
 * The board as omp shows it: the `/coord` command and the `coord_*` tools. Both read and change the shared board
 * through the coordinator and answer in the text `text/report.ts` makes.
 */
import { spawnAllowance } from "../../domain/agents.ts";
import type { Claim } from "../../domain/model.ts";
import { LATEST_NOTES } from "../../domain/overview.ts";
import {
  formatAgents,
  formatInterrupted,
  formatNotes,
  formatStats,
  formatStatus,
  type StatusOptions,
} from "../text/report.ts";
import type { ExtensionAPI, ToolResult } from "./api.ts";
import { describe, inactive, type Runtime, scratchFor, shared, text } from "./runtime.ts";

const DAY = 86_400_000;
const CLAIM_KINDS: Claim["kind"][] = ["branch", "worktree", "pr"];

/** Main-session bindings whose main-only tools are registered, so a repeated `session_start` registers once. */
const mainToolsRegistered = new WeakSet<ExtensionAPI>();

/** `coord_status` and `coord_resources`: the tools every agent has, and the `/coord` command. */
export function registerBoard(pi: ExtensionAPI): void {
  pi.registerTool<{ notes?: number; compact?: boolean }>({
    name: "coord_status",
    label: "Coordination status",
    description:
      "Shows sessions, agent slots, the line, claims, build/test queues and recent decisions; check it before starting agents or heavy builds.",
    parameters: pi.zod.object({
      notes: pi.zod.number().optional().describe("Decisions to list (default 3; 0 in subagents)"),
      compact: pi.zod.boolean().optional().describe("Shorter lines (default on in subagents)"),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const rt = shared.runtime;
      if (!rt) return inactive();
      const sub = ctx.agent.kind !== "main";
      const notes = params.notes ?? (sub ? 0 : LATEST_NOTES);
      if (!Number.isSafeInteger(notes) || notes < 0) return text("notes must be a whole number, 0 or more", true);
      return text(statusText(rt, { notes, compact: params.compact ?? sub }));
    },
  });

  pi.registerTool<Record<string, never>>({
    name: "coord_resources",
    label: "Ports and scratch folder",
    description:
      "Your own block of ports and scratch folder, never shared with other agents or sessions; stable per agent.",
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

/**
 * The tools only the main session uses. They are registered from the main session's `session_start`, where
 * `ctx.agent.kind` is known, not in the factory: omp rebinds the factory for every subagent, and a subagent's tool
 * list is text in every request it makes.
 */
export function registerMainTools(pi: ExtensionAPI): void {
  if (mainToolsRegistered.has(pi)) return;
  mainToolsRegistered.add(pi);

  pi.registerTool<{ to: string; text: string }>({
    name: "coord_send",
    label: "Message another omp session",
    description:
      "Messages another omp session in this project: `to` is its letter, `<letter>/<agent id>` or `all`; keep it short and factual, never just to acknowledge.",
    parameters: pi.zod.object({
      to: pi.zod.string().describe("Letter, `B/<agent id>`, or `all`"),
      text: pi.zod.string().describe("The message"),
    }),
    async execute(_id, params) {
      const rt = shared.runtime;
      if (!rt) return inactive();
      return sendFrom(rt, params.to, params.text);
    },
  });

  pi.registerTool<{ kind: string; target: string; note?: string }>({
    name: "coord_claim",
    label: "Claim a branch, worktree or PR",
    description:
      "Claims a branch, worktree (absolute path) or PR (number) so other sessions' agents can't change it with git or gh until released; refused when held.",
    parameters: pi.zod.object({
      kind: pi.zod.string().describe("branch, worktree or pr"),
      target: pi.zod.string().describe("Branch, worktree path, or PR number"),
      note: pi.zod.string().optional().describe("What you do with it, which files"),
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
    description: "Releases a branch, worktree or PR this session claimed.",
    parameters: pi.zod.object({
      kind: pi.zod.string().describe("branch, worktree or pr"),
      target: pi.zod.string().describe("Branch, worktree path, or PR number"),
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
      "Adds a short entry to the decision log every session sees: a user decision with who and when, or a fact all must keep to; not progress.",
    parameters: pi.zod.object({
      text: pi.zod.string().describe("E.g. 'User, 14:05: ship #2913 first'"),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const rt = shared.runtime;
      if (!rt) return inactive();
      const r = rt.coordinator.note(rt.sessionId, ctx.agent.id, params.text);
      return r.ok ? text(`Recorded as decision #${r.note.id}.`) : text(`Not recorded: ${r.reason}.`, true);
    },
  });

  pi.registerTool<{ job: string; priority: string }>({
    name: "coord_job_priority",
    label: "Reorder this session's queued jobs",
    description:
      "Sets the priority of one of this session's waiting queue jobs; higher goes first, never ahead of other sessions' jobs in fair-share queues.",
    parameters: pi.zod.object({
      job: pi.zod.string().describe("Job id from coord_status"),
      priority: pi.zod.string().describe("Whole number; 0 normal, higher first"),
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
}

function sendFrom(rt: Runtime, to: string, body: string): ToolResult {
  const result = rt.coordinator.send(rt.sessionId, to, body);
  return result.ok ? text(`Sent to ${result.delivered.join(", ")}.`) : text(`Not sent: ${result.reason}.`, true);
}

function statusText(rt: Runtime, options: StatusOptions = {}): string {
  const board = rt.coordinator.board();
  const status = formatStatus(board, rt.config, rt.sessionId, Date.now(), options);
  if (options.compact) return status;
  // whether this session's spawns wait in omp's queue right now, and why not
  const queueLine = !rt.queue
    ? rt.queueNote
    : spawnAllowance(board, rt.config.agents, rt.sessionId, Date.now()) !== undefined
      ? "Spawns past the cap wait in omp's queue and start as slots free (this is the only session)."
      : `Spawns over the cap are refused and put this session in line (${board.pause ? "the scope is paused" : board.sessions.length > 1 ? "other sessions are in the scope" : board.slots.some(x => x.sessionId === rt.sessionId && x.unqueued === "eval") ? "a workpool's workers are running" : "no slot is free for a new spawn"}).`;
  return `${status}\n${queueLine}`;
}

function claimKind(word: string): Claim["kind"] | undefined {
  const k = word.trim().toLowerCase();
  return CLAIM_KINDS.find(x => x === k);
}

function count(word: string | undefined, fallback: number): number {
  const n = Number(word);
  return word !== undefined && Number.isSafeInteger(n) && n > 0 ? n : fallback;
}
