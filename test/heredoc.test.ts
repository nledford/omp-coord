import { describe, expect, test } from "bun:test";
import { type CommandRule, decideCommand } from "../src/domain/commands.ts";
import { blankHeredocBodies } from "../src/domain/heredoc.ts";

const rules: CommandRule[] = [
  { pattern: /(^|[;&|(\s'"`])pkill\b/, action: "refuse", reason: "stop only your own process" },
  { pattern: /(^|[;&|(\s])cargo\s+test\b/, action: "queue", queue: "test", lane: undefined },
];
const runner = { argv: ["/usr/local/bin/bun", "/opt/omp-coord/src/cli.ts"], owner: "s1", config: "/w/.omp-coord.json" };
const kind = (command: string) => decideCommand(rules, command, runner).kind;

describe("heredoc bodies are text the rules do not judge", () => {
  test.each([
    "cat <<EOF\npkill x\nEOF",
    "cat <<'EOF' > notes.md\nrun pkill foo and cargo test\nEOF",
    'cat <<"EOF" > notes.md\nthe pkill rule\nEOF',
    "cat <<\\EOF > notes.md\nthe pkill rule\nEOF",
    "cat <<-EOF\n\tpkill x\n\tEOF",
    "cat <<-'EOF'\n\tpkill x\n\t\tEOF\n",
    "tee notes.md <<'EOF'\npkill x\nEOF",
    "git commit -F - <<'EOF'\nStop calling pkill\n\nEOF is not the end here\nEOF",
    "git -C /w/wt commit -F - <<'EOF'\nfix pkill\nEOF",
    "gh pr create --title t --body-file - <<'EOF'\nthe pkill rule\nEOF",
    "cat <<EOF\nplain text, $HOME and pkill\nEOF",
    "cat <<'A' > a.md\npkill\nA\ncat <<'B' > b.md\npkill\nB",
    "echo start\ncat <<'EOF' > n.md\npkill x\nEOF",
    "cat <<'EOF'\n$(pkill x) and `pkill y` stay text when the delimiter is quoted\nEOF",
    "cat << 'EOF'\npkill x\nEOF",
    "cat <<EOF>n.md\npkill x\nEOF",
    "cat <<< 'x'\ncat <<'EOF'\npkill x\nEOF",
    "git tag -a v1 -F - <<'EOF'\npkill x\nEOF",
    "git merge --no-edit topic -F - <<'EOF'\npkill x\nEOF",
    "git commit --file=- <<'EOF'\npkill x\nEOF",
    "git commit --file - <<'EOF'\npkill x\nEOF",
    "git notes add -F - <<'EOF'\npkill x\nEOF",
    "gh issue comment 7 --body-file - <<'EOF'\npkill x\nEOF",
  ])("allowed: %j", command => {
    expect(kind(command)).toBe("allow");
  });

  test("a body that names a queued command is not queued", () => {
    expect(kind("cat <<'EOF' > n.md\nrun cargo test here\nEOF")).toBe("allow");
    expect(kind("cargo test\ncat <<'EOF' > n.md\nx\nEOF")).toBe("queue");
  });
});

describe("everything but a heredoc body is judged as written", () => {
  test.each([
    ["the command before the heredoc", "pkill x\ncat <<EOF\nhi\nEOF"],
    ["the command on the << line", "cat <<'EOF' > n.md; pkill x\nhi\nEOF"],
    ["a command substitution on the << line", "cat <<'EOF' $(pkill x)\nhi\nEOF"],
    ["a backtick substitution on the << line", "cat <<'EOF' `pkill x`\nhi\nEOF"],
    ["a command after the delimiter", "cat <<'EOF' > n.md\nhi\nEOF\npkill x"],
    ["a command after the delimiter, same logic with &&", "cat <<'EOF' > n.md\nhi\nEOF\ntrue && pkill x"],
    ["sh -c", "sh -c 'pkill x'"],
    ["sh -c with a heredoc inside it", "sh -c 'cat <<EOF\npkill x\nEOF\n'"],
    ["a heredoc a shell reads", "bash <<EOF\npkill x\nEOF"],
    ["a heredoc a pipe feeds to a shell", "cat <<'EOF' | sh\npkill x\nEOF"],
    ["a heredoc an interpreter reads", "python3 - <<'EOF'\nimport os; os.system('pkill x')\nEOF"],
    ["a delimiter with trailing blanks is no delimiter", "cat <<'EOF' > n.md\npkill x\nEOF \nhi\n"],
    ["an unterminated heredoc", "cat <<'EOF' > n.md\npkill x"],
    ["a here-string", 'cat <<< "pkill x"'],
    ["<< inside quotes", 'echo "<<EOF"\npkill x\nEOF'],
    ["two heredocs on one line", "cat <<'A' <<'B'\npkill\nA\nhi\nB"],
    ["an unquoted delimiter whose body substitutes a command", "cat <<EOF\n$(pkill x)\nEOF"],
    ["an unquoted delimiter whose body has backticks", "cat <<EOF\n`pkill x`\nEOF"],
    ["an unquoted delimiter whose body expands a parameter", `cat <<EOF\n\${HOME} pkill x\nEOF`],
    ["a heredoc after an open quote", "echo 'a\ncat <<'EOF'\npkill x\nEOF"],
    ["a heredoc after $'…'", "echo $'a\\'b'\ncat <<'EOF'\npkill x\nEOF"],
    ["a heredoc after a backtick substitution", "echo `true`\ncat <<'EOF'\npkill x\nEOF"],
    ["a heredoc after a comment", "true # it's\ncat <<'EOF'\npkill x\nEOF"],
    ["a heredoc after a continued line", "echo a \\\ncat <<'EOF'\npkill x\nEOF"],
    ["a heredoc fed through a wrapper", "env cat <<'EOF'\npkill x\nEOF"],
    ["a heredoc on a line with a pipe", "cat <<'EOF' | tee n.md\npkill x\nEOF"],
    ["a git subcommand that is not a message or patch", "git bisect run sh <<'EOF'\npkill x\nEOF"],
    ["a bare delimiter whose body joins lines into the delimiter", "cat <<EOF\nE\\\nOF\npkill x\nEOF"],
    ["a bare delimiter whose body joins lines into a substitution", "cat <<EOF\n$\\\n(pkill x)\nEOF"],
    ["git told to edit the message it read", "git commit -e -F - <<'EOF'\npkill x\nEOF"],
    ["git told to edit, in a cluster of flags", "git commit -ae -F - <<'EOF'\npkill x\nEOF"],
    ["git told to edit, spelled out", "git commit --edit -F - <<'EOF'\npkill x\nEOF"],
    ["git told which editor", "git tag -a --editor=sh -F - <<'EOF'\npkill x\nEOF"],
    ["git with a setting that can run the message", "git -c core.editor=sh commit -e -F - <<'EOF'\npkill x\nEOF"],
    ["git with any -c setting", "git -c core.editor=sh commit -F - <<'EOF'\npkill x\nEOF"],
    ["a second heredoc inside the first one's body", "cat <<'A' > a\ncat <<'B'\nA\npkill x\nB"],
    ["a delimiter word glued to more text", "cat <<'EOF'x\npkill x\nEOF"],
    ["a delimiter that is a variable", "cat <<$X\npkill x\n$X"],
    ["git commit that reads no message from stdin", "git commit <<'EOF'\npkill x\nEOF"],
    ["git tag that reads no message from stdin", "git tag -a v1 <<'EOF'\npkill x\nEOF"],
    ["git merge that reads no message from stdin", "git merge topic <<'EOF'\npkill x\nEOF"],
    ["git notes that reads no message from stdin", "git notes add <<'EOF'\npkill x\nEOF"],
    ["git commit with the message on the line", "git commit -m x <<'EOF'\npkill x\nEOF"],
    ["git commit reading the message from a file", "git commit -F msg.txt <<'EOF'\npkill x\nEOF"],
    ["git commit whose -F value only starts with a dash", "git commit -F -x <<'EOF'\npkill x\nEOF"],
    ["git am, which has no message option", "git am <<'EOF'\n+ pkill x\nEOF"],
    ["git apply, which has no message option", "git apply <<'EOF'\n+ pkill x\nEOF"],
    ["git told to edit, by an abbreviation", "git commit --ed -F - <<'EOF'\npkill x\nEOF"],
    ["git told to edit, by a shorter abbreviation", "git commit --e -F - <<'EOF'\npkill x\nEOF"],
    ["git told to edit, with the message attached", "git commit -eF- <<'EOF'\npkill x\nEOF"],
    ["git told to edit, after the message", "git tag -a -F - -e <<'EOF'\npkill x\nEOF"],
    [
      "a heredoc the first one's body only looks like (a live body is still skipped whole)",
      "cat <<A\ncat <<'B'\n$(x)\nA\npkill x\nB",
    ],
    ["a command right after an empty heredoc", "cat <<'A'\nA\npkill x\nA"],
  ])("refused: %s", (_name, command) => {
    expect(kind(command)).toBe("refuse");
  });

  test("a later command is judged even when an earlier heredoc was blanked", () => {
    expect(kind("cat <<'A' > a.md\npkill\nA\nbash <<'B'\npkill\nB")).toBe("refuse");
  });
});

describe("blankHeredocBodies", () => {
  test("blanks the body, keeps its length and line breaks, and leaves the delimiter line and the rest", () => {
    const command = "cat <<'EOF' > n.md\nab\ncd\nEOF\necho after";
    expect(blankHeredocBodies(command)).toBe("cat <<'EOF' > n.md\n__\n__\nEOF\necho after");
  });

  test("returns a command without a heredoc as it is", () => {
    expect(blankHeredocBodies("echo hi")).toBe("echo hi");
    expect(blankHeredocBodies("")).toBe("");
  });

  test("a <<- delimiter may be indented with tabs, a << delimiter may not", () => {
    expect(blankHeredocBodies("cat <<-'E'\n\tx\n\tE")).toBe("cat <<-'E'\n__\n\tE");
    expect(blankHeredocBodies("cat <<'E'\nx\n\tE\ny\nE")).toBe("cat <<'E'\n_\n__\n_\nE");
  });

  test("a command it cannot read with certainty comes back unchanged", () => {
    for (const command of ["cat <<'EOF'\nx", "cat <<EOF\n$(x)\nEOF", "echo 'a\ncat <<'E'\nx\nE", "cat <<'E'\r\nx\r\nE"])
      expect(blankHeredocBodies(command)).toBe(command);
  });
});

describe("a << line that is more than one simple command leaves its body judged", () => {
  // the body is what trips the rule, so these fail unless the line itself was what kept the body visible
  test.each([
    "; true",
    " && true",
    " | cat",
    " & true",
    " $(true)",
    " `true`",
    " # comment",
    " (true)",
    " { true",
    " !x",
    " \\x",
    " <(true)",
    " <in.txt",
  ])("cat <<'EOF' > n.md%s", suffix => {
    expect(kind(`cat <<'EOF' > n.md${suffix}\npkill x\nEOF`)).toBe("refuse");
  });

  test("a file full of empty heredocs is read in linear time", () => {
    const command = "cat <<A\nA\n".repeat(60_000);
    const started = performance.now();
    blankHeredocBodies(command);
    expect(performance.now() - started).toBeLessThan(1500);
  });
});
