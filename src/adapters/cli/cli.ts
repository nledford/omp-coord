#!/usr/bin/env bun
/**
 * omp-coord command line: runs commands through the shared build and test queues, from `just` recipes, scripts,
 * terminals, or agents' bash calls (which the extension rewrites to go through here), and reports on the scope.
 *
 *   omp-coord run <queue> [--lane L] [--priority N] [--key K] [--owner SESSION] [--timeout 90m] -- <command> [args…]
 *   omp-coord status | stats [days] | interrupted [hours] | notes [count] | note <text…>
 *   omp-coord pause [reason…] | resume | doctor [--fix]
 *
 * `run` waits for a slot, runs the command with the terminal's stdin/stdout/stderr, and exits with its exit code.
 * The command gets `OMP_COORD_JOB` (the job id) and `OMP_COORD_QUEUE` in its environment; a nested `run` on the same
 * queue runs at once, since the command already holds that queue's slot.
 * Exit 75 means the job was not run (a refused or superseded duplicate); 124 that its time limit stopped it;
 * 2 a usage or configuration error.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { constants, userInfo } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Coordinator } from "../../app/coordinator.ts";
import { doctor } from "../../app/doctor.ts";
import { EXIT_TIMED_OUT, runJob } from "../../app/job-runner.ts";
import { type Config, ConfigError, findConfigFile, loadConfig } from "../../config.ts";
import { MAX_PRIORITY } from "../../domain/queues.ts";
import { osLoad } from "../os/load.ts";
import { BoardStore, stateDir } from "../sqlite/store.ts";
import { formatFindings, formatInterrupted, formatNotes, formatStats, formatStatus } from "../text/report.ts";
import { startBeacon, unixLiveness } from "../unix/beacon.ts";

const EXIT_USAGE = 2;
/** How long a command gets to stop after SIGTERM before SIGKILL, once its time limit passed. */
const KILL_GRACE_MS = 10_000;
const DAY = 86_400_000;

const USAGE = `usage:
  omp-coord run <queue> [--lane L] [--priority N] [--key K] [--owner SESSION] [--timeout 90m] -- <command…>
  omp-coord status | stats [days] | interrupted [hours] | notes [count] | note <text…>
  omp-coord pause [reason…] | resume | doctor [--fix]`;

class UsageError extends Error {}

async function main(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "run":
      return run(rest);
    case "status":
      return withScope(({ config, coordinator }) => print(formatStatus(coordinator.board(), config, "", Date.now())));
    case "stats":
      return withScope(({ coordinator }) =>
        print(formatStats(coordinator.stats(wholeNumber(rest[0], 7, "days") * DAY))),
      );
    case "interrupted":
      // A crashed session counts as left only once something drops it; with no session running, nothing else will.
      return withScope(async ({ coordinator }) => {
        await coordinator.prune("");
        return print(formatInterrupted(coordinator.interrupted(wholeNumber(rest[0], 24, "hours") * 3_600_000)));
      });
    case "notes":
      return withScope(({ coordinator }) => print(formatNotes(coordinator.notes(wholeNumber(rest[0], 20, "count")))));
    case "note":
      return withScope(({ coordinator }) => {
        const r = coordinator.note(null, userInfo().username, rest.join(" "));
        if (!r.ok) throw new UsageError(`omp-coord note: ${r.reason}`);
        return print(`noted #${r.note.id}`);
      });
    case "pause":
      return withScope(({ coordinator }) => {
        coordinator.pause(null, rest.join(" "));
        return print("paused: no new agent or queued job starts in this scope until `omp-coord resume`");
      });
    case "resume":
      return withScope(({ coordinator }) => print(coordinator.resume(null) ? "resumed" : "was not paused"));
    case "doctor":
      return withScope(async ({ config, coordinator, dir }) => {
        const findings = await doctor(
          coordinator,
          unixLiveness,
          {
            config,
            stateDirMode: statSync(dir).mode,
            socketFiles: socketFiles(join(dir, "s")),
            cliOnPath: Bun.which("omp-coord") !== null,
            now: Date.now(),
          },
          rest.includes("--fix"),
        );
        console.log(formatFindings(findings));
        return findings.some(f => f.level === "error") ? 1 : 0;
      });
    default:
      throw new UsageError(USAGE);
  }
}

