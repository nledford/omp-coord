/**
 * Use cases of an omp session on the shared board: joining and leaving, the periodic tick (messages, slot holds and
 * the machine's load), deciding agent spawns, following agent runs, messaging, pausing, claims, the decision log,
 * port ranges, reports from the event log, and dropping sessions and jobs whose process is gone. Each use case is one
 * repository transaction around pure domain transitions.
 */
import type { Config } from "../config.ts";
import {
  agentEnded,
  agentStarted,
  expire,
  requestSpawn,
  type SpawnDecision,
  type SpawnRequest,
  takeNewHolds,
} from "../domain/agents.ts";
import {
  type ClaimResult,
  type CommandQuery,
  claim,
  claimConflict,
  claimRefused,
  normalizeTarget,
  release,
} from "../domain/claims.ts";
import { pause, resume } from "../domain/control.ts";
import { type DayStats, type InterruptedSession, interrupted, stats } from "../domain/history.ts";
import { observeLoad } from "../domain/limits.ts";
import { type SendResult, sendMessage, takeInbox } from "../domain/messages.ts";
import type { Board, Claim, Note } from "../domain/model.ts";
import { addNote, type NoteResult } from "../domain/notes.ts";
import { type AgentPortsResult, agentPorts } from "../domain/ports.ts";
import { dropJobs, type EnqueueResult, schedule, setJobPriority } from "../domain/queues.ts";
import { registerSession, removeSession } from "../domain/sessions.ts";
import type { BoardRepository, Clock, Liveness, LoadProbe } from "./ports.ts";

export interface SessionIdentity {
  id: string;
  pid: number;
  cwd: string;
  /** Liveness address this session answers on. */
  address: string;
}

export interface TickResult {
  label: string;
  inbox: { from: string; toAgent: string | undefined; text: string; sentAt: number }[];
  holds: { pool: string; until: number }[];
  board: Board;
}

export class Coordinator {
  constructor(
    private readonly config: Config,
    private readonly repo: BoardRepository,
    private readonly liveness: Liveness,
    private readonly clock: Clock,
    private readonly loadProbe: LoadProbe = { load: () => undefined },
  ) {}

  join(me: SessionIdentity): string {
    return this.repo.transact(b => this.#register(b, me, this.clock.now()));
  }

  leave(sessionId: string): void {
    this.repo.transact(b => removeSession(b, this.config.agents, sessionId, this.clock.now()));
  }

  /**
   * Periodic work for one session: re-registers it if another session dropped it, records the machine's load,
   * expires stale approvals and holds, starts queued jobs a lower load now allows, and takes the messages and new
   * slot holds waiting for it.
   */
  tick(me: SessionIdentity): TickResult {
    const load = this.loadProbe.load();
    return this.repo.transact(b => {
      const now = this.clock.now();
      const label = this.#register(b, me, now);
      if (load !== undefined) observeLoad(b, load, now);
      expire(b, this.config.agents, now);
      schedule(b, this.config.queues, now);
      return { label, inbox: takeInbox(b, me.id), holds: takeNewHolds(b, me.id), board: structuredClone(b) };
    });
  }

  #register(b: Board, me: SessionIdentity, now: number): string {
    return registerSession(
      b,
      { id: me.id, pid: me.pid, cwd: me.cwd, socket: me.address, configHash: this.config.hash, now },
      this.config.resources.ports,
    );
  }

  pause(by: string | null, reason: string): void {
    this.repo.transact(b => pause(b, { by, reason, now: this.clock.now() }));
  }

  resume(by: string | null): boolean {
    return this.repo.transact(b => {
      const was = b.pause !== undefined;
      resume(b, this.config.agents, this.config.queues, { by, now: this.clock.now() });
      return was;
    });
  }

  claim(c: {
    sessionId: string;
    agentId: string;
    kind: Claim["kind"];
    target: string;
    note: string;
    cwd: string;
  }): ClaimResult {
    const target = normalizeTarget(c.kind, c.target, c.cwd);
    return this.repo.transact(b => claim(b, { ...c, target, now: this.clock.now() }));
  }

