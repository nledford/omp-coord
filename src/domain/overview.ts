/**
 * The board as plain data for readers: `omp-coord status --json` prints a `StatusView`, and the text reports format
 * its `agents`. Pure: callers pass `now` and the policies. Every time is milliseconds since the epoch; a session is
 * named by its letter, or null when there is none (a job started outside omp, or by a session that has ended).
 *
 * The field names are part of the contract (docs/commands.md, docs/versioning.md): rename or remove one only as a
 * breaking change.
 */
import { capOf, used } from "./agents.ts";
import { currentLoad } from "./limits.ts";
import { type AgentPolicy, type Board, labelOf } from "./model.ts";
import { orderWaiting, type Queues, slotsOf } from "./queues.ts";

/** What the view needs of the scope's configuration. `Config` satisfies it. */
export interface ScopeConfig {
  scope: string;
  /** The config file the scope was read from. */
  source: string;
  /** Hash of that file; sessions that read another one are flagged. */
  hash: string;
  agents: AgentPolicy;
  queues: Queues;
}

/** How many of the latest notes the view carries. */
export const LATEST_NOTES = 3;

export interface AgentView {
  /** omp's agent id; null for an approved spawn whose first run has not started and that omp gave no key for. */
  id: string | null;
  type: string;
  /** `Main` or the id of the subagent that started it. */
  parent: string;
  /** Letter of the session it runs in. */
  session: string | null;
  /** The pool holding its slot; null outside the caps (exempt types and nested reviewers). */
  pool: string | null;
  /** `starting`: approved, first run not seen yet. */
  state: "starting" | "running";
  /** When it took its slot. */
  since: number;
}

export interface JobView {
  id: string;
  /** Letter of the session whose agent started it; null outside omp or once that session ended. */
  session: string | null;
  /** The owning session's id; null outside omp. */
  owner: string | null;
  lane: string;
  priority: number;
  key: string | null;
  command: string;
  state: "running" | "waiting";
  /** When it joined the line (a superseding job keeps the place of the one it replaced). */
  queuedAt: number;
  /** When it started; null while waiting. */
  startedAt: number | null;
  /** Place in line, from 1, in the order jobs will start; null while running. */
  position: number | null;
}

export interface StatusView {
  /** When the view was built. */
  generatedAt: number;
  scope: { name: string; source: string };
  /** `by` is the pausing session's letter; null from a terminal, or once that session ended (`byId` tells which). */
  paused: { by: string | null; byId: string | null; reason: string; since: number } | null;
  /** The load average the limits act on; null without a fresh reading. */
  load: number | null;
  sessions: {
    letter: string;
    id: string;
    folder: string;
    pid: number;
    since: number;
    /** Slots held per configured pool, and agents outside the caps. */
    agents: { pools: Record<string, number>; outsideCaps: number };
    ports: { from: number; to: number } | null;
    /** Whether it read a different config file than this scope's. */
    differentConfig: boolean;
  }[];
  pools: { name: string; used: number; cap: number; configuredCap: number }[];
  /** Sessions waiting for a slot, per pool, first in line first. */
  line: { pool: string; session: string | null; position: number; since: number; heldUntil: number | null }[];
  agents: AgentView[];
  claims: {
    kind: string;
    target: string;
    session: string | null;
    agent: string;
    note: string;
    since: number;
  }[];
  queues: {
    name: string;
    order: string;
    /** Slots now: lowered under load, 0 while paused. */
    slots: number;
    configuredSlots: number;
    running: JobView[];
    waiting: JobView[];
  }[];
  /** The latest notes, oldest first. `session` is the letter when the note was written, kept after that session ends. */
  notes: { id: number; at: number; session: string | null; author: string; text: string }[];
}

/** Every agent holding a slot, by session letter then start. */
export function agentList(board: Board): AgentView[] {
  return board.slots
    .map(s => ({
      id: s.agentId ?? null,
      type: s.agentType,
      parent: s.parentId,
      session: labelOf(board, s.sessionId) ?? null,
      pool: s.pool,
      state: s.state,
      since: s.since,
    }))
    .sort(
      (a, b) =>
        (a.session ?? "").localeCompare(b.session ?? "") || a.since - b.since || (a.id ?? "").localeCompare(b.id ?? ""),
    );
}

export function statusView(board: Board, config: ScopeConfig, now: number): StatusView {
  const policy = config.agents;
  const letter = (sessionId: string | null) => (sessionId === null ? null : (labelOf(board, sessionId) ?? null));
  const pools = Object.keys(policy.pools);

  const job = (j: Board["jobs"][number], position: number | null): JobView => ({
    id: j.id,
    session: letter(j.owner),
    owner: j.owner,
    lane: j.lane,
    priority: j.priority,
    key: j.key ?? null,
    command: j.command,
    state: position === null ? "running" : "waiting",
    queuedAt: j.since,
    startedAt: j.startedAt ?? null,
    position,
  });

  const paused = board.pause;
  return {
    generatedAt: now,
    scope: { name: config.scope, source: config.source },
    paused: paused ? { by: letter(paused.by), byId: paused.by, reason: paused.reason, since: paused.since } : null,
    load: currentLoad(board, now) ?? null,
    sessions: [...board.sessions]
      .sort((a, b) => a.label.localeCompare(b.label))
      .map(s => {
        const held = board.slots.filter(x => x.sessionId === s.id);
        return {
          letter: s.label,
          id: s.id,
          folder: s.cwd,
          pid: s.pid,
          since: s.startedAt,
          agents: {
            pools: Object.fromEntries(pools.map(p => [p, held.filter(x => x.pool === p).length])),
            outsideCaps: held.filter(x => x.pool === null).length,
          },
          ports: s.ports ? { from: s.ports.from, to: s.ports.to } : null,
          differentConfig: s.configHash !== config.hash,
        };
      }),
    pools: pools.map(name => ({
      name,
      used: used(board, name),
      cap: capOf(board, policy, name, now),
      configuredCap: policy.pools[name]?.cap ?? 0,
    })),
    line: pools.flatMap(pool =>
      board.waitlist
        .filter(t => t.pool === pool)
        .sort((a, b) => a.since - b.since)
        .map((t, i) => ({
          pool,
          session: letter(t.sessionId),
          position: i + 1,
          since: t.since,
          heldUntil: t.holdUntil ?? null,
        })),
    ),
    agents: agentList(board),
    claims: board.claims.map(c => ({
      kind: c.kind,
      target: c.target,
      session: letter(c.sessionId),
      agent: c.agentId,
      note: c.note,
      since: c.since,
    })),
    queues: Object.entries(config.queues).map(([name, q]) => ({
      name,
      order: q.order,
      slots: slotsOf(board, q, now),
      configuredSlots: q.slots,
      running: board.jobs.filter(j => j.queue === name && j.state === "running").map(j => job(j, null)),
      waiting: orderWaiting(q, name, board, now).map((j, i) => job(j, i + 1)),
    })),
    notes: board.notes.slice(-LATEST_NOTES).map(n => ({
      id: n.id,
      at: n.at,
      session: n.label,
      author: n.author,
      text: n.text,
    })),
  };
}
