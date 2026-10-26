/**
 * Port ranges: each session gets its own block of a configured range, and its agents take smaller blocks from it, so
 * two agents never start servers on the same port. Blocks are kept until their session leaves.
 */
import type { Board, PortRange } from "./model.ts";

export interface PortPolicy {
  from: number;
  /** Inclusive. */
  to: number;
  perSession: number;
  perAgent: number;
}

/** The first block of `size` ports in `from..to` that no range in `taken` overlaps. */
export function freeBlock(from: number, to: number, size: number, taken: PortRange[]): PortRange | undefined {
  for (let start = from; start + size - 1 <= to; start += size) {
    const block = { from: start, to: start + size - 1 };
    if (!taken.some(t => t.from <= block.to && block.from <= t.to)) return block;
  }
  return undefined;
}

export type AgentPortsResult = { ok: true; ports: PortRange } | { ok: false; reason: string };

/** The agent's block in its session's range, taking a free one the first time. Only for scopes that hand out ports. */
export function agentPorts(
  board: Board,
  a: { sessionId: string; agentId: string; perAgent: number },
): AgentPortsResult {
  const session = board.sessions.find(s => s.id === a.sessionId);
  if (!session?.ports) {
    return {
      ok: false,
      reason: "this session got no ports when it started: other sessions held every block of resources.ports",
    };
  }
  const own = board.agentPorts.find(p => p.sessionId === a.sessionId && p.agentId === a.agentId);
  if (own) return { ok: true, ports: { from: own.from, to: own.to } };
  const block = freeBlock(
    session.ports.from,
    session.ports.to,
    a.perAgent,
    board.agentPorts.filter(p => p.sessionId === a.sessionId),
  );
  if (!block) {
    return {
      ok: false,
      reason: `this session's ports ${session.ports.from}–${session.ports.to} are all given to its agents`,
    };
  }
  board.agentPorts.push({ sessionId: a.sessionId, agentId: a.agentId, ...block });
  return { ok: true, ports: block };
}
