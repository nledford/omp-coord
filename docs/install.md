# Install

Requires omp 18.12 or later. No dependencies at runtime: the extension and the runner use the Bun built into omp.

## From GitHub Packages

Each release is published as the npm package `@nledford/omp-coord` to GitHub Packages. It is private like the repository, and GitHub Packages asks for a token even for public packages, so each machine needs one-time setup: a token that can read packages, and the `@nledford` scope pointed at GitHub's registry in `~/.npmrc`.

```sh
gh auth refresh --scopes read:packages      # once: let the GitHub CLI's token read packages
cat >> ~/.npmrc <<EOF
@nledford:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=$(gh auth token)
EOF
```

Then install a release, or the newest one:

```sh
omp plugin install @nledford/omp-coord@0.2.0
omp plugin install @nledford/omp-coord
```

## From GitHub

Over SSH. The repository is private for now, and the `github:` shorthand and HTTPS URLs fail without credentials; `github:nledford/omp-coord` works once it is public:

```sh
omp plugin install "git+ssh://git@github.com/nledford/omp-coord.git"
```

Or through omp's marketplace, which this repository also serves:

```sh
omp plugin marketplace add git@github.com:nledford/omp-coord.git
omp plugin install omp-coord@omp-coord
```

## Updating

`omp plugin upgrade @nledford/omp-coord` moves a package or git URL install to the newest release or commit; `omp plugin upgrade omp-coord@omp-coord` moves a marketplace install once a release has raised the catalog's version. Bun remembers the commit a git URL resolved to, so installing a git URL again can bring back an older commit; to pin a release over git, add its tag: `…/omp-coord.git#v0.2.0`. [CHANGELOG.md](../CHANGELOG.md) lists what each release changed.

## From a checkout

Link it instead: `omp plugin install /path/to/omp-coord`, or load it for one run with `omp -e /path/to/omp-coord/src/index.ts`.

## The `omp-coord` command

For scripts and terminals: `bun link` in the checkout puts it on `PATH` (`~/.bun/bin`). Without Bun, call it through omp: `BUN_BE_BUN=1 omp /path/to/omp-coord/src/adapters/cli/cli.ts <subcommand>`.

## Turning it on in a project

The extension stays inactive in a session unless it finds a `.omp-coord.json` in the session's folder or a parent folder (so every worktree below a checkout uses the checkout's file), or the file named by `OMP_COORD_CONFIG`. See [configuration](configuration.md). Run `omp-coord doctor` in the project to check the setup.
