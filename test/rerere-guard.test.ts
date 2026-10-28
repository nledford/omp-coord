import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";
import { decideCommand, MAX_CHECKED_COMMAND } from "../src/domain/commands.ts";

// The rerere rules shipped in examples/omp-coord.json, loaded the way a project's own file is.
const config = loadConfig(new URL("../examples/omp-coord.json", import.meta.url).pathname);
const runner = { argv: ["/usr/local/bin/bun", "/opt/omp-coord/src/cli.ts"], owner: "s1", config: "/w/.omp-coord.json" };
const decide = (command: string) => decideCommand(config.commands, command, runner);

const REFUSED = [
  "rm -rf .git/rr-cache",
  "rm -rf /work/repo/.git/rr-cache/*",
  'rm -rf "$(git rev-parse --git-common-dir)/rr-cache"',
  "rm -rf $(git rev-parse --git-common-dir)/rr-cache",
  'git -C /work/repo rev-parse --git-common-dir && rm -rf "$(git rev-parse --git-common-dir)"/rr-cache',
  "find .git/rr-cache -type f -mmin -40 -delete",
  "find .git -name rr-cache -exec rm -rf {} +",
  "cd .git/rr-cache && rm -rf *",
  "cd .git && rm -rf rr-cache",
  "sudo /bin/rm -r /work/repo/.git/rr-cache",
  "git clean -fdx .git/rr-cache",
  "git rerere clear",
  "git rerere forget src/lib.rs",
  "git rerere gc",
  "git -C /work/repo rerere gc",
  "git -c rerere.enabled=false rerere clear",
  "cargo build && git rerere clear",
  "rm -rf /tmpfoo/rr-cache",
  "git -C /tmp/x status; rm -rf .git/rr-cache",
  "rm -rf .git/rr-cache; git -C /tmp/x status",
  "git -C /tmp/x status && git rerere clear",
  "GIT_DIR=/tmp/scratch/.git git status; git rerere clear",
  "tar -C /tmp/extract -xzf a.tgz && rm -rf .git/rr-cache",
  "make -C /tmp/build && git rerere gc",
  "echo .git/rr-cache | xargs rm -rf",
  "rm -rf .git/rr-cache && bun test",
  "bun test && git rerere clear",
  "npm run build && rm -rf .git/rr-cache",
  "sh -c 'git rerere clear'",
  "git --no-pager rerere gc",
  'git -C "/work/my repo" rerere gc',
  "rm -r -f -- .git/rr-cache",
  "find . -path '*rr-cache*' -delete",
  'cd "$(git rev-parse --git-common-dir)/rr-cache" && rm -rf *',
  "cd $(git rev-parse --git-common-dir)/rr-cache && rm -rf *",
  'cd "$(git rev-parse --git-common-dir)"/rr-cache && rm -rf *',
  "(cd .git/rr-cache && rm -rf *)",
  'sh -c "cd .git/rr-cache && rm -rf *"',
  "git ls-files -u | xargs git rerere forget",
  "for f in a b; do git rerere forget $f; done",
  "if true; then git rerere clear; fi",
  "{ git rerere clear; }",
  "echo `git rerere clear`",
  "/usr/bin/git rerere clear",
  "timeout 10 git rerere gc",
  "env -i git rerere clear",
  "git ".concat("-c ".repeat(50), "status; git rerere clear"),
  'git -c "user.name=A B" rerere gc',
  "git rerere clear GIT_DIR=/tmp/x",
  "rm -rf /tmp/../Users/me/repo/.git/rr-cache",
  "cd /tmp/../work/.git/rr-cache && rm -rf *",
  "cd .git/rr-cache\nrm -rf *",
  'cd "$(git rev-parse --git-path rr-cache)"\nrm -rf -- *',
  "cd .git/rr-cache && \\\n  rm -rf *",
  "cd -- .git/rr-cache && rm -rf *",
  "pushd .git/rr-cache && rm -rf *",
  "cd .git/rr-cache && command rm -rf *",
  "cd .git/rr-cache && \\rm -rf *",
  'git -c "a" '.repeat(30) + "status; git rerere clear",
  "git clean ".repeat(500) + "; rm -rf .git/rr-cache",
  "rm=/tmp/".repeat(625) + " .git/rr-cache",
  "pushd .git/rr-cache >/dev/null && rm -rf *",
  "cd .git/rr-cache 2>/dev/null && rm -rf *",
  "cd .git/rr-cache &>/dev/null && rm -rf *",
  "(cd .git/rr-cache || exit; rm -rf *)",
  "cd .git/rr-cache || exit 1\nrm -rf *",
  'git -c user.name="A B" rerere clear',
  'git -C /work/"my repo" rerere gc',
  "sudo -E git rerere clear",
  "timeout --foreground 10 git rerere gc",
  "nice git rerere clear",
  "if ! git rerere clear; then :; fi",
  "while git rerere gc; do :; done",
  "git rerere --no-rerere-autoupdate clear",
  "git \\\n  rerere clear",
  "a=\n".repeat(10000) + "true; git rerere clear",
  "a=\n".repeat(10900) + "true; git rerere clear",
  "echo " + "a".repeat(MAX_CHECKED_COMMAND) + "; git rerere clear",
  "git -c (".repeat(4000) + "; git rerere clear",
  "git rerere" + " ".repeat(32700) + "clear",
  "git -c x" + "''".repeat(16300) + "; git rerere clear",
  "git --work-tree=.git/rr-cache clean -fdx",
  "git --work-tree .git/rr-cache clean -fdx",
  'git --work-tree="$(git rev-parse --git-common-dir)/rr-cache" clean -fdx',
  "git -C $(git rev-parse --show-toplevel) rerere clear",
  "git --git-dir=$(git rev-parse --git-common-dir) rerere gc",
  "git -C `git rev-parse --show-toplevel` rerere clear",
  "nice -n 10 git rerere gc",
  "timeout -s KILL 60 git rerere gc",
  "timeout -k 5 60 git rerere gc",
  "git " + "-c\\\\".repeat(20) + "x; git rerere clear",
  "git " + "-C\\\\".repeat(20) + "status; git rerere clear",
  "git " + "-c a=b\\\n".repeat(30) + "x; git rerere clear",
  "git -c " + "\\".repeat(5000) + "; git rerere clear",
  "git -C /work/my\\ repo rerere gc",
  "git -c user.name=A\\ B rerere clear",
  "rm -rf \\\n  .git/rr-cache",
  "find .git/rr-cache \\\n  -type f -delete",
  "cd .git/rr-cache \\\n  && rm -rf *",
  "(git -C /tmp/".repeat(2400) + "; git rerere clear",
  "git -C /tmp/x ".repeat(2300) + "; git rerere clear",
  "cd .git/rr-cache && " + "\\".repeat(32000) + "; rm -rf .git/rr-cache",
  "cd rr-cache>" + ("1".repeat(80) + ">").repeat(6) + "x x; rm -rf .git/rr-cache",
  "cd .git/rr-cache 2>&1 && rm -rf *",
  "GIT_DIR=$(git rev-parse --git-dir) git rerere clear",
  'GIT_EDITOR="code --wait" git rerere forget a.rs',
  "GIT_PAGER='less -R' git rerere gc",
  'env GIT_EDITOR="code --wait" git rerere clear',
];

