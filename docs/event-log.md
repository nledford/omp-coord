# State and event log

Kept in `~/.omp/run/omp-coord/` (owner-only; `OMP_COORD_STATE_DIR` overrides): one SQLite database per scope, `<scope>.db`, and one Unix socket per live session and per queued job. A session or job is gone when nothing listens on its socket, which a reused PID cannot fake.

The database is meant to be read by other tools. The schema version is in `PRAGMA user_version`; a database with a different schema is refused rather than misread.

## Current state

These tables are rebuilt as sessions come and go; their layout is not part of the [versioned contract](versioning.md).

| Table | Rows |
|---|---|
| `sessions` | Live sessions: `id`, `label` (A, B…), `pid`, `cwd`, `socket`, `started_at`, `config_hash` (of the `.omp-coord.json` it read), `ports_from`/`ports_to`. |
| `slots` | Agent slots held: `session_id`, `agent_id`, `parent_id`, `agent_type`, `pool` (null outside the caps), `state` (`starting` or `running`), `since`. |
| `tickets` | The line: `session_id`, `pool`, `since`, `hold_until` (set while a slot is held for it), `notified`. |
| `messages` | Messages not yet delivered. |
| `jobs` | Queued and running build/test jobs: `id`, `queue`, `owner` (session id, or null outside omp), `lane`, `priority`, `key`, `command`, `agent` (null when not recorded), `pid`, `state` (`waiting`, `running`, `superseded`), `since`, `started_at`. |
| `claims` | `kind` (`branch`, `worktree`, `pr`), `target`, `session_id`, `agent_id`, `note`, `since`. |
| `pause` | One row while the scope is paused: `by_session` (null from a terminal), `reason`, `since`. |
| `agent_ports` | Port blocks agents took: `session_id`, `agent_id`, `from_port`, `to_port`. |
| `machine_load` | The latest load average any session or runner measured, and when. |

## Event log and decision log

`events` is an append-only log: `at` (ms since epoch), `type`, `session_id` (null for jobs from outside omp), `label`, and `data` (JSON). Types:

- Sessions and agents: `session_joined`, `session_left`, `spawn_approved`, `spawn_refused` (with `position`, `used`, `cap`, or `nested` and `reason`), `run_started` (with `revived`), `run_ended` (with `ranMs`), `start_expired`, `hold_granted`, `hold_used` and `hold_expired` (with `waitedMs` since the first refusal), `message_sent` (recipients and length, never the text).
- Jobs: `job_queued` (with `queue`, `lane`, `priority`, `key`, and `agent` when recorded), `job_refused` (with `reason`), `job_started` (with `waitedMs`), `job_ended` (with `exitCode`, `ranMs`, and `timedOut` when the time limit stopped it), `job_withdrawn` (left the line before starting), `job_superseded`, `job_lost` (its runner died), `job_reprioritized`.
- Control: `paused` (with `reason`), `resumed` (with `pausedMs`), `claimed`, `released`, `claim_refused` (with `holder`), `write_refused` (a file-tool write into a protected checkout: `agentId`, `tool`, `paths` as the agent wrote them), `note_added` (note number and length).

`notes` is the decision log: `id`, `at`, `label`, `author`, `text`.

Retention: events and notes older than `history.retentionDays`, and all but the newest `history.maxEvents` events, are deleted when a session starts and then at most once an hour. All times are milliseconds since the epoch.

## Queries

```sh
db=~/.omp/run/omp-coord/my-project.db   # <scope>.db
# Agent slots held right now, per session
sqlite3 -column -header "$db" "select s.label, sl.pool, count(*) n from slots sl join sessions s on s.id = sl.session_id group by 1, 2"
# How long sessions waited for a slot (minutes), per day
sqlite3 -column -header "$db" "select date(at/1000,'unixepoch','localtime') day, label, count(*) holds, round(max(json_extract(data,'$.waitedMs'))/60000.0,1) max_wait_min from events where type='hold_used' group by 1, 2"
# Refusals per hour
sqlite3 -column -header "$db" "select strftime('%Y-%m-%d %H:00',at/1000,'unixepoch','localtime') hour, count(*) refused from events where type='spawn_refused' group by 1"
# Build waits per queue and day: jobs, average and longest wait (minutes)
sqlite3 -column -header "$db" "select date(at/1000,'unixepoch','localtime') day, json_extract(data,'$.queue') queue, count(*) jobs, round(avg(json_extract(data,'$.waitedMs'))/60000.0,1) avg_wait, round(max(json_extract(data,'$.waitedMs'))/60000.0,1) max_wait from events where type='job_started' group by 1, 2"
```
