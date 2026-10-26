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

# Cut a release locally: `just release fix|feature|breaking` (or an exact X.Y.Z, e.g. 1.0.0). Bumps the version files, dates the changelog, runs the checks, commits and tags. Pushes nothing.
[group('release')]
release change:
    @bun '{{ root }}/scripts/release.ts' prepare '{{ change }}'

# Publish the release at HEAD: push main and its tag; CI then creates the GitHub release.
[confirm('Push main and the release tag to origin?')]
[group('release')]
release-publish:
    #!/usr/bin/env bash
    set -euo pipefail
    [ "$(git rev-parse --abbrev-ref HEAD)" = main ] || { echo "check out main first: only main is published" >&2; exit 1; }
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

# Start a neutral demo for screenshots: /tmp/demo-shop (2 work slots, scratch state) and two omp sessions in tmux, `demo-a` and `demo-b`.
[group('docs')]
demo:
    #!/usr/bin/env bash
    set -euo pipefail
    project=/tmp/demo-shop state=/tmp/demo-shop-state
    rm -rf "$project" "$state" && mkdir -p "$project" "$state" && cd "$project"
    git init -q -b main && printf '# demo-shop\n' > README.md && git add -A
    git -c user.name=demo -c user.email=demo@example.com commit -qm init
    printf '%s\n' '{' '  "scope": "demo-shop",' \
      '  "agents": { "pools": { "work": { "cap": 2 } }, "exempt": ["reviewer"] },' \
      '  "queues": { "build": { "slots": 1, "order": "fair-share" } },' \
      '  "commands": [{ "pattern": "(^|\\s)npm run build\\b", "action": "queue", "queue": "build" }]' '}' > .omp-coord.json
    for s in demo-a demo-b; do
      tmux new-session -d -s "$s" -x 110 -y 32 -c "$project" "OMP_COORD_STATE_DIR=$state exec omp --no-extensions -e '{{ root }}/src/index.ts'"
      sleep 4
    done
    echo "Sessions demo-a and demo-b are running in $project; drive them with tmux attach -t demo-a (see AGENTS.md, Screenshots)."

# Render a tmux pane to a PNG, e.g. `just screenshot demo-b docs/images/spawn-refused.png 1 32`.
[group('docs')]
screenshot target out first='1' last='$':
    '{{ root }}/scripts/screenshot.sh' '{{ target }}' '{{ out }}' '{{ first }}' '{{ last }}'

# Stop the demo sessions and delete the demo project and its state.
[group('docs')]
demo-stop:
    -tmux kill-session -t demo-a
    -tmux kill-session -t demo-b
    rm -rf /tmp/demo-shop /tmp/demo-shop-state
