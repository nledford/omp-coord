# omp-coord

An [omp](https://github.com/can1357/oh-my-pi) extension, plus a small command-line runner, that lets several omp sessions on one machine, working in the same project, share one set of agent caps and build/test queues, and talk to each other.

- **Shared agent caps.** Subagents count against pools (for example 8 `work` and 2 `short` slots) shared by every session in the project. A spawn over the cap is refused through omp's `before_subagent_spawn` check, so the cap does not depend on agents remembering to take and free slots.
- **A fair line.** A refused session joins the line for that pool. When a slot frees, it is held for the session refused first (default 5 minutes) and that session is told so; other sessions' spawns are refused meanwhile.
- **Subagents start only reviewers.** A subagent may start only the agent types listed under `agents.nested.allow`, one at a time, outside the caps. Everything else is refused, so "no nested worker agents" is enforced rather than asked for.
- **Session registry.** Each session gets a letter (A, B, …) and shows `coord B · work 5/8 · short 1/2` in the footer. A session that exits or crashes leaves the board within about 10 seconds, and its slots free.
- **Messages.** `coord_send` (or `/coord send B …`) delivers a message into the other session's conversation at its next step, waking it when idle.
- **Build and test queues.** `omp-coord run <queue> -- <command>` waits for one of the queue's slots, shared by everything on this machine in the same scope, then runs the command. `just` recipes, scripts and terminals call it; agents' matching bash commands are rewritten to go through it. Queues order waiting jobs first come first served, by fair share between sessions, or by priority, in lanes (e.g. a front lane for approved work).
- **Command rules.** An agent's bash command matching a configured pattern is refused with a reason (`pkill`, raw `cargo test`…) or run through a queue.

## How slots are counted

| Event | Effect |
|---|---|
| omp's spawn check approves a subagent | It takes a slot at once (`starting`). |
| The subagent's run starts (`agent_start`) | The slot becomes `running`. |
| The subagent's run ends (`agent_end`: finished, failed or killed) | The slot frees. An idle or parked agent holds no slot. |
| An idle agent is revived (`write agent://…`) | It takes a slot again, even over the cap. omp does not run the spawn check for revivals, and running agents are never stopped; new spawns are refused until the total is under the cap. |
| An approved spawn never starts | Its slot frees after `agents.startTimeoutSeconds`. |
| A session exits or its process dies | All its slots and its place in line go. |

omp gives the spawn check 30 seconds and then lets the spawn through, so the extension never waits inside it: it refuses at once and holds the next free slot instead. If the shared board cannot be read, spawns are let through with an error notice: the cap is an agreement between sessions, not a security boundary.

## Build and test queues

```sh
omp-coord run <queue> [--lane L] [--priority N] [--key K] [--owner SESSION] -- <command> [args…]
omp-coord status
```

- `run` waits for a slot of `<queue>`, runs the command with the terminal's input and output, and exits with the command's exit code. Ctrl-C while waiting leaves the line; while running, it is passed to the command.
- **Lanes**: `--lane` picks one of the queue's `lanes`; earlier lanes go first. Without it, the job goes in the last lane.
- **Duplicates**: jobs with the same `--key` (for example `"<checkout> ci"`) are duplicates. One that duplicates a running job is refused; one that duplicates a waiting job is refused or, with `onDuplicate: "supersede"`, replaces it in its place in line.
- **Exit codes**: the command's own, `75` when the job was not run (a refused or superseded duplicate), `2` for a usage or configuration error.
- **Owner**: jobs belong to the omp session in `OMP_COORD_SESSION` (set by the extension, so commands an agent runs inherit it) or `--owner`; otherwise to no session ("outside omp").
- **Order** (per queue): `fifo`, oldest first; `fair-share`, owners take turns (the one served longest ago goes next), and within one owner higher `priority` goes first, so priority never lets a session jump another; `priority`, higher priority first across everyone. With `agingMinutes`, each that many minutes of waiting adds 1 to a job's priority, so no job waits forever behind others *in its lane*. Lanes are strict: steady front-lane traffic keeps the normal lane waiting.
- Agents reorder their own session's waiting jobs with `coord_job_priority`. Priorities run from -1,000,000 to 1,000,000.
- The running command gets `OMP_COORD_JOB` (its job id) and `OMP_COORD_QUEUE`. An `omp-coord run` on the same queue from inside that command runs at once, since it already holds that queue's slot (otherwise a one-slot queue would wait for itself). So a script can queue itself:

```sh
# At the top of a script that needs a heavy slot: re-run this script inside one.
[ "${OMP_COORD_QUEUE:-}" = heavy ] || exec omp-coord run heavy --key "$PWD ci" -- "$0" "$@"
```

A runner that dies (crash, `kill -9`) loses its slot within about 10 seconds: every runner listens on a Unix socket, and the others drop jobs whose socket stops answering. The command it started is not stopped: after `kill -9` of the runner it keeps running outside the queue. Stop runners with Ctrl-C or `kill` (SIGTERM), which pass the signal on.

A command that puts its work in the background (`cargo test &`) holds the slot only until the shell exits, so the background work runs unqueued.

When an agent's bash command matches a `queue` rule, the extension rewrites it to `omp-coord run <queue> --owner <session> -- sh -c '<command>'`. The waiting happens inside the bash call, which counts against the bash tool's timeout: agents should run long jobs as background (`async`) bash calls. The rewritten command runs in `sh`, so shell variables the agent set earlier without exporting them are not visible to it.

## Install

Requires omp 18.12 or later and Bun on `PATH` (the extension runs inside omp's Bun runtime; the runner runs with `bun`). No dependencies at runtime.

Load it for every session, in `~/.omp/agent/config.yml`:

```yaml
extensions:
  - /path/to/omp-coord/src/index.ts
```

or for one run: `omp -e /path/to/omp-coord/src/index.ts`.

Put the runner on `PATH` with `bun link` in this folder (it installs `omp-coord` into `~/.bun/bin`), or call `bun /path/to/omp-coord/src/cli.ts`.

The extension stays inactive in a session unless it finds a `.omp-coord.json` in the session's folder or a parent folder (so every worktree below a checkout uses the checkout's file), or the file named by `OMP_COORD_CONFIG`.

## Configuration

`.omp-coord.json` (see [`examples/omp-coord.json`](examples/omp-coord.json)):

| Field | Default | Meaning |
|---|---|---|
| `scope` | required | Sessions coordinate only with sessions of the same scope. Letters, digits, `.`, `_`, `-`. |
| `agents.pools` | `{ "work": { "cap": 8 } }` | Pools of slots: `cap`, and `agentTypes` (omp agent definition names) that use the pool. |
| `agents.defaultPool` | first pool | Pool for agent types no pool lists. |
| `agents.exempt` | `[]` | Agent types that never take a slot (read-only reviewers). |
| `agents.nested.allow` | `agents.exempt` | Agent types a subagent may start. |
| `agents.nested.maxRunningPerParent` | `1` | How many of those one subagent may run at once. |
| `agents.holdMinutes` | `5` | How long a freed slot stays held for the session first in line. |
| `agents.startTimeoutSeconds` | `120` | How long an approved spawn may take to start before its slot frees. |
| `messages.perMinute` | `10` | Messages one session may send per minute. It slows two sessions that keep answering each other; it does not stop them. Each delivered message starts a turn in an idle session. |
| `commands` | `[]` | Rules for agents' bash commands, first match wins: `{ "pattern": "<regex>", "action": "refuse", "reason": "…" }`, or `{ "pattern", "action": "queue", "queue": "<name>", "lane"? }`. The user's own `!` commands are not affected. |
| `queues.<name>.slots` | required | How many jobs of this queue run at once, across all processes in the scope. Queue names use letters, digits, `.`, `_`, `-`. |
| `queues.<name>.order` | `"fifo"` | `"fifo"`, `"fair-share"` or `"priority"` (see above). |
| `queues.<name>.lanes` | `["normal"]` | Lane names, first served first; the last is the default. |
| `queues.<name>.agingMinutes` | none | Waiting this long adds 1 to a job's priority. |
| `queues.<name>.onDuplicate` | `"refuse"` | `"refuse"` or `"supersede"` a waiting job with the same key. |
| `history.retentionDays` | `30` | Events older than this are deleted from the event log. |
| `history.maxEvents` | `100000` | The event log keeps at most this many of the newest events. |

Agent type names are matched lowercased against omp's agent definition names (`task`, `scout`, `reviewer`, `security-reviewer`, `sonic`, or your own).

## Use

- `/coord`: sessions, slots per session, the line, and each queue's running and waiting jobs.
- `/coord send <letter|all> <text>`: message other sessions yourself.
- Agents get the tools `coord_status`, `coord_send` (main session only) and `coord_job_priority`.
- `omp-coord status` prints the queues from any terminal.

Messages arrive as `[omp-coord] Message from omp session A …`, marked as coming from another session rather than from the user.

## State and event log

Kept in `~/.omp/run/omp-coord/` (owner-only; `OMP_COORD_STATE_DIR` overrides): one SQLite database per scope, `<scope>.db`, and one Unix socket per live session and per queued job. A session or job is gone when nothing listens on its socket, which a reused PID cannot fake.

The database is meant to be read by other tools. Current state:

| Table | Rows |
|---|---|
| `sessions` | Live sessions: `id`, `label` (A, B…), `pid`, `cwd`, `socket`, `started_at`. |
| `slots` | Agent slots held: `session_id`, `agent_id`, `parent_id`, `agent_type`, `pool` (null outside the caps), `state` (`starting` or `running`), `since`. |
| `tickets` | The line: `session_id`, `pool`, `since`, `hold_until` (set while a slot is held for it), `notified`. |
| `messages` | Messages not yet delivered. |
| `jobs` | Queued and running build/test jobs: `id`, `queue`, `owner` (session id, or null outside omp), `lane`, `priority`, `key`, `command`, `pid`, `state` (`waiting`, `running`, `superseded`), `since`, `started_at`. |

`events` is an append-only log: `at` (ms since epoch), `type`, `session_id` (null for jobs from outside omp), `label`, and `data` (JSON). Types:

- Sessions and agents: `session_joined`, `session_left`, `spawn_approved`, `spawn_refused` (with `position`, `used`, `cap`, or `nested` and `reason`), `run_started` (with `revived`), `run_ended` (with `ranMs`), `start_expired`, `hold_granted`, `hold_used` and `hold_expired` (with `waitedMs` since the first refusal), `message_sent` (recipients and length, never the text).
- Jobs: `job_queued` (with `queue`, `lane`, `priority`, `key`), `job_refused` (with `reason`), `job_started` (with `waitedMs`), `job_ended` (with `exitCode`, `ranMs`), `job_withdrawn` (left the line before starting), `job_superseded`, `job_lost` (its runner died), `job_reprioritized`.

Retention: events older than `history.retentionDays` and all but the newest `history.maxEvents` are deleted when a session starts and then at most once an hour. All times are milliseconds since the epoch.

```sh
db=~/.omp/run/omp-coord/lightcraft.db
# Agent slots held right now, per session
sqlite3 -column -header "$db" "select s.label, sl.pool, count(*) n from slots sl join sessions s on s.id = sl.session_id group by 1, 2"
# How long sessions waited for a slot (minutes), per day
sqlite3 -column -header "$db" "select date(at/1000,'unixepoch','localtime') day, label, count(*) holds, round(max(json_extract(data,'$.waitedMs'))/60000.0,1) max_wait_min from events where type='hold_used' group by 1, 2"
# Refusals per hour
sqlite3 -column -header "$db" "select strftime('%Y-%m-%d %H:00',at/1000,'unixepoch','localtime') hour, count(*) refused from events where type='spawn_refused' group by 1"
# Build waits per queue and day: jobs, average and longest wait (minutes)
sqlite3 -column -header "$db" "select date(at/1000,'unixepoch','localtime') day, json_extract(data,'$.queue') queue, count(*) jobs, round(avg(json_extract(data,'$.waitedMs'))/60000.0,1) avg_wait, round(max(json_extract(data,'$.waitedMs'))/60000.0,1) max_wait from events where type='job_started' group by 1, 2"
```

The schema version is in `PRAGMA user_version`. A database with a different schema is refused rather than misread.

## Limits

- Sessions of one scope should read the same file. Each session applies the caps and timeouts of the file it found; two different files under one scope (for example one per worktree) make sessions disagree.
- A message is put into the other session's conversation as written, marked as coming from another session. Text an agent copies into a message from an untrusted source reaches the other session too.
- `/tan` clones are subagents to omp, so they take slots from the default pool and fall under the rules for agents started by subagents.
- On one machine only: sessions find each other through a shared folder, not the network.

## Develop

```sh
just install
just check   # typecheck and tests
just         # every workflow
```

Code layout and conventions for contributors: [`AGENTS.md`](AGENTS.md).
