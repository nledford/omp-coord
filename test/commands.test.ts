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

  describe("a command that merely mentions the wrapper is still judged", () => {
    const env = { ...runner, env: { BUN_BE_BUN: "1" } };
    const wrapped = (command: string) => {
      const d = decideCommand(rules, command, env);
      if (d.kind !== "queue") throw new Error(`expected a queue decision for ${command}`);
      return d.command;
    };

    test("a refused command after the wrapper, or around its words, is refused", () => {
      for (const command of [
        "omp-coord run x; pkill y",
        "omp-coord run test -- cargo test && pkill y",
        "omp-coord run test -- cargo test || pkill y",
        "omp-coord run test -- cargo test | pkill y",
        "omp-coord run test -- cargo test & pkill y",
        "omp-coord run test -- cargo test\npkill y",
        "omp-coord run test -- cargo test $(pkill y)",
        // shell syntax that hides a second command from a scanner reading the text a character at a time
        "omp-coord run x \\>& pkill y",
        "omp-coord run x ${y:- # } ; pkill z",
        "omp-coord run x\\\n#; pkill y",
        "omp-coord run x $'\\''&pkill\n$(<\\'x",
        "omp-coord run x &>& pkill y",
        `${wrapped("cargo test")}; pkill y`,
        `${wrapped("cargo test")} && pkill y`,
        "echo omp-coord run; pkill y",
        "cd /w && omp-coord run test -- cargo test; pkill y",
        "pkill -f '/usr/local/bin/bun' '/opt/omp-coord/src/cli.ts'",
        "echo '/usr/local/bin/bun' '/opt/omp-coord/src/cli.ts'; pkill y",
      ]) {
        expect(decideCommand(rules, command, env), command).toEqual({
          kind: "refuse",
          reason: "stop only your own process",
        });
      }
    });

    test("a command substitution after the wrapper reaches the rules instead of skipping them", () => {
      // the rule patterns here do not look inside backticks; what matters is that the early allow is gone
      expect(decideCommand(rules, "omp-coord run test -- cargo test `pkill y`", env).kind).toBe("queue");
    });

    test("the wrapper as this extension writes it, and a bare `omp-coord run`, are allowed", () => {
      const real = wrapped("cd /w && cargo test -p core 'a b'; echo \"$(date)\" | tee x");
      expect(decideCommand(rules, real, env)).toEqual({ kind: "allow" });
      expect(decideCommand(rules, "omp-coord run test -- cargo test -p core 2>&1", env)).toEqual({ kind: "allow" });
      expect(decideCommand(rules, "omp-coord run test --owner s1 -- sh -c 'cargo test; echo done'", env)).toEqual({
        kind: "allow",
      });
    });

    test("a queued command is not wrapped a second time", () => {
      for (const command of ["cargo test", "cd /w && cargo xtask ci", "cargo test; cargo check | tail -1"]) {
        expect(decideCommand(rules, wrapped(command), env)).toEqual({ kind: "allow" });
      }
    });
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
