# omp-coord

An [omp](https://github.com/can1357/oh-my-pi) extension that lets several omp sessions on one machine, working in the same project, share one set of agent caps and talk to each other.

- **Shared agent caps.** Subagents count against pools (for example 8 `work` and 2 `short` slots) shared by every session in the project. A spawn over the cap is refused through omp's `before_subagent_spawn` check, so the cap does not depend on agents remembering to take and free slots.
- **A fair line.** A refused session joins the line for that pool. When a slot frees, it is held for the session refused first (default 5 minutes) and that session is told so; other sessions' spawns are refused meanwhile.
- **Subagents start only reviewers.** A subagent may start only the agent types listed under `agents.nested.allow`, one at a time, outside the caps. Everything else is refused, so "no nested worker agents" is enforced rather than asked for.
- **Session registry.** Each session gets a letter (A, B, …) and shows `coord B · work 5/8 · short 1/2` in the footer. A session that exits or crashes leaves the board within about 10 seconds, and its slots free.
- **Messages.** `coord_send` (or `/coord send B …`) delivers a message into the other session's conversation at its next step, waking it when idle.
- **Command guard.** Bash commands matching configured patterns (raw `cargo test`, `pkill`…) are refused to agents with a reason.
- **Build and test queues.** `/coord` and `coord_status` show existing `flock`-based slot queues (who holds a slot, who waits), read-only.

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

## Install

Requires omp 18.12 or later (it runs inside omp's Bun runtime; no dependencies at runtime).

Load it for every session, in `~/.omp/agent/config.yml`:

```yaml
extensions:
  - /path/to/omp-coord/src/index.ts
```

or for one run: `omp -e /path/to/omp-coord/src/index.ts`.

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
| `refuseCommands` | `[]` | `{ "pattern": "<regex>", "reason": "…" }`: bash commands refused to agents. The user's own `!` commands are not affected. |
| `queues` | `[]` | `{ "name", "dir", "slots" }`: `flock` slot queues to show. `dir` holds `<n>.lock` files and a `queue/` folder of tickets named so that sorting gives the order of service and ending in `-<pid>`. Relative to the config file. |
| `history.retentionDays` | `30` | Events older than this are deleted from the event log. |
| `history.maxEvents` | `100000` | The event log keeps at most this many of the newest events. |

Agent type names are matched lowercased against omp's agent definition names (`task`, `scout`, `reviewer`, `security-reviewer`, `sonic`, or your own).

## Use

- `/coord`: sessions, slots per session, the line, build and test queues.
- `/coord send <letter|all> <text>`: message other sessions yourself.
- Agents get the tools `coord_status` and `coord_send` (`coord_send` works only in the main session).

Messages arrive as `[omp-coord] Message from omp session A …`, marked as coming from another session rather than from the user.

## State and event log

Kept in `~/.omp/run/omp-coord/` (owner-only; `OMP_COORD_STATE_DIR` overrides): one SQLite database per scope, `<scope>.db`, and one Unix socket per live session. A session is gone when nothing listens on its socket, which a reused PID cannot fake.

The database is meant to be read by other tools. Current state:

| Table | Rows |
|---|---|
| `sessions` | Live sessions: `id`, `label` (A, B…), `pid`, `cwd`, `socket`, `started_at`. |
| `slots` | Agent slots held: `session_id`, `agent_id`, `parent_id`, `agent_type`, `pool` (null outside the caps), `state` (`starting` or `running`), `since`. |
| `tickets` | The line: `session_id`, `pool`, `since`, `hold_until` (set while a slot is held for it), `notified`. |
| `messages` | Messages not yet delivered. |

`events` is an append-only log: `at` (ms since epoch), `type`, `session_id`, `label`, and `data` (JSON). Types: `session_joined`, `session_left`, `spawn_approved`, `spawn_refused` (with `position`, `used`, `cap`, or `nested` and `reason`), `run_started` (with `revived`), `run_ended` (with `ranMs`), `start_expired`, `hold_granted`, `hold_used` and `hold_expired` (with `waitedMs` since the first refusal), and `message_sent` (recipients and length, never the text).

Retention: events older than `history.retentionDays` and all but the newest `history.maxEvents` are deleted when a session starts and then at most once an hour. All times are milliseconds since the epoch.

```sh
db=~/.omp/run/omp-coord/lightcraft.db
# Agent slots held right now, per session
sqlite3 -column -header "$db" "select s.label, sl.pool, count(*) n from slots sl join sessions s on s.id = sl.session_id group by 1, 2"
# How long sessions waited for a slot (minutes), per day
sqlite3 -column -header "$db" "select date(at/1000,'unixepoch','localtime') day, label, count(*) holds, round(max(json_extract(data,'$.waitedMs'))/60000.0,1) max_wait_min from events where type='hold_used' group by 1, 2"
# Refusals per hour
sqlite3 -column -header "$db" "select strftime('%Y-%m-%d %H:00',at/1000,'unixepoch','localtime') hour, count(*) refused from events where type='spawn_refused' group by 1"
```

The schema version is in `PRAGMA user_version`. A database from a newer omp-coord is refused rather than misread.

## Limits

- Sessions of one scope should read the same file. Each session applies the caps and timeouts of the file it found; two different files under one scope (for example one per worktree) make sessions disagree.
- A message is put into the other session's conversation as written, marked as coming from another session. Text an agent copies into a message from an untrusted source reaches the other session too.
- `/tan` clones are subagents to omp, so they take slots from the default pool and fall under the rules for agents started by subagents.
- On one machine only: sessions find each other through a shared folder, not the network.

## Develop

```sh
bun install
bun run check   # typecheck and tests
```
