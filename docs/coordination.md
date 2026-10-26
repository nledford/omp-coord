# Working across sessions

Each session gets a letter (A, B, …) and shows `coord B · work 5/8 · short 1/2` in the footer. A session that exits or crashes leaves the board within about 10 seconds. Commands and tools are listed in the [command reference](commands.md).

## Messages

`coord_send` (or `/coord send B …`) delivers a message into the other session's conversation at its next step, waking it when idle; `all` reaches every other session, and `B/<agent id>` one of session B's subagents. Messages arrive as `[omp-coord] Message from omp session A …`, marked as coming from another session rather than from the user. A message for a subagent that is not running goes to its main session, which can pass it on with `write agent://<id>`.

Messages are rate-limited (`messages.perMinute`), and each delivered message starts a turn in an idle session. Text an agent copies into a message from an untrusted source reaches the other session as written.

## Claims

A session claims a branch, worktree or PR (`coord_claim`, `/coord claim`); other sessions' agents are refused git and gh commands that would change it until it is released or the session ends.

**Claims are a guard against mistakes, not a lock.** They match command text:

- a git command that changes a claimed worktree: run in it, after `cd` into it, or with `git -C`. A worktree nested inside a claimed checkout is its own.
- a git command that changes a branch named in it: push (including force-push with `+`), checkout, rebase, reset, …. Commit messages do not count.
- a gh command that changes a claimed PR: `gh pr edit`, `comment`, `merge`, … with the number or URL anywhere outside `--body` and `--title`, and `gh api` writes to `pulls/N` or `issues/N`.

Reading commands always pass, and so does anything written to dodge the patterns.

## Pause and drain

`/coord pause [reason]` or `omp-coord pause` stops every new agent and queued job in the scope while running work finishes; `resume` lifts it. Exempt agents still start.

**Pausing keeps everyone's place.** A slot held for a session when the pause starts stays held, and on resume each held slot gets its full hold time again.

## Decision log

`coord_note`, `/coord note` and `omp-coord note` record a decision every session sees in `/coord` and `coord_status`, numbered and with its author. `/coord notes` and `omp-coord notes` list them. Notes are kept like events (`history.retentionDays`).

## Ports and scratch folders

With `resources.ports`, each session gets its own block of ports, in `OMP_COORD_PORTS` (e.g. `18700-18799`) for every command its agents run; with `resources.scratch`, its own folder in `OMP_COORD_SCRATCH`. An agent that needs ports or a folder of its own (a server, a control port) calls `coord_resources` and gets a share of its session's, the same one each time. A session started when every block was taken gets no ports and is told so.

## After a crash

`/coord interrupted` (or `omp-coord interrupted`, which first drops sessions whose process is gone) lists, per session that left, the agents that were mid-run and the folder the session ran in. omp keeps their transcripts; revive each from a session in that folder with `write agent://<id>`.

`/coord stats` sums waits, refusals, peaks and job outcomes per day; `omp-coord doctor` checks the scope's health, and `doctor --fix` drops sessions and jobs whose process is gone.
