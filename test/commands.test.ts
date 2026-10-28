import { describe, expect, test } from "bun:test";
import { type CommandRule, decideCommand, MAX_CHECKED_COMMAND } from "../src/domain/commands.ts";

const rules: CommandRule[] = [
  { pattern: /(^|[;&|(\s])pkill\b/, action: "refuse", reason: "stop only your own process" },
  { pattern: /(^|[;&|(\s])cargo\s+(test|check)\b/, action: "queue", queue: "test", lane: undefined },
  { pattern: /(^|[;&|(\s])cargo\s+xtask\s+ci\b/, action: "queue", queue: "heavy", lane: "normal" },
];
const runner = { argv: ["/usr/local/bin/bun", "/opt/omp-coord/src/cli.ts"], owner: "s1", config: "/w/.omp-coord.json" };

describe("agents' bash commands", () => {
  test("a refused command is blocked with its reason", () => {
    expect(decideCommand(rules, "pkill -f foo", runner)).toEqual({
      kind: "refuse",
      reason: "stop only your own process",
    });
  });

  test("a command over the length cap is refused when any refuse rule exists, without running a pattern on it", () => {
    const long = `echo ${"a".repeat(MAX_CHECKED_COMMAND)}`;
    const decision = decideCommand(rules, long, runner);
    expect(decision.kind).toBe("refuse");
    if (decision.kind === "refuse") expect(decision.reason).toContain(String(MAX_CHECKED_COMMAND));
    // A pattern that would stall forever is never run on it.
    const trap: CommandRule[] = [{ pattern: /^(a+)+$/, action: "refuse", reason: "r" }];
    const started = performance.now();
    const stalled = decideCommand(trap, `${"a".repeat(MAX_CHECKED_COMMAND)}!`, runner);
    expect(stalled.kind === "refuse" && stalled.reason.includes(String(MAX_CHECKED_COMMAND))).toBe(true);
    expect(performance.now() - started).toBeLessThan(50);
  });

  test("the cap applies only where a refuse rule could be dodged by a long line", () => {
    const queueOnly: CommandRule[] = [{ pattern: /cargo test/, action: "queue", queue: "test", lane: undefined }];
    expect(decideCommand(queueOnly, `echo ${"a".repeat(MAX_CHECKED_COMMAND)}`, runner)).toEqual({ kind: "allow" });
    expect(decideCommand(rules, "a".repeat(MAX_CHECKED_COMMAND), runner)).toEqual({ kind: "allow" });
    expect(decideCommand(rules, "a".repeat(MAX_CHECKED_COMMAND + 1), runner).kind).toBe("refuse");
  });

  test("a queued command runs through the queue as the same shell command, owned by the session", () => {
    expect(decideCommand(rules, "cd /w && cargo test -p core 'a b'", runner)).toEqual({
      kind: "queue",
      queue: "test",
      command: `OMP_COORD_CONFIG='/w/.omp-coord.json' '/usr/local/bin/bun' '/opt/omp-coord/src/cli.ts' run 'test' --owner 's1' -- sh -c 'cd /w && cargo test -p core '\\''a b'\\'''`,
    });
  });

  test("the configured lane is passed on", () => {
    const d = decideCommand(rules, "cargo xtask ci", runner);
    expect(d.kind === "queue" && d.command).toContain("run 'heavy' --lane 'normal' --owner 's1'");
  });

  test("the runner's environment comes first, as assignments the shell applies", async () => {
    const d = decideCommand([{ pattern: /x/, action: "queue", queue: "q", lane: undefined }], "x", {
      argv: ["sh", "-c", 'echo "$BUN_BE_BUN"; exit 0', "-"],
      env: { BUN_BE_BUN: "1" },
      owner: "s",
      config: "/c",
    });
    expect(d.kind === "queue" && d.command).toStartWith("OMP_COORD_CONFIG='/c' BUN_BE_BUN='1' 'sh'");
    expect(await Bun.$`sh -c ${d.kind === "queue" ? d.command : ""}`.text()).toBe("1\n");
  });

  test("a command already going through omp-coord, or matching no rule, is left alone", () => {
    expect(decideCommand(rules, "omp-coord run test -- cargo test", runner)).toEqual({ kind: "allow" });
    expect(
      decideCommand(rules, "'/usr/local/bin/bun' '/opt/omp-coord/src/cli.ts' run test -- cargo test", runner),
    ).toEqual({ kind: "allow" });
    expect(decideCommand(rules, "ls -la", runner)).toEqual({ kind: "allow" });
  });

  test("a folder or file merely named omp-coord does not exempt a command from its queue", () => {
    for (const command of ["cd /work/omp-coord && cargo test", "cargo test 2>&1 | tee /tmp/omp-coord"]) {
      expect(decideCommand(rules, command, runner).kind).toBe("queue");
    }
  });

  test("the queued shell command keeps its meaning", async () => {
    const d = decideCommand(
      [{ pattern: /echo/, action: "queue", queue: "q", lane: undefined }],
      `echo "it's" $((1+2)) | tr a-z A-Z`,
      {
        argv: ["env"],
        owner: "s",
        config: "/c",
      },
    );
    // Run what follows `--` as the runner would.
    const command = d.kind === "queue" ? d.command.slice(d.command.indexOf(" -- ") + 4) : "";
    const out = await Bun.$`sh -c ${command}`.text();
    expect(out).toBe("IT'S 3\n");
  });
});