const ALLOWED = [
  "ls .git/rr-cache",
  "cat .git/rr-cache/*/postimage",
  "du -sh .git/rr-cache",
  "git rerere status",
  "git rerere diff",
  "git rerere remaining",
  "git -c rerere.enabled=false rebase origin/main",
  "rm -rf target",
  "ls .git/rr-cache; rm -rf target",
  "rm -rf /tmp/scratch/repo/.git/rr-cache",
  "rm -rf /private/tmp/x/.git/rr-cache",
  "rm -rf /var/folders/ab/cd/T/x/.git/rr-cache",
  'rm -rf "$TMPDIR/x/.git/rr-cache"',
  "GIT_DIR=/tmp/scratch/.git git rerere clear",
  "git --git-dir=/tmp/scratch/.git rerere gc",
  "git --git-dir /tmp/scratch/.git rerere forget a.rs",
  "git -C /tmp/scratch rerere clear",
  "git -C /private/tmp/scratch rerere gc",
  "git clean -fd /tmp/scratch",
  "echo rerere clear is refused",
  "git commit -m 'examples: refuse git rerere clear, forget and gc'",
  "git log --grep='rerere gc'",
  "git config rerere.enabled true",
  "cd .git/rr-cache && ls && cd ../.. && rm -rf target",
  "echo 'cd .git/rr-cache' && rm -rf target",
  'rm -rf "$TMPDIR"/x/.git/rr-cache',
  'git -C "$TMPDIR"/x rerere gc',
  "git rerere",
  'cd "$TMPDIR/x/.git/rr-cache" && rm -rf *',
  "cd .git/rr-cache && ls",
  "git do rerere status",
  "echo then git log",
  "rm -rf ${TMPDIR:-/tmp}/x/.git/rr-cache",
  'git -C "${TMPDIR:-/tmp}/x" rerere clear',
  "cd .git/rr-cache\nls\nrm -rf *",
  "cd /tmp/x/.git/rr-cache\nrm -rf *",
  'GIT_DIR="/tmp/x/.git" git rerere clear',
  "GIT_DIR='/tmp/x/.git' git rerere clear",
  'GIT_DIR="$TMPDIR/x/.git" git rerere gc',
  'env GIT_DIR="/tmp/x/.git" git rerere clear',
  'GIT_DIR=/tmp/x/.git GIT_WORK_TREE="/tmp/x" git rerere clear',
  "git --work-tree=.git/rr-cache status",
  'GIT_DIR="/tmp/my x/.git" git rerere clear',
];

