/**
 * What happens to an agent's bash command: the first matching rule refuses it, or rewrites it to run through a
 * queue (`omp-coord run <queue> -- sh -c '<command>'`), so it waits for a slot inside the bash call instead of
 * starting at once. omp's `tool_call` check must answer within 30 s, so waiting there is not an option.
 */
import type { CommandRule } from "./config.ts";

export type CommandDecision =
  | { kind: "allow" }
  | { kind: "refuse"; reason: string }
  | { kind: "queue"; queue: string; command: string };

/**
 * How to start the runner (`bun <path>/cli.ts`), which session owns the jobs it queues, and the config file the
 * session's rules came from: the runner must use the same one, whatever folder the bash call runs in.
 */
export interface Runner {
  argv: string[];
  owner: string;
  config: string;
}

export function decideCommand(rules: CommandRule[], command: string, runner: Runner): CommandDecision {
  // Already queued: a command that runs `omp-coord run`, or one this extension rewrote.
  if (/(^|[;&|(\s'"/])omp-coord'?\s+'?run\b/.test(command) || runner.argv.every(a => command.includes(a))) return { kind: "allow" };
  const rule = rules.find(r => r.pattern.test(command));
  if (!rule) return { kind: "allow" };
  if (rule.action === "refuse") return { kind: "refuse", reason: rule.reason };
  const wrapped = [
    `OMP_COORD_CONFIG=${quote(runner.config)}`,
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
