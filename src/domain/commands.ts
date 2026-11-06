import { blankHeredocBodies } from "./heredoc.ts";

/**
 * What happens to an agent's bash command: the first matching rule refuses it, or rewrites it to run through a queue
 * (`omp-coord run <queue> -- sh -c '<command>'`), so it waits for a slot inside the bash call instead of starting at
 * once. omp's `tool_call` check must answer within 30 s, so waiting there is not an option.
 *
 * A rule is a regex over the command's text (case-sensitive, no flags; `^` and `$` anchor the whole command, not a
 * line), with the body of a heredoc that only feeds text to `cat`, `tee`, `git` or `gh` blanked first
 * (`blankHeredocBodies`); all other text is judged as written. `agents: "sub"` limits the rule to subagents' commands
 * (the main agent's run as if it were not there); the default is all.
 */
export type CommandRule =
  | { pattern: RegExp; action: "refuse"; reason: string; agents?: "all" | "sub" }
  | { pattern: RegExp; action: "queue"; queue: string; lane: string | undefined; agents?: "all" | "sub" };

export type CommandDecision =
  | { kind: "allow" }
  | { kind: "refuse"; reason: string }
  | { kind: "queue"; queue: string; command: string };

/**
 * How to start the runner (e.g. omp's own binary on `cli.ts` with `BUN_BE_BUN=1`), which session owns the jobs it
 * queues, and the config file the session's rules came from: the runner must use the same one, whatever folder the
 * bash call runs in.
 */
export interface Runner {
  argv: string[];
  /** Variables set for the runner only. Names must be valid shell names. */
  env?: Record<string, string>;
  owner: string;
  config: string;
}

/**
 * Longest command a `refuse` rule is judged on. omp's `tool_call` check is synchronous here and fails closed after 30 s,
 * and a regex that spends its whole backtracking budget answers "no match", which would let the command through. A
 * longer command is refused instead, so the cost of every pattern is bounded by this length.
 */
export const MAX_CHECKED_COMMAND = 32_768;

export function decideCommand(
  rules: CommandRule[],
  command: string,
  runner: Runner,
  agentKind: "main" | "sub" = "sub",
): CommandDecision {
  // Already queued: the command is the wrapper (this extension's rewrite, or a plain `omp-coord run`) and nothing else.
  if (isWrapper(command, runner)) return { kind: "allow" };
  const applies = (r: CommandRule) => r.agents !== "sub" || agentKind === "sub";
  if (command.length > MAX_CHECKED_COMMAND && rules.some(r => r.action === "refuse" && applies(r)))
    return {
      kind: "refuse",
      reason: `the command is ${command.length} characters, over the ${MAX_CHECKED_COMMAND} that omp-coord's refuse rules can check: create the file with the write tool and run it from a short command`,
    };
  const judged = rules.length > 0 ? blankHeredocBodies(command) : command;
  const rule = rules.find(r => applies(r) && r.pattern.test(judged));
  if (!rule) return { kind: "allow" };
  if (rule.action === "refuse") return { kind: "refuse", reason: rule.reason };
  const wrapped = [
    ...wrapperPrefix(runner),
    quote(rule.queue),
    ...(rule.lane === undefined ? [] : ["--lane", quote(rule.lane)]),
    "--owner",
    quote(runner.owner),
    "--",
    "sh",
    "-c",
    quote(command),
  ].join(" ");
  return { kind: "queue", queue: rule.queue, command: wrapped };
}

/** Single-quotes a word for sh. */
function quote(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/** How an agent may write the runner without this extension's rewrite. */
const BARE_RUNNERS = ["omp-coord run", "'omp-coord' run", '"omp-coord" run'];

/** The words that start a rewritten command, up to and including `run`: the config, the runner's environment and argv. */
function wrapperPrefix(runner: Runner): string[] {
  return [
    `OMP_COORD_CONFIG=${quote(runner.config)}`,
    ...Object.entries(runner.env ?? {}).map(([k, v]) => `${k}=${quote(v)}`),
    ...runner.argv.map(quote),
    "run",
  ];
}

/** The blanks a shell skips before a command: not `\s`, which also matches NBSP and other Unicode spaces. */
const SHELL_BLANKS = /^[ \t\n]+/;

/**
 * Whether the whole command is one `omp-coord run` invocation: it starts with the rewritten prefix (`wrapperPrefix`),
 * the runner's argv and `run`, or `omp-coord run`, and no further command follows it. A command that merely contains
 * those words (`omp-coord run x; pkill y`, `echo omp-coord run; …`) is judged by the rules like any other.
 */
function isWrapper(command: string, runner: Runner): boolean {
  const starts = [wrapperPrefix(runner).join(" "), [...runner.argv.map(quote), "run"].join(" "), ...BARE_RUNNERS];
  const start = command.replace(SHELL_BLANKS, "");
  const prefix = starts.find(
    p => start.startsWith(p) && (start.length === p.length || " \t\n".includes(start[p.length] as string)),
  );
  return prefix !== undefined && isSingleCommand(start.slice(prefix.length));
}

/**
 * Whether the rest of a command line is arguments of one simple command. False when anything could start another
 * command or change how the rest is read: an unquoted `;`, `&&`, `||`, `|`, `&` (also in `&>` and `&>>`, which only
 * bash reads as a redirection; `2>&1` is not a break), newline, parenthesis, backtick, `$(`, `${`, `$'` or `$"`; a
 * backslash before a newline; a `$(` or backtick inside double quotes; a quote left open. A `#` starts a comment only
 * after a space or tab, never after an escape or a quote. Anything unsure is "no": the command then goes to the rules,
 * which cost a queue wait at worst.
 */
function isSingleCommand(rest: string): boolean {
  let i = 0;
  /** The previous character when it was an unquoted, unescaped one on its own; "" after an escape or a quote. */
  let prev = " ";
  while (i < rest.length) {
    const c = rest[i] as string;
    if (c === "\\") {
      if (rest[i + 1] === "\n") return false;
      i += 2;
      prev = "";
    } else if (c === "'") {
      const close = rest.indexOf("'", i + 1);
      if (close < 0) return false;
      i = close + 1;
      prev = "";
    } else if (c === '"') {
      i++;
      while (i < rest.length && rest[i] !== '"') {
        if (rest[i] === "\\") i++;
        else if (rest[i] === "`" || (rest[i] === "$" && rest[i + 1] === "(")) return false;
        i++;
      }
      if (i >= rest.length) return false;
      i++;
      prev = "";
    } else if (c === "&" && (prev === ">" || prev === "<")) {
      i++;
      prev = "&";
    } else if (c === "#" && (prev === " " || prev === "\t")) {
      // a comment runs to the end of the line; a newline after it is judged like any other
      const end = rest.indexOf("\n", i);
      i = end < 0 ? rest.length : end;
    } else if (";&|\n()`".includes(c) || (c === "$" && "('\"{".includes(rest[i + 1] ?? "x"))) {
      return false;
    } else {
      i++;
      prev = c;
    }
  }
  return true;
}
