# Changelog

Notable changes to omp-coord, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) as described in [docs/versioning.md](docs/versioning.md).

Add each user-visible change under Unreleased as it lands, in one of: Added, Changed, Deprecated, Removed, Fixed, Security. Mark a change that breaks the contract with **Breaking:** and say what to do about it.

## [Unreleased]

## [0.5.3] - 2026-11-06

### Fixed

- A `commands` rule no longer matches the body of a heredoc that only reads it as text, so a note, commit message or PR body that names `pkill` or `sed -i` is no longer refused (and one that names `cargo test` is no longer queued). The body is blanked only for `cat`, `tee`, `git commit`/`tag`/`notes` with `-F -` (or `--file=-`) and no other option that takes a value, quoted word or `--` and `gh pr`/`gh issue` on a line that is that one command, without `-c` or an editor flag (`-e`, a short-flag cluster holding an `e`, `--e…`) for git, and with a quoted delimiter or a body without `$(`, `${`, a backtick or a line ending in a backslash; the `<<` line, the delimiter line and everything after it are judged as written, and a heredoc a shell or interpreter reads, or one the scan cannot read with certainty, is judged whole as before ([what a rule reads](docs/queues.md#what-a-rule-reads)).
- Docs: a `commands` pattern is a regex without flags (case-sensitive; `^` and `$` anchor the whole command).
- Claim checks read a bash call's `cwd` the way omp and the protected-checkout guard do (`~` is the home folder, a relative `cwd` is relative to omp's folder): a call with `cwd: "~/repo"` no longer misses a claim on that worktree.

### Changed

- Claims now also guard `git add` and `git bisect` in a claimed worktree, and one list of git subcommands that change state serves claims and [protected checkouts](docs/protect.md#state-changing-git) (the protected-checkout docs now list `bisect`, which was already refused).
- Docs: the `coord_*` tools' parameters are listed (`coord_send` takes `to` and `text`, not `message`).
- Internal: the omp adapter's `extension.ts` is split into wiring, `guards.ts`, `board.ts`, `notices.ts` and `runtime.ts`. No behavior change.

## [0.5.2] - 2026-11-06

### Fixed

- A command no longer skips every `commands` rule because it contains `omp-coord run` or the runner's words: `omp-coord run x; pkill y` was allowed whole, whatever the rules said. Only a command that is the wrapper itself (this extension's rewrite, or `omp-coord run …`, at the start of the command after spaces, tabs or newlines, with nothing after it that could start another command: `;`, `&&`, `||`, `|`, `&` (also in `&>`), a newline, a subshell, `$(`, a backtick, `${`, `$'`) is left alone and not queued twice; any other command is judged by the rules. A command such as `cd /w && omp-coord run test -- cargo test` is therefore no longer exempt and matches a `queue` rule on `cargo test` as it reads. What follows `--` in a plain `omp-coord run <queue> -- <command>` is still not judged (documented in `docs/queues.md`).

### Changed

- A spawn refused for a full pool (or a pause) now says plainly that it did NOT start and must be started again when the message that a slot is held arrives. That message names the refused agent: its type, and its name when omp gave one (the first spawn refused in the session's place in line). The tickets table gains nullable `agent_type` and `agent_name` columns (no schema version bump); a place in line made by an older omp-coord has none, and its notice does not name an agent.

## [0.5.1] - 2026-11-03

### Added

- `agents.runtimeNoticeMinutes` (a whole number of minutes; off when absent): an agent whose run lasts that long, in any pool and nested or exempt ones too, gets one message to stop at the next clean point and write its handoff, and its session gets one notice naming it; both again at twice the limit, then no more. Nothing is stopped. New event `run_overtime` (`agentId`, `agentType`, `pool`, `minutes`, `notice` 1 or 2); `omp-coord stats` and `/coord stats` add `, N overtime notices` to a day that had some; `/coord agents` marks an agent past a notice, and each `agents[]` row of `status --json` gains `overtimeNotices` (`null`, `1` or `2`), the highest notice level reached. The slots table gains a nullable `notices` column with that meaning (no schema version bump).

## [0.5.0] - 2026-11-03

### Added

- `coord_status` takes `notes` (how many of the latest decisions to list, a whole number, 0 or more) and `compact` (true: no folders, start times or claim times, and no spawn-queue line). Without them the main session gets 3 decisions and the full lines, as before; a subagent gets no decisions and the compact lines.

### Changed

- **Breaking:** a subagent no longer has `coord_send`, `coord_claim`, `coord_release`, `coord_note` and `coord_job_priority`: they are registered in the main session only (`coord_status` and `coord_resources` stay for every agent), which removes their text from every request a subagent makes. A subagent that needs to message another session, claim something, record a decision or reorder a job reports to its parent, which does it. A message delivered to a subagent, and the refusal of a subagent's command on another session's claim, no longer tell it to use `coord_send`.
- The tool descriptions are one sentence each, and some parameter descriptions are shorter. The tools' text sent with each request falls by about a quarter in the main session and about four fifths in a subagent.

## [0.4.2] - 2026-11-02

### Added

- `omp-coord run --meta k=v` (repeatable, at most 8; the key matches `[a-z][a-z0-9_-]{0,31}`, the value is at most 200 characters on one line) tags a job. The tags go into the `job_queued` and `job_ended` events as `meta`, and `job_ended` now also carries the job's `key`. A script can detect support with `omp-coord --help 2>&1 | grep -q -- '--meta'`. The jobs table gains a nullable `meta` column (no schema version bump).
- `omp-coord stats` and `/coord stats` add `; of the failures: N repeat an unchanged failure, M intended` to a queue's line when a failed job of that day had tags: a repeat is a failed job whose `fp` tag equals that of an earlier failed job in the same queue, with no successful job of that `fp` in between; intended is `intent=failfirst`.

## [0.4.1] - 2026-10-30

### Added

- `protect` in `.omp-coord.json`: the extension refuses `edit`, `write`, `ast_edit` and `apply_patch` calls (also through `xd://`) whose target lies in a protected checkout and not in a linked worktree below it, and a bash command whose state-changing `git` (`checkout`, `reset`, `commit`, `clean`, `rebase` and the like) runs there, naming the resolved path or folder. A relative path in the file tools resolves against omp's own folder, not the `cwd` of an agent's bash calls, and a bash call without a `cwd` runs there too, so an agent told to work in a worktree edited or reset the main checkout. Known gaps, in [protect](docs/protect.md#what-it-cannot-see): a shell command's file writes (`cat >`, `cp`, `mv`) and `eval`, the `eval` tool and `lsp` write without a file-tool call to judge; a git folder the shell computes (`cd "$W"`, `git -C $(pwd)`) is not judged; the guard fails open when its own check throws. Subagents only unless `protect.agents` is `"all"`; each refusal is a `write_refused` event naming the agent. Without `protect` nothing changes. The guard reads paths and command text, so it stops the usual forms, not a determined dodge; what it cannot see is listed in [protect](docs/protect.md).
- A `commands` rule may set `"agents": "sub"` to apply to subagents' commands only (default `"all"`). `examples/omp-coord.json` has three such `refuse` rules for in-place rewrites (`sed -i`, `perl -i`, an inline Python script that writes a file), which agents used instead of the edit tool; copy them into your file to use them.

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

[Unreleased]: https://github.com/nledford/omp-coord/compare/v0.5.3...HEAD
[0.5.3]: https://github.com/nledford/omp-coord/compare/v0.5.2...v0.5.3
[0.5.2]: https://github.com/nledford/omp-coord/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/nledford/omp-coord/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/nledford/omp-coord/compare/v0.4.2...v0.5.0
[0.4.2]: https://github.com/nledford/omp-coord/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/nledford/omp-coord/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/nledford/omp-coord/compare/v0.3.2...v0.4.0
[0.3.2]: https://github.com/nledford/omp-coord/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/nledford/omp-coord/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/nledford/omp-coord/compare/v0.2.3...v0.3.0
[0.2.3]: https://github.com/nledford/omp-coord/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/nledford/omp-coord/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/nledford/omp-coord/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/nledford/omp-coord/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/nledford/omp-coord/releases/tag/v0.1.0
