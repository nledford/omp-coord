# omp-coord: notes for agents working on this repo

An omp extension (TypeScript, runs inside omp's Bun runtime) and the `omp-coord` command-line runner for build and test queues. User-facing behavior and configuration: `README.md`.

## Commands

- `just` lists the workflows. `just install`, then `just check` (typecheck and every test) before every commit; `just test <file>` or `just test -t <pattern>` while iterating.
- Load a working copy into omp: `just omp-dev` (scratch state folder; run it from a folder holding a scratch `.omp-coord.json`). Never point `OMP_COORD_STATE_DIR` at the real `~/.omp/run/omp-coord` while testing. `just events <scope>` reads that scratch board's event log.
- Smoke test across sessions: two omp sessions in tmux in the same scratch folder, with caps of 1, so that one spawn fills a pool.
- `src/` changes that move the CLI need `just unlink && just link` so `~/.bun/bin/omp-coord` follows.

## Layout: hexagonal, around a functional core

Dependencies point inward only: adapters → app → domain. The domain imports nothing outside itself; the app imports only the domain and its own ports.

| Path | Role |
|---|---|
| `src/domain/model.ts` | The `Board` (sessions, agent slots, the line, messages, jobs, pause, claims, notes, port blocks, the latest load), policy types, `BoardEvent` and `emit`. |
| `src/domain/sessions.ts`, `agents.ts`, `messages.ts`, `queues.ts` | Pure transitions over the `Board`, one concern each. No I/O, no clock; callers pass `now`. Transitions append `BoardEvent`s. |
| `src/domain/control.ts`, `limits.ts`, `claims.ts`, `notes.ts`, `ports.ts` | Pause and resume; load-aware limits; claims and the command-text guard; the decision log; port blocks. |
| `src/domain/history.ts` | Reports from the event log: agents interrupted by a session leaving, daily statistics. |
| `src/domain/commands.ts` | Decides what happens to an agent's bash command: allow, refuse, or rewrite to run through a queue. |
| `src/app/ports.ts` | What the app needs from outside: `BoardRepository`, `Liveness`, `Listener`, `Clock`, `LoadProbe`. |
| `src/app/coordinator.ts` | Session use cases: join, leave, tick, spawn decisions, agent runs, messages, pause, claims, notes, ports, reports, pruning dead sessions and jobs. |
| `src/app/job-runner.ts` | The runner use case: join a queue, wait (dropping dead runners, recording load), run within the time limit, leave with the exit code. |
| `src/app/doctor.ts` | `omp-coord doctor`'s checks and fixes. |
| `src/config.ts` | Finds and validates `.omp-coord.json` into domain policy types, and hashes it. Errors name the field. |
| `src/adapters/sqlite/store.ts` | `BoardRepository` on SQLite: state tables, the event log, the decision log, schema version, retention. |
| `src/adapters/unix/beacon.ts` | `Listener` and `Liveness` on Unix sockets, one per live session or queued job. |
| `src/adapters/os/load.ts` | `LoadProbe` from the 1-minute load average. |
| `src/adapters/omp/extension.ts`, `api.ts` | The omp adapter (hooks, tools, `/coord`, the 2 s tick) and the slice of omp's API it uses, declared locally (see below). Sets `OMP_COORD_SESSION`, `OMP_COORD_PORTS` and `OMP_COORD_SCRATCH` for commands the session's agents run. Keeps each subagent's binding to deliver messages to it. |
| `src/adapters/cli/cli.ts` | `omp-coord` subcommands: argument parsing, signals, time limits and process spawning around the use cases; sets `OMP_COORD_JOB` and `OMP_COORD_QUEUE` for a queued command. |
| `src/adapters/text/report.ts` | Text for `/coord`, the tools, the `omp-coord` subcommands and the footer. |

New behavior goes in the domain (rules) and the app (use cases), with tests there; adapters only translate. Test the app with the fakes in `test/support/fakes.ts`.

## Invariants

- Every board change goes through `BoardRepository.transact`: load, pure transition, save state, append events, in one `BEGIN IMMEDIATE` transaction. Never write the tables any other way; several omp processes share them.
- Domain rules are tested in the domain without SQL. The store only maps rows to and from `Board`.
- The schema is still version 1 and may change freely: the plugin has no real-world users yet, so edit `SCHEMA` in `store.ts` in place and delete old scratch databases. Once it has users, a schema change bumps `SCHEMA_VERSION` and adds a migration step that keeps the `events` table (board state is short-lived and may be dropped).
- The event log never stores message text.
- No runtime dependencies: Bun built-ins only (`bun:sqlite`, `Bun.listen`). Dev dependencies are fine.
- Background work uses `ctx.setInterval`/`ctx.setTimeout`. A raw timer that throws takes down the user's whole omp session.
- The runtime lives on `globalThis` under `Symbol.for("omp-coord.runtime")`, not in a module variable: omp re-imports the module for isolated subagents, and all copies in a process must share one registration.
- If the board cannot be read, spawns are let through with an error notice. The cap is an agreement between sessions, not a security boundary; do not make it fail closed.
- Liveness: a session or job counts as dead only when its socket answers `ENOENT` or `ECONNREFUSED`. Timeouts and other errors count as alive.
- `tool_call` handlers must answer at once (omp gives 30 s, then fails the call closed), so queued commands are rewritten to wait inside the bash call, never in the handler.

## omp behavior the design relies on

Observed on omp 18.12.6; re-check after omp upgrades.

- `before_subagent_spawn` fires in the parent's binding after the `task` tool has returned "Spawned". omp waits 30 s for the handler, then lets the spawn through, so the handler must decide at once and never wait.
- A blocked spawn ends as a failed job whose error text is the block `reason`.
- Revivals (`write agent://<id>`) do not run the spawn check. The child gets a new `agent_start`.
- The child's `agent_start`/`agent_end` fire once per run, including when the run is killed. The child's `session_shutdown` fires only when the process exits.
- A nested spawn's check runs in the child's binding (`ctx.agent.kind === "sub"`). The main agent's id is `"Main"`.
- `spawnKey` is the new agent's id for `task`, eval `agent()` and workpools, but only a label for some callers (`/cleanse`), so `agentStarted` falls back to matching parent and type.
- A `tool_call` handler that returns `{ input }` replaces the arguments the tool runs with; the agent sees the rewritten command in its transcript.
- omp's bash tool passes the omp process's environment to commands, so `OMP_COORD_SESSION` set by the extension reaches `just` recipes run by agents.
- `sendMessage` through a subagent's binding (captured in its `session_start`) lands in that subagent's conversation, not the main session's.
- The installed `@oh-my-pi/pi-coding-agent` package can lag the `omp` binary (17.4.1 against 18.12.6 when this was written). That is why `src/omp-api.ts` declares the API instead of importing it. Check API facts against `omp://extensions.md` from the running omp.

## Tests

- `test/board.test.ts`: agent slots, sessions, messages and their events. `test/queues.test.ts`: queue rules. `test/features.test.ts`: pause, load limits, claims, notes, ports, subagent messages and event-log reports. `test/commands.test.ts`: command rules and quoting. `test/config.test.ts`: config. `test/app.test.ts`: use cases through in-memory fakes. `test/infra.test.ts`: the SQLite store (concurrency across processes, constraints, retention, schema check, round-trips) and socket liveness. `test/cli.test.ts`: the CLI across real processes (waiting, exit codes, duplicates, a killed runner, time limits, pause, doctor).
- Tests that need several processes spawn `bun` children; keep them, they are the evidence that processes don't lose each other's writes or slots.
