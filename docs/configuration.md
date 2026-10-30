# Configuration

`.omp-coord.json`, in the project's top folder (see [`examples/omp-coord.json`](../examples/omp-coord.json)). Sessions find it in their folder or a parent folder, or through `OMP_COORD_CONFIG`. Every session of a scope should read the same file: each applies the caps and timeouts of the file it found, and `/coord` marks sessions that read a different one.

| Field | Default | Meaning |
|---|---|---|
| `scope` | required | Sessions coordinate only with sessions of the same scope. Letters, digits, `.`, `_`, `-`. |
| `agents.pools` | `{ "work": { "cap": 8 } }` | Pools of slots: `cap`, `agentTypes` (omp agent definition names) that use the pool, and `loadCaps`: `[{ "above": 150, "cap": 4 }]` lowers the cap while the 1-minute load average is above 150. |
| `agents.defaultPool` | first pool | Pool for agent types no pool lists. |
| `agents.exempt` | `[]` | Agent types that never take a slot (read-only reviewers). |
| `agents.nested.allow` | `agents.exempt` | Agent types a subagent may start. |
| `agents.nested.maxRunningPerParent` | `1` | How many of those one subagent may run at once. |
| `agents.holdMinutes` | `5` | How long a freed slot stays held for the session first in line. |
| `agents.startTimeoutSeconds` | `120` | How long an approved spawn may take to start before its slot frees. |
| `agents.queueSpawns` | `true` | While the session is the only one in the scope, keep omp's per-session spawn queue (`task.maxConcurrency`) at what the caps allow it, so spawns past the cap wait and start by themselves instead of being refused ([agent slots](agent-slots.md#spawns-wait-their-turn)); with other sessions, or paused, spawns over the cap are refused as before. A `task.maxConcurrency` you set yourself stays the ceiling. `false` keeps the refusals always. |
| `messages.perMinute` | `10` | Messages one session may send per minute. It slows two sessions that keep answering each other; it does not stop them. Each delivered message starts a turn in an idle session. |
| `commands` | `[]` | Rules for agents' bash commands, first match wins: `{ "pattern": "<regex>", "action": "refuse", "reason": "…" }`, or `{ "pattern", "action": "queue", "queue": "<name>", "lane"? }`; `"agents": "sub"` on a rule applies it to subagents' commands only (default `"all"`). The user's own `!` commands are not affected. Nothing is refused unless a rule is listed; `examples/omp-coord.json` has ready-made `refuse` rules, including two that protect git's rerere cache ([queues](queues.md#example-protecting-gits-rerere-cache)) and three that refuse in-place rewrites by `sed -i`, `perl -i` and inline Python ([protect](protect.md#in-place-rewrites-by-shell)). |
| `protect` | none | `{ "roots": ["."], "allow": [], "agents": "sub" }`: checkouts the file tools (`edit`, `write`, `ast_edit`, `apply_patch`) may not write to and where a bash command's state-changing `git` (`checkout`, `reset`, `commit`, `clean`, `rebase` and the like) may not run, so an agent that types a relative path does not change the main checkout instead of its worktree ([protect](protect.md)). `roots` are relative to the config file's folder; `allow` entries are files or folders below a root, relative to it (no leading `/`, no `..`); `agents` is `"sub"` (default) or `"all"`. |
| `queues.<name>.slots` | required | How many jobs of this queue run at once, across all processes in the scope. Queue names use letters, digits, `.`, `_`, `-`. |
| `queues.<name>.order` | `"fifo"` | `"fifo"`, `"fair-share"` or `"priority"` (see [queues](queues.md#order)). |
| `queues.<name>.lanes` | `["normal"]` | Lane names, first served first; the last is the default. |
| `queues.<name>.agingMinutes` | none | Waiting this long adds 1 to a job's priority. |
| `queues.<name>.onDuplicate` | `"refuse"` | `"refuse"` or `"supersede"` a waiting job with the same key. |
| `queues.<name>.timeoutMinutes` | none | Stop a job's command after this long: SIGTERM to its process group, then SIGKILL to whatever of it is left 10 s later; it exits 124. `--timeout` overrides it per job. |
| `queues.<name>.loadSlots` | `[]` | `[{ "above": 150, "slots": 1 }]`: fewer slots under load; `0` holds the queue. |
| `tagAgentCommands` | none | Deprecated and ignored: every queued job records the agent that queued it now (on omp 18.12.4 or later), without rewriting commands. Accepted so existing files keep loading; remove it. |
| `resources.ports` | none | `{ "from", "to", "perSession", "perAgent" (10) }`: each session gets a block of `perSession` ports, each agent a block of `perAgent` from its session's. |
| `resources.scratch` | none | Root of the scratch folders: `<scratch>/<letter>` per session, `<scratch>/<letter>/<agent id>` per agent. Relative to the config file. |
| `history.retentionDays` | `30` | Events and decision-log notes older than this are deleted. |
| `history.maxEvents` | `100000` | The event log keeps at most this many of the newest events. |

Agent type names are matched lowercased against omp's agent definition names (`task`, `scout`, `reviewer`, `security-reviewer`, `sonic`, or your own).

A file with a mistake turns omp-coord off in that session, with an error that names the field, e.g. `omp-coord is off: /repo/.omp-coord.json: queues.build.slots must be a whole number of at least 1`. `omp-coord doctor` reports the same.
