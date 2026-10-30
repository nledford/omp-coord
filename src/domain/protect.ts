/**
 * Protected checkouts: what agents may not change in a project's main checkout. A relative path in the file tools
 * (`edit`, `write`, `ast_edit`, `apply_patch`) resolves against omp's own folder, not against the `cwd` an agent
 * gives its bash calls, so an agent told to work in a worktree edits the main checkout the moment it types
 * `crates/a.rs` instead of the worktree's absolute path; and a bash call without a `cwd` runs in that same folder, so
 * its `git checkout` changes the main checkout too. A refusal names the resolved path, so the agent sees the mistake
 * before anything changes.
 *
 * File paths are judged as written and as omp is likely to read them (decorations such as a quoted path or an
 * `[Update File: …]` wrapper removed): a call is refused when either lies in the checkout, because omp's own reading
 * differs per tool and a careless agent's decorated path should stop it, not slip by. A shell command's file writes
 * are not judged (the `commands` rules cover the in-place rewriters); its state-changing `git` is (`gitChange`).
 * Pure path arithmetic; what the disk says (symlinks, nested checkouts) is passed in.
 */
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type Board, emit } from "./model.ts";

export interface WriteGuard {
  /** Absolute folders of the checkouts to protect. A linked worktree (or any folder with its own `.git`) below one is not part of it. */
  roots: string[];
  /** Folders and files below a root (relative to it) that stay writable. */
  allow: string[];
  /** Whose writes are judged: subagents only, or the main agent too. */
  agents: "sub" | "all";
}

export interface GuardFacts {
  /** omp's folder for the agent: where a relative path in a file tool resolves. */
  cwd: string;
  home: string;
  /** The path with symbolic links resolved (a file that does not exist yet: its nearest folder that does, plus the rest). */
  canonical: (path: string) => string;
  /** Whether the folder has a `.git` of its own: a checkout's top. */
  hasGitEntry: (dir: string) => boolean;
}

export type WriteDecision = { kind: "allow" } | { kind: "refuse"; reason: string; shown?: string[] };

/** Tools that write files, each with how its arguments name them (see `writeTargets`). */
const WRITE_TOOLS: Record<string, true> = { edit: true, write: true, ast_edit: true, apply_patch: true };

/**
 * The paths a file tool call would change: each as the agent wrote it, and again with the decorations omp strips
 * removed when that differs. Undefined for a tool that writes no files.
 */
