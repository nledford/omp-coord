# Command reference

## In omp

| Command | Does |
|---|---|
| `/coord` | Sessions, slots, the line, claims, queues, the latest decisions; marks a paused scope and sessions reading a different config file. |
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
omp-coord run <queue> [--lane L] [--priority N] [--key K] [--owner SESSION] [--timeout 90m] -- <command> [args…]
omp-coord status | stats [days] | interrupted [hours] | notes [count] | note <text…>
omp-coord pause [reason…] | resume | doctor [--fix]
```

`run` is described under [queues](queues.md). The others act on the scope whose `.omp-coord.json` is found from the current folder.

Exit codes: `0` success, the command's own for `run`, `75` a job not run, `124` a job stopped by its time limit, `2` a usage or configuration error.

## Environment

| Variable | Set by | Meaning |
|---|---|---|
| `OMP_COORD_CONFIG` | you | The config file to use instead of searching from the current folder. |
| `OMP_COORD_STATE_DIR` | you | The state folder instead of `~/.omp/run/omp-coord` (use a scratch folder for tests). |
| `OMP_COORD_SESSION` | the extension | The session that owns jobs started from its agents' commands. |
| `OMP_COORD_PORTS` | the extension | The session's port block, e.g. `18700-18799`, when `resources.ports` is set. |
| `OMP_COORD_SCRATCH` | the extension | The session's scratch folder, when `resources.scratch` is set. |
| `OMP_COORD_JOB`, `OMP_COORD_QUEUE` | `omp-coord run` | The running job's id and queue, for nested runs. |
