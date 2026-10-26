/**
 * Claims: a session marks a branch, a worktree or a PR as its own, and other sessions' agents are refused git and gh
 * commands that would change it. Commands are matched by their text, so this is a guard against mistakes, not a lock:
 * a command written to dodge it gets through.
 */
import { isAbsolute, normalize, resolve, sep } from "node:path";
import { type Board, type Claim, emit, labelOf } from "./model.ts";

export type ClaimResult = { ok: true } | { ok: false; reason: string };

const KINDS: Claim["kind"][] = ["branch", "worktree", "pr"];

/** git subcommands that change a worktree, a branch or a remote. */
const GIT_CHANGES = /\bgit\b(?:\s+-C\s+\S+)?(?:\s+-[^\s]+)*\s+(commit|push|pull|rebase|reset|checkout|switch|merge|cherry-pick|revert|am|apply|stash|restore|clean|rm|mv|tag|branch\s+-[dDmMf])\b/;
/** gh pr subcommands that change a PR. */
const GH_PR_CHANGES = /\bgh\s+pr\s+(edit|comment|merge|close|reopen|ready|review|lock|unlock)\s+#?(\d+)\b/g;

export function normalizeTarget(kind: Claim["kind"], target: string, cwd: string): string {
  const t = target.trim();
  if (kind === "worktree") return resolve(cwd, t);
  if (kind === "pr") return t.replace(/^#/, "");
  return t;
}

export function claim(
  board: Board,
  c: { sessionId: string; agentId: string; kind: Claim["kind"]; target: string; note: string; now: number },
): ClaimResult {
  if (!KINDS.includes(c.kind)) return { ok: false, reason: `a claim is on a ${KINDS.join(", a ")}` };
  if (!c.target.trim()) return { ok: false, reason: "name what to claim" };
  const held = board.claims.find(x => x.kind === c.kind && x.target === c.target);
  if (held && held.sessionId !== c.sessionId) {
    return { ok: false, reason: `${c.kind} ${c.target} is claimed by session ${labelOf(board, held.sessionId) ?? "?"} (${held.agentId}) since ${new Date(held.since).toISOString()}: ${held.note || "no note"}` };
  }
  board.claims = board.claims.filter(x => x !== held);
  board.claims.push({ kind: c.kind, target: c.target, sessionId: c.sessionId, agentId: c.agentId, note: c.note.trim(), since: c.now });
  emit(board, c.now, "claimed", c.sessionId, { kind: c.kind, target: c.target, agentId: c.agentId });
  return { ok: true };
}

export function release(board: Board, r: { sessionId: string; kind: Claim["kind"]; target: string; now: number }): ClaimResult {
  const held = board.claims.find(x => x.kind === r.kind && x.target === r.target);
  if (!held) return { ok: false, reason: `${r.kind} ${r.target} is not claimed` };
  if (held.sessionId !== r.sessionId) return { ok: false, reason: `${r.kind} ${r.target} is claimed by session ${labelOf(board, held.sessionId) ?? "?"}` };
  board.claims = board.claims.filter(x => x !== held);
  emit(board, r.now, "released", r.sessionId, { kind: r.kind, target: r.target });
  return { ok: true };
}

/**
 * The claim of another session that `command`, run in `cwd`, would change, if any: a git command that changes a
 * claimed worktree (run in it, `cd`-ing into it, or with `git -C` on it), a git command that changes a claimed branch
 * named in it, or a gh command that changes a claimed PR.
 */
export function claimConflict(board: Board, q: { sessionId: string; command: string; cwd: string }): Claim | undefined {
  const others = board.claims.filter(c => c.sessionId !== q.sessionId);
  if (others.length === 0) return undefined;

  const prs = [...q.command.matchAll(GH_PR_CHANGES)].map(m => m[2]);
  const pr = others.find(c => c.kind === "pr" && prs.includes(c.target));
  if (pr) return pr;

  if (!GIT_CHANGES.test(q.command)) return undefined;
  const dirs = commandDirs(q.command, q.cwd);
  const worktree = others.find(c => c.kind === "worktree" && dirs.some(d => inside(d, c.target)));
  if (worktree) return worktree;
  const words = new Set(q.command.split(/[\s:'"=]+/).flatMap(w => [w, w.replace(/^refs\/heads\//, "")]));
  return others.find(c => c.kind === "branch" && words.has(c.target));
}

/** Records a refusal for the event log. */
export function claimRefused(board: Board, sessionId: string, c: Claim, now: number): void {
  emit(board, now, "claim_refused", sessionId, { kind: c.kind, target: c.target, holder: labelOf(board, c.sessionId) ?? null });
}

/** Folders a command acts in: its working folder, every `cd <dir>` and every `git -C <dir>`, resolved in order. */
function commandDirs(command: string, cwd: string): string[] {
  const dirs = [cwd];
  let here = cwd;
  for (const m of command.matchAll(/(?:^|[;&|(]\s*|\s)(?:cd\s+(\S+)|git\s+-C\s+(\S+))/g)) {
    const raw = (m[1] ?? m[2] ?? "").replace(/^['"]|['"]$/g, "");
    const dir = isAbsolute(raw) ? normalize(raw) : resolve(here, raw);
    if (m[1] !== undefined) here = dir;
    dirs.push(dir);
  }
  return dirs;
}

function inside(dir: string, root: string): boolean {
  return dir === root || dir.startsWith(root.endsWith(sep) ? root : root + sep);
}
