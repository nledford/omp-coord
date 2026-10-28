# Build and test queues

`omp-coord run <queue> -- <command>` waits for one of the queue's slots, shared by everything on this machine in the same scope, then runs the command. `just` recipes, scripts and terminals call it; agents' matching bash commands are rewritten to go through it. Queues are set under `queues` in the [configuration](configuration.md).

```sh
omp-coord run <queue> [--lane L] [--priority N] [--key K] [--owner SESSION] [--timeout 90m] -- <command> [args…]
```

## Running a job

`run` waits for a slot of `<queue>`, runs the command with the terminal's input and output, and exits with the command's exit code. Ctrl-C while waiting leaves the line; while running, it is passed to the command.

The command runs in its own process group and session, so a time limit stops everything it started: SIGTERM to the group, then SIGKILL to whatever is left 10 seconds later. The command has no controlling terminal: it reads and writes the terminal through its input and output, but prompts that open `/dev/tty` (sudo, ssh or gpg passphrases, git credential prompts) fail, and Ctrl-Z stops only the runner.

- **Exit codes**: the command's own, `75` when the job was not run (a refused or superseded duplicate), `124` when its time limit stopped it, `2` for a usage or configuration error.
- **Owner**: jobs belong to the omp session in `OMP_COORD_SESSION` (set by the extension, so commands an agent runs inherit it) or `--owner`; otherwise to no session ("outside omp").
- **Duplicates**: jobs with the same `--key` (for example `"<checkout> ci"`) are duplicates. One that duplicates a running job is refused; one that duplicates a waiting job is refused or, with `onDuplicate: "supersede"`, replaces it in its place in line.

## Order

Per queue:

- `fifo`: oldest first.
- `fair-share`: owners take turns (the one served longest ago goes next), and within one owner higher `priority` goes first, so priority never lets a session jump another.
- `priority`: higher priority first across everyone.

With `agingMinutes`, each that many minutes of waiting adds 1 to a job's priority, so no job waits forever behind others *in its lane*.

**Lanes**: `--lane` picks one of the queue's `lanes`; earlier lanes go first. Without it, the job goes in the last lane. Lanes are strict: steady front-lane traffic keeps the normal lane waiting.

Agents reorder their own session's waiting jobs with `coord_job_priority`. Priorities run from -1,000,000 to 1,000,000. While the load average is above a queue's `loadSlots` threshold, fewer jobs start.

## Nested runs

The running command gets `OMP_COORD_JOB` (its job id) and `OMP_COORD_QUEUE`. An `omp-coord run` on the same queue from inside that command runs at once, since it already holds that queue's slot (otherwise a one-slot queue would wait for itself). It stays in the outer job's process group, so the outer time limit stops it too. So a script can queue itself:

```sh
# At the top of a script that needs a heavy slot: re-run this script inside one.
[ "${OMP_COORD_QUEUE:-}" = heavy ] || exec omp-coord run heavy --key "$PWD ci" -- "$0" "$@"
```

## When runners die

A runner that dies (crash, `kill -9`) loses its slot within about 10 seconds: every runner listens on a Unix socket, and the others drop jobs whose socket stops answering. The command it started is not stopped: after `kill -9` of the runner it keeps running outside the queue. Stop runners with Ctrl-C or `kill` (SIGTERM), which pass the signal on.

A command that puts its work in the background (`cargo test &`) holds the slot only until the shell exits, so the background work runs unqueued.

## Agents' commands

When an agent's bash command matches a `queue` rule under `commands`, the extension rewrites it to run `omp-coord run <queue> --owner <session> -- sh -c '<command>'` with omp's own binary as Bun (`BUN_BE_BUN=1`), so it needs no separate Bun install. The waiting happens inside the bash call, which counts against the bash tool's timeout: agents should run long jobs as background (`async`) bash calls. The rewritten command runs in `sh`, so shell variables the agent set earlier without exporting them are not visible to it.

`omp-coord run` records the agent whose command it is on each job, so queue lines read `session A/WaveImport` instead of only `session A`. omp (18.12.4 or later) gives every bash call the id of its agent's conversation (`PI_SESSION_ID`), and the extension records on the board which agent that is, so the command text is never touched: queue rules, omp's `bash.patterns` rules and other extensions' rewrites see exactly what the agent wrote. A script can name the agent itself with `OMP_COORD_AGENT`.

A command matching a `refuse` rule is refused with the rule's reason. While any `refuse` rule is configured, a command longer than 32,768 characters is refused too, with a message that says so (create the file with the write tool and run it from a short command): the check runs inside omp's `tool_call` handler, which omp gives 30 seconds and fails closed, and a regex that runs out of its backtracking budget answers "no match", so a very long line could otherwise stall the session or slip past a rule. Configs without a `refuse` rule are not affected.

### Example: protecting git's rerere cache

