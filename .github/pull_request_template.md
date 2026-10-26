## What and why

<!-- What changes for someone using omp-coord, and why. Link the issue if there is one. -->

## Versioning

<!-- docs/versioning.md lists the contract: config fields, CLI subcommands/flags/exit codes, coord_* tools and /coord,
     OMP_COORD_* variables, event types and fields, the minimum omp version, the package and marketplace names. -->

- [ ] No change to the contract (internal, docs or tooling only)
- [ ] Adds to the contract without breaking it
- [ ] Breaks the contract (marked **Breaking:** in the changelog, with what users should do)

## Checklist

- [ ] `just check` passes (typecheck, Biome, tests, version files agreeing)
- [ ] User-visible change: a line under `## [Unreleased]` in `CHANGELOG.md`
- [ ] Behavior change: the matching page under `docs/` is updated
- [ ] Version files untouched (`just release` changes them in the release commit)

## How it was verified

<!-- Commands run and what they showed: tests added, and a real run where it matters (e.g. two omp sessions in tmux
     with a scratch OMP_COORD_STATE_DIR, or `omp-coord run` against a scratch scope). -->

## Screenshots

<!-- Only when what omp shows changes (notices, /coord, the footer). Take them from `just demo` and
     `just screenshot` (see AGENTS.md, "Screenshots"): demo project only, never a real project or state folder. -->
