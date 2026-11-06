/**
 * Which `git` subcommands change something, in one place for the two guards that ask: protected checkouts
 * (`protect.ts`) judge the ones that change a checkout's files, index or HEAD, and claims (`claims.ts`) also the ones
 * that change refs or a remote. What each changes:
 * - `tree`: the files, the index or HEAD of the checkout it runs in.
 * - `refs`: branches, tags, the stash or a remote, not the checkout's files (`push` stays allowed in a protected checkout).
 * `branch` is not listed: most uses only read; `branch -d/-D/-m/-M/-f` is a claims pattern of its own.
 */
const GIT_CHANGES: Record<string, "tree" | "refs"> = {
  checkout: "tree",
  switch: "tree",
  reset: "tree",
  restore: "tree",
  clean: "tree",
  rebase: "tree",
  merge: "tree",
  commit: "tree",
  pull: "tree",
  "cherry-pick": "tree",
  revert: "tree",
  am: "tree",
  add: "tree",
  rm: "tree",
  mv: "tree",
  apply: "tree",
  bisect: "tree",
  push: "refs",
  stash: "refs",
  tag: "refs",
};

/** Whether `sub` changes a checkout's files, index or HEAD. */
export function isGitChange(sub: string): boolean {
  return Object.hasOwn(GIT_CHANGES, sub) && GIT_CHANGES[sub] === "tree";
}

/**
 * Matches `git <subcommand>` anywhere in a command line for any subcommand that changes a checkout, a branch, a tag,
 * the stash or a remote, allowing `-C <dir>` and other global options between.
 */
export const GIT_CHANGE_TEXT = new RegExp(
  String.raw`\bgit\b(?:\s+-C\s+\S+)?(?:\s+-[^\s]+)*\s+(?:${[...Object.keys(GIT_CHANGES), String.raw`branch\s+-[dDmMf]`].join("|")})\b`,
);
