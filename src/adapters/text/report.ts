/** Plain text for `/coord`, the agent tools, the `omp-coord` subcommands and the footer. */
import type { Finding } from "../../app/doctor.ts";
import type { Config } from "../../config.ts";
import { capOf, used } from "../../domain/agents.ts";
import { pauseReason } from "../../domain/control.ts";
import type { DayStats, InterruptedSession } from "../../domain/history.ts";
import { currentLoad } from "../../domain/limits.ts";
import { type AgentPolicy, type Board, type Job, labelOf, type Note } from "../../domain/model.ts";
import { agentList, LATEST_NOTES } from "../../domain/overview.ts";
import { orderWaiting, type Queues, slotsOf } from "../../domain/queues.ts";

export function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const minutes = (ms: number) => `${Math.round(ms / 60_000)} min`;

/** `45 s`, `12 min`, `2 h 5 min`. */
function age(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const mins = Math.floor(seconds / 60);
  return mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h ${mins % 60} min`;
}

/**
 * The agents holding slots, one line each: session letter, id, type, parent, pool, state and how long ago the slot was
 * taken. A starting agent's id is the spawn key omp gave, or `(no id yet)`.
 */
export function formatAgents(board: Board, now: number): string {
  const agents = agentList(board);
  if (agents.length === 0) return "No agents are running.";
  const rows = agents.map(a => [
    a.session ?? "?",
    a.id ?? "(no id yet)",
    a.type,
    `parent ${a.parent}`,
    a.pool === null ? "outside the caps" : `pool ${a.pool}`,
    a.state,
    age(now - a.since),
  ]);
  const widths = rows[0]?.map((_, c) => Math.max(...rows.map(r => (r[c] as string).length))) ?? [];
  return [
    `Agents (${agents.length}):`,
    ...rows.map(r => `  ${r.map((cell, c) => (c === r.length - 1 ? cell : cell.padEnd(widths[c] ?? 0))).join("  ")}`),
  ].join("\n");
}

/** Everything on the board, from the view of session `me` ("" outside omp). */
export function formatStatus(board: Board, config: Config, me: string, now: number): string {
  const policy = config.agents;
  const lines: string[] = [];
  lines.push(
    me
      ? `This session: ${labelOf(board, me) ?? "(not registered)"} (scope ${config.scope})`
      : `Scope ${config.scope} (${config.source})`,
  );
  const paused = pauseReason(board);
  if (paused)
    lines.push(`PAUSED: ${paused}, since ${clock(board.pause?.since ?? now)}. No new agent or queued job starts.`);
  const load = currentLoad(board, now);
  if (load !== undefined) lines.push(`Load: ${load}`);

  lines.push("Sessions:");
  for (const s of [...board.sessions].sort((a, b) => a.label.localeCompare(b.label))) {
    const held = board.slots.filter(x => x.sessionId === s.id);
    const perPool = Object.keys(policy.pools)
      .map(p => [p, held.filter(x => x.pool === p).length] as const)
      .filter(([, n]) => n > 0)
      .map(([p, n]) => `${p} ${n}`);
    const outside = held.filter(x => x.pool === null).length;
    if (outside) perPool.push(`${outside} outside the caps`);
    const extras = [
      s.ports ? `ports ${s.ports.from}–${s.ports.to}` : "",
      s.configHash === config.hash ? "" : "DIFFERENT CONFIG FILE",
    ].filter(Boolean);
    lines.push(
      `  ${s.label}  ${s.cwd}${s.id === me ? " (this session)" : ""}, since ${clock(s.startedAt)}; agents: ${perPool.join(", ") || "none"}` +
        (extras.length ? `; ${extras.join("; ")}` : ""),
    );
  }

  lines.push(
    `Agent slots: ${Object.keys(policy.pools)
      .map(p => {
        const cap = capOf(board, policy, p, now);
        const normal = policy.pools[p]?.cap ?? 0;
        return `${p} ${used(board, p)}/${cap}${cap < normal && !board.pause ? ` (lowered from ${normal} under load)` : ""}`;
      })
      .join(", ")}`,
  );

  for (const pool of Object.keys(policy.pools)) {
    const line = board.waitlist.filter(t => t.pool === pool).sort((a, b) => a.since - b.since);
    if (line.length === 0) continue;
    const entries = line.map(
      (t, i) =>
        `#${i + 1} ${labelOf(board, t.sessionId) ?? "?"}${t.holdUntil === undefined ? "" : ` (slot held until ${clock(t.holdUntil)})`}`,
    );
    lines.push(`Line for ${pool}: ${entries.join(", ")}`);
  }

  if (board.claims.length) {
    lines.push("Claims:");
    for (const c of board.claims) {
      lines.push(
        `  ${c.kind} ${c.target}: session ${labelOf(board, c.sessionId) ?? "?"} (${c.agentId}) since ${clock(c.since)}${c.note ? `: ${c.note}` : ""}`,
      );
    }
  }

  const queueLines = formatQueues(board, config.queues, now);
  if (queueLines.length) lines.push("Build and test queues:", ...queueLines);

  const recent = board.notes.slice(-LATEST_NOTES);
  if (recent.length)
    lines.push(
      "Latest decisions (all: notes):",
      ...formatNotes(recent)
        .split("\n")
        .map(l => `  ${l}`),
    );
  return lines.join("\n");
}

