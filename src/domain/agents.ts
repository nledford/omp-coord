/**
 * Agent slots: pools with caps shared by every session, the line of sessions refused a slot, slots held for the
 * session first in line, and what subagents may start themselves.
 */
import { pauseReason } from "./control.ts";
import { currentLoad, limitUnderLoad } from "./limits.ts";
import { type AgentPolicy, type Board, emit } from "./model.ts";

export function poolFor(policy: AgentPolicy, agentType: string): string | null {
  if (policy.exempt.includes(agentType)) return null;
  for (const [name, pool] of Object.entries(policy.pools)) if (pool.agentTypes.includes(agentType)) return name;
  return policy.defaultPool;
}

export function used(board: Board, pool: string): number {
  return board.slots.filter(s => s.pool === pool).length;
}

function activeHolds(board: Board, pool: string): number {
  return board.waitlist.filter(t => t.pool === pool && t.holdUntil !== undefined).length;
}

/** A pool's cap now: lowered while the machine is under load, 0 while paused. */
export function capOf(board: Board, policy: AgentPolicy, pool: string, now: number): number {
  const p = policy.pools[pool];
  if (!p || board.pause) return 0;
  return limitUnderLoad(p.cap, p.loadCaps, currentLoad(board, now));
}

export interface SpawnRequest {
  sessionId: string;
  /** The agent asking: `Main` or a subagent id. */
  parentAgentId: string;
  parentIsSubagent: boolean;
  agentType: string;
  /** omp's spawn key: the new agent's id for `task`, eval `agent()` and workpools; only a label for some callers. */
  spawnKey?: string;
  /** How omp starts it; "eval" (eval `agent()` and workpool workers) takes no place in omp's spawn queue. */
  invocationKind?: string;
  now: number;
}

export type SpawnDecision =
  | { allowed: true; pool: string | null }
  | { allowed: false; pool: string | null; reason: string; position?: number };

/**
 * Decides whether an agent may start. An approved agent takes its slot at once (state `starting`).
 * A refusal puts the session in line for that pool (once; later refusals keep its place).
 */
export function requestSpawn(board: Board, policy: AgentPolicy, req: SpawnRequest): SpawnDecision {
  expire(board, policy, req.now);

  if (req.parentIsSubagent) {
    if (!policy.nested.allow.includes(req.agentType)) {
      const reason = `subagents may start only ${listOr(policy.nested.allow)}; plan "${req.agentType}" work as a separate agent of the main session`;
      emit(board, req.now, "spawn_refused", req.sessionId, { agentType: req.agentType, nested: true, reason });
      return { allowed: false, pool: null, reason };
    }
    const running = board.slots.filter(
      s =>
        s.sessionId === req.sessionId && s.parentId === req.parentAgentId && policy.nested.allow.includes(s.agentType),
    ).length;
    if (running >= policy.nested.maxRunningPerParent) {
      const reason = `a subagent may run ${policy.nested.maxRunningPerParent} ${listOr(policy.nested.allow)} at a time; wait for the running one to finish`;
      emit(board, req.now, "spawn_refused", req.sessionId, { agentType: req.agentType, nested: true, reason });
      return { allowed: false, pool: null, reason };
    }
    addStartingSlot(board, req, null);
    return { allowed: true, pool: null };
  }

  const pool = poolFor(policy, req.agentType);
  if (pool === null) {
    addStartingSlot(board, req, null);
    return { allowed: true, pool: null };
  }

  const mine = board.waitlist.find(t => t.sessionId === req.sessionId && t.pool === pool);
  if (mine?.holdUntil !== undefined && !board.pause) {
    board.waitlist = board.waitlist.filter(t => t !== mine);
    emit(board, req.now, "hold_used", req.sessionId, { pool, waitedMs: req.now - mine.since });
    addStartingSlot(board, req, pool);
    return { allowed: true, pool };
  }

  const cap = capOf(board, policy, pool, req.now);
  if (used(board, pool) + activeHolds(board, pool) < cap && !mine) {
    addStartingSlot(board, req, pool);
    return { allowed: true, pool };
  }

  const ticket = mine ?? { sessionId: req.sessionId, pool, since: req.now, holdUntil: undefined, notified: false };
  if (!mine) board.waitlist.push(ticket);
  const line = board.waitlist.filter(t => t.pool === pool).sort((a, b) => a.since - b.since);
  const position = line.indexOf(ticket) + 1;
  emit(board, req.now, "spawn_refused", req.sessionId, {
    agentType: req.agentType,
    pool,
    position,
    used: used(board, pool),
    cap,
  });
  const normal = policy.pools[pool]?.cap ?? 0;
  const load = currentLoad(board, req.now);
  const why = board.pause
    ? `${pauseReason(board)}. No new agents start until it resumes`
    : `FULL: ${used(board, pool)}/${cap} ${pool} slots are in use across all sessions` +
      (cap < normal ? ` (the cap is lowered from ${normal} at load ${load})` : "") +
      (activeHolds(board, pool) ? ` and ${activeHolds(board, pool)} more held for sessions ahead in line` : "");
  return {
    allowed: false,
    pool,
    position,
    reason: `${why}. This session is #${position} in line for a ${pool} slot. Start nothing else now; you will get a message when a slot is held for you.`,
  };
}

