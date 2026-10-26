# Changelog

Notable changes to omp-coord, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html) as described in [docs/versioning.md](docs/versioning.md).

Add each user-visible change under Unreleased as it lands, in one of: Added, Changed, Deprecated, Removed, Fixed, Security. Mark a change that breaks the contract with **Breaking:** and say what to do about it.

## [Unreleased]

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

[Unreleased]: https://github.com/nledford/omp-coord/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/nledford/omp-coord/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/nledford/omp-coord/releases/tag/v0.1.0
