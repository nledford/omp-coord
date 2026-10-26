/** Plain-text status of the board, for `/coord`, the `coord_status` tool, `omp-coord status` and the footer. */
import { used } from "../../domain/agents.ts";
import { type AgentPolicy, type Board, labelOf } from "../../domain/model.ts";
import { type Queues, orderWaiting } from "../../domain/queues.ts";

export function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function formatStatus(board: Board, policy: AgentPolicy, queues: Queues, scope: string, me: string, now: number): string {
  const lines: string[] = [];
  lines.push(`This session: ${labelOf(board, me) ?? "(not registered)"} (scope ${scope})`);

  lines.push("Sessions:");
  for (const s of [...board.sessions].sort((a, b) => a.label.localeCompare(b.label))) {
    const held = board.slots.filter(x => x.sessionId === s.id);
    const perPool = Object.keys(policy.pools)
      .map(p => [p, held.filter(x => x.pool === p).length] as const)
      .filter(([, n]) => n > 0)
      .map(([p, n]) => `${p} ${n}`);
    const outside = held.filter(x => x.pool === null).length;
    if (outside) perPool.push(`${outside} outside the caps`);
    lines.push(
      `  ${s.label}  ${s.cwd}${s.id === me ? " (this session)" : ""}, since ${clock(s.startedAt)}; agents: ${perPool.join(", ") || "none"}`,
    );
  }

  lines.push(
    `Agent slots: ${Object.entries(policy.pools)
      .map(([p, { cap }]) => `${p} ${used(board, p)}/${cap}`)
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

  const queueLines = formatQueues(board, queues, now);
  if (queueLines.length) lines.push("Build and test queues:", ...queueLines);
  return lines.join("\n");
}

/** One block per queue: running jobs, then waiting jobs in the order they will start. */
export function formatQueues(board: Board, queues: Queues, now: number): string[] {
  const lines: string[] = [];
  const who = (owner: string | null) => (owner === null ? "outside omp" : `session ${labelOf(board, owner) ?? "(ended)"}`);
  const minutes = (ms: number) => `${Math.round(ms / 60_000)} min`;
  for (const [name, q] of Object.entries(queues)) {
    const running = board.jobs.filter(j => j.queue === name && j.state === "running");
    const waiting = orderWaiting(q, name, board, now);
    lines.push(`  ${name} (${q.order}): ${running.length}/${q.slots} running, ${waiting.length} waiting`);
    for (const j of running) lines.push(`    running  ${j.id}  ${who(j.owner)}  ${minutes(now - (j.startedAt ?? now))}  ${j.command}`);
    for (const [i, j] of waiting.entries()) {
      const extras = [j.lane === q.lanes.at(-1) ? "" : `lane ${j.lane}`, j.priority ? `priority ${j.priority}` : ""].filter(Boolean);
      lines.push(`    #${i + 1}       ${j.id}  ${who(j.owner)}  waited ${minutes(now - j.since)}${extras.length ? ` (${extras.join(", ")})` : ""}  ${j.command}`);
    }
  }
  return lines;
}

/** One-line footer summary: `coord B · work 5/8 · short 1/2 · 1 held · 2 in line · heavy 2/2+3`. */
export function formatFooter(board: Board, policy: AgentPolicy, queues: Queues, me: string): string {
  const pools = Object.entries(policy.pools).map(([p, { cap }]) => `${p} ${used(board, p)}/${cap}`);
  const held = board.waitlist.filter(t => t.holdUntil !== undefined).length;
  const waiting = board.waitlist.length - held;
  const jobs = Object.entries(queues).map(([name, q]) => {
    const running = board.jobs.filter(j => j.queue === name && j.state === "running").length;
    const queued = board.jobs.filter(j => j.queue === name && j.state === "waiting").length;
    return `${name} ${running}/${q.slots}${queued ? `+${queued}` : ""}`;
  });
  return [`coord ${labelOf(board, me) ?? "?"}`, ...pools, ...(held ? [`${held} held`] : []), ...(waiting ? [`${waiting} in line`] : []), ...jobs].join(
    " · ",
  );
}