function addStartingSlot(board: Board, req: SpawnRequest, pool: string | null): void {
  board.slots.push({
    sessionId: req.sessionId,
    agentId: req.spawnKey,
    parentId: req.parentAgentId,
    agentType: req.agentType,
    pool,
    state: "starting",
    since: req.now,
    ...(req.invocationKind === "eval" ? { unqueued: "eval" as const } : {}),
  });
  emit(board, req.now, "spawn_approved", req.sessionId, {
    agentType: req.agentType,
    pool,
    nested: req.parentIsSubagent,
  });
}

/**
 * An agent's run started. Claims its approved slot; an agent with no slot (a revived one, or one started before this
 * session joined) takes one even over the cap: running agents are never stopped, the cap only refuses new ones.
 * An agent started by a subagent stays outside the caps, as when it was first approved.
 * Returns the agent's pool count after the change, or null for agents outside the caps.
 */
export function agentStarted(
  board: Board,
  policy: AgentPolicy,
  a: {
    sessionId: string;
    agentId: string;
    parentId: string;
    parentIsSubagent: boolean;
    agentType: string;
    now: number;
  },
): { pool: string; used: number; cap: number } | null {
  expire(board, policy, a.now);
  let slot = board.slots.find(s => s.sessionId === a.sessionId && s.agentId === a.agentId);
  slot ??= board.slots.find(
    s =>
      s.sessionId === a.sessionId &&
      s.state === "starting" &&
      s.agentId !== undefined &&
      a.agentId.endsWith(`.${s.agentId}`),
  );
  // No key matched: take the oldest approval for the same parent and type that was given no key, or whose key is a
  // label the id grew from (`CleanseDiscovery` for agent `CleanseDiscovery-2`). A slot keyed for another agent is
  // that agent's, even while a revived sibling looks for one.
  slot ??= board.slots
    .filter(
      s =>
        s.sessionId === a.sessionId &&
        s.state === "starting" &&
        s.parentId === a.parentId &&
        s.agentType === a.agentType &&
        (s.agentId === undefined || a.agentId.startsWith(s.agentId)),
    )
    .sort((x, y) => Number(x.agentId !== undefined) - Number(y.agentId !== undefined) || x.since - y.since)[0];

  const revived = !slot;
  if (slot) {
    slot.agentId = a.agentId;
    slot.state = "running";
  } else {
    slot = {
      sessionId: a.sessionId,
      agentId: a.agentId,
      parentId: a.parentId,
      agentType: a.agentType,
      pool: a.parentIsSubagent ? null : poolFor(policy, a.agentType),
      state: "running",
      since: a.now,
      unqueued: "revived",
    };
    board.slots.push(slot);
  }
  const count =
    slot.pool === null
      ? null
      : { pool: slot.pool, used: used(board, slot.pool), cap: capOf(board, policy, slot.pool, a.now) };
  emit(board, a.now, "run_started", a.sessionId, {
    agentId: a.agentId,
    agentType: a.agentType,
    ...(count ?? { pool: null }),
    revived,
  });
  return count;
}

/** An agent's run ended (finished, failed, or killed): its slot frees until it runs again. */
export function agentEnded(
  board: Board,
  policy: AgentPolicy,
  a: { sessionId: string; agentId: string; now: number },
): void {
  const slot = board.slots.find(s => s.sessionId === a.sessionId && s.agentId === a.agentId);
  if (slot) {
    board.slots = board.slots.filter(s => s !== slot);
    emit(board, a.now, "run_ended", a.sessionId, { agentId: a.agentId, pool: slot.pool, ranMs: a.now - slot.since });
  }
  expire(board, policy, a.now);
}

