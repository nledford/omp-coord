# omp-coord documentation

Setting up:

- [Install](install.md): plugin install, updating, the `omp-coord` command.
- [Configuration](configuration.md): every `.omp-coord.json` field.

How it works:

- [Agent slots and the line](agent-slots.md): caps, holds, revivals, agents started by subagents.
- [Build and test queues](queues.md): `omp-coord run`, order, lanes, time limits, agents' commands.
- [Working across sessions](coordination.md): messages, claims, pause, the decision log, ports, crash recovery.

Reference:

- [Commands](commands.md): `/coord`, the agent tools, `omp-coord`, environment variables.
- [State and event log](event-log.md): the SQLite tables, event types, example queries.
- [Versioning and releases](versioning.md): what the version promises, and how releases are cut.

Contributing: [AGENTS.md](../AGENTS.md) covers the code layout and conventions.
