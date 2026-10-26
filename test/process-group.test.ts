import { describe, expect, test } from "bun:test";
import { groupRunning, parseProcStat } from "../src/adapters/os/process-group.ts";

describe("reading /proc/<pid>/stat", () => {
  test("state and process group come after the command name, whatever it contains", () => {
    expect(parseProcStat("4242 (sleep) S 1 4240 4240 0 -1 4194304")).toEqual({ state: "S", pgrp: 4240 });
    expect(parseProcStat("81 (sh) Z 1 80 80 0 -1")).toEqual({ state: "Z", pgrp: 80 });
    expect(parseProcStat("77 (my (odd) cmd) R 5 70 70 0")).toEqual({ state: "R", pgrp: 70 });
  });

  test("text that is not a stat line gives nothing", () => {
    expect(parseProcStat("")).toBeUndefined();
    expect(parseProcStat("4242 sleep S 1 4240")).toBeUndefined();
    expect(parseProcStat("4242 (sleep)")).toBeUndefined();
  });
});

test("a process group counts as running while a member runs, and not once all have exited", async () => {
  const child = Bun.spawn(["sh", "-c", "sleep 30 & wait"], { detached: true, stdout: "ignore", stderr: "ignore" });
  await Bun.sleep(200);
  expect(groupRunning(child.pid)).toBe(true);
  process.kill(-child.pid, "SIGKILL");
  await child.exited;
  await Bun.sleep(200);
  expect(groupRunning(child.pid)).toBe(false);
});