/**
 * Drops spawns that never started and holds nobody used, then hands freed slots to the sessions in line. While
 * paused, holds do not run out: their sessions cannot use them, and `resume` starts them again.
 */
export function expire(board: Board, policy: AgentPolicy, now: number): void {
  for (const s of board.slots.filter(s => s.state === "starting" && now - s.since > policy.startTimeoutMs)) {
    emit(board, now, "start_expired", s.sessionId, { agentType: s.agentType, pool: s.pool });
  }
  board.slots = board.slots.filter(s => s.state !== "starting" || now - s.since <= policy.startTimeoutMs);
  if (board.pause) return;
  for (const t of board.waitlist.filter(t => t.holdUntil !== undefined && now > t.holdUntil)) {
    emit(board, now, "hold_expired", t.sessionId, { pool: t.pool, waitedMs: now - t.since });
  }
  board.waitlist = board.waitlist.filter(t => t.holdUntil === undefined || now <= t.holdUntil);
  grantHolds(board, policy, now);
}

/** Holds freed slots for the sessions longest in line. Runs after anything that may free a slot. */
export function grantHolds(board: Board, policy: AgentPolicy, now: number): void {
  for (const pool of Object.keys(policy.pools)) {
    let free = capOf(board, policy, pool, now) - used(board, pool) - activeHolds(board, pool);
    const waiting = board.waitlist
      .filter(t => t.pool === pool && t.holdUntil === undefined)
      .sort((a, b) => a.since - b.since);
    for (const ticket of waiting) {
      if (free <= 0) break;
      ticket.holdUntil = now + policy.holdMs;
      ticket.notified = false;
      emit(board, now, "hold_granted", ticket.sessionId, {
        pool,
        until: ticket.holdUntil,
        waitedMs: now - ticket.since,
      });
      free--;
    }
  }
}

/** Holds granted to a session that it has not been told about yet; marks them told. */
export function takeNewHolds(board: Board, sessionId: string): { pool: string; until: number }[] {
  const fresh = board.waitlist.filter(t => t.sessionId === sessionId && t.holdUntil !== undefined && !t.notified);
  for (const t of fresh) t.notified = true;
  return fresh.map(t => ({ pool: t.pool, until: t.holdUntil as number }));
}
function listOr(items: string[]): string {
  if (items.length === 0) return "nothing";
  if (items.length === 1) return items[0] as string;
  return `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`;
}

/**
 * How many of this session's own (main-agent) spawns may run at once right now, for omp's per-session spawn queue
 * (`task.maxConcurrency`), or `undefined` when the queue must not be driven and spawns are left to the spawn check.
 *
 * Driven only while this session is alone in the scope, not paused, and runs no eval workpool workers. omp re-reads its queue size only when this
 * session asks for a spawn or one of its runs ends, and a spawn parked in that queue never reaches the spawn check, so
 * it never joins the line: with other sessions, a slot one of them frees could not be held for this session fairly.
 * There the refusal and the line decide, as they always did.
 *
 * Alone, the allowance is this session's top-level agents that hold a place in omp's queue (running or starting, not
 * `unqueued` ones: revived agents and workpool workers), plus the default pool's free slots and one held for it there. Other pools'
 * free slots are left out: omp's queue doesn't know a waiting spawn's pool, so counting them would let a default-pool
 * spawn through to a refusal. `undefined` too when that comes to 0 (every slot taken by agents outside omp's queue):
 * omp reads 0 as unlimited, and a floor of 1 would let each waiting spawn through to a refusal in turn.
 */
export function spawnAllowance(board: Board, policy: AgentPolicy, sessionId: string, now: number): number | undefined {
  if (board.pause || board.sessions.some(s => s.id !== sessionId)) return undefined;
  // an eval workpool sizes itself from the same setting while its own workers take slots: one number can't size
  // both queues, so while workers run the spawn check decides
  if (board.slots.some(s => s.sessionId === sessionId && s.unqueued === "eval")) return undefined;
  const pool = policy.defaultPool;
  const queued = board.slots.filter(s => s.sessionId === sessionId && s.parentId === "Main" && !s.unqueued).length;
  const held = board.waitlist.filter(
    t => t.sessionId === sessionId && t.pool === pool && t.holdUntil !== undefined,
  ).length;
  const free = Math.max(0, capOf(board, policy, pool, now) - used(board, pool) - activeHolds(board, pool));
  const allowance = queued + held + free;
  return allowance > 0 ? allowance : undefined;
}
