/**
 * The coordination board: every omp session on this machine that shares one scope (e.g. one project), the agent
 * slots they hold, the line of sessions waiting for a slot, and messages between sessions.
 *
 * Pure state transitions over a plain, JSON-serializable `Board`. Persistence and clocks live outside: callers pass
 * `now` (ms since epoch) and run each transition inside one store transaction.
 */

/** How many agents may run at once, and which agent types fall where. */
export interface AgentPolicy {
  /** Pools of slots: each has a cap shared by every session, and the agent types it covers. */
  pools: Record<string, { cap: number; agentTypes: string[] }>;
  /** Pool for agent types no pool lists. */
  defaultPool: string;
  /** Agent types that never take a slot (read-only reviewers). */
  exempt: string[];
  /** What a subagent may start itself: only these types, at most this many running per parent, outside the caps. */
  nested: { allow: string[]; maxRunningPerParent: number };
  /** How long a freed slot stays held for the session first in line. */
  holdMs: number;
  /** How long an approved spawn may take to start its first run before its slot is given back. */
  startTimeoutMs: number;
  /** Messages one session may send per minute. */
  messagesPerMinute: number;
}

export interface SessionRecord {
  id: string;
  /** Short name other sessions and the user address it by: A, B, C… */
  label: string;
  pid: number;
  cwd: string;
  /** Unix socket the session listens on while it lives; how other sessions tell it is gone. */
  socket: string;
  startedAt: number;
}

/** One agent's hold on a pool slot. `pool: null` for agents outside the caps (exempt and nested reviewers). */
export interface AgentSlot {
  sessionId: string;
  /** omp agent id once its first run started; until then the spawn key, when omp gave one. */
  agentId: string | undefined;
  parentId: string;
  agentType: string;
  pool: string | null;
  /** `starting`: approved, first run not seen yet. `running`: in a run. */
  state: "starting" | "running";
  since: number;
}

/** A session's place in line for a pool, after a refused spawn. */
export interface Ticket {
  sessionId: string;
  pool: string;
  since: number;
  /** Set when a slot freed and is held for this session until then. */
  holdUntil: number | undefined;
  /** Whether the session has been told about its hold. */
  notified: boolean;
}

export interface Message {
  fromId: string;
  toId: string;
  text: string;
  sentAt: number;
}

/** Something that happened on the board, for the event log. Transitions append; the store drains them. */
export interface BoardEvent {
  at: number;
  type:
    | "session_joined"
    | "session_left"
    | "spawn_approved"
    | "spawn_refused"
    | "run_started"
    | "run_ended"
    | "start_expired"
    | "hold_granted"
    | "hold_used"
    | "hold_expired"
    | "message_sent"
    | "job_queued"
    | "job_withdrawn"
    | "job_refused"
    | "job_started"
    | "job_ended"
    | "job_lost"
    | "job_superseded"
    | "job_reprioritized";
  /** The omp session concerned; null for build jobs started outside any omp session. */
  sessionId: string | null;
  /** The session's letter when the event happened. */
  label: string | null;
  data: Record<string, unknown>;
}

/** A build or test job in a queue (see `queues.ts`). */
export interface Job {
  id: string;
  queue: string;
  /** The omp session whose agent started it, or null (a terminal, a script). Fair share is per owner. */
  owner: string | null;
  lane: string;
  priority: number;
  /** Jobs with the same key are duplicates (e.g. "<checkout> ci"). */
  key: string | undefined;
  /** What runs, for display. */
  command: string;
  /** The runner's liveness socket and process id. */
  socket: string;
  pid: number;
  state: "waiting" | "running" | "superseded";
  since: number;
  startedAt: number | undefined;
}

export interface Board {
  sessions: SessionRecord[];
  slots: AgentSlot[];
  waitlist: Ticket[];
  messages: Message[];
  /** When each session sent its recent messages, for the rate limit. */
  sent: { sessionId: string; at: number }[];
  jobs: Job[];
  /** When each owner last had a job started in each queue, for fair share. */
  served: { queue: string; owner: string | null; at: number }[];
  /** Events since the board was loaded, oldest first. Not board state: the store moves them to the log. */
  events: BoardEvent[];
}

export function emptyBoard(): Board {
  return { sessions: [], slots: [], waitlist: [], messages: [], sent: [], jobs: [], served: [], events: [] };
}

/** Appends an event to the board's log. For transitions in the domain modules only. */
export function emit(board: Board, at: number, type: BoardEvent["type"], sessionId: string | null, data: Record<string, unknown> = {}): void {
  board.events.push({ at, type, sessionId, label: sessionId === null ? null : (labelOf(board, sessionId) ?? null), data });
}

const LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const MINUTE = 60_000;

// ── Sessions ────────────────────────────────────────────────────────────────

/** Adds a session under the first free letter and returns the letter. Re-registering an id keeps its letter. */
export function registerSession(
  board: Board,
  s: { id: string; pid: number; cwd: string; socket: string; now: number },
): string {
  const existing = board.sessions.find(x => x.id === s.id);
  if (existing) return existing.label;
  const taken = new Set(board.sessions.map(x => x.label));
  const label = [...LABELS].find(l => !taken.has(l));
  if (!label) throw new Error(`${LABELS.length} sessions are already registered`);
  board.sessions.push({ id: s.id, label, pid: s.pid, cwd: s.cwd, socket: s.socket, startedAt: s.now });
  emit(board, s.now, "session_joined", s.id, { pid: s.pid, cwd: s.cwd });
  return label;
}

/** Removes a session that ended or died: its slots free, it leaves the line, messages to it are dropped. */
export function removeSession(board: Board, policy: AgentPolicy, sessionId: string, now: number): void {
  if (board.sessions.some(s => s.id === sessionId)) emit(board, now, "session_left", sessionId);
  board.sessions = board.sessions.filter(s => s.id !== sessionId);
  board.slots = board.slots.filter(s => s.sessionId !== sessionId);
  board.waitlist = board.waitlist.filter(t => t.sessionId !== sessionId);
  board.messages = board.messages.filter(m => m.toId !== sessionId);
  board.sent = board.sent.filter(m => m.sessionId !== sessionId);
  // Its fair-share history goes too; it would only grow, since a session id is never reused.
  board.served = board.served.filter(s => s.owner !== sessionId);
  grantHolds(board, policy, now);
}

export function labelOf(board: Board, sessionId: string): string | undefined {
  return board.sessions.find(s => s.id === sessionId)?.label;
}

// ── Agent slots ─────────────────────────────────────────────────────────────

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

function capOf(policy: AgentPolicy, pool: string): number {
  return policy.pools[pool]?.cap ?? 0;
}

export interface SpawnRequest {
  sessionId: string;
  /** The agent asking: `Main` or a subagent id. */
  parentAgentId: string;
  parentIsSubagent: boolean;
  agentType: string;
  /** omp's spawn key: the new agent's id for `task`, eval `agent()` and workpools; only a label for some callers. */
  spawnKey?: string;
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
      s => s.sessionId === req.sessionId && s.parentId === req.parentAgentId && policy.nested.allow.includes(s.agentType),
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
  if (mine?.holdUntil !== undefined) {
    board.waitlist = board.waitlist.filter(t => t !== mine);
    emit(board, req.now, "hold_used", req.sessionId, { pool, waitedMs: req.now - mine.since });
    addStartingSlot(board, req, pool);
    return { allowed: true, pool };
  }

  const cap = capOf(policy, pool);
  if (used(board, pool) + activeHolds(board, pool) < cap && !mine) {
    addStartingSlot(board, req, pool);
    return { allowed: true, pool };
  }

  const ticket = mine ?? { sessionId: req.sessionId, pool, since: req.now, holdUntil: undefined, notified: false };
  if (!mine) board.waitlist.push(ticket);
  const line = board.waitlist.filter(t => t.pool === pool).sort((a, b) => a.since - b.since);
  const position = line.indexOf(ticket) + 1;
  emit(board, req.now, "spawn_refused", req.sessionId, { agentType: req.agentType, pool, position, used: used(board, pool), cap });
  return {
    allowed: false,
    pool,
    position,
    reason:
      `FULL: ${used(board, pool)}/${cap} ${pool} slots are in use across all sessions` +
      (activeHolds(board, pool) ? ` and ${activeHolds(board, pool)} more held for sessions ahead in line` : "") +
      `. This session is #${position} in line for a ${pool} slot. Start nothing else now; ` +
      `you will get a message when a slot is held for you.`,
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
  });
  emit(board, req.now, "spawn_approved", req.sessionId, { agentType: req.agentType, pool, nested: req.parentIsSubagent });
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
  a: { sessionId: string; agentId: string; parentId: string; parentIsSubagent: boolean; agentType: string; now: number },
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
    };
    board.slots.push(slot);
  }
  const count = slot.pool === null ? null : { pool: slot.pool, used: used(board, slot.pool), cap: capOf(policy, slot.pool) };
  emit(board, a.now, "run_started", a.sessionId, { agentId: a.agentId, agentType: a.agentType, ...(count ?? { pool: null }), revived });
  return count;
}

