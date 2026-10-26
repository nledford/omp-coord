#!/usr/bin/env bun
/**
 * omp-coord command line: runs commands through the shared build and test queues, from `just` recipes, scripts,
 * terminals, or agents' bash calls (which the extension rewrites to go through here).
 *
 *   omp-coord run <queue> [--lane L] [--priority N] [--key K] [--owner SESSION] -- <command> [args…]
 *   omp-coord status
 *
 * `run` waits for a slot, runs the command with the terminal's stdin/stdout/stderr, and exits with its exit code.
 * The command gets `OMP_COORD_JOB` (the job id) and `OMP_COORD_QUEUE` in its environment; a nested `run` on the same
 * queue runs at once, since the command already holds that queue's slot.
 * Exit 75 means the job was not run: refused (a duplicate of a waiting or running job) or superseded by a newer one.
 * Exit 2 means a usage or configuration error.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { constants } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { runJob } from "../../app/job-runner.ts";
import { type Config, ConfigError, findConfigFile, loadConfig } from "../../config.ts";
import { MAX_PRIORITY } from "../../domain/queues.ts";
import { BoardStore, stateDir } from "../sqlite/store.ts";
import { formatQueues } from "../text/report.ts";
import { startBeacon, unixLiveness } from "../unix/beacon.ts";

const EXIT_USAGE = 2;

class UsageError extends Error {}

async function main(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === "run") return run(rest);
  if (sub === "status") return status();
  throw new UsageError("usage: omp-coord run <queue> [--lane L] [--priority N] [--key K] [--owner SESSION] -- <command…> | omp-coord status");
}

function openScope(): { config: Config; store: BoardStore; dir: string } {
  const path = findConfigFile(process.cwd());
  if (!path) throw new UsageError(`no .omp-coord.json in ${process.cwd()} or above it (or set OMP_COORD_CONFIG)`);
  const config = loadConfig(path);
  const dir = stateDir();
  return { config, dir, store: new BoardStore(join(dir, `${config.scope}.db`), config.history) };
}

async function status(): Promise<number> {
  const { config, store } = openScope();
  const lines = formatQueues(store.read(), config.queues, Date.now());
  console.log(lines.length ? lines.join("\n").replace(/^ {2}/gm, "") : `no queues in ${config.source}`);
  store.close();
  return 0;
}

async function run(args: string[]): Promise<number> {
  const split = args.indexOf("--");
  if (split < 0 || split === args.length - 1) throw new UsageError("omp-coord run: give the command after `--`");
  let parsed: ReturnType<typeof parseRunFlags>;
  try {
    parsed = parseRunFlags(args.slice(0, split));
  } catch (error) {
    throw new UsageError(`omp-coord run: ${error instanceof Error ? error.message : String(error)}`);
  }
  const { values, positionals } = parsed;
  const queue = positionals[0];
  if (!queue || positionals.length > 1) throw new UsageError("omp-coord run: name exactly one queue");
  const priority = values.priority === undefined ? 0 : Number(values.priority);
  if (!Number.isSafeInteger(priority) || Math.abs(priority) > MAX_PRIORITY) {
    throw new UsageError(`omp-coord run: --priority must be a whole number from -${MAX_PRIORITY} to ${MAX_PRIORITY}`);
  }
  const command = args.slice(split + 1);

  // A command that already holds a slot of this queue runs nested jobs of the same queue at once: waiting for a
  // second slot of a one-slot queue would wait for itself forever.
  if (process.env.OMP_COORD_JOB && process.env.OMP_COORD_QUEUE === queue) return spawnCommand(command, process.env, () => undefined);

  const { config, store, dir } = openScope();
  try {
    const policy = Object.hasOwn(config.queues, queue) ? config.queues[queue] : undefined;
    if (!policy) throw new UsageError(`omp-coord run: no queue "${queue}" in ${config.source} (${Object.keys(config.queues).join(", ") || "none"})`);
    if (values.lane !== undefined && !policy.lanes.includes(values.lane)) {
      throw new UsageError(`omp-coord run: no lane "${values.lane}" in queue ${queue} (${policy.lanes.join(", ")})`);
    }
    mkdirSync(join(dir, "s"), { recursive: true, mode: 0o700 });
    const id = randomBytes(4).toString("hex");
    const address = join(dir, "s", `job-${id}.sock`);

    let stopping: NodeJS.Signals | undefined;
    let forward: (signal: NodeJS.Signals) => void = () => undefined;
    for (const s of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      process.on(s, signal => {
        stopping = signal;
        forward(signal);
      });
    }

    return await runJob(
      {
        id,
        queue,
        owner: values.owner || process.env.OMP_COORD_SESSION || null,
        ...(values.lane === undefined ? {} : { lane: values.lane }),
        priority,
        ...(values.key === undefined ? {} : { key: values.key }),
        command: command.join(" "),
        pid: process.pid,
      },
      config.queues,
      {
        repo: store,
        liveness: unixLiveness,
        clock: Date,
        listen: () => startBeacon(address),
        sleep: ms => Bun.sleep(ms),
        stopRequested: () => (stopping ? 128 + signalNumber(stopping) : undefined),
        report: line => console.error(line),
        execute: () =>
          spawnCommand(command, { ...process.env, OMP_COORD_JOB: id, OMP_COORD_QUEUE: queue }, f => {
            forward = f;
            if (stopping) f(stopping);
          }),
      },
    );
  } finally {
    store.close();
  }
}

function parseRunFlags(args: string[]) {
  return parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: { lane: { type: "string" }, priority: { type: "string" }, key: { type: "string" }, owner: { type: "string" } },
  });
}

/**
 * Runs the command with the terminal's input and output and returns its exit status (128 + signal number when a
 * signal ended it). `onStart` receives a function that passes a signal on to it. Ctrl-C at a terminal already
 * reaches the command (the terminal signals the whole process group), so SIGINT is passed on only without one.
 */
async function spawnCommand(command: string[], env: NodeJS.ProcessEnv, onStart: (forward: (signal: NodeJS.Signals) => void) => void): Promise<number> {
  const child = Bun.spawn(command, { stdio: ["inherit", "inherit", "inherit"], env });
  onStart(signal => {
    if (signal === "SIGINT" && process.stdin.isTTY) return;
    child.kill(signal);
  });
  const exitCode = await child.exited;
  return child.signalCode ? 128 + signalNumber(child.signalCode as NodeJS.Signals) : exitCode;
}

function signalNumber(signal: NodeJS.Signals): number {
  return constants.signals[signal] ?? 1;
}

if (import.meta.main) {
  try {
    process.exitCode = await main(Bun.argv.slice(2));
  } catch (error) {
    console.error(`omp-coord: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = error instanceof UsageError || error instanceof ConfigError ? EXIT_USAGE : 1;
  }
  process.exit();
}