  release(r: { sessionId: string; kind: Claim["kind"]; target: string; cwd: string }): ClaimResult {
    const target = normalizeTarget(r.kind, r.target, r.cwd);
    return this.repo.transact(b => release(b, { ...r, target, now: this.clock.now() }));
  }

  /** Another session's claim the command would change, recorded as a refusal; undefined when it may run. */
  checkCommand(q: CommandQuery): Claim | undefined {
    const conflict = claimConflict(this.repo.read(), q);
    if (conflict) this.repo.transact(b => claimRefused(b, q.sessionId, conflict, this.clock.now()));
    return conflict;
  }

  note(sessionId: string | null, author: string, text: string): NoteResult {
    return this.repo.transact(b => addNote(b, { sessionId, author, text, now: this.clock.now() }));
  }

  notes(limit: number): Note[] {
    return this.repo.notes(limit);
  }

  agentPorts(sessionId: string, agentId: string): AgentPortsResult {
    const perAgent = this.config.resources.ports?.perAgent ?? 0;
    return this.repo.transact(b => agentPorts(b, { sessionId, agentId, perAgent }));
  }

  interrupted(sinceMs: number): InterruptedSession[] {
    return interrupted(this.repo.events(0), this.clock.now() - sinceMs);
  }

  stats(sinceMs: number): DayStats[] {
    return stats(this.repo.events(this.clock.now() - sinceMs), 0).days;
  }

  requestSpawn(req: Omit<SpawnRequest, "now">): SpawnDecision {
    return this.repo.transact(b => requestSpawn(b, this.config.agents, { ...req, now: this.clock.now() }));
  }

  agentStarted(a: {
    sessionId: string;
    agentId: string;
    parentId: string;
    parentIsSubagent: boolean;
    agentType: string;
    evalWorker?: boolean;
  }) {
    return this.repo.transact(b => agentStarted(b, this.config.agents, { ...a, now: this.clock.now() }));
  }

  agentEnded(a: { sessionId: string; agentId: string }): void {
    this.repo.transact(b => agentEnded(b, this.config.agents, { ...a, now: this.clock.now() }));
  }

  send(from: string, to: string, text: string): SendResult {
    return this.repo.transact(b => sendMessage(b, this.config.agents, { from, to, text, now: this.clock.now() }));
  }

  setJobPriority(sessionId: string, job: string, priority: number): EnqueueResult {
    return this.repo.transact(b => setJobPriority(b, { id: job, sessionId, priority, now: this.clock.now() }));
  }

  board(): Board {
    return this.repo.read();
  }

  /**
   * Drops other sessions and queued jobs whose process is gone, freeing their slots and places in line, and clears
   * what they left behind. `stillActive` is asked after the liveness checks: a session that stopped meanwhile must not
   * write. Returns how many of each were dropped.
   */
  async prune(selfId: string, stillActive: () => boolean = () => true): Promise<{ sessions: number; jobs: number }> {
    const board = this.repo.read();
    const others = board.sessions.filter(s => s.id !== selfId);
    const [sessionsAlive, jobsAlive] = await Promise.all([
      Promise.all(others.map(s => this.liveness.isAlive(s.socket))),
      Promise.all(board.jobs.map(j => this.liveness.isAlive(j.socket))),
    ]);
    const deadSessions = others.filter((_, i) => !sessionsAlive[i]);
    const deadJobs = board.jobs.filter((_, i) => !jobsAlive[i]);
    if ((deadSessions.length || deadJobs.length) && stillActive()) {
      this.repo.transact(b => {
        const now = this.clock.now();
        for (const s of deadSessions) removeSession(b, this.config.agents, s.id, now);
        if (deadJobs.length)
          dropJobs(
            b,
            this.config.queues,
            deadJobs.map(j => j.id),
            now,
          );
      });
      for (const x of [...deadSessions, ...deadJobs]) this.liveness.forget(x.socket);
    }
    return { sessions: deadSessions.length, jobs: deadJobs.length };
  }
}