/** One block per queue: running jobs, then waiting jobs in the order they will start. */
export function formatQueues(board: Board, queues: Queues, now: number): string[] {
  const lines: string[] = [];
  // whose job: the session, and the agent when recorded ("session A/WaveImport")
  const who = (j: Job) =>
    (j.owner === null ? "outside omp" : `session ${labelOf(board, j.owner) ?? "(ended)"}`) +
    (j.agent ? `/${j.agent}` : "");
  // what it is: the job's key ("<checkout> <recipe> <args>") reads better than the command's full path; the command
  // when there is no key
  const what = (j: Job) => j.key || j.command;
  for (const [name, q] of Object.entries(queues)) {
    const running = board.jobs.filter(j => j.queue === name && j.state === "running");
    const waiting = orderWaiting(q, name, board, now);
    const slots = slotsOf(board, q, now);
    const lowered = slots < q.slots && !board.pause ? ` (lowered from ${q.slots} under load)` : "";
    lines.push(`  ${name} (${q.order}): ${running.length}/${slots} running${lowered}, ${waiting.length} waiting`);
    for (const j of running)
      lines.push(`    running  ${j.id}  ${who(j)}  ${minutes(now - (j.startedAt ?? now))}  ${what(j)}`);
    for (const [i, j] of waiting.entries()) {
      const extras = [
        j.lane === q.lanes.at(-1) ? "" : `lane ${j.lane}`,
        j.priority ? `priority ${j.priority}` : "",
      ].filter(Boolean);
      lines.push(
        `    #${i + 1}       ${j.id}  ${who(j)}  waited ${minutes(now - j.since)}${extras.length ? ` (${extras.join(", ")})` : ""}  ${what(j)}`,
      );
    }
  }
  return lines;
}

/** One-line footer summary: `coord B · PAUSED · work 5/8 · short 1/2 · 1 held · 2 in line · heavy 2/2+3`. */
export function formatFooter(board: Board, policy: AgentPolicy, queues: Queues, me: string, now: number): string {
  const pools = Object.keys(policy.pools).map(p => `${p} ${used(board, p)}/${capOf(board, policy, p, now)}`);
  const held = board.waitlist.filter(t => t.holdUntil !== undefined).length;
  const waiting = board.waitlist.length - held;
  const jobs = Object.entries(queues).map(([name, q]) => {
    const running = board.jobs.filter(j => j.queue === name && j.state === "running").length;
    const queued = board.jobs.filter(j => j.queue === name && j.state === "waiting").length;
    return `${name} ${running}/${slotsOf(board, q, now)}${queued ? `+${queued}` : ""}`;
  });
  return [
    `coord ${labelOf(board, me) ?? "?"}`,
    ...(board.pause ? ["PAUSED"] : []),
    ...pools,
    ...(held ? [`${held} held`] : []),
    ...(waiting ? [`${waiting} in line`] : []),
    ...jobs,
  ].join(" · ");
}

export function formatNotes(notes: Note[]): string {
  if (notes.length === 0) return "No notes yet.";
  return notes
    .map(
      n =>
        `#${n.id} ${new Date(n.at).toLocaleString([], { dateStyle: "short", timeStyle: "short" })} ${n.label ? `session ${n.label}` : "outside omp"} (${n.author}): ${n.text}`,
    )
    .join("\n");
}

export function formatInterrupted(sessions: InterruptedSession[]): string {
  if (sessions.length === 0) return "No session left agents running in that time.";
  const lines: string[] = [];
  for (const s of sessions) {
    lines.push(
      `Session ${s.label ?? "?"} (${s.cwd ?? "folder unknown"}) left at ${new Date(s.leftAt).toLocaleString()} with ${s.agents.length} agent(s) mid-run:`,
    );
    for (const a of s.agents) lines.push(`  ${a.id} (${a.type}), run started ${clock(a.startedAt)}`);
  }
  lines.push(
    "Revive each from an omp session in the same folder with `write agent://<id>`, naming its worktree's state (git status, last commit) and telling it to inspect and continue.",
  );
  return lines.join("\n");
}

export function formatStats(days: DayStats[]): string {
  if (days.length === 0) return "No events in that time.";
  const lines: string[] = [];
  for (const d of days) {
    const peaks =
      Object.entries(d.peakAgents)
        .map(([p, n]) => `${p} ${n}`)
        .join(", ") || "none";
    lines.push(
      `${d.day}: ${d.refusals} spawn refusal(s), ${d.holdsUsed} held slot(s) used (longest wait ${minutes(d.maxHoldWaitMs)}), peak agents ${peaks}`,
    );
    for (const [q, s] of Object.entries(d.queues)) {
      lines.push(
        `  ${q}: ${s.started} started, wait avg ${minutes(s.avgWaitMs)} / max ${minutes(s.maxWaitMs)}; ${s.ended} ended, ${s.failed} failed${s.timedOut ? ` (${s.timedOut} timed out)` : ""}`,
      );
    }
  }
  return lines.join("\n");
}

export function formatFindings(findings: Finding[]): string {
  const mark = { ok: "ok   ", warn: "WARN ", error: "ERROR" } as const;
  return findings.map(f => `${mark[f.level]} ${f.text}`).join("\n");
}
