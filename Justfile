# omp-coord: workflows for people and agents. `just` lists them.

set shell := ["bash", "-euo", "pipefail", "-c"]

root := justfile_directory()
cli := root / "src/adapters/cli/cli.ts"

# List the workflows.
[group('help')]
default:
    @just --list --unsorted

alias t := test

# Install the pinned dev dependencies (bun.lock).
[group('setup')]
install:
    bun install --frozen-lockfile

# Put `omp-coord` on PATH (~/.bun/bin) from this checkout.
[group('setup')]
link:
    bun link

# Remove the `omp-coord` link from PATH.
[group('setup')]
unlink:
    bun unlink

# Type-check without emitting files.
[group('quality')]
typecheck:
    bun run typecheck

# Run tests; pass file names or `-t <pattern>` to narrow them.
[group('quality')]
test *args='':
    bun test {{ args }}

# Run the full local check: typecheck, every test, and the version files agreeing. Run before each commit.
[group('quality')]
check: typecheck test
    @bun '{{ root }}/scripts/release.ts' verify

# Show what a release would contain and the next version for each kind of change.
[group('release')]
release-plan:
    @bun '{{ root }}/scripts/release.ts' plan

# Cut a release locally: `just release fix|feature|breaking` (or an exact X.Y.Z). Bumps the version files, dates the changelog, runs the checks, commits and tags. Pushes nothing.
[group('release')]
release change:
    @bun '{{ root }}/scripts/release.ts' prepare '{{ change }}'

# Publish the release at HEAD: push main and its tag; CI then creates the GitHub release.
[confirm('Push main and the release tag to origin?')]
[group('release')]
release-publish:
    #!/usr/bin/env bash
    set -euo pipefail
    tag=$(git describe --exact-match --tags --match 'v*' HEAD 2>/dev/null) || { echo "HEAD is not a release commit; run \`just release <change>\` first" >&2; exit 1; }
    bun '{{ root }}/scripts/release.ts' verify "$tag"
    git push --atomic origin main "refs/tags/$tag"
    echo "Pushed $tag. Release workflow: https://github.com/nledford/omp-coord/actions/workflows/release.yml"

# Show the build and test queues of the scope found from the current folder.
[group('use')]
status:
    bun '{{ cli }}' status

# Run a command through a queue, e.g. `just run heavy -- make`.
[group('use')]
[positional-arguments]
run queue *args:
    bun '{{ cli }}' run "$@"

# Start omp with this checkout's extension and a scratch state folder (never the real board).
[group('dev')]
omp-dev state='/tmp/omp-coord-dev/state':
    mkdir -p '{{ state }}'
    OMP_COORD_STATE_DIR='{{ state }}' omp --no-extensions -e '{{ root }}/src/index.ts'

# Read a scratch board's event log, newest last (default: the omp-dev state folder).
[group('dev')]
events scope state='/tmp/omp-coord-dev/state':
    sqlite3 -column -header '{{ state }}/{{ scope }}.db' "select datetime(at/1000,'unixepoch','localtime') t, type, label, data from events order by id"
