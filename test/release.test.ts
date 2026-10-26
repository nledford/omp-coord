import { describe, expect, test } from "bun:test";
import {
  changelogSection,
  compareVersions,
  cutChangelog,
  formatVersion,
  latestRelease,
  nextVersion,
  parseVersion,
  setJsonVersion,
} from "../scripts/release.ts";

const next = (v: string, c: "breaking" | "feature" | "fix") => formatVersion(nextVersion(parseVersion(v), c));

describe("next version", () => {
  test("before 1.0.0, a breaking change moves the minor version and anything else the patch version", () => {
    expect(next("0.3.4", "breaking")).toBe("0.4.0");
    expect(next("0.3.4", "feature")).toBe("0.3.5");
    expect(next("0.3.4", "fix")).toBe("0.3.5");
  });

  test("from 1.0.0 on, breaking, feature and fix move major, minor and patch, resetting what follows", () => {
    expect(next("1.4.2", "breaking")).toBe("2.0.0");
    expect(next("1.4.2", "feature")).toBe("1.5.0");
    expect(next("1.4.2", "fix")).toBe("1.4.3");
  });
});

describe("versions and tags", () => {
  test("ordering is numeric per field, not textual", () => {
    const sorted = ["1.0.0", "0.10.0", "0.9.12", "0.9.2", "2.0.0"].map(parseVersion).sort(compareVersions).map(formatVersion);
    expect(sorted).toEqual(["0.9.2", "0.9.12", "0.10.0", "1.0.0", "2.0.0"]);
  });

  test("the last release is the highest vX.Y.Z tag, not the newest or the last listed; other tags are ignored", () => {
    expect(latestRelease(["v0.9.0", "v0.10.0", "v0.2.0", "nightly", "v1.0", "v0.11.0-rc.1"])).toEqual({ major: 0, minor: 10, patch: 0 });
    expect(latestRelease(["nightly"])).toBeUndefined();
  });

  test("malformed versions and prereleases are rejected", () => {
    for (const bad of ["v1.2.3", "1.2", "01.2.3", "1.2.3-", "1.2.3-rc.1"]) expect(() => parseVersion(bad)).toThrow(/not a release version/);
  });
});

describe("changelog", () => {
  const log = [
    "# Changelog",
    "",
    "## [Unreleased]",
    "",
    "### Fixed",
    "",
    "- Pause keeps held slots.",
    "",
    "## [0.1.0] - 2026-10-26",
    "",
    "- First release.",
    "",
    "[Unreleased]: https://github.com/nledford/omp-coord/compare/v0.1.0...HEAD",
    "[0.1.0]: https://github.com/nledford/omp-coord/releases/tag/v0.1.0",
    "",
  ].join("\n");

  test("cutting a release dates the Unreleased entries under the new version and links it to the previous one", () => {
    const cut = cutChangelog(log, "0.1.1", "2026-11-02", "0.1.0");
    expect(changelogSection(cut, "Unreleased")).toBe("");
    expect(changelogSection(cut, "0.1.1")).toBe("### Fixed\n\n- Pause keeps held slots.");
    expect(changelogSection(cut, "0.1.0")).toBe("- First release.");
    expect(cut).toContain("## [0.1.1] - 2026-11-02");
    expect(cut).toContain("[Unreleased]: https://github.com/nledford/omp-coord/compare/v0.1.1...HEAD\n[0.1.1]: https://github.com/nledford/omp-coord/compare/v0.1.0...v0.1.1\n[0.1.0]:");
  });

  test("the first release links to its tag", () => {
    const first = cutChangelog("# Changelog\n\n## [Unreleased]\n\n- Everything.\n", "0.1.0", "2026-10-26", undefined);
    expect(first).toEndWith(
      "[Unreleased]: https://github.com/nledford/omp-coord/compare/v0.1.0...HEAD\n[0.1.0]: https://github.com/nledford/omp-coord/releases/tag/v0.1.0\n",
    );
  });

  test("a release with nothing in Unreleased, or a version already listed, is refused", () => {
    const empty = cutChangelog(log, "0.1.1", "2026-11-02", "0.1.0");
    expect(() => cutChangelog(empty, "0.1.2", "2026-11-03", "0.1.1")).toThrow(/Unreleased section is empty/);
    expect(() => cutChangelog(log, "0.1.0", "2026-11-02", "0.1.0")).toThrow(/already has a section for 0.1.0/);
  });

  test("a mention of the Unreleased heading in the intro, link definitions inside a section, and CRLF line ends are handled", () => {
    const tricky = [
      "# Changelog",
      "",
      "Add entries under `## [Unreleased]` as they land.",
      "",
      "## [Unreleased]",
      "",
      "- Faster [queues][q].",
      "",
      "[q]: docs/queues.md",
      "",
      "## [0.1.0] - 2026-10-26",
      "",
      "- First release.",
      "",
    ].join("\r\n");
    const cut = cutChangelog(tricky, "0.1.1", "2026-11-02", "0.1.0");
    expect(cut).not.toContain("\r");
    expect(cut).toContain("Add entries under `## [Unreleased]` as they land.\n\n## [Unreleased]\n\n## [0.1.1] - 2026-11-02\n");
    expect(changelogSection(cut, "0.1.1")).toBe("- Faster [queues][q].\n\n[q]: docs/queues.md");
  });
});

test("the version in a JSON file changes in place, and only when it occurs exactly once", () => {
  const pkg = '{\n  "name": "x",\n  "version": "0.1.0",\n  "deps": { "y": "0.1.0" }\n}\n';
  expect(setJsonVersion(pkg, "0.1.0", "0.2.0")).toBe('{\n  "name": "x",\n  "version": "0.2.0",\n  "deps": { "y": "0.1.0" }\n}\n');
  expect(() => setJsonVersion(pkg, "9.9.9", "1.0.0")).toThrow(/found 0/);
});
