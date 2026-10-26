/**
 * Claims: a session marks a branch, a worktree or a PR as its own, and other sessions' agents are refused git and gh
 * commands that would change it. Commands are matched by their text, so this is a guard against mistakes, not a lock:
 * a command written to dodge it gets through.
 *
 * Uses `node:path`'s POSIX path arithmetic (pure string functions); nothing here reads the file system.
 */
import { isAbsolute, join, normalize, resolve, sep } from "node:path";
import { type Board, type Claim, emit, labelOf } from "./model.ts";

export type ClaimResult = { ok: true } | { ok: false; reason: string };

const KINDS: Claim["kind"][] = ["branch", "worktree", "pr"];

/** git subcommands that change a worktree, a branch or a remote. */
const GIT_CHANGES = /\bgit\b(?:\s+-C\s+\S+)?(?:\s+-[^\s]+)*\s+(commit|push|pull|rebase|reset|checkout|switch|merge|cherry-pick|revert|am|apply|stash|restore|clean|rm|mv|tag|branch\s+-[dDmMf])\b/;
/** A `gh pr` subcommand that changes a PR, with the rest of its shell command. */
const GH_PR_CHANGES = /\bgh\s+pr\s+(?:edit|comment|merge|close|reopen|ready|review|lock|unlock)\b([^;&|]*)/g;
/** A `gh api` call with the rest of its shell command. */
const GH_API = /\bgh\s+api\b([^;&|]*)/g;
/** A quoted or single-word argument. */
const ARG = String.raw`(?:'[^']*'|"(?:[^"\\]|\\.)*"|\S+)`;
/** Text arguments of gh (`--body`, `--title`, …): a PR number in them is a mention, not the PR being changed. */
const GH_TEXT_ARG = new RegExp(String.raw`\s(?:-[bt]|--body|--title|--subject)(?:=|\s+)${ARG}`, "g");
/** git subcommands whose `-m` takes a message (for `branch`, `checkout` and `switch` it does not). */
const GIT_WITH_MESSAGE = /\bgit\b[^;&|]*?\s(?:commit|tag|merge|stash|revert|notes)\b/;
/** A message argument (`-m msg`, `-am msg`, `--message=msg`): text, not a branch name. */
const MESSAGE_ARG = new RegExp(String.raw`\s(?:-[a-zA-Z]*m|--message)(?:=|\s+)${ARG}`, "g");

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

/** What the guard needs besides the board. The two optional fields come from the machine and default to "unknown". */
export interface CommandQuery {
  sessionId: string;
  command: string;
  cwd: string;
  /** For `cd ~/…` and `cd $HOME/…`. */
  home?: string;
  /** Whether a folder is the top of a git worktree; a claim on a checkout does not reach worktrees nested in it. */
  isWorktreeRoot?: (dir: string) => boolean;
}

/**
 * The claim of another session that `command`, run in `cwd`, would change, if any: a git command that changes a
 * claimed worktree (run in it, after `cd`-ing into it, or with `git -C` on it), a git command that changes a claimed
 * branch named in it, or a gh command that changes a claimed PR.
 */
export function claimConflict(board: Board, q: CommandQuery): Claim | undefined {
  const others = board.claims.filter(c => c.sessionId !== q.sessionId);
  if (others.length === 0) return undefined;

  const prs = prsChanged(q.command);
  const pr = others.find(c => c.kind === "pr" && prs.has(c.target));
  if (pr) return pr;

  if (!GIT_CHANGES.test(q.command)) return undefined;
  const dirs = gitDirs(q.command, q.cwd, q.home);
  const isRoot = q.isWorktreeRoot ?? (() => false);
  const worktree = others.find(c => c.kind === "worktree" && dirs.some(d => withinWorktree(d, c.target, isRoot)));
  if (worktree) return worktree;
  const text = GIT_WITH_MESSAGE.test(q.command) ? q.command.replace(MESSAGE_ARG, " ") : q.command;
  const words = new Set(
    text
      .split(/[\s:'"=]+/)
      .map(w => w.replace(/^\+/, ""))
      .flatMap(w => [w, w.replace(/^refs\/heads\//, "")]),
  );
  return others.find(c => c.kind === "branch" && words.has(c.target));
}

/** Records a refusal for the event log. */
export function claimRefused(board: Board, sessionId: string, c: Claim, now: number): void {
  emit(board, now, "claim_refused", sessionId, { kind: c.kind, target: c.target, holder: labelOf(board, c.sessionId) ?? null });
}

/** PR numbers a command changes: in a changing `gh pr` command outside its text arguments, or in a `gh api` write. */
function prsChanged(command: string): Set<string> {
  const prs = new Set<string>();
  for (const [, rest = ""] of command.matchAll(GH_PR_CHANGES)) {
    for (const m of rest.replace(GH_TEXT_ARG, " ").matchAll(/(?:^|\s)#?(\d+)(?=\s|$)|\/pull\/(\d+)\b/g)) prs.add(m[1] ?? m[2] ?? "");
  }
  for (const [, rest = ""] of command.matchAll(GH_API)) {
    // gh api sends a POST when given fields, unless a method is named.
    const method = /(?:-X|--method)[\s=]*['"]?([A-Za-z]+)/.exec(rest)?.[1]?.toUpperCase();
    const writes = method === undefined ? /\s(?:-[fF]|--field|--raw-field|--input)\b/.test(rest) : method !== "GET" && method !== "HEAD";
    if (writes) for (const m of rest.matchAll(/\/(?:pulls|issues)\/(\d+)\b/g)) prs.add(m[1] ?? "");
  }
  return prs;
}

/**
 * Folders the command's git invocations run in: the working folder as changed by each `cd` before them, or the
 * folder named by `git -C`. A `cd` to a folder that cannot be worked out (`cd -`, `cd $DIR`) makes later git
 * invocations' folders unknown, and they are skipped.
 */
function gitDirs(command: string, cwd: string, home: string | undefined): string[] {
  const dirs: string[] = [];
  let here: string | undefined = cwd;
  const steps = /(?:^|[;&|(]\s*|\s)(?:(cd)(?:\s+([^\s;&|)]+))?(?=$|[\s;&|)])|(?:\S*\/)?git\b(?:\s+-C\s+([^\s;&|)]+))?)/g;
  for (const [, cd, cdTo, gitC] of command.matchAll(steps)) {
    if (cd !== undefined) {
      here = cdTo === undefined ? home : resolveDir(cdTo, here, home);
    } else {
      const dir = gitC === undefined ? here : resolveDir(gitC, here, home);
      if (dir !== undefined) dirs.push(dir);
    }
  }
  return dirs;
}

function resolveDir(raw: string, here: string | undefined, home: string | undefined): string | undefined {
  let p = raw.replace(/^['"]|['"]$/g, "");
  if (home !== undefined) p = p.replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/, home);
  if (p === "-" || p.includes("$") || p.startsWith("~")) return undefined;
  if (isAbsolute(p)) return normalize(p);
  return here === undefined ? undefined : resolve(here, p);
}

/** `dir` is in the worktree at `root`, and not in another worktree nested below it. */
function withinWorktree(dir: string, root: string, isWorktreeRoot: (dir: string) => boolean): boolean {
  if (dir !== root && !dir.startsWith(root.endsWith(sep) ? root : root + sep)) return false;
  let p = root;
  for (const part of dir.slice(root.length).split(sep).filter(Boolean)) {
    p = join(p, part);
    if (isWorktreeRoot(p)) return false;
  }
  return true;
}
