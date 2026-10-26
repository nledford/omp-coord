# Versioning and releases

Releases follow [Semantic Versioning](https://semver.org/) and are tagged `vX.Y.Z`; [CHANGELOG.md](../CHANGELOG.md) lists what each one changed.

## The contract

The version covers:

- the `.omp-coord.json` fields, their defaults and what they accept ([configuration](configuration.md));
- the `omp-coord` subcommands, flags and exit codes (75, 124, 2) ([commands](commands.md));
- the fields of `omp-coord status --json` ([commands](commands.md#status));
- the agent tools (`coord_*`) and their parameters, and the `/coord` commands;
- the environment variables it sets or reads (`OMP_COORD_*`);
- the event types and fields in the event log, and the decision log ([event log](event-log.md));
- the minimum omp version;
- the package name (`@nledford/omp-coord`) and the marketplace plugin name (`omp-coord@omp-coord`) that install and upgrade it.

Not covered: the wording of messages and reports, the other state tables (rebuilt as sessions come and go), and anything under `src/` that the above does not expose.

## Which number moves

| Change | Before 1.0.0 | From 1.0.0 |
|---|---|---|
| Breaks the contract: a removed or renamed field, flag, tool or event; a narrower accepted value; a changed default or exit code; a higher minimum omp version | minor (0.3.4 → 0.4.0) | major |
| Adds to it without breaking: a new field, flag, tool, event or event field | patch (0.3.4 → 0.3.5) | minor |
| Fixes behavior to match the documentation | patch | patch |

1.0.0 comes when the contract is declared stable, after real use in a project. Until then, read the changelog before upgrading across a minor version.

There are no prereleases (`-rc.1` and the like): the marketplace catalog follows `main`, and omp would move every marketplace install onto one.

## Cutting a release

From `main`, with a clean work tree, not behind `origin/main`:

```sh
just release-plan              # commits and changelog since the last release; the next version for each kind of change
just release fix               # or feature, breaking, or an exact version such as 1.0.0
just release-publish           # asks, then pushes main and the tag; CI checks it and creates the GitHub release
```

`just release` refuses an empty Unreleased section in the changelog, sets the version in `package.json` and the marketplace catalog, dates the changelog, runs the checks, then commits `Release vX.Y.Z` and tags it, all locally. If anything fails before the commit, the files are put back. The version changes only in release commits, because omp upgrades marketplace installs only when the catalog's version goes up.

The release workflow checks that the tag is on `main` and matches the version files and the changelog, runs the checks on macOS, and creates the GitHub release with the changelog entry as its notes.
