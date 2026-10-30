import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Coordinator } from "../src/app/coordinator.ts";
import { parseConfig } from "../src/config.ts";
import { type CommandRule, decideCommand } from "../src/domain/commands.ts";
import {
  canonicalWith,
  decideWrite,
  type GuardFacts,
  gitChange,
  resolveCwd,
  type WriteGuard,
  writeTargets,
} from "../src/domain/protect.ts";
import { FakeClock, FakeLiveness, MemoryRepository } from "./support/fakes.ts";

const targets = (tool: string, input: Record<string, unknown>) => writeTargets(tool, input) ?? [];

describe("what a file tool call would change", () => {
  test("edit: every [path#tag] header and every MV destination, as written and cleaned, not the payload", () => {
    const input = [
      "[crates/a.rs#1A2B]",
      "PUT 3.=4:",
      "+[not/a/header]",
      "[/abs/b.rs#00FF]",
      "REM",
      "[docs/c.md]",
      "MV /abs/d.md",
      "  MV relative.md",
    ].join("\n");
    const got = targets("edit", { input });
    for (const want of ["crates/a.rs", "/abs/b.rs", "docs/c.md", "/abs/d.md", "relative.md"])
      expect(got).toContain(want);
    expect(got).not.toContain("not/a/header");
    // the raw form of a header carries its tag: it is judged too
    expect(got).toContain("crates/a.rs#1A2B");
  });

  test("edit: a path with ] in it, a quoted path and a copied wrapper are read as omp reads them, and as written", () => {
    expect(targets("edit", { input: "[src/routes/[slug]/+page.svelte#1A2B]\nREM" })).toContain(
      "src/routes/[slug]/+page.svelte",
    );
    expect(targets("edit", { input: '["/abs/a b.rs"#1A2B]\nREM' })).toContain("/abs/a b.rs");
    expect(targets("edit", { input: "[Update File: /abs/a.rs#1A2B]\nREM" })).toContain("/abs/a.rs");
    expect(targets("edit", { input: "[*** Update File: /abs/a.rs#1A2B]\nREM" })).toContain("/abs/a.rs");
    expect(targets("edit", { input: 'MV "/abs/new name.md"' })).toContain("/abs/new name.md");
    expect(targets("edit", { input: "MV @/abs/b.md" })).toContain("/abs/b.md");
    expect(targets("write", { path: "[/abs/a.rs#1A2B]", content: "x" })).toContain("/abs/a.rs");
    expect(targets("write", { path: '"/abs/a.rs"', content: "x" })).toContain('"/abs/a.rs"');
  });

  test("edit: replace mode, patch-mode rename, apply_patch and sloppy lines in any case or indent", () => {
    expect(targets("edit", { path: "crates/a.rs", old_string: "a", new_string: "b" })).toContain("crates/a.rs");
    expect(
      targets("edit", { path: "/abs/a.rs", edits: [{ op: "update", rename: "crates/b.rs", diff: "@@" }] }),
    ).toContain("crates/b.rs");
    const patch = [
      "*** Begin Patch",
      "*** Update File: crates/a.rs",
      "*** Move to: crates/b.rs",
      "  *** Add File: docs/c.md",
      "*** delete file docs/d.md",
      "*** End Patch",
    ].join("\n");
    for (const tool of ["apply_patch", "edit"])
      for (const want of ["crates/a.rs", "crates/b.rs", "docs/c.md", "docs/d.md"])
        expect(targets(tool, { input: patch })).toContain(want);
    for (const line of ["*** Edit File: e.rs", "***   edit   file e.rs", " *** Edit File e.rs all"])
      expect(targets("edit", { input: `${line}\n@@\n-a\n+b` })).toContain("e.rs");
  });

  test("write: its path; an internal URL is no file", () => {
    expect(targets("write", { path: "crates/a.rs", content: "x" })).toContain("crates/a.rs");
    expect(targets("write", { path: "local://notes.md", content: "x" })).toEqual([]);
  });

  test("write to xd://<tool>, in any case, is judged as that tool's arguments", () => {
    const content = JSON.stringify({ input: "[crates/a.rs#1A2B]\nREM" });
    expect(targets("write", { path: "xd://edit", content })).toContain("crates/a.rs");
    expect(targets("write", { path: "XD://Edit/", content })).toContain("crates/a.rs");
    const ast = JSON.stringify({ ops: [], paths: ["crates/**/*.rs", "docs/x.md"] });
    expect(targets("write", { path: "xd://ast_edit", content: ast })).toEqual(["crates/", "docs/x.md"]);
    expect(targets("write", { path: "xd://bash", content: "{}" })).toEqual([]);
    expect(targets("write", { path: "xd://edit", content: "not json" })).toEqual([]);
  });

  test("ast_edit: a glob is judged by what comes before its first wildcard; a file:// URL is a path", () => {
    expect(targets("ast_edit", { paths: ["src/**/*.ts", "*.md", "a.ts", "file:///abs/x"] })).toEqual([
      "src/",
      ".",
      "a.ts",
      "/abs/x",
    ]);
  });

  test("tools that write no files have no targets", () => {
    expect(writeTargets("read", { path: "crates/a.rs" })).toBeUndefined();
    expect(writeTargets("bash", { command: "ls" })).toBeUndefined();
    expect(writeTargets("toString", {})).toBeUndefined();
  });
});

