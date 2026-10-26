/** Messages between sessions: addressed by letter or `all`, rate limited per sender, taken once by the recipient. */
import { type AgentPolicy, type Board, emit, labelOf } from "./model.ts";

const MINUTE = 60_000;

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
