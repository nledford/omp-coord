import { describe, expect, test } from "bun:test";
import { type CommandRule, decideCommand, withAgent, withoutAgentExports } from "../src/domain/commands.ts";

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

describe("the agent behind a command", () => {
  test("every command of a compound line sees the agent's id, quoted however it is spelled", async () => {
    const line = withAgent("Wave'Import", "echo one $OMP_COORD_AGENT; sh -c 'echo two $OMP_COORD_AGENT'");
    const out = Bun.spawnSync(["bash", "-c", line], { env: {} });
    expect(out.stdout.toString()).toBe("one Wave'Import\ntwo Wave'Import\n");
  });

  test("a command that already starts with the prefix, once or many times, gets exactly one, for its own agent", () => {
    const once = withAgent("Main", "just ci");
    expect(withAgent("Main", once)).toBe(once);
    const piled = `export OMP_COORD_AGENT='Main'; export OMP_COORD_AGENT=Main;  ${withAgent("Wave'Import", "true")}`;
    expect(withAgent("Fixer", piled)).toBe(withAgent("Fixer", "true"));
  });

  test("a quoted value holding ';' or a newline is one prefix; a bare value holding shell syntax is the command's own", () => {
    expect(withoutAgentExports("export OMP_COORD_AGENT='a;b\nc'; true")).toBe("true");
    for (const own of [
      "export OMP_COORD_AGENT=a\\;b; c",
      "export OMP_COORD_AGENT=a|tee; c",
      "export OMP_COORD_AGENT=a>out; c",
      "export OMP_COORD_AGENT=`touch x`; c",
      "export OMP_COORD_AGENT=$(date); c",
      // a newline ends a command in bash: `export` alone on its line, or the `;` on the next, isn't a prefix
      "export\nOMP_COORD_AGENT=old; echo done",
      "export OMP_COORD_AGENT=old\n; echo done",
    ])
      expect(withoutAgentExports(own)).toBe(own);
  });

  test("an export of the variable later in a command, or of another variable first, is the command's own", () => {
    const later = "cd w && export OMP_COORD_AGENT=x; just ci";
    expect(withAgent("Main", later)).toBe(`export OMP_COORD_AGENT='Main'; ${later}`);
    const other = "export OMP_COORD_AGENT_X=1; true";
    expect(withAgent("Main", other)).toBe(`export OMP_COORD_AGENT='Main'; ${other}`);
  });
});
