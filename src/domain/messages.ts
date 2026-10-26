/** Messages between sessions: addressed by letter or `all`, rate limited per sender, taken once by the recipient. */
import { type AgentPolicy, type Board, emit, labelOf } from "./model.ts";

const MINUTE = 60_000;

export type SendResult = { ok: true; delivered: string[] } | { ok: false; reason: string };

/**
 * Queues a message for one session (by letter), one subagent of another session (`B/<agent id>`), or every other
 * session (`all`).
 */
export function sendMessage(
  board: Board,
  policy: AgentPolicy,
  m: { from: string; to: string; text: string; now: number },
): SendResult {
  const sender = board.sessions.find(s => s.id === m.from);
  if (!sender) return { ok: false, reason: "this session is not registered" };
  const text = m.text.trim();
  if (!text) return { ok: false, reason: "the message is empty" };

  const [session = "", ...rest] = m.to.trim().split("/");
  const toAgent = rest.length ? rest.join("/").trim() : undefined;
  if (toAgent === "") return { ok: false, reason: "name the agent after the slash, e.g. B/RebaseWave1" };
  const all = session.toLowerCase() === "all";
  if (all && toAgent) return { ok: false, reason: "a message to a subagent goes to one session, not all" };
  const targets = all ? board.sessions.filter(s => s.id !== m.from) : board.sessions.filter(s => s.label === session.toUpperCase());
  if (session.toUpperCase() === sender.label) return { ok: false, reason: "a session cannot message itself" };
  if (targets.length === 0) {
    const others = board.sessions.filter(s => s.id !== m.from).map(s => s.label);
    return { ok: false, reason: `no session ${session}; active: ${others.length ? others.join(", ") : "none besides this one"}` };
  }

  board.sent = board.sent.filter(x => m.now - x.at < MINUTE);
  const recent = board.sent.filter(x => x.sessionId === m.from).length;
  if (recent >= policy.messagesPerMinute) {
    return { ok: false, reason: `rate limit: at most ${policy.messagesPerMinute} messages a minute; send one summary later` };
  }
  board.sent.push({ sessionId: m.from, at: m.now });
  for (const t of targets) board.messages.push({ fromId: m.from, toId: t.id, toAgent, text, sentAt: m.now });
  const delivered = targets.map(t => (toAgent ? `${t.label}/${toAgent}` : t.label));
  emit(board, m.now, "message_sent", m.from, { to: delivered, chars: text.length });
  return { ok: true, delivered };
}

/** Removes and returns the messages waiting for a session or its subagents, oldest first. */
export function takeInbox(board: Board, sessionId: string): { from: string; toAgent: string | undefined; text: string; sentAt: number }[] {
  const mine = board.messages.filter(m => m.toId === sessionId);
  board.messages = board.messages.filter(m => m.toId !== sessionId);
  return mine
    .sort((a, b) => a.sentAt - b.sentAt)
    .map(m => ({ from: labelOf(board, m.fromId) ?? "?", toAgent: m.toAgent, text: m.text, sentAt: m.sentAt }));
}
