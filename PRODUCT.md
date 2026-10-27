---
productmd: 1
register: product
---

# omp-coord

Shared agent caps, build queues and messages for several omp sessions on one machine.
One agreement, enforced, instead of rules agents are asked to remember.

## Register

product

## Users

Developers who run two or more [omp](https://github.com/can1357/oh-my-pi) sessions side by side on one project, each starting several subagents, on a laptop or workstation that cannot run everything at once. They already split work between sessions by hand: inbox files, `CLAIM` messages, a shared cap they add up themselves, `flock` scripts for builds. They know their build and their agents; they want the machine to keep the agreement for them.

The second reader is the coding agent inside those sessions. It sees omp-coord as refusals with reasons, messages from other sessions, and three tools.

## Problem

Without it, sessions only coordinate by convention, and conventions break under load:

- Agents start more agents than agreed (26 against a cap of 8), because the cap lives in a rule file.
- A slot taken by hand is never given back when the agent finishes or crashes.
- One session with many agents wins every race for a build slot; another session's single test waits 15 minutes.
- Raw `cargo test` and `pkill` from agents load the machine or kill other agents' builds.
- A message to the other session needs a file watcher that dies with every restart.

## Product Purpose

omp-coord turns those conventions into checks omp runs. A session alone in its scope has its spawns past the cap wait in omp's own queue; with other sessions, a spawn over the shared cap is refused, with the session's place in line, and the next free slot is held for the session refused first. Build and test commands wait for a queue slot shared by every process in the project. Sessions see each other by letter and send each other messages that arrive in the conversation. Everything that happens goes to an event log in SQLite.

Success: no agent starts over the cap; no slot stays taken after its process is gone (within about 10 seconds); every wait is recorded; users delete the rules omp-coord now enforces from their agent instructions.

## Brand Personality

Plain, exact, unexcited. The voice of a careful colleague holding a door.

### Tone

- Refusals say what is full, where the session stands, and what happens next: `FULL: 8/8 work slots are in use across all sessions. This session is #2 in line…`.
- Messages to agents say where they come from and that they are not from the user.
- Numbers over adjectives: counts, minutes, slots.
- No emoji, no exclamation marks, no colour that carries meaning on its own.

## Anti-references

- Refusals MUST NOT be silent or vague; every refusal names its reason and the next step.
- omp-coord MUST NOT stop work it cannot verify: if the shared board cannot be read, spawns go through with an error notice.
- MUST NOT stop agents or jobs that are already running to enforce a cap; caps only refuse new work.
- MUST NOT store message text in the event log.
- No daemon, no network service, no account.

## Design Principles

1. Enforce at the point of action (omp's spawn check, the bash call, the runner), never by asking agents to remember.
2. Never wait where omp gives a deadline: refuse at once and hold the next slot instead.
3. Fair before fast: the session refused first gets the next slot; sessions take turns in fair-share queues.
4. Fail open for agreements, closed for nothing: the cap is a cooperative agreement, not a security boundary.
5. Every decision is an event someone can query later.
6. Project policy stays in the project's config; the plugin stays generic.

## Accessibility & Inclusion

- All output is plain text, readable in any terminal, screen reader or log; nothing depends on colour.
- Times are shown in the user's local clock format; durations in minutes and seconds.

## Offer

Free and open source under the MIT license. No paid tier, no telemetry.

```json product.md#pricing
{ "model": "free", "price": 0, "license": "MIT" }
```

## Boundaries

- One machine only. Sessions find each other through a shared folder, not a network.
- Not a security boundary: any process of the same user can bypass it.
- Not a build system or CI: it decides when a command may run, not what it runs.
- Not a replacement for omp's own `task.maxConcurrency`: while a session is alone the extension sets it to what the caps allow (a value you set stays the ceiling); otherwise it still limits one session as you set it.
- Early: not yet used beyond its author's project.

## Stack

- [README.md](README.md): what it is, quick start; [docs/](docs/README.md): install, configuration, how it works, reference.
- [AGENTS.md](AGENTS.md): code layout and conventions for coding agents.
- [examples/omp-coord.json](examples/omp-coord.json): a complete configuration.
