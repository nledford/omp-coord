# Changelog

Notable changes to omp-coord, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) as described in [docs/versioning.md](docs/versioning.md).

Add each user-visible change under Unreleased as it lands, in one of: Added, Changed, Deprecated, Removed, Fixed, Security. Mark a change that breaks the contract with **Breaking:** and say what to do about it.

## [Unreleased]

## [0.4.0] - 2026-10-28

### Added

- `examples/omp-coord.json` has two `refuse` rules that protect git's rerere cache, which every worktree of a repository shares: deleting `rr-cache` (`rm`, `find -delete`, `git clean` and the like) and `git rerere clear`, `forget` and `gc` are refused, with a reason that points to `git -c rerere.enabled=false …` for throwaway builds. Reading the cache, `git rerere status`, `diff`, `remaining` and a command that names a throwaway repository under `/tmp` (an `rr-cache` path there, or `git -C`/`GIT_DIR=` for `git rerere`) are allowed; the limits are in the docs. Copy the rules into your `.omp-coord.json` above any `queue` rules to use them; no code or default changed. See [queues](docs/queues.md#example-protecting-gits-rerere-cache).

### Changed

- **Breaking:** while any `refuse` rule is configured, a bash command longer than 32,768 characters is refused with a message, instead of being judged by the patterns: a pattern that stalls on a very long line froze the session's `tool_call` check (omp gives it 30 s and fails closed), and one that runs out of backtracking budget answered "no match" and let the command through. A command that used to run and is now refused: write the long script to a file with the write tool and run it from a short command. Configs without a `refuse` rule (queue rules only) are not affected. See [queues](docs/queues.md#agents-commands).

## [0.3.2] - 2026-10-28

### Changed

- **Breaking:** the extension no longer starts agents' bash commands with `export OMP_COORD_AGENT=<agent id>;`, and no longer sets `OMP_COORD_AGENT` at all. The rewritten command showed up in the conversation, and agents copied the prefix into later calls. Instead `omp-coord run` finds the agent from `PI_SESSION_ID`, the id omp gives each bash call for its agent's conversation, which the extension records on the board (the main session as `Main`, each subagent when its run starts, dropped when it ends). A script that read `OMP_COORD_AGENT` inside an agent's command must read `PI_SESSION_ID` or ask the board instead; `OMP_COORD_AGENT=<name> omp-coord run …` still names the agent for a job started where omp gives no `PI_SESSION_ID`, or one the board doesn't know. Only commands a `queue` rule matches are rewritten now, as before 0.2.3; omp's `bash.patterns` rules and other extensions see every other command as the agent wrote it.

### Deprecated

- `tagAgentCommands` does nothing and is still accepted, so existing `.omp-coord.json` files keep loading; remove it. Queued jobs record their agent whether it was on or not.

### Fixed

- A job queued by an agent now records the agent whether or not `tagAgentCommands` was on. A board made by an older omp-coord gains the two new columns when this version opens it; while a session of the scope (or an older `omp-coord run`) still uses the old version, its saves drop the recorded ids: the main session's comes back within 2 s, but a subagent's only at its next run, so while any older omp-coord is in use a subagent's jobs may show no agent (display only). omp gives bash calls `PI_SESSION_ID` from 18.12.4 on (the plugin still runs on 18.12.0 to 18.12.3, where jobs record no agent unless a script sets `OMP_COORD_AGENT`).

## [0.3.1] - 2026-10-27

### Fixed

- `omp-coord interrupted` and `/coord interrupted` no longer list an agent that was revived (`write agent://<id>`) since its session left, from a session in the same folder, nor its nested helpers, and leave out a session with none left; before, a session restarted after a crash kept being told to revive agents that had long finished. A new agent that only reuses the name doesn't count as a revival.

## [0.3.0] - 2026-10-27

### Changed

- **Breaking:** while a session is the only one in its scope, spawns past the cap now wait their turn instead of being refused (`agents.queueSpawns`, on by default): the extension keeps omp's per-session spawn queue (`task.maxConcurrency`) at what the caps allow the session, so you can start as many agents as you need and those past the cap start by themselves as slots free. With other sessions in the scope, or while paused, spawns over the cap are refused and the session joins the line, as before. A `task.maxConcurrency` you set stays the ceiling; the override is never saved and is cleared when the session ends. Set `agents.queueSpawns: false` to keep refusals always. See [agent slots](docs/agent-slots.md#spawns-wait-their-turn).
- `coord_status` and `/coord` say whether this session's spawns wait in omp's queue right now, and if not, why (another session, paused, or every slot taken by agents outside the queue).

### Fixed

