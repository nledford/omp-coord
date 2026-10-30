# Command reference

## In omp

| Command | Does |
|---|---|
| `/coord` | Sessions, slots, the line, claims, queues, the latest decisions; marks a paused scope and sessions reading a different config file. |
| `/coord agents` | The agents holding slots, one line each: session, id, type, parent (`Main` or an agent id), pool or `outside the caps`, state and age. Use it to see who runs, and what type each is, before messaging them. |
| `/coord send <letter\|B/agent\|all> <text>` | Message other sessions or one of their subagents. |
| `/coord pause [reason]`, `/coord resume` | Stop and restart new agents and queued jobs in every session. |
| `/coord claim <branch\|worktree\|pr> <target> [note]`, `/coord release <kind> <target>` | Claim or release. |
| `/coord note <text>`, `/coord notes [n]` | Write to and read the decision log. |
| `/coord stats [days]`, `/coord interrupted [hours]` | Reports from the event log. |

## Agent tools

| Tool | Does |
|---|---|
| `coord_status` | The same overview as `/coord`. |
| `coord_send` | Message another session or one of its subagents (main session only). |
| `coord_claim`, `coord_release` | Claim or release a branch, worktree or PR. |
| `coord_note` | Add to the decision log. |
| `coord_resources` | The calling agent's own ports and scratch folder. |
| `coord_job_priority` | Reorder this session's waiting jobs. |

## `omp-coord`

```sh
omp-coord run <queue> [--lane L] [--priority N] [--key K] [--owner SESSION] [--timeout 90m] [--meta k=v]... -- <command> [args…]
omp-coord status [--agents | --json] | stats [days] | interrupted [hours] | notes [count] | note <text…>
omp-coord pause [reason…] | resume | doctor [--fix]
```

`run` is described under [queues](queues.md). The others act on the scope whose `.omp-coord.json` is found from the current folder.

### `status`

`omp-coord status` prints the same overview as `/coord`. `--agents` prints only the running agents, as `/coord agents` does:

```text
Agents (3):
  A  Fixer        task      parent Main   pool work         running  5 min
  A  Fixer.Check  reviewer  parent Fixer  outside the caps  running  4 min
  B  Other        task      parent Main   pool work         running  2 min
```

Each line is the session letter, the agent's id (`(no id yet)` for an approved spawn omp gave no key for), its type, its parent, its pool, its state (`running`, or `starting` until its first run is seen) and how long ago it took its slot.

`--json` prints the board as one JSON object on stdout, for scripts. It is built whole before anything is written: if the board cannot be read, nothing goes to stdout, the error goes to stderr, and the exit code is not `0` (`2` for a usage or configuration error, `1` otherwise). `--json` and `--agents` do not combine.

Every time is milliseconds since the epoch (`Date.now()`); a session is its letter, or `null` when there is none (a job started outside omp, or by a session that has ended). Fields are never omitted: a missing value is `null`, a list is `[]`. Removing or renaming a field is a breaking change ([versioning](versioning.md)); new fields may appear.

