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

A command matching a `refuse` rule is refused with the rule's reason.
