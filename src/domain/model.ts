/**
 * The coordination board's model: every omp session on this machine that shares one scope (e.g. one project), the
 * agent slots they hold, the line for slots, messages, and build/test jobs, plus the event log entries transitions
 * emit. The transitions live in `sessions.ts`, `agents.ts`, `messages.ts` and `queues.ts`.
 *
 * Pure state over a plain, JSON-serializable `Board`. Persistence and clocks live outside: callers pass `now`
 * (ms since epoch) and run each transition inside one store transaction.
 */
import type { LoadLimit } from "./limits.ts";

/** How many agents may run at once, and which agent types fall where. */
export interface AgentPolicy {
  /** Pools of slots: each has a cap shared by every session, the agent types it covers, and lower caps under load. */
  pools: Record<string, { cap: number; agentTypes: string[]; loadCaps: LoadLimit[] }>;
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
  /** Keep omp's per-session spawn queue (`task.maxConcurrency`) at what the caps allow, so spawns wait instead of being refused. */
  queueSpawns: boolean;
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
  /** Hash of the config file the session read, so sessions of one scope can tell when they disagree. */
  configHash: string;
  /** Port range handed to this session, when the scope hands out ports. */
  ports: PortRange | undefined;
}

export interface PortRange {
  from: number;
  /** Inclusive. */
  to: number;
}

/** Ports one agent took from its session's range. */
export interface AgentPorts extends PortRange {
  sessionId: string;
  agentId: string;
}

/** While set, no new agent spawn (except outside the caps) and no queued job starts, in any session. */
export interface Pause {
  /** The session that paused, or null (`omp-coord pause` from a terminal). */
  by: string | null;
  reason: string;
  since: number;
}

/** A session's claim on something other sessions must leave alone. */
export interface Claim {
  kind: "branch" | "worktree" | "pr";
  /** Branch name, absolute worktree path, or PR number. */
  target: string;
  sessionId: string;
  /** The agent that claimed it, or `Main`. */
  agentId: string;
  note: string;
  since: number;
}

/** An entry in the shared decision log. */
export interface Note {
  id: number;
  at: number;
  /** Session letter when written, or null from outside omp. */
  label: string | null;
  author: string;
  text: string;
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
  /**
   * Holds no place in omp's spawn queue, so `spawnAllowance` doesn't count it: started without a spawn this extension
   * approved (revived with `write agent://…`, or running when this session joined), or a workpool worker (omp starts
   * those outside the queue, as spawns of `invocationKind` "eval").
   */
  unqueued?: "revived" | "eval";
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
  /** For a subagent of the recipient session (by agent id); its main session otherwise. */
  toAgent: string | undefined;
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
    | "job_reprioritized"
    | "paused"
    | "resumed"
    | "claimed"
    | "released"
    | "claim_refused"
    | "note_added";
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
  /** omp's id of the agent whose command queued it ("Main" for the main agent), or undefined (outside omp, or an
   * older omp-coord that did not record it). For display only. */
  agent: string | undefined;
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
  pause: Pause | undefined;
  claims: Claim[];
  notes: Note[];
  agentPorts: AgentPorts[];
  /** The latest load average any process on this machine measured (see `limits.ts`). */
  load: { value: number; at: number } | undefined;
  /** Events since the board was loaded, oldest first. Not board state: the store moves them to the log. */
  events: BoardEvent[];
}

export function emptyBoard(): Board {
  return {
    sessions: [],
    slots: [],
    waitlist: [],
    messages: [],
    sent: [],
    jobs: [],
    served: [],
    pause: undefined,
    claims: [],
    notes: [],
    agentPorts: [],
    load: undefined,
    events: [],
  };
}

/** Appends an event to the board's log. For transitions in the domain modules only. */
export function emit(
  board: Board,
  at: number,
  type: BoardEvent["type"],
  sessionId: string | null,
  data: Record<string, unknown> = {},
): void {
  board.events.push({
    at,
    type,
    sessionId,
    label: sessionId === null ? null : (labelOf(board, sessionId) ?? null),
    data,
  });
}

export function labelOf(board: Board, sessionId: string): string | undefined {
  return board.sessions.find(s => s.id === sessionId)?.label;
}