describe("rerere cache rules in the example config", () => {
  for (const command of REFUSED) {
    test(`refuses: ${command}`, () => {
      const decision = decide(command);
      expect(decision.kind).toBe("refuse");
      if (decision.kind === "refuse" && command.length <= MAX_CHECKED_COMMAND) {
        expect(decision.reason).toContain("rerere.enabled=false");
        expect(decision.reason).toContain("every worktree");
      }
    });
  }
  for (const command of ALLOWED) {
    test(`allows: ${command}`, () => {
      expect(decide(command)).toEqual({ kind: "allow" });
    });
  }
});

describe("documented limits of the rerere rules", () => {
  test("a path that does not spell rr-cache, or a cd in an earlier call, gets through", () => {
    expect(decide("rm -rf .git/rr-*").kind).toBe("allow");
    expect(decide('rm -rf "$CACHE"').kind).toBe("allow");
    expect(decide("rm -rf *").kind).toBe("allow");
    expect(decide("mv .git/rr-cache /tmp/old-rr").kind).toBe("allow");
  });
  test("an unrelated verb in the same segment as rr-cache is refused", () => {
    expect(decide("grep rm .git/rr-cache/x/preimage").kind).toBe("refuse");
    expect(decide("ls .git/rr-cache | grep rm").kind).toBe("refuse");
  });
  test("a throwaway repository is recognized by the command's own segment, not an earlier cd or export", () => {
    expect(decide("cd /tmp/scratch && git rerere clear").kind).toBe("refuse");
    expect(decide("export GIT_DIR=/tmp/scratch/.git; git rerere clear").kind).toBe("refuse");
  });
});

describe("rerere rules cost", () => {
  test("a long command is judged in well under a second", () => {
    const commands = [
      `ls ${"/rm".repeat(1667)}`,
      `just control 18010 engine.execute '[${'{"op":"rm","path":"photos/p0.jpg"},'.repeat(150)}]'`,
      `echo ${"A".repeat(20000)} | base64 -d`,
      `cd ${"a/".repeat(15000)}`,
      `rm ${"a".repeat(5000)}`,
      `cd ${"a/".repeat(2500)}`,
      `git ${"-c a=b ".repeat(700)}status`,
      `git ${"-c ".repeat(5000)}status; git rerere clear`,
      "(rr-cache".repeat(2222),
      `rm ${"(".repeat(20000)}`,
      `rm ${"=".repeat(20000)}`,
      `cd ${"$(".repeat(5000)}`,
      `rm ${"'".repeat(20000)}`,
      `${"git clean ".repeat(2000)}`,
      `${"rm=/tmp/".repeat(2500)}`,
      "\n".repeat(20000),
      `git ${'-c "a" '.repeat(2000)}status`,
    ];
    for (const command of commands) {
      const started = performance.now();
      decide(command);
      expect(performance.now() - started).toBeLessThan(500);
      // A stall must not turn into a wrong "no match": the same prefix, then a real offense, is still refused.
      expect(decide(`${command}; git rerere clear`).kind).toBe("refuse");
      expect(decide(`${command}; rm -rf .git/rr-cache`).kind).toBe("refuse");
    }
  });
});
