/**
 * Use cases of an omp session on the shared board: joining and leaving, the periodic tick (messages and slot holds
 * for this session), deciding agent spawns, following agent runs, messaging, and dropping sessions and jobs whose
 * process is gone. Each use case is one repository transaction around pure domain transitions.
 */
import type { Config } from "../config.ts";
import {
  type SpawnDecision,
  type SpawnRequest,
  agentEnded,
  agentStarted,
  expire,
  requestSpawn,
  takeNewHolds,
} from "../domain/agents.ts";
import { type SendResult, sendMessage, takeInbox } from "../domain/messages.ts";
import type { Board } from "../domain/model.ts";
import { type EnqueueResult, dropJobs, setJobPriority } from "../domain/queues.ts";
import { registerSession, removeSession } from "../domain/sessions.ts";
import type { BoardRepository, Clock, Liveness } from "./ports.ts";

export interface SessionIdentity {
  id: string;
  pid: number;
  cwd: string;
  /** Liveness address this session answers on. */
  address: string;
}

export interface TickResult {
  label: string;
  inbox: { from: string; text: string; sentAt: number }[];
  holds: { pool: string; until: number }[];
  board: Board;
}

export class Coordinator {
  constructor(
    private readonly config: Config,
    private readonly repo: BoardRepository,
    private readonly liveness: Liveness,
    private readonly clock: Clock,
  ) {}

  join(me: SessionIdentity): string {
    return this.repo.transact(b => registerSession(b, { id: me.id, pid: me.pid, cwd: me.cwd, socket: me.address, now: this.clock.now() }));
  }

  leave(sessionId: string): void {
    this.repo.transact(b => removeSession(b, this.config.agents, sessionId, this.clock.now()));
  }

  /**
   * Periodic work for one session: re-registers it if another session dropped it, expires stale approvals and holds,
   * and takes the messages and new slot holds waiting for it.
   */
  tick(me: SessionIdentity): TickResult {
    return this.repo.transact(b => {
      const now = this.clock.now();
      const label = registerSession(b, { id: me.id, pid: me.pid, cwd: me.cwd, socket: me.address, now });
      expire(b, this.config.agents, now);
      return { label, inbox: takeInbox(b, me.id), holds: takeNewHolds(b, me.id), board: structuredClone(b) };
    });
  }

  requestSpawn(req: Omit<SpawnRequest, "now">): SpawnDecision {
    return this.repo.transact(b => requestSpawn(b, this.config.agents, { ...req, now: this.clock.now() }));
  }

  agentStarted(a: { sessionId: string; agentId: string; parentId: string; parentIsSubagent: boolean; agentType: string }) {
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
        if (deadJobs.length) dropJobs(b, this.config.queues, deadJobs.map(j => j.id), now);
      });
      for (const x of [...deadSessions, ...deadJobs]) this.liveness.forget(x.socket);
    }
    return { sessions: deadSessions.length, jobs: deadJobs.length };
  }
}