interface Scope {
  config: Config;
  store: BoardStore;
  coordinator: Coordinator;
  dir: string;
}

function openScope(): Scope {
  const path = findConfigFile(process.cwd());
  if (!path) throw new UsageError(`no .omp-coord.json in ${process.cwd()} or above it (or set OMP_COORD_CONFIG)`);
  const config = loadConfig(path);
  const dir = stateDir();
  const store = new BoardStore(join(dir, `${config.scope}.db`), config.history);
  return { config, dir, store, coordinator: new Coordinator(config, store, unixLiveness, Date, osLoad) };
}

async function withScope(f: (s: Scope) => number | Promise<number>): Promise<number> {
  const scope = openScope();
  try {
    return await f(scope);
  } finally {
    scope.store.close();
  }
}

function print(text: string): number {
  console.log(text);
  return 0;
}

function wholeNumber(v: string | undefined, fallback: number, what: string): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 1) throw new UsageError(`${what} must be a whole number of at least 1`);
  return n;
}

function socketFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter(f => f.endsWith(".sock"))
      .map(f => join(dir, f));
  } catch {
    return [];
  }
}

/** `90m`, `2h`, `45s`, or a plain number of minutes. */
export function parseDuration(text: string): number {
  const m = /^(\d+)\s*(s|m|h)?$/.exec(text.trim());
  if (!m || Number(m[1]) < 1) throw new UsageError(`--timeout takes a duration such as 90m, 2h or 45s, not "${text}"`);
  return Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[(m[2] ?? "m") as "s" | "m" | "h"];
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
  const timeoutMs = values.timeout === undefined ? undefined : parseDuration(values.timeout);
  const command = args.slice(split + 1);

  // Signals to the runner go to the command: it runs in its own process group (so a time limit can stop all of it),
  // which the terminal's Ctrl-C no longer reaches.
  let stopping: NodeJS.Signals | undefined;
  let forward: (signal: NodeJS.Signals) => void = () => undefined;
  for (const s of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(s, signal => {
      stopping = signal;
      forward(signal);
    });
  }
  const attach = (f: (signal: NodeJS.Signals) => void) => {
    forward = f;
    if (stopping) f(stopping);
  };

  // A command that already holds a slot of this queue runs nested jobs of the same queue at once: waiting for a
  // second slot of a one-slot queue would wait for itself forever. It stays in the outer job's process group, so the
  // outer job's signals and time limit reach it directly; nothing is forwarded.
  if (process.env.OMP_COORD_JOB && process.env.OMP_COORD_QUEUE === queue) {
    const { code, timedOut } = await spawnCommand(command, commandEnv({}), timeoutMs ?? null, { ownGroup: false });
    if (timedOut) console.error(`omp-coord: stopped after the time limit`);
    return timedOut ? EXIT_TIMED_OUT : code;
  }

  return withScope(async ({ config, store, dir }) => {
    const policy = Object.hasOwn(config.queues, queue) ? config.queues[queue] : undefined;
    if (!policy)
      throw new UsageError(
        `omp-coord run: no queue "${queue}" in ${config.source} (${Object.keys(config.queues).join(", ") || "none"})`,
      );
    if (values.lane !== undefined && !policy.lanes.includes(values.lane)) {
      throw new UsageError(`omp-coord run: no lane "${values.lane}" in queue ${queue} (${policy.lanes.join(", ")})`);
    }
    mkdirSync(join(dir, "s"), { recursive: true, mode: 0o700 });
    const id = randomBytes(4).toString("hex");
    const address = join(dir, "s", `job-${id}.sock`);

    return runJob(
      {
        id,
        queue,
        owner: values.owner || process.env.OMP_COORD_SESSION || null,
        ...(values.lane === undefined ? {} : { lane: values.lane }),
        priority,
        ...(values.key === undefined ? {} : { key: values.key }),
        command: command.join(" "),
        pid: process.pid,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      },
      config.queues,
      {
        repo: store,
        liveness: unixLiveness,
        clock: Date,
        load: osLoad,
        listen: () => startBeacon(address),
        sleep: ms => Bun.sleep(ms),
        stopRequested: () => (stopping ? 128 + signalNumber(stopping) : undefined),
        report: line => console.error(line),
        execute: limit =>
          spawnCommand(command, commandEnv({ OMP_COORD_JOB: id, OMP_COORD_QUEUE: queue }), limit, {
            ownGroup: true,
            onStart: attach,
          }),
      },
    );
  });
}