`examples/omp-coord.json` carries two `refuse` rules (copy them into your `.omp-coord.json`; nothing is refused unless a rule is in the file) for a cache that every worktree of a repository shares: `<git-common-dir>/rr-cache`, where `git rerere` keeps recorded conflict resolutions. A command that deletes entries from it takes away resolutions other sessions' agents recorded, and their next rebase hits the same conflicts again. Rules are first-match-wins, so list them before any `queue` rule: a command that matches both (`rm -rf .git/rr-cache && bun test`) is queued, not refused, when the `queue` rule comes first.

- **Refused**: `rm`, `rmdir`, `unlink`, `trash`, `shred`, `find … -delete` and `git clean` (also `git --work-tree=<path> clean`) in a command line (up to the next `;`, `&` or newline, a backslash-newline continuing the line, so also `… | xargs rm`) that names a path containing `rr-cache` (`.git/rr-cache`, `"$(git rev-parse --git-common-dir)/rr-cache"`); the same delete as the very next command after `cd` into such a path (`cd .git/rr-cache && rm -rf *`, also `cd -- …`, `pushd`, a delete on the next line, also `cd "$(git rev-parse --git-common-dir)/rr-cache"` and inside `( … )` or `sh -c "…"`); and `git rerere clear`, `forget` and `gc`, with up to 64 `git` global options before `rerere` (values may be quoted, escaped or `$(…)`, up to 4,096 characters each), after `sudo`, `env`, `xargs`, `timeout [-s SIG] [-k D] N` (`sudo`, `env`, `xargs` and `time` with short flags that take no value, so `sudo -u me git …`, `xargs -I{} git …` and `env -u X git …` get through), `nice` (and `nice -n 10`), `!`, `if`, `while`, `until`, `elif`, `do`, `then`, `else`, `{`, a pipe or `;`, and with `git` given by path (`/usr/bin/git`). The reason names the alternative: run the throwaway command with `git -c rerere.enabled=false …`, so its resolutions never reach the shared cache.
- **Not refused**: reading the cache (`ls`, `cat`, `du`), `git rerere status`, `diff` and `remaining`, and anything aimed at a throwaway repository under `/tmp`, `/private/tmp`, `/var/folders` or `$TMPDIR` (also `${TMPDIR:-/tmp}`): an `rr-cache` path that starts there (and has no `..` after it), or, for `git rerere`, a `GIT_DIR=`, `--git-dir` or `git -C` that points there in the same command (between `;`, `&`, `|` or a newline) before `rerere`.

These rules match command text, like every rule here, so they stop mistakes, not a determined dodge. Limits:

- A path that does not spell `rr-cache` (`rm -rf .git/rr-*`, a variable holding the path, a script that deletes it) gets through, and so does `mv`.
- A `cd` in an earlier call, or a delete that is not the next command after the `cd`, is not seen; neither is `cd … && find . -exec rm …` (a `find … -delete` is). A redirection or `|| exit` after the `cd` is allowed for.
- Text that merely mentions the words is refused too (`git commit -m "…; git rerere gc is refused"`, a heredoc line, `git log -S"git rerere gc"`), as is a verb and `rr-cache` in the same command line even when unrelated: `grep rm .git/rr-cache` and `ls .git/rr-cache | grep rm` are refused. So is `git rerere clear` written as the start of a quoted string (`sh -c 'git rerere clear'` is meant to be caught, and so is `git commit -m 'git rerere clear'`).
- A throwaway repository is recognized only inside the one command: `cd /tmp/x && git rerere clear` and an earlier `export GIT_DIR=…` are refused (write `git -C /tmp/x rerere clear`), and so is one outside the temporary folders, because text cannot tell it from the project's own.
- Other ways to run the same thing get through. After a `cd`: `if cd …; then rm …`, `&& { rm …; }`, `&& (rm …)`, `&& nice rm …`, and a loop such as `for d in .git/rr-cache/*; do rm -rf "$d"; done`. For `git rerere`: `eval git rerere clear`, `parallel`, `stdbuf`, `find … -exec git rerere forget {} +`, `git rerere 'clear'`, `xargs` with options that take a value (`xargs -n 1`, `xargs -I{}`), `timeout --signal=KILL`, and a command inside `python -c` or `node -e`. A guard that reads command text cannot close these; it stops the usual spellings.
- A delete and the `rr-cache` path more than 2,000 characters apart in one command line are not connected; that bound, and the other limits on how far a match reaches, keep matching time small, and the 32,768-character cap above bounds it for every pattern: the tests time adversarial lines of 5 KB to 30 KB, each under half a second on a busy machine, and check that a real offense after each is still refused. A regex that runs out of its engine's backtracking budget answers "no match", which would let a command through; reviewers found such stalling lines of a few hundred bytes (since fixed), and none is known up to the cap (the tests run shapes of up to about 32 KB).
- A `GIT_DIR=` before an `sh -c "git rerere clear"` is not seen inside the quoted string, and a variable whose name merely ends in `GIT_DIR=` counts as one.
- Only the first throwaway option counts: `git -C /tmp/x -C /work/repo rerere clear` is exempt, though a later `-C` points at the project. `${TMPDIR:-<anything>}` is exempt whatever the default.
- A quoted path with a space in it (`"/tmp/my dir/.git/rr-cache"`) is judged by the part after the space.