/** An agent's run ended (finished, failed, or killed): its slot frees until it runs again. */
export function agentEnded(board: Board, policy: AgentPolicy, a: { sessionId: string; agentId: string; now: number }): void {
  const slot = board.slots.find(s => s.sessionId === a.sessionId && s.agentId === a.agentId);
  if (slot) {
    board.slots = board.slots.filter(s => s !== slot);
    emit(board, a.now, "run_ended", a.sessionId, { agentId: a.agentId, pool: slot.pool, ranMs: a.now - slot.since });
  }
  expire(board, policy, a.now);
}

/** Drops spawns that never started and holds nobody used, then hands freed slots to the sessions in line. */
export function expire(board: Board, policy: AgentPolicy, now: number): void {
  for (const s of board.slots.filter(s => s.state === "starting" && now - s.since > policy.startTimeoutMs)) {
    emit(board, now, "start_expired", s.sessionId, { agentType: s.agentType, pool: s.pool });
  }
  board.slots = board.slots.filter(s => s.state !== "starting" || now - s.since <= policy.startTimeoutMs);
  for (const t of board.waitlist.filter(t => t.holdUntil !== undefined && now > t.holdUntil)) {
    emit(board, now, "hold_expired", t.sessionId, { pool: t.pool, waitedMs: now - t.since });
  }
  board.waitlist = board.waitlist.filter(t => t.holdUntil === undefined || now <= t.holdUntil);
  grantHolds(board, policy, now);
}

function grantHolds(board: Board, policy: AgentPolicy, now: number): void {
  for (const pool of Object.keys(policy.pools)) {
    let free = capOf(policy, pool) - used(board, pool) - activeHolds(board, pool);
    const waiting = board.waitlist
      .filter(t => t.pool === pool && t.holdUntil === undefined)
      .sort((a, b) => a.since - b.since);
    for (const ticket of waiting) {
      if (free <= 0) break;
      ticket.holdUntil = now + policy.holdMs;
      ticket.notified = false;
      emit(board, now, "hold_granted", ticket.sessionId, { pool, until: ticket.holdUntil, waitedMs: now - ticket.since });
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

// ── Messages ────────────────────────────────────────────────────────────────

export type SendResult = { ok: true; delivered: string[] } | { ok: false; reason: string };

/** Queues a message for one session (by letter) or every other session (`all`). */
export function sendMessage(
  board: Board,
  policy: AgentPolicy,
  m: { from: string; to: string; text: string; now: number },
): SendResult {
  const sender = board.sessions.find(s => s.id === m.from);
  if (!sender) return { ok: false, reason: "this session is not registered" };
  const text = m.text.trim();
  if (!text) return { ok: false, reason: "the message is empty" };

  const to = m.to.trim();
  const targets =
    to.toLowerCase() === "all"
      ? board.sessions.filter(s => s.id !== m.from)
      : board.sessions.filter(s => s.label === to.toUpperCase());
  if (to.toUpperCase() === sender.label) return { ok: false, reason: "a session cannot message itself" };
  if (targets.length === 0) {
    const others = board.sessions.filter(s => s.id !== m.from).map(s => s.label);
    return { ok: false, reason: `no session ${to}; active: ${others.length ? others.join(", ") : "none besides this one"}` };
  }

  board.sent = board.sent.filter(x => m.now - x.at < MINUTE);
  const recent = board.sent.filter(x => x.sessionId === m.from).length;
  if (recent >= policy.messagesPerMinute) {
    return { ok: false, reason: `rate limit: at most ${policy.messagesPerMinute} messages a minute; send one summary later` };
  }
  board.sent.push({ sessionId: m.from, at: m.now });
  for (const t of targets) board.messages.push({ fromId: m.from, toId: t.id, text, sentAt: m.now });
  emit(board, m.now, "message_sent", m.from, { to: targets.map(t => t.label), chars: text.length });
  return { ok: true, delivered: targets.map(t => t.label) };
}

/** Removes and returns the messages waiting for a session, oldest first. */
export function takeInbox(board: Board, sessionId: string): { from: string; text: string; sentAt: number }[] {
  const mine = board.messages.filter(m => m.toId === sessionId);
  board.messages = board.messages.filter(m => m.toId !== sessionId);
  return mine
    .sort((a, b) => a.sentAt - b.sentAt)
    .map(m => ({ from: labelOf(board, m.fromId) ?? "?", text: m.text, sentAt: m.sentAt }));
}

function listOr(items: string[]): string {
  if (items.length === 0) return "nothing";
  if (items.length === 1) return items[0] as string;
  return `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`;
}
