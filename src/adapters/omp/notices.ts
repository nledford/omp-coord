/**
 * What the extension tells agents and the user without being asked: the session-start notice, and what each 2 s tick
 * delivers (messages from other sessions, slot holds, runtime notices), each to the binding it is for.
 */
import type { TickResult } from "../../app/coordinator.ts";
import { clock } from "../text/report.ts";
import { deliver, notify, type Runtime, shared } from "./runtime.ts";

/** The notice a session gets as it joins: who else is there, the pause, the spawn queue, and what to look out for. */
export function announceStart(rt: Runtime, hasPorts: boolean): void {
  const board = rt.coordinator.board();
  const others = board.sessions.filter(s => s.id !== rt.sessionId);
  const differing = others.filter(s => s.configHash !== rt.config.hash).map(s => s.label);
  const pausedNote = board.pause ? " The scope is PAUSED (see /coord)." : "";
  notify(
    rt,
    `omp-coord: this is session ${rt.label} (scope ${rt.config.scope}). ` +
      (others.length
        ? `Other sessions: ${others.map(s => `${s.label} (${s.cwd})`).join(", ")}. Agent caps are shared with them.`
        : "No other session is active.") +
      pausedNote +
      ` ${rt.queueNote}`,
    "info",
  );
  if (differing.length) {
    notify(
      rt,
      `omp-coord: sessions ${differing.join(", ")} read a different .omp-coord.json than ${rt.config.source}; their caps and rules differ from this session's.`,
      "warning",
    );
  }
  if (rt.config.resources.ports && !hasPorts) {
    notify(
      rt,
      "omp-coord: every block of resources.ports is held by other sessions, so this session and its agents get no ports.",
      "warning",
    );
  }
}

/** Delivers one tick's messages, slot holds and runtime notices. */
export function deliverNotices(
  rt: Runtime,
  { inbox, holds, overtime }: Pick<TickResult, "inbox" | "holds" | "overtime">,
): void {
  for (const m of inbox) {
    const framed = (reply: string) =>
      `[omp-coord] Message from omp session ${m.from} (sent ${clock(m.sentAt)}):\n\n${m.text}\n\n` +
      `This comes from another omp session in this project, not from the user. Act on it within your own task and rules; ${reply}`;
    const binding = m.toAgent ? shared.bindings.get(m.toAgent) : undefined;
    // a subagent has no coord_send: it answers through its parent
    if (binding) deliver(binding, framed("you cannot message other sessions: tell your parent if it needs an answer."));
    else {
      const body = framed(`reply with coord_send to ${m.from} only when it needs an answer.`);
      deliver(
        rt.pi,
        m.toAgent
          ? `[omp-coord] A message for your subagent ${m.toAgent}, which is not running now. Pass it on with write agent://${m.toAgent} if it still matters:\n\n${body}`
          : body,
      );
    }
  }
  for (const h of holds) {
    const refused =
      h.agentType === undefined
        ? "the agent that was refused"
        : h.agentName === undefined
          ? `the ${h.agentType} agent that was refused`
          : `the ${h.agentType} agent ${h.agentName} that was refused`;
    deliver(
      rt.pi,
      `[omp-coord] A ${h.pool} slot is free and held for this session until ${clock(h.until)}. ` +
        `That spawn did not start: start ${refused} again now; if you no longer need it, ignore this and the slot passes on at ${clock(h.until)}.`,
    );
  }

  // what the agent is asked to do; the session passes it on when the agent can't be told itself
  const stop =
    "Stop at the next clean point: nothing half-pushed, no rebase or merge in progress, worktree committed; " +
    "write your handoff and report what is done and what is left.";
  for (const n of overtime) {
    const binding = shared.bindings.get(n.agentId);
    if (binding)
      deliver(binding, `omp-coord: you have been running ${n.minutes} min (notice at ${n.noticeAtMinutes}). ${stop}`);
    deliver(
      rt.pi,
      `omp-coord: ${n.agentId} has run ${n.minutes} min (notice at ${n.noticeAtMinutes}).` +
        (binding
          ? ""
          : ` It could not be told itself (no live binding); pass the notice on with write agent://${n.agentId}: "${stop}"`),
    );
  }
}