const ROOT = "/repo";
const guard: WriteGuard = { roots: [ROOT], allow: [], agents: "sub" };
// A disk of folders: the checkout and one linked worktree below it (its own `.git`).
const facts = (over: Partial<GuardFacts> = {}): GuardFacts => ({
  cwd: ROOT,
  home: "/home/u",
  canonical: p => p,
  hasGitEntry: dir => dir === ROOT || dir === `${ROOT}/.claude/worktrees/wt`,
  ...over,
});
const decide = (target: string, g = guard, kind: "main" | "sub" = "sub", f = facts()) =>
  decideWrite(g, kind, "edit", [target], f);

describe("a write into a protected checkout", () => {
  test("a relative path resolves against omp's folder, the main checkout, and is refused with the resolved path", () => {
    const d = decide("crates/a.rs");
    expect(d.kind).toBe("refuse");
    if (d.kind !== "refuse") return;
    expect(d.reason).toContain("/repo/crates/a.rs");
    expect(d.reason).toContain("relative path");
    expect(d.reason).toContain("<your worktree>/crates/a.rs");
  });

  test("an absolute path in the checkout is refused, one in a linked worktree below it is not", () => {
    expect(decide("/repo/crates/a.rs").kind).toBe("refuse");
    expect(decide("/repo/.claude/worktrees/wt/crates/a.rs").kind).toBe("allow");
    expect(decide("/repo/.claude/worktrees/wt/deep/new/dir/a.rs").kind).toBe("allow");
    expect(decide(".claude/worktrees/wt/crates/a.rs").kind).toBe("allow");
  });

  test("a decorated path is refused when it lies in the checkout either as written or cleaned", () => {
    const judge = (tool: string, input: Record<string, unknown>) =>
      decideWrite(guard, "sub", tool, targets(tool, input), facts()).kind;
    expect(judge("edit", { input: "[/repo/.claude/worktrees/wt/a.rs#1A2B]\nREM" })).toBe("allow");
    expect(judge("edit", { input: "[Update File: crates/a.rs#1A2B]\nREM" })).toBe("refuse");
    expect(judge("write", { path: '"/repo/.claude/worktrees/wt/a.rs"', content: "x" })).toBe("refuse");
    expect(judge("write", { path: " /repo/.claude/worktrees/wt/a.rs", content: "x" })).toBe("refuse");
    expect(judge("edit", { path: "/repo/.claude/worktrees/wt/a.rs", edits: [{ rename: "crates/b.rs" }] })).toBe(
      "refuse",
    );
    expect(judge("edit", { input: "[/repo/.claude/worktrees/wt/a.rs#1A2B]\n  MV crates/b.rs" })).toBe("refuse");
  });

  test("a worktree's own folder is part of the worktree; a path that holds the checkout is not", () => {
    const ast = (paths: string[]) => decideWrite(guard, "sub", "ast_edit", targets("ast_edit", { paths }), facts());
    expect(ast(["/repo/.claude/worktrees/wt"]).kind).toBe("allow");
    expect(ast(["/repo/.claude/worktrees/wt/"]).kind).toBe("allow");
    expect(ast(["/repo/.claude/worktrees/wt/**/*.rs"]).kind).toBe("allow");
    expect(ast(["/repo/.claude/worktrees/wt/crates"]).kind).toBe("allow");
    expect(ast(["/repo"]).kind).toBe("refuse");
    expect(ast(["/repo/crates/**/*.rs"]).kind).toBe("refuse");
    expect(ast([".."]).kind).toBe("refuse");
    expect(ast(["../**/*.rs"]).kind).toBe("refuse");
    expect(ast(["/"]).kind).toBe("refuse");
    expect(ast(["."]).kind).toBe("refuse");
  });

  test("the checkout's own .git is protected, a sibling folder and a similarly named one are not", () => {
    expect(decide("/repo/.git/info/exclude").kind).toBe("refuse");
    expect(decide("/repo-other/a.rs").kind).toBe("allow");
    expect(decide("/elsewhere/a.rs").kind).toBe("allow");
    expect(decide("../repo-other/a.rs").kind).toBe("allow");
  });

  test("a ~/ path and a .. path are resolved before they are judged", () => {
    expect(decide("~/x.md", guard, "sub", facts({ home: "/repo" })).kind).toBe("refuse");
    expect(decide("/repo/.claude/worktrees/wt/../../../a.rs").kind).toBe("refuse");
  });

  test("a symbolic link out of the checkout is judged by where it points, and one into it likewise", () => {
    const into = facts({ canonical: p => (p === "/elsewhere/link.md" ? "/repo/docs/link.md" : p) });
    expect(decide("/elsewhere/link.md", guard, "sub", into).kind).toBe("refuse");
    const out = facts({ canonical: p => (p === "/repo/AGENTS.local.md" ? "/tools/AGENTS.local.md" : p) });
    expect(decide("AGENTS.local.md", guard, "sub", out).kind).toBe("allow");
  });

  test("allowed folders and files stay writable; a name that only starts the same does not", () => {
    const g: WriteGuard = { roots: [ROOT], allow: ["target", "notes.md"], agents: "sub" };
    expect(decide("/repo/target/x/y.o", g).kind).toBe("allow");
    expect(decide("/repo/notes.md", g).kind).toBe("allow");
    expect(decide("/repo/targets/a.rs", g).kind).toBe("refuse");
    expect(decide("/repo/notes.md.bak", g).kind).toBe("refuse");
  });

  test("the main agent is not judged unless agents is all", () => {
    expect(decide("crates/a.rs", guard, "main").kind).toBe("allow");
    expect(decide("crates/a.rs", { ...guard, agents: "all" }, "main").kind).toBe("refuse");
  });

  test("one protected target among several refuses the whole call", () => {
    const d = decideWrite(guard, "sub", "edit", ["/repo/.claude/worktrees/wt/a.rs", "docs/b.md"], facts());
    expect(d.kind).toBe("refuse");
  });
});