function parseRunFlags(args: string[]) {
  return parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      lane: { type: "string" },
      priority: { type: "string" },
      key: { type: "string" },
      owner: { type: "string" },
      timeout: { type: "string" },
    },
  });
}

/**
 * The command's environment: the runner's, minus `BUN_BE_BUN` (set when omp's binary runs this file as Bun; a
 * command that starts `omp` must get omp), plus `extra`.
 */
function commandEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const { BUN_BE_BUN: _, ...env } = process.env;
  return { ...env, ...extra };
}

/**
 * Runs the command with the terminal's input and output and returns its exit status (128 + signal number when a
 * signal ended it). With `ownGroup`, the command runs in its own process group, and `onStart` receives a function
 * that passes a signal to the whole group. With a time limit, the command (its group, with `ownGroup`) gets SIGTERM
 * when it passes; whatever of it is still running 10 s later (`sh -c 'a && b'` exits on SIGTERM while `a` may not)
 * gets SIGKILL before the slot is given back.
 */
async function spawnCommand(
  command: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number | null,
  o: { ownGroup: true; onStart: (forward: (signal: NodeJS.Signals) => void) => void } | { ownGroup: false },
): Promise<{ code: number; timedOut: boolean }> {
  const child = Bun.spawn(command, { stdio: ["inherit", "inherit", "inherit"], env, detached: o.ownGroup });
  const target = o.ownGroup ? -child.pid : child.pid;
  const signal = (s: NodeJS.Signals | 0): boolean => {
    try {
      process.kill(target, s);
      return true;
    } catch {
      return false; // gone
    }
  };
  if (o.ownGroup) o.onStart(signal);
  let termAt: number | undefined;
  const limit =
    timeoutMs === null
      ? undefined
      : setTimeout(() => {
          termAt = Date.now();
          signal("SIGTERM");
        }, timeoutMs);
  const exitCode = await child.exited;
  clearTimeout(limit);
  if (termAt !== undefined) {
    const running = () => (o.ownGroup ? groupRunning(child.pid) : signal(0));
    while (running() && Date.now() - termAt < KILL_GRACE_MS) await Bun.sleep(100);
    signal("SIGKILL");
  }
  return {
    code: child.signalCode ? 128 + signalNumber(child.signalCode as NodeJS.Signals) : exitCode,
    timedOut: termAt !== undefined,
  };
}

function signalNumber(signal: NodeJS.Signals): number {
  return constants.signals[signal] ?? 1;
}

/**
 * Whether process group `pgid` still has a member that has not exited. A signal to the group succeeds while it holds
 * only zombies, which is what an exited command's children become in a container whose first process never reaps
 * orphans; on Linux, /proc tells them apart. Elsewhere (macOS has no /proc; launchd reaps orphans) the signal decides.
 */
function groupRunning(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
  } catch {
    return false;
  }
  if (process.platform !== "linux") return true;
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      // /proc/<pid>/stat: "pid (comm) state ppid pgrp …"; comm may contain spaces and parentheses.
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const [state, , pgrp] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(pgrp) === pgid && state !== "Z") return true;
    } catch {
      // The process ended while being read.
    }
  }
  return false;
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
