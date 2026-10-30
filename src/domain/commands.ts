/**
 * What happens to an agent's bash command: the first matching rule refuses it, or rewrites it to run through a
 * queue (`omp-coord run <queue> -- sh -c '<command>'`), so it waits for a slot inside the bash call instead of
 * starting at once. omp's `tool_call` check must answer within 30 s, so waiting there is not an option.
 */
/**
 * What happens to an agent's bash command that matches `pattern`: refused with a reason, or run through a queue.
 * `agents: "sub"` limits the rule to subagents' commands (the main agent's run as if it were not there); the default is all.
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
  // Already queued: a command that runs `omp-coord run`, or one this extension rewrote.
  if (/(^|[;&|(\s'"/])omp-coord'?\s+'?run\b/.test(command) || runner.argv.every(a => command.includes(a)))
    return { kind: "allow" };
  const applies = (r: CommandRule) => r.agents !== "sub" || agentKind === "sub";
  if (command.length > MAX_CHECKED_COMMAND && rules.some(r => r.action === "refuse" && applies(r)))
    return {
      kind: "refuse",
      reason: `the command is ${command.length} characters, over the ${MAX_CHECKED_COMMAND} that omp-coord's refuse rules can check: create the file with the write tool and run it from a short command`,
    };
  const rule = rules.find(r => applies(r) && r.pattern.test(command));
  if (!rule) return { kind: "allow" };
  if (rule.action === "refuse") return { kind: "refuse", reason: rule.reason };
  const wrapped = [
    `OMP_COORD_CONFIG=${quote(runner.config)}`,
    ...Object.entries(runner.env ?? {}).map(([k, v]) => `${k}=${quote(v)}`),
    ...runner.argv.map(quote),
    "run",
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
