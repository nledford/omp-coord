/** Plain-text status of the board and the build queues, for `/coord` and the `coord_status` tool. */
import { type AgentPolicy, type Board, labelOf, used } from "./domain/board.ts";
import type { QueueView } from "./infra/flock-queues.ts";

export function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function formatStatus(board: Board, policy: AgentPolicy, scope: string, me: string, queues: QueueView[]): string {
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

  if (queues.length) {
    lines.push("Build and test queues:");
    for (const q of queues) {
      const running = q.running.map(r => r.holder || `slot ${r.slot}`).join("; ");
      const waiting = q.waiting.filter(w => w.alive);
      lines.push(
        `  ${q.name}: ${q.running.length}/${q.slots} running${running ? ` (${running})` : ""}, ${waiting.length} waiting` +
          (waiting.length ? `: ${waiting.map(w => `${w.holder || w.ticket} ${Math.round(w.ageSeconds / 60)} min`).join("; ")}` : "") +
          (q.problem ? ` [${q.problem}]` : ""),
      );
    }
  }
  return lines.join("\n");
}

/** One-line footer summary: `coord B · work 5/8 · short 1/2 · 1 held · 2 in line`. */
export function formatFooter(board: Board, policy: AgentPolicy, me: string): string {
  const pools = Object.entries(policy.pools).map(([p, { cap }]) => `${p} ${used(board, p)}/${cap}`);
  const held = board.waitlist.filter(t => t.holdUntil !== undefined).length;
  const waiting = board.waitlist.length - held;
  return [`coord ${labelOf(board, me) ?? "?"}`, ...pools, ...(held ? [`${held} held`] : []), ...(waiting ? [`${waiting} in line`] : [])].join(
    " · ",
  );
}