describe("state-changing git in a protected checkout", () => {
  const git = (command: string, cwd = ROOT, g = guard, kind: "main" | "sub" = "sub") =>
    gitChange(g, kind, command, cwd, facts({ cwd })).kind;
  const WT = "/repo/.claude/worktrees/wt";

  test("the command that changed the main checkout on 29 Oct is refused", () => {
    expect(
      git(
        "cd /repo && git checkout -q -- . 2>/dev/null; cd .claude/worktrees/swui-pm && git checkout -- crates/a.rs && git status --short | head -3",
        WT,
      ),
    ).toBe("refuse");
  });

  test("a bash call without a cwd runs in the main checkout: every state-changing subcommand is refused there", () => {
    for (const sub of [
      "checkout -- .",
      "checkout main",
      "switch main",
      "reset --hard HEAD",
      "restore .",
      "clean -fd",
      "rebase origin/main",
      "merge x",
      "commit -m x",
      "pull",
      "cherry-pick abc",
      "revert abc",
      "am p.patch",
      "add -A",
      "rm f",
      "mv a b",
      "apply x.diff",
    ])
      expect(git(`git ${sub}`)).toBe("refuse");
  });

  test("reading commands, fetching, worktrees and pushing are allowed in the main checkout", () => {
    for (const sub of [
      "status --short",
      "diff",
      "log --oneline -3",
      "show HEAD",
      "branch -a",
      "fetch origin main:main",
      "worktree add ../x -b y",
      "worktree remove x",
      "push fork a:b",
      "rev-parse HEAD",
    ])
      expect(git(`git ${sub}`)).toBe("allow");
  });

  test("the folder follows cd, pushd, git -C and --work-tree", () => {
    expect(git("git checkout x", WT)).toBe("allow");
    expect(git(`cd ${WT} && git reset --hard`)).toBe("allow");
    expect(git(`cd ${WT}; cd /repo; git reset --hard`)).toBe("refuse");
    expect(git(`git -C ${WT} commit -m x`)).toBe("allow");
    expect(git("git -C /repo commit -m x", WT)).toBe("refuse");
    expect(git("git -C .claude/worktrees/wt commit -m x")).toBe("allow");
    expect(git("git -c a=b --no-pager -C /repo reset --hard", WT)).toBe("refuse");
    expect(git("pushd /repo && git add -A", WT)).toBe("refuse");
    expect(git("cd /tmp && git checkout x")).toBe("allow");
    expect(git("git --work-tree=/tmp/x checkout .")).toBe("allow");
    expect(git("git --work-tree /repo checkout .", "/tmp")).toBe("refuse");
    expect(git("cd ~ && git checkout x")).toBe("allow");
    expect(git("cd /repo/crates && git checkout x", WT)).toBe("refuse");
    expect(git(`cd -- ${WT} && git add -A`)).toBe("allow");
  });

  test("a folder that cannot be known is not judged, nor is anything but a git command", () => {
    expect(git("cd $W && git checkout x")).toBe("allow");
    expect(git('cd "$(mktemp -d)" && git checkout x')).toBe("allow");
    expect(git("cd - && git checkout x")).toBe("allow");
    expect(git('echo "git checkout -- ." > /tmp/note')).toBe("allow");
    expect(git("grep -n 'git reset' notes.md")).toBe("allow");
    expect(git("just ci")).toBe("allow");
  });

  test("heredoc bodies are text, not commands", () => {
    expect(git("cat > /tmp/brief.md <<'EOF'\nrun git checkout -- . in the main checkout\nEOF\ngit status")).toBe(
      "allow",
    );
    expect(git("cat <<EOF\nx\nEOF\ngit checkout y")).toBe("refuse");
  });

  test("env prefixes, absolute git paths, quotes and chains are read", () => {
    expect(git("GIT_EDITOR=true git rebase --continue")).toBe("refuse");
    expect(git("/usr/bin/git reset --hard")).toBe("refuse");
    expect(git("git 'checkout' -- .")).toBe("refuse");
    expect(git("true && git clean -fdx || echo no")).toBe("refuse");
    expect(git("(cd /repo && git checkout x)", WT)).toBe("refuse");
  });

  test("the main agent is not judged unless agents is all; allow entries and symlinks count as for files", () => {
    expect(git("git checkout x", ROOT, guard, "main")).toBe("allow");
    expect(git("git checkout x", ROOT, { ...guard, agents: "all" }, "main")).toBe("refuse");
    expect(git("git add x", "/repo/target", { ...guard, allow: ["target"] })).toBe("allow");
    const link = facts({ canonical: p => (p === "/elsewhere" ? "/repo" : p) });
    expect(gitChange(guard, "sub", "cd /elsewhere && git checkout x", WT, link).kind).toBe("refuse");
  });

  test("hostile lines under the length cap are judged within a bound and a real offense after them is found", () => {
    const lines = [
      "git ".repeat(8000),
      "<<E\n".repeat(8000),
      `git commit -m "${'a\\"b '.repeat(6000)}`,
      "'\"".repeat(15_000),
      "(".repeat(15_000),
      "cd a && ".repeat(3900),
      `git ${"-C x ".repeat(5900)}status`,
      "cat <<E\n".repeat(3900),
      "git \\".repeat(10_000),
    ];
    for (const line of lines) {
      const started = performance.now();
      git(line);
      expect(performance.now() - started).toBeLessThan(1000);
    }
    expect(git(`${"x; ".repeat(3000)}git checkout y`)).toBe("refuse");
  });

  test("text in quotes is not a command: messages, search patterns and bodies that mention git", () => {
    for (const command of [
      `git -C ${WT} commit -m "docs: explain why (git add -N is needed)"`,
      `git -C ${WT} commit -m "fix: stop agents; git checkout no longer resets"`,
      `git -C ${WT} commit -m 'guard: refuse cd x && git reset'`,
      "rg -n 'git add|git commit' docs",
      'grep -E "foo|git reset" notes.md',
      'git log --grep="a;git checkout"',
      'gh pr create --body "Run: cd x; git checkout main"',
      'echo "ok; git reset --hard"',
    ])
      expect(git(command)).toBe("allow");
    expect(git('git commit -m "a && b"; git checkout x')).toBe("refuse");
  });

  test("a cd or pushd inside a subshell or a substitution ends with it", () => {
    expect(git("(cd /repo && git fetch origin) && git rebase origin/main", WT)).toBe("allow");
    expect(git("(cd /repo; git log -1); git commit -m x", WT)).toBe("allow");
    expect(git("X=$(cd /repo && git rev-parse HEAD); git reset --hard $X", WT)).toBe("allow");
    expect(git("echo $(cd /repo; pwd) && git commit -am x", WT)).toBe("allow");
    expect(git("X=`cd /repo; pwd`; git commit -am x", WT)).toBe("allow");
    expect(git("(cd /repo/.claude/worktrees/b && git log); git checkout .")).toBe("refuse");
    expect(git("X=$(cd /repo && git reset --hard)", WT)).toBe("refuse");
    expect(git("pushd /repo >/dev/null && git log -1 && popd && git commit -m x", WT)).toBe("allow");
  });

  test("a git after if, then, do, while, ! and the wrappers with their options is found", () => {
    for (const command of [
      "if true; then git checkout .; fi",
      'for f in a b; do git checkout -- "$f"; done',
      'while read f; do git add "$f"; done < list',
      "! git checkout x",
      "sudo -u nate git checkout .",
      "env -u X FOO=1 git checkout .",
      "nice -n 5 git checkout .",
      "timeout 60 git checkout .",
      "timeout -s KILL 60 git checkout .",
      "xargs -n 1 git checkout -- < files",
      'GIT_EDITOR="code -w" git rebase -i',
      "time git reset --hard",
      "git bisect start",
    ])
      expect(git(command)).toBe("refuse");
    expect(git("git branch -D x")).toBe("allow");
  });

  test("a line break with a backslash does not hide the subcommand", () => {
    expect(git("git \\\n  checkout -- .")).toBe("refuse");
    expect(git("git -C /repo \\\n  reset --hard", WT)).toBe("refuse");
  });

  test("a folder that is unknown for a while is known again by an absolute cd or -C", () => {
    expect(git('cd "$TMPDIR"; cd /repo && git checkout .', "/tmp")).toBe("refuse");
    expect(git("cd $X; git -C /repo reset --hard", "/tmp")).toBe("refuse");
    expect(git("cd $X; git -C sub reset --hard", "/tmp")).toBe("allow");
    expect(git('cd ""; git checkout x')).toBe("refuse");
    expect(git('git -C "" checkout x')).toBe("refuse");
  });

  test("sh -c and bash -c run their text in the current folder; GIT_WORK_TREE moves the work tree", () => {
    expect(git("sh -c 'cd /repo && git checkout .'", WT)).toBe("refuse");
    expect(git('bash -c "git -C /repo checkout ."', WT)).toBe("refuse");
    expect(git("sh -c 'git checkout x'", WT)).toBe("allow");
    expect(git("GIT_WORK_TREE=/repo GIT_DIR=/repo/.git git checkout .", WT)).toBe("refuse");
    expect(git("GIT_WORK_TREE=/tmp/x git checkout .")).toBe("allow");
  });

  test("heredoc delimiters in any spelling end their bodies, and the text inside is not judged", () => {
    for (const open of ["<<'END-MSG'", "<<\\EOF", '<<"A.B"', "<<-EOF"]) {
      const name = open.replace(/^<<-?\\?['"]?|['"]$/g, "");
      const body = `git -C ${WT} commit -F - ${open}\nmessage\n\tgit reset --hard was wrong\n${open.startsWith("<<-") ? "\t" : ""}${name}\ngit status`;
      expect(git(body)).toBe("allow");
    }
    expect(git("cat <<E\nx\nE\ngit reset --hard")).toBe("refuse");
  });

  test("the tilde in a bash call's cwd is the home folder", () => {
    expect(resolveCwd("/repo", "~", "/home/u")).toBe("/home/u");
    expect(resolveCwd("/repo", "~/work/x", "/home/u")).toBe("/home/u/work/x");
    expect(resolveCwd("/repo", "crates", "/home/u")).toBe("/repo/crates");
    expect(resolveCwd("/repo", "/tmp/x", "/home/u")).toBe("/tmp/x");
  });

  test("quotes inside a double-quoted substitution are fresh: the commit-message idiom with a stray quote", () => {
    const msg = (body: string, after = "") => `git -C ${WT} commit -m "$(cat <<'EOF'\n${body}\nEOF\n)"${after}`;
    expect(git(msg('fix: 5" screens\n\nsee notes; git checkout was wrong'))).toBe("allow");
    expect(git(msg("docs: the \"agent's\" folder\n\nIt's the main checkout (git checkout -- . reset it)"))).toBe(
      "allow",
    );
    expect(git(msg("x (cd /repo && git reset)", ""), WT)).toBe("allow");
    expect(git(msg('fix: 5" screens', " && git reset --hard"))).toBe("refuse");
    expect(git(`cd "$(mktemp -d)" && git commit -m x`)).toBe("allow");
    expect(git('echo "a $(git reset --hard) b"')).toBe("refuse");
  });

  test("wrappers: -- ends their options, paths and --chdir forms are followed, xargs placeholders are unknown", () => {
    for (const command of [
      "sudo -- git -C /repo checkout .",
      "env -- git -C /repo checkout .",
      "env -C /repo -- git checkout .",
      "env --chdir=/repo git checkout .",
      "env --chdir /repo git checkout .",
      "env -C/repo git checkout .",
      "sudo --chdir=/repo git checkout .",
      "/usr/bin/env git -C /repo checkout .",
      "/usr/bin/sudo git -C /repo checkout .",
    ])
      expect(git(command, WT)).toBe("refuse");
    expect(git("ls -d x/* | xargs -I{} git -C {} pull --ff-only")).toBe("allow");
    expect(git("ls -d x/* | xargs -I % git -C % pull")).toBe("allow");
  });

  test("backticks inside double quotes are substitutions; xargs replace strings, attached wrapper values, exec -a", () => {
    expect(git('echo "`git -C /repo reset --hard`"', WT)).toBe("refuse");
    expect(git('git commit -m "x `git -C /repo checkout .` y"', WT)).toBe("refuse");
    expect(git('git -C /repo/.claude/worktrees/wt commit -m "x `date` y"')).toBe("allow");
    expect(git('echo "`cd /repo`"; git commit -m x', WT)).toBe("allow");
    expect(git("ls | xargs -I@ git -C @ pull")).toBe("allow");
    expect(git("ls | xargs -I@ git -C /repo pull", WT)).toBe("refuse");
    expect(git("ls | xargs -i git -C /repo pull", WT)).toBe("refuse");
    expect(git("ls | xargs -i git -C {} pull")).toBe("allow");
    expect(git("ls | xargs -I {} sh -c 'cd /repo && git checkout {}'", WT)).toBe("refuse");
    expect(git("ls | xargs -I {} bash -c 'git -C /repo checkout {}'", WT)).toBe("refuse");
    expect(git("ls | xargs -I {} sh -c 'git -C {} pull'")).toBe("allow");
    expect(git("sudo -D/repo git checkout .", WT)).toBe("refuse");
    expect(git("exec -a NAME git -C /repo checkout .", WT)).toBe("refuse");
  });

  test("file:// is decoded after quotes and @ are removed; localhost is dropped", () => {
    expect(targets("write", { path: '"file:///repo/a.rs"', content: "x" })).toContain("/repo/a.rs");
    expect(targets("write", { path: "@file:///repo/a.rs", content: "x" })).toContain("/repo/a.rs");
    expect(targets("write", { path: "file://localhost/repo/a.rs", content: "x" })).toContain("/repo/a.rs");
  });

  test("a null tool input does not throw", () => {
    expect(() => writeTargets("edit", null as unknown as Record<string, unknown>)).not.toThrow();
    expect(() => writeTargets("write", undefined as unknown as Record<string, unknown>)).not.toThrow();
  });

  test("a substitution is its own command list: its folder is unknown outside, its git is judged inside", () => {
    expect(git("cd $(mktemp -d) && git init -q && git commit -m x")).toBe("allow");
    expect(git("cd `mktemp -d` && git commit -m x")).toBe("allow");
    expect(git("echo $(git reset --hard)")).toBe("refuse");
    expect(git("echo `git reset --hard`")).toBe("refuse");
    expect(git('X=$(git -C /repo rev-parse HEAD); git -C "$X" log', WT)).toBe("allow");
    expect(git("git commit -m $(date)", WT)).toBe("allow");
    expect(git("git commit -m $(date)")).toBe("refuse");
  });

  test("sh -c in any spelling, env -C and sudo -D move the folder, command -p git is git", () => {
    for (const sh of ["bash -lc", "bash -ec", "sh -euc", "/bin/sh -c", "zsh -c"])
      expect(git(`${sh} 'git -C /repo checkout .'`, WT)).toBe("refuse");
    expect(git("env -C /repo git checkout .", WT)).toBe("refuse");
    expect(git("sudo -D /repo git checkout .", WT)).toBe("refuse");
    expect(git("env -C /tmp git checkout .")).toBe("allow");
    expect(git("command -p git reset --hard")).toBe("refuse");
    expect(git("command -v git")).toBe("allow");
  });

  test("a file:// path is a path", () => {
    expect(targets("write", { path: "file:///repo/crates/a.rs", content: "x" })).toContain("/repo/crates/a.rs");
    expect(
      decideWrite(guard, "sub", "write", targets("write", { path: "file:///repo/a.rs", content: "x" }), facts()).kind,
    ).toBe("refuse");
  });

  test("a refusal logs the subcommand and the folder, not the command text", () => {
    const d = gitChange(guard, "sub", "git -c http.extraheader=SECRET reset --hard", ROOT, facts());
    expect(d.kind === "refuse" && d.shown).toEqual(["git reset in /repo"]);
  });

  test("the reason names the folder and the ways to run it in a worktree", () => {
    const d = gitChange(guard, "sub", "git reset --hard", ROOT, facts());
    expect(d.kind === "refuse" && d.reason).toContain("git reset refused");
    expect(d.kind === "refuse" && d.reason).toContain("/repo");
    expect(d.kind === "refuse" && d.reason).toContain("git -C <your worktree>");
  });
});

describe("on a real disk", () => {
  const real = (p: string): string | undefined => {
    try {
      return realpathSync(p);
    } catch {
      return undefined;
    }
  };

  test("a nested worktree (.git file), a symlink and a file that does not exist yet", () => {
    const top = realpathSync(mkdtempSync(join(tmpdir(), "protect-")));
    const main = join(top, "main");
    const tools = join(top, "tools");
    mkdirSync(join(main, ".git"), { recursive: true });
    mkdirSync(join(main, ".claude/worktrees/wt/crates"), { recursive: true });
    writeFileSync(join(main, ".claude/worktrees/wt/.git"), "gitdir: elsewhere\n");
    mkdirSync(tools);
    writeFileSync(join(tools, "Justfile"), "x\n");
    symlinkSync(join(tools, "Justfile"), join(main, "Justfile"));
    const f: GuardFacts = {
      cwd: main,
      home: top,
      canonical: canonicalWith(real),
      hasGitEntry: dir => real(join(dir, ".git")) !== undefined,
    };
    const g: WriteGuard = { roots: [main], allow: [], agents: "sub" };
    const kind = (t: string) => decideWrite(g, "sub", "write", [t], f).kind;
    expect(kind("crates/new/file.rs")).toBe("refuse");
    expect(kind(join(main, ".claude/worktrees/wt/crates/new/file.rs"))).toBe("allow");
    expect(kind(join(main, ".claude/worktrees/wt"))).toBe("allow");
    expect(kind("Justfile")).toBe("allow");
    expect(kind(join(top, "main-copy/a.rs"))).toBe("allow");
    expect(gitChange(g, "sub", "git checkout x", main, f).kind).toBe("refuse");
    expect(gitChange(g, "sub", "git checkout x", join(main, ".claude/worktrees/wt/crates"), f).kind).toBe("allow");
  });
});

describe("configuration", () => {
  const parse = (protect: unknown) => parseConfig({ scope: "p", protect }, "/work/proj/.omp-coord.json");

  test("roots are relative to the config file's folder; agents defaults to subagents only", () => {
    const c = parse({ roots: [".", "/abs/other"], allow: ["./target/", "notes.md"] });
    expect(c.protect).toEqual({ roots: ["/work/proj", "/abs/other"], allow: ["target/", "notes.md"], agents: "sub" });
    expect(parseConfig({ scope: "p" }, "f").protect).toBeUndefined();
  });

  test("mistakes name the field", () => {
    expect(() => parse({})).toThrow(/protect\.roots/);
    expect(() => parse({ roots: [] })).toThrow(/protect\.roots/);
    expect(() => parse({ roots: ["."], agents: "main" })).toThrow(/protect\.agents/);
    expect(() => parse({ roots: ["."], allow: [1] })).toThrow(/protect\.allow/);
    for (const bad of ["/notes.md", ".", "..", "../x", "a/../../b", "", "a/./b", "a//b", "a\\b"])
      expect(() => parse({ roots: ["."], allow: [bad] })).toThrow(/protect\.allow\[0\]/);
  });

  test("a command rule's agents is all or sub", () => {
    const rule = (agents: unknown) => ({
      scope: "p",
      commands: [{ pattern: "x", action: "refuse", reason: "r", agents }],
    });
    expect(parseConfig(rule("sub"), "f").commands[0]?.agents).toBe("sub");
    expect(parseConfig(rule(undefined), "f").commands[0]?.agents).toBe("all");
    expect(() => parseConfig(rule("main"), "f")).toThrow(/commands\[0\]\.agents/);
  });
});

describe("command rules for subagents only", () => {
  const rules: CommandRule[] = [{ pattern: /sed -i/, action: "refuse", reason: "use edit", agents: "sub" }];
  const runner = { argv: ["/bun", "/cli.ts"], owner: "s", config: "/c" };

  test("a subagent's command is refused, the main agent's is not", () => {
    expect(decideCommand(rules, "sed -i s/a/b/ f", runner, "sub").kind).toBe("refuse");
    expect(decideCommand(rules, "sed -i s/a/b/ f", runner, "main")).toEqual({ kind: "allow" });
  });

  test("the length cap is for rules that apply to the caller", () => {
    const long = `echo ${"a".repeat(40_000)}`;
    expect(decideCommand(rules, long, runner, "sub").kind).toBe("refuse");
    expect(decideCommand(rules, long, runner, "main")).toEqual({ kind: "allow" });
  });
});

describe("the event log", () => {
  test("a refused write is recorded with the agent, the tool and the paths as written", () => {
    const repo = new MemoryRepository();
    const coordinator = new Coordinator(
      parseConfig({ scope: "t" }, "/t/.omp-coord.json"),
      repo,
      new FakeLiveness(),
      new FakeClock(5),
    );
    coordinator.join({ id: "s1", pid: 1, cwd: "/w", address: "/s/s1" });
    coordinator.recordWriteRefused("s1", "FixThing", "edit", ["crates/a.rs"]);
    const e = repo.events().at(-1);
    expect(e?.type).toBe("write_refused");
    expect(e?.sessionId).toBe("s1");
    expect(e?.data).toEqual({ agentId: "FixThing", tool: "edit", paths: ["crates/a.rs"] });
  });
});
