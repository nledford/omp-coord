#!/usr/bin/env bun
/**
 * Releases: the version policy (README, "Versioning") in code.
 *
 *   bun scripts/release.ts plan                       what would be released, and the next version per kind of change
 *   bun scripts/release.ts prepare <breaking|feature|fix|X.Y.Z[-pre]>
 *                                                     set the version, date the changelog, check, commit, tag (local only)
 *   bun scripts/release.ts verify [vX.Y.Z]            the version files agree (and match the tag, with its changelog entry)
 *   bun scripts/release.ts notes <X.Y.Z>              the changelog entry of a version, for the GitHub release
 *
 * The version lives in package.json and in the marketplace catalog; omp upgrades marketplace installs only when the
 * catalog's version goes up, so both change together, and only in release commits.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const REPO_URL = "https://github.com/nledford/omp-coord";
const FILES = { pkg: "package.json", catalog: ".omp-plugin/marketplace.json", changelog: "CHANGELOG.md" } as const;

export type Change = "breaking" | "feature" | "fix";

export interface Version {
  major: number;
  minor: number;
  patch: number;
  pre: string | undefined;
}

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/;

export function parseVersion(text: string): Version {
  const m = VERSION.exec(text);
  if (!m) throw new Error(`not a version: "${text}" (expected X.Y.Z or X.Y.Z-pre, without a leading v)`);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] };
}

export function formatVersion(v: Version): string {
  return `${v.major}.${v.minor}.${v.patch}${v.pre === undefined ? "" : `-${v.pre}`}`;
}

/** SemVer precedence: negative when a < b. */
export function compareVersions(a: Version, b: Version): number {
  for (const k of ["major", "minor", "patch"] as const) if (a[k] !== b[k]) return a[k] - b[k];
  if (a.pre === b.pre) return 0;
  if (a.pre === undefined) return 1;
  if (b.pre === undefined) return -1;
  const x = a.pre.split(".");
  const y = b.pre.split(".");
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i];
    const q = y[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) - Number(q);
    if (pn) return -1;
    if (qn) return 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/**
 * The next release after `released` for the most significant kind of change in it. Before 1.0.0 a breaking change
 * moves the minor version and everything else the patch version; from 1.0.0 on, breaking, feature and fix move
 * major, minor and patch. A prerelease of the target is replaced by the target itself.
 */
export function nextVersion(released: Version, change: Change): Version {
  const core = { ...released, pre: undefined };
  if (released.pre !== undefined) {
    // Releasing 0.3.0 after 0.3.0-rc.2: the target was chosen when the prerelease was cut.
    return core;
  }
  const level = released.major === 0 ? (change === "breaking" ? "minor" : "patch") : change === "breaking" ? "major" : change === "feature" ? "minor" : "patch";
  if (level === "major") return { major: core.major + 1, minor: 0, patch: 0, pre: undefined };
  if (level === "minor") return { ...core, minor: core.minor + 1, patch: 0 };
  return { ...core, patch: core.patch + 1 };
}

/** The highest released version among `vX.Y.Z` tags, if any. */
export function latestRelease(tags: string[]): Version | undefined {
  return tags
    .filter(t => t.startsWith("v") && VERSION.test(t.slice(1)))
    .map(t => parseVersion(t.slice(1)))
    .sort(compareVersions)
    .at(-1);
}

/** The text of a changelog section, without its heading; undefined when there is no such section. */
export function changelogSection(changelog: string, name: string): string | undefined {
  const lines = changelog.split("\n");
  const start = lines.findIndex(l => l.startsWith(`## [${name}]`));
  if (start === -1) return undefined;
  const end = lines.findIndex((l, i) => i > start && (l.startsWith("## ") || /^\[[^\]]+\]: /.test(l)));
  return lines
    .slice(start + 1, end === -1 ? undefined : end)
    .join("\n")
    .trim();
}

/**
 * Turns the Unreleased section into the section of `version`, dated `date`, under a new empty Unreleased section,
 * and updates the comparison links at the bottom.
 */
export function cutChangelog(changelog: string, version: string, date: string, previous: string | undefined): string {
  const unreleased = changelogSection(changelog, "Unreleased");
  if (unreleased === undefined) throw new Error(`${FILES.changelog} has no "## [Unreleased]" section`);
  if (unreleased === "") throw new Error(`${FILES.changelog}: the Unreleased section is empty; describe the changes in this release first`);
  if (changelogSection(changelog, version) !== undefined) throw new Error(`${FILES.changelog} already has a section for ${version}`);
  const body = changelog.replace("## [Unreleased]", `## [Unreleased]\n\n## [${version}] - ${date}`);
  const versionLink = previous === undefined ? `${REPO_URL}/releases/tag/v${version}` : `${REPO_URL}/compare/v${previous}...v${version}`;
  const links = `[Unreleased]: ${REPO_URL}/compare/v${version}...HEAD\n[${version}]: ${versionLink}`;
  return /^\[Unreleased\]: .*$/m.test(body) ? body.replace(/^\[Unreleased\]: .*$/m, links) : `${body.trimEnd()}\n\n${links}\n`;
}

/** Replaces the `"version": "…"` value in a JSON file's text without reformatting it. */
export function setJsonVersion(text: string, from: string, to: string): string {
  const pattern = new RegExp(`("version"\\s*:\\s*)"${from.replaceAll(".", "\\.")}"`, "g");
  const count = text.match(pattern)?.length ?? 0;
  if (count !== 1) throw new Error(`expected one "version": "${from}", found ${count}`);
  return text.replace(pattern, `$1"${to}"`);
}

// ---------------------------------------------------------------------------------------------------------------------

function read(file: string): string {
  return readFileSync(join(ROOT, file), "utf8");
}