export function writeTargets(toolName: string, input: Record<string, unknown>): string[] | undefined {
  if (typeof input !== "object" || input === null) return Object.hasOwn(WRITE_TOOLS, toolName) ? [] : undefined;
  if (!Object.hasOwn(WRITE_TOOLS, toolName)) return undefined;
  const written: string[] = [];
  if (toolName === "write") {
    const path = input.path;
    if (typeof path !== "string") return [];
    // `xd://<tool>` runs that tool with the written JSON as its arguments.
    const device = /^xd:\/\/(edit|write|ast_edit|apply_patch)\/?$/i.exec(path);
    if (device && typeof input.content === "string") {
      try {
        const args: unknown = JSON.parse(input.content);
        if (typeof args === "object" && args !== null && !Array.isArray(args))
          return writeTargets((device[1] as string).toLowerCase(), args as Record<string, unknown>) ?? [];
      } catch {
        // not JSON: the device refuses it itself
      }
      return [];
    }
    written.push(path);
  } else if (toolName === "ast_edit") {
    const paths = Array.isArray(input.paths) ? input.paths.filter((p): p is string => typeof p === "string") : [];
    for (const p of paths) {
      // a glob is judged by what comes before its first wildcard, cut back to a folder
      const prefix = p.replace(/^file:\/\//i, "").replace(/[*?[{][\s\S]*$/, "");
      written.push(prefix === "" ? "." : prefix);
    }
  } else {
    const text = [input.input, input.patch].find((t): t is string => typeof t === "string") ?? "";
    // replace mode names its file in `path`; patch mode may move one with `rename`
    for (const key of ["path", "rename", "move_to"]) if (typeof input[key] === "string") written.push(input[key]);
    if (Array.isArray(input.edits))
      for (const e of input.edits)
        if (typeof e === "object" && e !== null)
          for (const key of ["path", "rename", "move_to"]) {
            const v = (e as Record<string, unknown>)[key];
            if (typeof v === "string") written.push(v);
          }
    for (const line of text.split("\n")) {
      // hashline mode: `[path#TAG]`; the path runs to the last `]` (a file may be named `[slug]`)
      const header = /^\[(.+)\]\s*$/.exec(line);
      if (header) written.push(header[1] as string);
      // `MV DEST`: resolved like a header
      const move = /^\s*MV\s+(.+?)\s*$/.exec(line);
      if (move) written.push(move[1] as string);
      // apply_patch and sloppy modes: `*** Update File: path`, `*** Move to: path`, `*** Edit File path all`
      const patch =
        /^\s*\*{3}\s*(?:(?:Update|Add|Delete)\s+File|Move\s+to|Edit\s+File)\s*:?\s*(.+?)(?:\s+all)?\s*$/i.exec(line);
      if (patch) written.push(patch[1] as string);
    }
  }
  const targets = new Set<string>();
  for (const w of written) {
    for (const p of [w, cleanPath(w)]) if (p !== "" && !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(p)) targets.add(p);
  }
  return [...targets];
}

/**
 * The path as omp is likely to read it: unquoted, without a `[…#TAG]` wrapper, a trailing `#TAG`, the `Update File:`
 * noise of a copied header or a leading `@`.
 */
function cleanPath(raw: string): string {
  let p = raw.trim();
  const stripFile = (s: string): string => {
    if (!/^file:\/\//i.test(s)) return s;
    const rest = s.replace(/^file:\/\/(?:localhost(?=\/))?/i, "");
    try {
      return decodeURIComponent(rest);
    } catch {
      return rest;
    }
  };
  p = stripFile(p);
  const wrapped = /^\[(.+)\]$/.exec(p);
  if (wrapped) p = (wrapped[1] as string).trim();
  p = p.replace(/^\**\s*(?:(?:Update|Add|Delete|Edit)\s+File|Move\s+to|Update|Move)\s*:?\s*\**\s*/i, "");
  p = p.replace(/#[0-9A-Fa-f]{2,8}$/, "");
  const quoted = /^(["'])(.*)\1$/.exec(p);
  if (quoted) p = quoted[2] as string;
  return stripFile(p.replace(/^@(?=[/~]|file:\/\/)/i, ""));
}

export function decideWrite(
  guard: WriteGuard,
  agentKind: "main" | "sub",
  toolName: string,
  targets: string[],
  facts: GuardFacts,
): WriteDecision {
  if (guard.agents === "sub" && agentKind !== "sub") return { kind: "allow" };
  const roots = guard.roots.map(r => facts.canonical(resolve(r)));
  for (const target of targets) {
    const absolute = resolve(facts.cwd, target.startsWith("~/") ? join(facts.home, target.slice(2)) : target);
    const path = facts.canonical(absolute);
    for (const root of roots) {
      // a target that holds the root (`ast_edit` on `..`) would change it too
      const holdsRoot = path !== root && inside(root, path);
      if (!holdsRoot && (!inside(path, root) || nested(path, root, facts) || allowed(path, root, guard.allow)))
        continue;
      const how =
        isAbsolute(target) || target.startsWith("~/")
          ? `${target} is in the main checkout ${root}`
          : `${target} resolves to ${path} in the main checkout ${root}: a relative path in ${toolName} resolves against omp's folder, not the cwd of your bash calls`;
      return {
        kind: "refuse",
        reason: `${toolName} refused: ${how}. Agents work in a worktree of their own: give the file's absolute path there (<your worktree>/${relative(root, path)}), and check the brief for the worktree's path.`,
      };
    }
  }
  return { kind: "allow" };
}

/** `git` subcommands that change a checkout's files, index or HEAD (`branch` is left out: most uses only read). */
const GIT_CHANGES: Record<string, true> = {
  checkout: true,
  switch: true,
  reset: true,
  restore: true,
  clean: true,
  rebase: true,
  merge: true,
  commit: true,
  pull: true,
  "cherry-pick": true,
  revert: true,
  am: true,
  add: true,
  rm: true,
  mv: true,
  apply: true,
  bisect: true,
};

/** How deep below a root a linked worktree is looked for: they sit one or two levels down (`.claude/worktrees/x`). */
const MAX_NEST_DEPTH = 8;

/** Words that start a command's real name without being it: shell keywords, and wrappers with the options they take. */
const KEYWORDS = new Set([
  "if",
  "then",
  "elif",
  "else",
  "do",
  "while",
  "until",
  "!",
  "{",
  "}",
  "time",
  "command",
  "exec",
  "nohup",
]);
const WRAPPERS: Record<string, string[]> = {
  sudo: ["-u", "-g", "-C", "-h", "-p", "-r", "-t", "-U", "-D", "-T", "--chdir"],
  env: ["-u", "-C", "-S", "-P", "--chdir"],
  nice: ["-n"],
  timeout: ["-s", "-k", "--signal", "--kill-after"],
  xargs: ["-n", "-I", "-P", "-d", "-L", "-E", "-s", "-a"],
};

/** Where a `cd` and the like lead: `from` is where the command runs, undefined when that is not known. */
function moved(from: string | undefined, target: string, facts: GuardFacts): string | undefined {
  if (target === "-" || /[$`*?[{%]|^~[^/]/.test(target)) return undefined;
  if (target === "") return from;
  if (target === "~") return facts.home;
  if (target.startsWith("~/")) return resolve(facts.home, target.slice(2));
  if (isAbsolute(target)) return resolve(target);
  return from === undefined ? undefined : resolve(from, target);
}

/** The folder a call's `cwd` names, as omp reads it (`~` expanded, relative to omp's own folder). */
export function resolveCwd(base: string, cwd: string, home: string): string {
  if (cwd === "~") return home;
  return cwd.startsWith("~/") ? resolve(home, cwd.slice(2)) : resolve(base, cwd);
}

/**
 * A `git` command in the bash command that changes a protected checkout. The folder it runs in follows the call's
 * `cwd`, `cd` and `pushd` (a subshell's change ends with it), `git -C`, `--work-tree` and `GIT_WORK_TREE=`, through
 * `&&`, `||`, `;`, `|`, newlines, `if`/`for`/`while` bodies, `sudo`/`env`/`nice`/`timeout`/`xargs` wrappers and
 * `sh -c '…'`; quotes are respected and heredoc bodies skipped. A folder it cannot work out (a variable, `cd -`,
 * after `popd`) is not judged. Like every rule that reads command text it stops the usual spellings, not a determined
 * dodge.
 */
export function gitChange(
  guard: WriteGuard,
  agentKind: "main" | "sub",
  command: string,
  cwd: string,
  facts: GuardFacts,
): WriteDecision {
  if (guard.agents === "sub" && agentKind !== "sub") return { kind: "allow" };
  const roots = guard.roots.map(r => facts.canonical(resolve(r)));
  const judge = (sub: string, dir: string): WriteDecision | undefined => {
    const path = facts.canonical(dir);
    for (const root of roots) {
      if (!inside(path, root) || nested(path, root, facts) || allowed(path, root, guard.allow)) continue;
      return {
        kind: "refuse",
        reason: `git ${sub} refused: it runs in ${path}, inside the main checkout ${root}, which no agent changes (a bash call without a cwd runs there). Run it in your own worktree: give the call that worktree's absolute path as its cwd, or use \`cd <your worktree> && git …\` or \`git -C <your worktree> …\`.`,
        shown: [`git ${sub} in ${path}`],
      };
    }
    return undefined;
  };
  return (
    scanCommands(command, cwd, facts, 0, (words, here) => {
      let dir = here;
      let sub: string | undefined;
      for (let i = 0; i < words.length; i++) {
        const w = words[i] as string;
        if (w === "-C" || w === "--work-tree") dir = moved(dir, words[++i] ?? "", facts);
        else if (w.startsWith("--work-tree=")) dir = moved(dir, w.slice("--work-tree=".length), facts);
        else if (w === "-c" || w === "--git-dir" || w === "--namespace" || w === "--exec-path") i++;
        else if (!w.startsWith("-")) {
          sub = w;
          break;
        }
      }
      return sub === undefined || !Object.hasOwn(GIT_CHANGES, sub) || dir === undefined ? undefined : judge(sub, dir);
    }) ?? { kind: "allow" }
  );
}

/**
 * Walks the commands of a shell script text in order, calling `onGit` with the words after `git` and the folder it runs
 * in; stops at the first answer. Tracks `cd`/`pushd`/`popd` and subshells.
 */
function scanCommands(
  script: string,
  start: string | undefined,
  facts: GuardFacts,
  depth: number,
  onGit: (words: string[], here: string | undefined) => WriteDecision | undefined,
): WriteDecision | undefined {
  let here = start;
  const stack: { here: string | undefined; outer?: { words: string[]; word: string | undefined }; dq?: boolean }[] = [];
  let found: WriteDecision | undefined;
  const run = (all: string[]): void => {
    const words = [...all];
    let base = here;
    let treeFromEnv: string | undefined;
    let replace: string | undefined;
    for (;;) {
      const first = words[0];
      if (first === undefined) return;
      const assign = /^[A-Za-z_]\w*=([\s\S]*)$/.exec(first);
      if (assign) {
        if (first.startsWith("GIT_WORK_TREE=")) treeFromEnv = assign[1];
        words.shift();
      } else if (first === "command" || first === "exec" || first === "time") {
        words.shift();
        while (words[0]?.startsWith("-")) words.splice(0, first === "exec" && words[0] === "-a" ? 2 : 1);
      } else if (KEYWORDS.has(first)) words.shift();
      else if (Object.hasOwn(WRAPPERS, basename(first))) {
        const name = basename(first);
        words.shift();
        const valued = WRAPPERS[name] as string[];
        while (words[0]?.startsWith("-") && words[0] !== "--") {
          const opt = words[0];
          if (name === "xargs") {
            if (opt === "-I") replace = words[1];
            else if (opt.startsWith("-I") && opt.length > 2) replace = opt.slice(2);
            else if (opt === "-i" || opt === "--replace") replace = "{}";
            else if (opt.startsWith("-i") && opt.length > 2) replace = opt.slice(2);
            else if (opt.startsWith("--replace=")) replace = opt.slice("--replace=".length);
          }
          const chdir = opt.startsWith("--chdir=")
            ? opt.slice("--chdir=".length)
            : opt === "--chdir" || (name === "env" && opt === "-C") || (name === "sudo" && opt === "-D")
              ? (words[1] ?? "")
              : (name === "env" && opt.startsWith("-C")) || (name === "sudo" && opt.startsWith("-D"))
                ? opt.slice(2) || undefined
                : undefined;
          if (chdir !== undefined) base = moved(base, chdir, facts);
          words.splice(0, valued.includes(opt) ? 2 : 1);
        }
        if (words[0] === "--") words.shift();
        if (name === "timeout") words.shift();
      } else break;
    }
    if (replace) for (let k = 0; k < words.length; k++) words[k] = (words[k] as string).split(replace).join("$");
    const head = words.shift() as string;
    if (head === "cd" || head === "pushd")
      here = moved(here, words.filter(w => w === "-" || !w.startsWith("-"))[0] ?? "~", facts);
    else if (head === "popd") here = undefined;
    else if (/^(?:sh|bash|zsh|dash)$/.test(basename(head)) && depth < 2) {
      const at = words.findIndex(w => /^-[A-Za-z]*c[A-Za-z]*$/.test(w));
      const body = at >= 0 ? words[at + 1] : undefined;
      if (body !== undefined) found ??= scanCommands(body, base, facts, depth + 1, onGit);
    } else if (basename(head) === "git")
      found ??= onGit(words, treeFromEnv === undefined ? base : moved(base, treeFromEnv, facts));
  };

  let words: string[] = [];
  let word: string | undefined;
  const endWord = (): void => {
    if (word !== undefined) words.push(word);
    word = undefined;
  };
  const endCommand = (): void => {
    endWord();
    if (words.length > 0) run(words);
    words = [];
  };
  const pending: { name: string; strip: boolean }[] = [];
  let backtick = false;
  let inDq = false;
  let i = 0;
  const n = script.length;
  while (i < n && found === undefined) {
    const c = script[i] as string;
    if (inDq) {
      // inside double quotes: text, except that `$(` starts a substitution whose own quotes are fresh
      if (c === '"') {
        inDq = false;
        i++;
      } else if (c === "\\" && i + 1 < n) {
        const next = script[i + 1] as string;
        word = (word ?? "") + ('"\\$`'.includes(next) ? next : `\\${next}`);
        i += 2;
      } else if (c === "$" && script[i + 1] === "(") {
        stack.push({ here, outer: { words, word }, dq: true });
        words = [];
        word = undefined;
        inDq = false;
        i += 2;
      } else if (c === "`" && !backtick) {
        stack.push({ here, outer: { words, word }, dq: true });
        words = [];
        word = undefined;
        inDq = false;
        backtick = true;
        i++;
      } else {
        word = (word ?? "") + c;
        i++;
      }
      continue;
    }
    if (c === "\\" && script[i + 1] === "\n") i += 2;
    else if (c === "\\") {
      word = (word ?? "") + (script[i + 1] ?? "");
      i += 2;
    } else if (c === "'") {
      const end = script.indexOf("'", i + 1);
      word = (word ?? "") + script.slice(i + 1, end < 0 ? n : end);
      i = end < 0 ? n : end + 1;
    } else if (c === '"') {
      inDq = true;
      word = word ?? "";
      i++;
    } else if (c === " " || c === "\t" || c === "\r") {
      endWord();
      i++;
    } else if (c === "\n") {
      endCommand();
      i++;
      // a heredoc's body runs from the next line to its delimiter line
      for (const h of pending.splice(0)) {
        for (;;) {
          if (i >= n) break;
          const eol = script.indexOf("\n", i);
          const line = script.slice(i, eol < 0 ? n : eol);
          i = eol < 0 ? n : eol + 1;
          if ((h.strip ? line.replace(/^\t+/, "") : line) === h.name) break;
        }
      }
    } else if (c === "#" && word === undefined) {
      const eol = script.indexOf("\n", i);
      i = eol < 0 ? n : eol;
    } else if (c === "<" && script[i + 1] === "<" && script[i + 2] !== "<") {
      i += 2;
      const strip = script[i] === "-";
      if (strip) i++;
      while (script[i] === " " || script[i] === "\t") i++;
      let name = "";
      while (i < n && !/[\s;&|<>()]/.test(script[i] as string)) {
        const d = script[i] as string;
        if (d === "'" || d === '"') {
          const end = script.indexOf(d, i + 1);
          name += script.slice(i + 1, end < 0 ? n : end);
          i = end < 0 ? n : end + 1;
        } else if (d === "\\") {
          name += script[i + 1] ?? "";
          i += 2;
        } else {
          name += d;
          i++;
        }
      }
      if (name !== "") pending.push({ name, strip });
    } else if (c === "$" && script[i + 1] === "(") {
      // a substitution is scanned as commands of its own; the outer word gets a `$` placeholder (an unknown value)
      stack.push({ here, outer: { words, word } });
      words = [];
      word = undefined;
      i += 2;
    } else if (c === "`") {
      if (backtick) {
        endCommand();
        const frame = stack.pop();
        here = frame?.here ?? here;
        words = frame?.outer?.words ?? words;
        word = `${frame?.outer?.word ?? ""}$`;
        if (frame?.dq) inDq = true;
      } else {
        stack.push({ here, outer: { words, word } });
        words = [];
        word = undefined;
      }
      backtick = !backtick;
      i++;
    } else if (c === "(") {
      endCommand();
      stack.push({ here });
      i++;
    } else if (c === ")") {
      endCommand();
      const frame = stack.pop();
      here = frame?.here ?? here;
      if (frame?.dq) inDq = true;
      if (frame?.outer) {
        words = frame.outer.words;
        word = `${frame.outer.word ?? ""}$`;
      }
      i++;
    } else if (c === ";" || c === "|" || c === "&") {
      endCommand();
      i += script[i + 1] === c && c !== ";" ? 2 : 1;
    } else {
      word = (word ?? "") + c;
      i++;
    }
  }
  if (found === undefined) endCommand();
  return found;
}

function inside(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * The path is, or lies in, a folder below the root that is a checkout of its own (a linked worktree): only the first
 * `MAX_NEST_DEPTH` levels below the root are looked at, so a path of thousands of levels costs a few checks.
 */
function nested(path: string, root: string, facts: GuardFacts): boolean {
  const parts = relative(root, path).split(sep).filter(Boolean);
  for (let i = 1; i <= Math.min(parts.length, MAX_NEST_DEPTH); i++)
    if (facts.hasGitEntry(join(root, ...parts.slice(0, i)))) return true;
  return false;
}

function allowed(path: string, root: string, allow: string[]): boolean {
  const rel = relative(root, path);
  return allow.some(a => {
    const prefix = a.replace(/\/+$/, "");
    return rel === prefix || rel.startsWith(`${prefix}/`);
  });
}

/**
 * A path with symbolic links resolved where it exists, built from a resolver for the part that does. A folder that
 * exists has all its parents, so the deepest one is found by bisection: a path of thousands of levels costs a few
 * lookups.
 */
export function canonicalWith(real: (p: string) => string | undefined): (path: string) => string {
  return (path: string): string => {
    const parts = path.split(sep).filter(Boolean);
    const prefix = (k: number): string => sep + parts.slice(0, k).join(sep);
    let lo = 0;
    let hi = parts.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (real(prefix(mid)) !== undefined) lo = mid;
      else hi = mid - 1;
    }
    return join(real(prefix(lo)) ?? prefix(lo), ...parts.slice(lo));
  };
}

/** Records a refused write or command for the event log: the agent, the tool and what the agent wrote. */
export function writeRefused(
  board: Board,
  sessionId: string,
  w: { agentId: string; tool: string; paths: string[]; now: number },
): void {
  emit(board, w.now, "write_refused", sessionId, { agentId: w.agentId, tool: w.tool, paths: w.paths });
}
