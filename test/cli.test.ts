import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "adapters", "cli", "cli.ts");

function scope(queues: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), "omp-coord-cli-"));
  mkdirSync(join(root, "state"));
  writeFileSync(join(root, ".omp-coord.json"), JSON.stringify({ scope: "cli", queues }));
  const env = { ...process.env, OMP_COORD_STATE_DIR: join(root, "state"), OMP_COORD_SESSION: "" };
  const run = (...args: string[]) =>
    Bun.spawn(["bun", CLI, ...args], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
  return { root, run };
}

/** Resolves once `file` exists, i.e. the command that writes it has started. */
async function started(file: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      readFileSync(file);
      return;
    } catch {
      await Bun.sleep(50); // polling a file another process creates; there is no event to await
    }
  }
  throw new Error(`${file} never appeared`);
}

describe("omp-coord run", () => {
  test("with one slot, a second job waits for the first, and each keeps its exit code", async () => {
    const { root, run } = scope({ heavy: { slots: 1 } });
    const first = run("run", "heavy", "--", "sh", "-c", `touch ${root}/a; sleep 1.5; echo a >> ${root}/order; exit 3`);
    await started(join(root, "a"));
    const second = run("run", "heavy", "--", "sh", "-c", `echo b >> ${root}/order`);

    expect(await first.exited).toBe(3);
    expect(await second.exited).toBe(0);
    expect(readFileSync(join(root, "order"), "utf8")).toBe("a\nb\n");
    expect(await new Response(second.stderr).text()).toContain("waiting for a heavy slot: #1 in line");
  }, 20_000);

  test("a duplicate of a running job is not run and exits 75", async () => {
    const { root, run } = scope({ heavy: { slots: 2 } });
    const first = run("run", "heavy", "--key", "w ci", "--", "sh", "-c", `touch ${root}/a; sleep 1`);
    await started(join(root, "a"));
    const dup = run("run", "heavy", "--key", "w ci", "--", "true");
    expect(await dup.exited).toBe(75);
    expect(await new Response(dup.stderr).text()).toContain("already running: w ci");
    expect(await first.exited).toBe(0);
  }, 20_000);

  test("a runner killed while it holds the slot frees it for the next job", async () => {
    const { root, run } = scope({ heavy: { slots: 1 } });
    const victim = run("run", "heavy", "--", "sh", "-c", `touch ${root}/a; sleep 60`);
    await started(join(root, "a"));
    const next = run("run", "heavy", "--", "true");
    victim.kill("SIGKILL");
    expect(await next.exited).toBe(0);
  }, 30_000);

  test("status lists running and waiting jobs", async () => {
    const { root, run } = scope({ heavy: { slots: 1 } });
    const first = run("run", "heavy", "--", "sh", "-c", `touch ${root}/a; sleep 2`);
    await started(join(root, "a"));
    const second = run("run", "heavy", "--", "true");
    await Bun.sleep(1200); // let the second runner join the line; it writes nothing observable before
    const out = await new Response(run("status").stdout).text();
    expect(out).toMatch(/heavy \(fifo\): 1\/1 running, 1 waiting/);
    expect(out).toMatch(/running .* outside omp .* sh -c/);
    await Promise.all([first.exited, second.exited]);
  }, 20_000);

  test("an unknown queue is a usage error (exit 2)", async () => {
    const { run } = scope({ heavy: { slots: 1 } });
    expect(await run("run", "nope", "--", "true").exited).toBe(2);
  });
});

test("a mistyped lane, an unknown flag or an absurd priority is a usage error (exit 2), and leaves no socket behind", async () => {
  const { root, run } = scope({ heavy: { slots: 1, lanes: ["front", "normal"] } });
  expect(await run("run", "heavy", "--lane", "frnt", "--", "true").exited).toBe(2);
  expect(await run("run", "heavy", "--prio", "3", "--", "true").exited).toBe(2);
  expect(await run("run", "heavy", "--priority", "1e300", "--", "true").exited).toBe(2);
  expect(await run("run", "constructor", "--", "true").exited).toBe(2);
  const sockets = join(root, "state", "s");
  expect(existsSync(sockets) ? readdirSync(sockets) : []).toEqual([]);
});

test("a command already holding a slot of a queue runs a nested job of the same queue at once", async () => {
  const { run } = scope({ heavy: { slots: 1 } });
  const outer = run("run", "heavy", "--", "bun", CLI, "run", "heavy", "--", "sh", "-c", "exit 7");
  expect(await outer.exited).toBe(7);
}, 15_000);

test("a command killed by a signal exits with 128 plus that signal's number", async () => {
  const { run } = scope({ heavy: { slots: 1 } });
  expect(await run("run", "heavy", "--", "sh", "-c", "kill -SEGV $$").exited).toBe(128 + 11);
});

test("a command past its time limit is stopped with everything it started, exits 124, and is counted as timed out", async () => {
  const { root, run } = scope({ heavy: { slots: 1 } });
  const leftover = join(root, "grandchild-ran");
  const began = Date.now();
  // The outer `sh` exits on SIGTERM at once; the inner one, its child, would go on to write the file 3 s later.
  expect(
    await run("run", "heavy", "--timeout", "1s", "--", "sh", "-c", `sh -c 'sleep 3; touch ${leftover}'; true`).exited,
  ).toBe(124);
  expect(Date.now() - began).toBeLessThan(10_000);
  await Bun.sleep(3_500);
  expect(existsSync(leftover)).toBe(false);
  expect(await new Response(run("stats").stdout).text()).toMatch(/heavy: 1 started.*1 failed \(1 timed out\)/);
}, 20_000);

test("while paused nothing starts; resuming lets the waiting job run", async () => {
  const { root, run } = scope({ heavy: { slots: 1 } });
  expect(await run("pause", "merging", "tools").exited).toBe(0);
  const waiting = run("run", "heavy", "--", "sh", "-c", `touch ${root}/ran`);
  await Bun.sleep(1500); // let the runner join the line and stay waiting; nothing observable happens before
  expect(existsSync(join(root, "ran"))).toBe(false);
  expect(await new Response(run("status").stdout).text()).toMatch(/PAUSED: paused from a terminal: merging tools/);
  expect(await run("resume").exited).toBe(0);
  expect(await waiting.exited).toBe(0);
  expect(existsSync(join(root, "ran"))).toBe(true);
}, 20_000);

test("doctor reports a socket file nothing listens on, and --fix removes it", async () => {
  const { root, run } = scope({ heavy: { slots: 1 } });
  expect(await run("status").exited).toBe(0);
  mkdirSync(join(root, "state", "s"), { recursive: true });
  // A runner killed with SIGKILL leaves its socket file behind with nothing listening.
  const dead = join(root, "state", "s", "job-dead.sock");
  await Bun.spawn([
    "bun",
    "-e",
    `Bun.listen({ unix: ${JSON.stringify(dead)}, socket: { data() {} } }); process.kill(process.pid, "SIGKILL");`,
  ]).exited;
  expect(existsSync(dead)).toBe(true);
  expect(await new Response(run("doctor").stdout).text()).toMatch(/WARN\s+1 socket file\(s\) nothing listens on/);
  expect(await new Response(run("doctor", "--fix").stdout).text()).toMatch(/removed 1 socket file/);
  expect(existsSync(join(root, "state", "s", "job-dead.sock"))).toBe(false);
}, 20_000);