function versions(): { pkg: string; catalog: string } {
  const pkg = (JSON.parse(read(FILES.pkg)) as { version: string }).version;
  const plugin = (JSON.parse(read(FILES.catalog)) as { plugins: { name: string; version?: string }[] }).plugins.find(p => p.name === "omp-coord");
  return { pkg, catalog: plugin?.version ?? "(none)" };
}

async function git(...args: string[]): Promise<string> {
  const p = Bun.spawn(["git", ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err.trim() || `exit ${code}`}`);
  return out.trimEnd();
}

async function released(): Promise<Version | undefined> {
  return latestRelease((await git("tag", "--list", "v*")).split("\n").filter(Boolean));
}

function verify(tag: string | undefined): void {
  const v = versions();
  parseVersion(v.pkg);
  if (v.pkg !== v.catalog) throw new Error(`${FILES.pkg} says ${v.pkg} but ${FILES.catalog} says ${v.catalog}; they must match`);
  if (tag !== undefined) {
    if (tag !== `v${v.pkg}`) throw new Error(`tag ${tag} does not match version ${v.pkg}`);
    if (!changelogSection(read(FILES.changelog), v.pkg)) throw new Error(`${FILES.changelog} has no entry for ${v.pkg}`);
  }
  console.log(`version ${v.pkg}${tag ? `, tag ${tag}` : ""}: ok`);
}

async function plan(): Promise<void> {
  const last = await released();
  const { pkg } = versions();
  const unreleased = changelogSection(read(FILES.changelog), "Unreleased") ?? "";
  const range = last ? `v${formatVersion(last)}..HEAD` : "HEAD";
  const commits = await git("log", "--format=  %h %s", range);
  console.log(`Last release: ${last ? `v${formatVersion(last)}` : "none"}; version files say ${pkg}.`);
  console.log(`\nCommits since: ${commits ? `\n${commits}` : "none"}`);
  console.log(`\nChangelog, Unreleased:\n${unreleased ? unreleased.replace(/^/gm, "  ") : "  (empty: write it before releasing)"}`);
  if (!last) {
    console.log(`\nNo release yet: the first one is \`just release ${pkg}\`.`);
    return;
  }
  console.log("\nNext version, by the most significant change since the last release:");
  for (const c of ["breaking", "feature", "fix"] as const) console.log(`  just release ${c.padEnd(8)}  ${formatVersion(nextVersion(last, c))}`);
}

async function prepare(arg: string | undefined): Promise<void> {
  if (!arg) throw new Error("usage: prepare <breaking|feature|fix|X.Y.Z[-pre]>");
  verify(undefined);
  if (await git("status", "--porcelain")) throw new Error("the work tree has uncommitted changes; commit or stash them first");
  if ((await git("rev-parse", "--abbrev-ref", "HEAD")) !== "main") throw new Error("releases are cut from main");
  await git("fetch", "--quiet", "origin", "main", "--tags");
  if (await git("rev-list", "HEAD..origin/main")) throw new Error("main is behind origin/main; pull first");

  const last = await released();
  const current = versions().pkg;
  let next: Version;
  if (arg === "breaking" || arg === "feature" || arg === "fix") {
    if (!last) throw new Error(`no release yet: name the first version explicitly, e.g. \`just release ${current}\``);
    next = nextVersion(last, arg);
  } else {
    next = parseVersion(arg);
    if (last && compareVersions(next, last) <= 0) throw new Error(`${arg} is not after the last release, ${formatVersion(last)}`);
  }
  const version = formatVersion(next);
  const tag = `v${version}`;
  if (await git("tag", "--list", tag)) throw new Error(`tag ${tag} already exists`);

  const date = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD, local time
  const changelog = cutChangelog(read(FILES.changelog), version, date, last && formatVersion(last));
  const files: Record<string, string> = { [FILES.changelog]: changelog };
  if (version !== current) {
    files[FILES.pkg] = setJsonVersion(read(FILES.pkg), current, version);
    files[FILES.catalog] = setJsonVersion(read(FILES.catalog), current, version);
  }
  for (const [file, text] of Object.entries(files)) writeFileSync(join(ROOT, file), text);

  try {
    verify(undefined);
    const check = Bun.spawn(["bun", "run", "check"], { cwd: ROOT, stdio: ["inherit", "inherit", "inherit"] });
    if ((await check.exited) !== 0) throw new Error("bun run check failed");
  } catch (error) {
    await git("checkout", "--", ...Object.keys(files));
    throw new Error(`${error instanceof Error ? error.message : String(error)}; the version files are back as they were`);
  }
  await git("commit", "--quiet", "-m", `Release ${tag}`, "--", ...Object.keys(files));
  await git("tag", "--annotate", tag, "--message", `omp-coord ${tag}`);
  console.log(`\nCommitted and tagged ${tag} locally. Nothing is pushed.`);
  console.log("Review with `git show`, then publish with `just release-publish` (pushes main and the tag; CI creates the GitHub release).");
  console.log(`To undo before publishing: git tag -d ${tag} && git reset --hard HEAD~1`);
}

if (import.meta.main) {
  const [command, arg] = Bun.argv.slice(2);
  try {
    if (command === "plan") await plan();
    else if (command === "prepare") await prepare(arg);
    else if (command === "verify") verify(arg);
    else if (command === "notes") {
      const notes = arg && changelogSection(read(FILES.changelog), arg);
      if (!notes) throw new Error(`${FILES.changelog} has no entry for ${arg ?? "(no version given)"}`);
      console.log(notes);
    } else throw new Error("usage: release.ts plan | prepare <breaking|feature|fix|X.Y.Z> | verify [vX.Y.Z] | notes <X.Y.Z>");
  } catch (error) {
    console.error(`release: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
