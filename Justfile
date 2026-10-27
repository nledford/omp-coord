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

# Format, organize imports and apply safe lint fixes (Biome; Markdown is left alone).
[group('quality')]
fmt:
    bun run format

# Check formatting and lint rules without changing files, as CI does.
[group('quality')]
lint:
    bun run lint

# Run tests; pass file names or `-t <pattern>` to narrow them.
[group('quality')]
test *args='':
    bun test {{ args }}

# Run the full local check: typecheck, lint, every test, and the version files agreeing. Run before each commit.
[group('quality')]
check: typecheck lint test
    @bun '{{ root }}/scripts/release.ts' verify

# Show what a release would contain and the next version for each kind of change.
[group('release')]
release-plan:
    @bun '{{ root }}/scripts/release.ts' plan

# Cut a release locally: `just release fix|feature|breaking` (or an exact X.Y.Z, e.g. 1.0.0). On a new release-vX.Y.Z branch: bumps the version files, dates the changelog, runs the checks, commits. Pushes nothing; `main` changes only by pull request.
[group('release')]
release change:
    @bun '{{ root }}/scripts/release.ts' prepare '{{ change }}'

# Push the release-vX.Y.Z branch `just release` made and open its pull request, with the changelog entry as the body.
[group('release')]
release-pr:
    #!/usr/bin/env bash
    set -euo pipefail
    branch=$(git rev-parse --abbrev-ref HEAD)
    case "$branch" in release-v*) ;; *) echo "check out the release-vX.Y.Z branch \`just release\` made first" >&2; exit 1 ;; esac
    tag=${branch#release-}
    bun '{{ root }}/scripts/release.ts' verify
    notes=$(bun '{{ root }}/scripts/release.ts' notes "${tag#v}")
    git push --set-upstream origin "$branch"
    gh pr create --base main --head "$branch" --title "Release $tag" --body "$notes"

# Publish the merged release: on an up-to-date main whose version has no tag yet, tag main's head and push only the tag; CI then creates the GitHub release.
[confirm('Tag main and push the release tag to origin?')]
[group('release')]
release-publish:
    #!/usr/bin/env bash
    set -euo pipefail
    [ "$(git rev-parse --abbrev-ref HEAD)" = main ] || { echo "check out main first: only main is published" >&2; exit 1; }
    git fetch --quiet origin main --tags
    [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || { echo "main is not at origin/main: pull first (the release PR must be merged)" >&2; exit 1; }
    [ -z "$(git status --porcelain)" ] || { echo "the work tree has uncommitted changes" >&2; exit 1; }
    tag="v$(bun -e 'console.log(require("{{ root }}/package.json").version)')"
    ! git rev-parse -q --verify "refs/tags/$tag" >/dev/null || { echo "$tag is tagged already: nothing to publish (run \`just release <change>\` for a new one)" >&2; exit 1; }
    # grep reads all of git log's output (no -q): under pipefail, an early exit would kill git log and read as "absent"
    git log --format=%s -n 50 origin/main | grep -x "Release $tag" >/dev/null || { echo "main holds no \"Release $tag\" commit: merge the release PR first" >&2; exit 1; }
    bun '{{ root }}/scripts/release.ts' verify "$tag"
    git tag --annotate "$tag" --message "omp-coord $tag"
    git push origin "refs/tags/$tag"
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
