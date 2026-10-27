/**
 * What happens to an agent's bash command: the first matching rule refuses it, or rewrites it to run through a
 * queue (`omp-coord run <queue> -- sh -c '<command>'`), so it waits for a slot inside the bash call instead of
 * starting at once. omp's `tool_call` check must answer within 30 s, so waiting there is not an option.
 */
/** What happens to an agent's bash command that matches `pattern`: refused with a reason, or run through a queue. */
export type CommandRule =
  | { pattern: RegExp; action: "refuse"; reason: string }
  | { pattern: RegExp; action: "queue"; queue: string; lane: string | undefined };

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

export function decideCommand(rules: CommandRule[], command: string, runner: Runner): CommandDecision {
  // Already queued: a command that runs `omp-coord run`, or one this extension rewrote.
  if (/(^|[;&|(\s'"/])omp-coord'?\s+'?run\b/.test(command) || runner.argv.every(a => command.includes(a)))
    return { kind: "allow" };
  const rule = rules.find(r => r.pattern.test(command));
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

/**
 * The command with the id of the agent running it exported first, so a queued job records whose it is
 * (`omp-coord run` reads `OMP_COORD_AGENT`). An export, not a `VAR=… cmd` prefix, so it reaches every command of a
 * compound line; each agent's next command sets it again.
 */
export function withAgent(agentId: string, command: string): string {
  return `export OMP_COORD_AGENT=${quote(agentId)}; ${withoutAgentExports(command)}`;
}

/** The command without the `export OMP_COORD_AGENT=…;` prefixes it starts with, if any. */
export function withoutAgentExports(command: string): string {
  return command.replace(LEADING_AGENT_EXPORTS, "");
}

/**
 * The `export OMP_COORD_AGENT=…;` prefixes already at the start of a command. The rewritten command is what the
 * conversation shows, so an agent that copies its earlier calls sends them back; without stripping, each call would
 * add one more. A value is single-quoted as `quote` writes it (`'\''` for a quote inside) or a bare word of
 * shell-safe characters only, so a hand-typed value holding `\;`, `|`, `>` or a substitution is never mistaken for
 * a prefix and nothing of the command itself is dropped.
 */
const LEADING_AGENT_EXPORTS = /^(?:\s*export\s+OMP_COORD_AGENT=(?:'(?:[^']|'\\'')*'|[\w.@%+,:/=-]+)\s*;)+\s*/;