- With `tagAgentCommands` on, a command that already starts with `export OMP_COORD_AGENT=…;` (an agent repeating an earlier, rewritten call it saw in the conversation) gets exactly one prefix for the agent running it, instead of one more each time.
- A release whose tag push GitHub delivers twice, or a release run again, no longer fails: release runs for one tag wait for each other, npm's current "already exists" (409) answer counts as already published once npm lists that version, and a GitHub release that exists already is left as it is.
- With `tagAgentCommands` on, a copied prefix no longer ends up inside a queued job's own command.

## [0.2.3] - 2026-10-27

### Added

- `tagAgentCommands` (off by default): each queued job records the agent whose command queued it, and the queue lines in `/coord` and `omp-coord status` read `session A/WaveImport`; `status --json` has `agent` on each job and the `job_queued` event carries it. With it on, the extension starts every agent bash command with `export OMP_COORD_AGENT=<agent id>;`, which `omp-coord run` reads; leave it off if you use omp's `bash.patterns` rules or another extension that rewrites bash commands. A board made by an older omp-coord gains the new column when this version opens it; while any session of the scope still runs an older omp-coord, its saves drop the recorded agents (display only).

### Changed

- A queue line shows the job's key (for example `rebase-2204 ci`) instead of its command when the job has one; the command still shows when it doesn't, and `status --json` keeps both.

## [0.2.2] - 2026-10-27

### Added

- `omp-coord status --json` prints the board as one JSON object for scripts (scope, sessions, pools, line, agents, claims, queues with their running and waiting jobs, latest notes, load; times in epoch milliseconds). With a board that cannot be read it prints nothing to stdout and exits non-zero. The fields are documented in [docs/commands.md](docs/commands.md).
- A list of the running agents with their type, parent, pool, state and age: `/coord agents`, `omp-coord status --agents`, and `agents` in `status --json`.

## [0.2.1] - 2026-10-26

### Added

- Releases are published to npmjs.com as `@nledford/omp-coord`, with provenance: `omp plugin install @nledford/omp-coord` needs no token or `.npmrc`.

### Fixed

- On Linux, where `/proc` cannot be read (some hardened containers), a timed-out job now falls back to signalling its process group instead of failing.

## [0.2.0] - 2026-10-26

### Added

- Each release is published as the npm package `@nledford/omp-coord` to GitHub Packages; see [docs/install.md](docs/install.md).

### Changed

- **Breaking:** the package is now named `@nledford/omp-coord`, so omp lists and upgrades a git or package install under that name (`omp plugin upgrade @nledford/omp-coord`). Marketplace installs keep `omp-coord@omp-coord`.

### Fixed

- In a container whose first process never reaps orphans, a job stopped by its time limit no longer holds its slot for the whole 10-second grace period: exited processes left in its process group no longer count as running.

## [0.1.0] - 2026-10-26

### Added

- Shared subagent caps across omp sessions in one project, with pools, exempt agent types, limits on agents started by subagents, and a fair line: a refused session gets the next free slot, held for it for a few minutes.
- Build and test queues: `omp-coord run <queue> -- <command>` waits for a slot. Queues can be ordered `fifo`, `fair-share` or `priority`, with lanes, aging, duplicate keys (refuse or supersede), and time limits. The extension rewrites agents' bash commands that match `queue` rules, and refuses those that match `refuse` rules.
- Messages between sessions and to another session's subagent (`coord_send`, `/coord send`, `B/<agent id>`).
- Claims on branches, worktrees and PRs (`coord_claim`, `/coord claim`): other sessions' agents are refused git and gh commands that would change a claimed one.
- Pause and resume for a whole scope (`/coord pause`, `omp-coord pause`).
- Lower agent caps and queue slots while the machine's load average is high (`loadCaps`, `loadSlots`).
- A block of ports and a scratch folder per session and per agent (`resources`, `coord_resources`, `OMP_COORD_PORTS`, `OMP_COORD_SCRATCH`).
- A shared decision log (`coord_note`, `/coord note`, `omp-coord note`).
- Reports from the event log: `omp-coord interrupted` (agents a crashed or closed session left mid-run) and `omp-coord stats`; `omp-coord doctor [--fix]`.
- An SQLite event log per scope, with retention.
- Packaging as an omp plugin, with a marketplace catalog; queued commands run on omp's own Bun.

[Unreleased]: https://github.com/nledford/omp-coord/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/nledford/omp-coord/compare/v0.3.2...v0.4.0
[0.3.2]: https://github.com/nledford/omp-coord/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/nledford/omp-coord/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/nledford/omp-coord/compare/v0.2.3...v0.3.0
[0.2.3]: https://github.com/nledford/omp-coord/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/nledford/omp-coord/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/nledford/omp-coord/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/nledford/omp-coord/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/nledford/omp-coord/releases/tag/v0.1.0
