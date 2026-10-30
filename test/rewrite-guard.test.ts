import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";
import { decideCommand, MAX_CHECKED_COMMAND } from "../src/domain/commands.ts";

// The in-place rewrite rules shipped in examples/omp-coord.json, loaded the way a project's own file is.
const config = loadConfig(new URL("../examples/omp-coord.json", import.meta.url).pathname);
const runner = { argv: ["/usr/local/bin/bun", "/opt/omp-coord/src/cli.ts"], owner: "s1", config: "/w/.omp-coord.json" };
const sub = (command: string) => decideCommand(config.commands, command, runner, "sub").kind;
const main = (command: string) => decideCommand(config.commands, command, runner, "main").kind;

const REFUSED = [
  "sed -i 's/a/b/' crates/a.rs",
  "sed -i '' 's/a/b/' docs/x.md",
  "sed -i.bak 's/a/b/' f",
  "sed -Ei 's/a+/b/' f",
  "sed -n -i '1d' f",
  "sed --in-place 's/a/b/' f",
  "cd /w/.claude/worktrees/x && sed -i '7s/old/new/' docs/whats-new.md && cargo fmt",
  "git ls-files -m | xargs sed -i '' -E 's/x/y/'",
  "perl -pi -e 's/a/b/' f",
  "perl -i.bak -pe 's/a/b/' f",
  "perl -0pi -e 's/a\\nb/c/' f",
  "perl -p -i -e 's/a/b/' f",
  "python3 - <<'E'\np='docs/x.md'\ns=open(p).read()\nopen(p,'w').write(s.replace('a','b'))\nE",
  "cd /w && python3 - <<'EOF'\nfrom pathlib import Path\nPath('a.rs').write_text('x')\nEOF",
  "python3 -c \"open('f','w').write('x')\"",
  'python -c \'import pathlib; pathlib.Path("f").write_text("x")\'',
  "python3.12 - <<'E'\nwith open('f', 'a') as h: h.write('x')\nE",
  "python3 <<'E'\nopen('f',\"wb\").write(b'x')\nE",
  "gsed -i 's/a/b/' f",
  "python3 -W ignore -c \"open('f','w')\"",
  "python3 -c \"open(os.path.join(d,'f'),'w')\"",
  "python3 - <<'E'\nopen(p, mode='w')\nE",
  "python3 - <<'E'\nopen('f','x')\nE",
  "python3 -c \"pathlib.Path('f').write_bytes(b'x')\"",
  "uv run python - <<'E'\nPath('f').write_text('x')\nE",
  "/usr/bin/python3 -u - <<'E'\nopen('f','a')\nE",
];

const ALLOWED = [
  "sed -n '1,20p' crates/a.rs",
  "sed -e 's/a/b/' f > /tmp/out",
  "sed 's/a/b/' f | head",
  "grep -n x f | sed -n '3p'",
  "perl -ne 'print if /x/i' f",
  "perl -MJSON::PP -e 'print 1' ",
  "perl -le 'print 1'",
  "python3 script.py arg",
  "python3 /tmp/rewrite.py",
  "python3 - <<'E'\nimport json\nprint(json.load(open('f')))\nE",
  "python3 -c \"print(open('f').read())\"",
  "cargo test && echo ok",
  "pip install sed-i",
  "python3 -m pytest -k write_text",
  "python3 -u script.py && echo '.write_text('",
  "python3 -c 'print(1)' && rg 'write_text\\('",
  "sed -E 's/i/j/g' f > out",
  "perl -Ilib script.pl",
];

describe("in-place rewrites by subagents", () => {
  test.each(REFUSED)("refused: %s", command => {
    expect(sub(command)).toBe("refuse");
  });

  test.each(ALLOWED)("allowed: %s", command => {
    expect(sub(command)).toBe("allow");
  });

  test("the main agent's commands are not judged", () => {
    for (const command of REFUSED) expect(main(command)).toBe("allow");
  });

  test("the reason names the edit tool and the way out for a bulk rewrite", () => {
    const d = decideCommand(config.commands, "sed -i 's/a/b/' f", runner, "sub");
    expect(d.kind === "refuse" && d.reason).toContain("edit tool");
    expect(d.kind === "refuse" && d.reason).toContain("script");
  });

  test("a script run from a short command is the way out", () => {
    expect(sub("python3 /tmp/lightcraft-scratch/rewrite.py crates/a.rs")).toBe("allow");
    expect(sub("bash /tmp/rewrite.sh")).toBe("allow");
  });

  test("limit: the rules read command text, so a command that only names sed -i is refused too", () => {
    expect(sub("echo sed -i is refused")).toBe("refuse");
  });

  test("a hostile line under the length cap is judged within a bound, each shape alone", () => {
    const lines = [
      "python3 -c open(,, ".repeat(1700),
      "python3 -c open(a(b(c,".repeat(1400),
      "python3 - ".repeat(3000),
      "python3 -c ".repeat(2900),
      "python3 -W a ".repeat(2400),
      "python -<<".repeat(3200),
      "python -u -<<".repeat(2400),
      `python ${"-/python ".repeat(3600)}`,
      `sed ${"-/sed ".repeat(5400)}`,
      `perl ${"-/perl ".repeat(4000)}`,
      `python3 - <<'E'\n${"x = open('f')\n".repeat(2200)}E`,
      `sed ${"-n ".repeat(10_000)}`,
      "gsed ".repeat(6000),
    ];
    for (const line of lines) {
      expect(line.length).toBeLessThan(MAX_CHECKED_COMMAND);
      const started = performance.now();
      sub(line);
      // each takes a few milliseconds to a few hundred on a loaded machine; the unbounded rules took tens of seconds
      expect(performance.now() - started).toBeLessThan(1500);
    }
  });
});