| Field | Meaning |
|---|---|
| `generatedAt` | When the object was built. |
| `scope` | `{ name, source }`: the scope and the config file it was read from. |
| `paused` | `null`, or `{ by, byId, reason, since }`: `by` is the pausing session's letter, `byId` its id; both are `null` for a pause from a terminal, and only `by` once that session has ended. |
| `load` | The load average the limits act on, or `null` without a fresh reading. |
| `sessions[]` | `letter`, `id`, `folder`, `pid`, `since`, `agents` (`{ pools: { <pool>: slots held }, outsideCaps }`), `ports` (`{ from, to }` or `null`), `differentConfig` (read another config file than this scope's). By letter. |
| `pools[]` | `name`, `used`, `cap` (now: lowered under load, `0` while paused), `configuredCap`. |
| `line[]` | Sessions waiting for a slot: `pool`, `session`, `position` (from 1), `since`, `heldUntil` (`null` unless a freed slot is held for it). |
| `agents[]` | One per agent holding a slot, by session letter then `since`: `id` (`null` for a spawn with no key and no first run yet), `type`, `parent` (`Main` or an agent id), `session`, `pool` (`null`: outside the caps), `state` (`starting` or `running`), `since`. |
| `claims[]` | `kind` (`branch`, `worktree`, `pr`), `target`, `session`, `agent`, `note`, `since`. |
| `queues[]` | `name`, `order`, `slots` (now), `configuredSlots`, `running[]` and `waiting[]` (in the order they will start), each job: `id`, `session`, `owner` (the owning session's id, or `null` outside omp), `lane`, `priority`, `key` (or `null`), `command`, `agent` (omp's id of the agent whose command queued it, `"Main"` for the main agent; `null` for a job started outside an agent's bash call, on omp older than 18.12.4 (which sets no `PI_SESSION_ID`), and while any session of the scope runs an omp-coord older than this one, whose saves drop the ids the agent is found by), `state`, `queuedAt`, `startedAt` (`null` while waiting), `position` (from 1 while waiting, `null` while running). |
| `notes[]` | The latest three decisions, oldest first: `id`, `at`, `session` (the letter when it was written, kept after that session ends; `null` outside omp), `author`, `text`. |

```json
{
  "generatedAt": 1793000000000,
  "scope": { "name": "demo", "source": "/work/demo/.omp-coord.json" },
  "paused": null,
  "load": 3.5,
  "sessions": [
    { "letter": "A", "id": "7f3c…", "folder": "/work/demo", "pid": 4210, "since": 1792999000000,
      "agents": { "pools": { "work": 1 }, "outsideCaps": 1 }, "ports": null, "differentConfig": false }
  ],
  "pools": [{ "name": "work", "used": 1, "cap": 2, "configuredCap": 2 }],
  "line": [],
  "agents": [
    { "id": "Fixer", "type": "task", "parent": "Main", "session": "A", "pool": "work", "state": "running", "since": 1792999300000 },
    { "id": "Fixer.Check", "type": "reviewer", "parent": "Fixer", "session": "A", "pool": null, "state": "running", "since": 1792999400000 }
  ],
  "claims": [],
  "queues": [
    { "name": "heavy", "order": "fifo", "slots": 1, "configuredSlots": 1,
      "running": [{ "id": "a1b2c3d4", "session": "A", "owner": "7f3c…", "lane": "normal", "priority": 0, "key": "demo ci",
                    "command": "cargo test", "state": "running", "queuedAt": 1792999500000, "startedAt": 1792999500000, "position": null }],
      "waiting": [] }
  ],
  "notes": []
}
```

Exit codes: `0` success, the command's own for `run`, `75` a job not run, `124` a job stopped by its time limit, `2` a usage or configuration error.

## Environment

| Variable | Set by | Meaning |
|---|---|---|
| `OMP_COORD_CONFIG` | you | The config file to use instead of searching from the current folder. |
| `OMP_COORD_STATE_DIR` | you | The state folder instead of `~/.omp/run/omp-coord` (use a scratch folder for tests). |
| `OMP_COORD_SESSION` | the extension | The session that owns jobs started from its agents' commands. |
| `OMP_COORD_PORTS` | the extension | The session's port block, e.g. `18700-18799`, when `resources.ports` is set. |
| `OMP_COORD_SCRATCH` | the extension | The session's scratch folder, when `resources.scratch` is set. |
| `PI_SESSION_ID` | omp | The id of the conversation an agent's bash call belongs to. `omp-coord run` looks up which agent that is (the extension records it on the board: `Main` for the main session, the subagent's id for a subagent) and records it on the job. |
| `OMP_COORD_AGENT` | you | The agent to record on a job started where omp gave no `PI_SESSION_ID` (a script), or one the board doesn't know. The extension no longer sets it. |
| `OMP_COORD_JOB`, `OMP_COORD_QUEUE` | `omp-coord run` | The running job's id and queue, for nested runs. |
