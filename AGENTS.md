# omp-coord: notes for agents working on this repo

An omp extension (TypeScript, runs inside omp's Bun runtime). User-facing behavior and configuration: `README.md`.

## Commands

- `bun install`, then `bun run check` (typecheck and tests). Run it before every commit.
- Load a working copy into omp: `OMP_COORD_STATE_DIR=/tmp/<scratch>/state omp --no-extensions -e "$PWD/src/index.ts"` from a folder holding a scratch `.omp-coord.json`. Never point `OMP_COORD_STATE_DIR` at the real `~/.omp/run/omp-coord` while testing.
- Smoke test across sessions: two omp sessions in tmux in the same scratch folder, with caps of 1, so that one spawn fills a pool. Read the board with `sqlite3 <state>/<scope>.db`.

## Layout

| Path | Role |
|---|---|
| `src/domain/board.ts` | The rules: pure transitions over a plain `Board` (sessions, slots, the line, messages). No I/O, no clock; callers pass `now`. Transitions append `BoardEvent`s to `board.events`. |
| `src/config.ts` | Finds and validates `.omp-coord.json`. Errors name the field. |
| `src/infra/store.ts` | SQLite: state tables, the event log, schema version (`PRAGMA user_version`), retention. |
| `src/infra/beacon.ts` | One Unix socket per live session; another session that cannot connect knows it is gone. |
| `src/infra/flock-queues.ts` | Read-only view of `flock` slot queues. |
| `src/extension.ts` | The omp adapter: hooks, tools, `/coord`, the 2 s tick that delivers messages and holds and prunes dead sessions. |
| `src/omp-api.ts` | The slice of omp's extension API used here, declared locally (see below). |
| `src/report.ts` | Text for `/coord`, `coord_status` and the footer. |

## Invariants

- Every board change goes through `BoardStore.transact`: load, pure transition, save state, append events, in one `BEGIN IMMEDIATE` transaction. Never write the tables any other way; several omp processes share them.
- Domain rules live in `board.ts` and are tested there without SQL. The store only maps rows to and from `Board`.
- A schema change bumps `SCHEMA_VERSION` in `store.ts` and adds its migration step. Board state is short-lived and may be dropped on migration; the `events` table may not.
- The event log never stores message text.
- No runtime dependencies: Bun built-ins only (`bun:sqlite`, `Bun.listen`). Dev dependencies are fine.
- Background work uses `ctx.setInterval`/`ctx.setTimeout`. A raw timer that throws takes down the user's whole omp session.
- The runtime lives on `globalThis` under `Symbol.for("omp-coord.runtime")`, not in a module variable: omp re-imports the module for isolated subagents, and all copies in a process must share one registration.
- If the board cannot be read, spawns are let through with an error notice. The cap is an agreement between sessions, not a security boundary; do not make it fail closed.
- Liveness: a session counts as dead only when its socket answers `ENOENT` or `ECONNREFUSED`. Timeouts and other errors count as alive.

## omp behavior the design relies on

Observed on omp 18.12.6; re-check after omp upgrades.

- `before_subagent_spawn` fires in the parent's binding after the `task` tool has returned "Spawned". omp waits 30 s for the handler, then lets the spawn through, so the handler must decide at once and never wait.
- A blocked spawn ends as a failed job whose error text is the block `reason`.
- Revivals (`write agent://<id>`) do not run the spawn check. The child gets a new `agent_start`.
- The child's `agent_start`/`agent_end` fire once per run, including when the run is killed. The child's `session_shutdown` fires only when the process exits.
- A nested spawn's check runs in the child's binding (`ctx.agent.kind === "sub"`). The main agent's id is `"Main"`.
- `spawnKey` is the new agent's id for `task`, eval `agent()` and workpools, but only a label for some callers (`/cleanse`), so `agentStarted` falls back to matching parent and type.
- The installed `@oh-my-pi/pi-coding-agent` package can lag the `omp` binary (17.4.1 against 18.12.6 when this was written). That is why `src/omp-api.ts` declares the API instead of importing it. Check API facts against `omp://extensions.md` from the running omp.

## Tests

- `test/board.test.ts`: rules and event log. `test/config.test.ts`: config. `test/infra.test.ts`: store (concurrency across processes, constraints, retention, migrations) and liveness. `test/flock-queues.test.ts`: needs `flock` (`brew install flock`); skipped without it.
- Tests that need several processes spawn `bun -e` children; keep them, they are the evidence that sessions don't lose each other's writes.
