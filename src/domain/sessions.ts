/** Sessions on the board: each registers under a letter (A, B, …) and leaves with everything it held. */
import { grantHolds } from "./agents.ts";
import { type AgentPolicy, type Board, emit } from "./model.ts";
import { freeBlock, type PortPolicy } from "./ports.ts";

const LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * Adds a session under the first free letter and returns the letter. Re-registering an id keeps its letter.
 * With a port policy, the session gets the first free block of ports.
 */
export function registerSession(
  board: Board,
  s: {
    id: string;
    pid: number;
    cwd: string;
    socket: string;
    configHash: string;
    ompSessionId?: string;
    now: number;
  },
  ports?: Pick<PortPolicy, "from" | "to" | "perSession">,
): string {
  const existing = board.sessions.find(x => x.id === s.id);
  if (existing) {
    // an older omp-coord's save writes every session without it
    if (s.ompSessionId !== undefined) existing.ompSessionId = s.ompSessionId;
    return existing.label;
  }
  const taken = new Set(board.sessions.map(x => x.label));
  const label = [...LABELS].find(l => !taken.has(l));
  if (!label) throw new Error(`${LABELS.length} sessions are already registered`);
  const block =
    ports &&
    freeBlock(
      ports.from,
      ports.to,
      ports.perSession,
      board.sessions.flatMap(x => (x.ports ? [x.ports] : [])),
    );
  board.sessions.push({
    id: s.id,
    label,
    pid: s.pid,
    cwd: s.cwd,
    socket: s.socket,
    startedAt: s.now,
    configHash: s.configHash,
    ports: block,
    ...(s.ompSessionId === undefined ? {} : { ompSessionId: s.ompSessionId }),
  });
  emit(board, s.now, "session_joined", s.id, {
    pid: s.pid,
    cwd: s.cwd,
    ...(block ? { ports: `${block.from}-${block.to}` } : {}),
  });
  return label;
}

/** Records omp's id for the main session's conversation, replacing the one it had. */
export function bindOmpSession(board: Board, sessionId: string, ompSessionId: string): void {
  const session = board.sessions.find(s => s.id === sessionId);
  if (session) session.ompSessionId = ompSessionId;
}

/**
 * The agent whose bash call carries this omp session id (`PI_SESSION_ID`): `Main` for a session's main conversation,
 * a running subagent's id for its own. Undefined for an id the board doesn't know, such as an agent whose run ended.
 */
export function agentOfOmpSession(board: Board, ompSessionId: string): string | undefined {
  const slot = board.slots.find(s => s.ompSessionId === ompSessionId && s.agentId !== undefined);
  if (slot) return slot.agentId;
  return board.sessions.some(s => s.ompSessionId === ompSessionId) ? "Main" : undefined;
}

/**
 * Removes a session that ended or died: its slots free, it leaves the line, messages to it are dropped, and its
 * claims, ports and fair-share history go.
 */
export function removeSession(board: Board, policy: AgentPolicy, sessionId: string, now: number): void {
  if (board.sessions.some(s => s.id === sessionId)) emit(board, now, "session_left", sessionId);
  board.sessions = board.sessions.filter(s => s.id !== sessionId);
  board.slots = board.slots.filter(s => s.sessionId !== sessionId);
  board.waitlist = board.waitlist.filter(t => t.sessionId !== sessionId);
  board.messages = board.messages.filter(m => m.toId !== sessionId);
  board.sent = board.sent.filter(m => m.sessionId !== sessionId);
  board.claims = board.claims.filter(c => c.sessionId !== sessionId);
  board.agentPorts = board.agentPorts.filter(p => p.sessionId !== sessionId);
  // Its fair-share history goes too; it would only grow, since a session id is never reused.
  board.served = board.served.filter(s => s.owner !== sessionId);
  grantHolds(board, policy, now);
}
