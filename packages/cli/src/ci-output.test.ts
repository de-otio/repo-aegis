// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Tests for the two CI-facing guarantees added in 0.8.0:
//
//   1. `--redact-attribution` removes every engagement id from output bound
//      for a publication channel.
//   2. `--min-patterns` / `--require-deny-set` refuse to report a result from
//      a deny set that is smaller than the caller demanded.
//
// The load-bearing test here is the ORACLE test: rather than asserting that
// specific keys were removed (which only ever covers the keys someone thought
// of), it serialises the entire payload and greps it for the literal
// engagement ids the fixture registry was built with. A new
// attribution-bearing field added anywhere in the tree fails it.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureOutputAsync, withEnvAsync } from "./_test-utils.js";
import { audit } from "./commands/audit.js";
import { check } from "./commands/check.js";

let tmp: string;

// Distinctive enough that a substring hit in the payload is unambiguous, and
// unlikely to collide with a path, a git sha, or a JSON key.
const ENGAGEMENT_A = "zqx-engagement-alpha";
const ENGAGEMENT_B = "zqx-engagement-beta";
const MARKER_A = "alpha-secret-token-xyzzy";

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "repo-aegis-ci-output-test-"));
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function setupHome(name: string, fileSpec: Record<string, string[]>): string {
  const home = join(tmp, name + "-home");
  const markersDir = join(home, "markers");
  mkdirSync(markersDir, { recursive: true });
  mkdirSync(join(home, "state"), { recursive: true });
  for (const [stem, patterns] of Object.entries(fileSpec)) {
    writeFileSync(join(markersDir, `${stem}.txt`), patterns.join("\n") + "\n");
  }
  return home;
}

function makeRepo(
  name: string,
  opts: { class?: string; engagements?: string[]; remote?: string } = {},
): string {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  if (opts.class) execFileSync("git", ["config", "repo-aegis.class", opts.class], { cwd: dir });
  for (const e of opts.engagements ?? []) {
    execFileSync("git", ["config", "--add", "repo-aegis.engagement", e], { cwd: dir });
  }
  if (opts.remote) execFileSync("git", ["remote", "add", "origin", opts.remote], { cwd: dir });
  return dir;
}

function commit(repo: string, files: Record<string, string>, message: string): void {
  for (const [path, content] of Object.entries(files)) {
    writeFileSync(join(repo, path), content);
    execFileSync("git", ["add", path], { cwd: repo });
  }
  execFileSync("git", ["commit", "-q", "-m", message], { cwd: repo });
}

/**
 * The fixture shape used by most tests below: a repo that carries engagement A
 * (so A's markers are NOT in its deny set) while engagement B's are, plus a
 * tracked file that trips B.
 */
function engagementFixture(name: string): { home: string; repo: string } {
  const home = setupHome(name, {
    _always: ["never-matches-anything-zzz"],
    [ENGAGEMENT_A]: [MARKER_A],
    [ENGAGEMENT_B]: ["beta-secret-token-plugh"],
  });
  const repo = makeRepo(name + "-repo", {
    class: "customer-coupled",
    engagements: [ENGAGEMENT_A],
  });
  commit(repo, { "notes.txt": "mentions beta-secret-token-plugh here" }, "init");
  return { home, repo };
}

describe("--redact-attribution — oracle", () => {
  it("audit --json emits no engagement id anywhere in the payload", async () => {
    const { home, repo } = engagementFixture("oracle-audit");
    const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() =>
        audit({ cwd: repo, json: true, hooksCheck: false, redactAttribution: true }),
      ),
    );

    // The scan must actually have found something — a redaction test over an
    // empty result proves nothing.
    const j = JSON.parse(result.stdout) as { checks: { name: string; ok: boolean }[] };
    const marker = j.checks.find(c => c.name === "marker-scan");
    assert.equal(marker!.ok, false, "fixture should trip the deny set");

    for (const id of [ENGAGEMENT_A, ENGAGEMENT_B]) {
      assert.ok(
        !result.stdout.includes(id),
        `redacted audit output must not contain engagement id ${id}\n${result.stdout}`,
      );
    }
  });

  it("check --json emits no engagement id anywhere in the payload", async () => {
    const { home, repo } = engagementFixture("oracle-check");
    const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() =>
        check({ cwd: repo, json: true, path: join(repo, "notes.txt"), redactAttribution: true }),
      ),
    );
    assert.equal(result.exitCode, 1, "fixture should trip the deny set");
    for (const id of [ENGAGEMENT_A, ENGAGEMENT_B]) {
      assert.ok(
        !result.stdout.includes(id),
        `redacted check output must not contain engagement id ${id}\n${result.stdout}`,
      );
    }
  });

  it("a CLEAN audit also emits no engagement id — redaction is not conditional on findings", async () => {
    // The regression this pins: `engagements: repo.engagements` is emitted on
    // every run, so a repo with zero hits still published its full engagement
    // list. A redaction keyed on "did we find anything" would pass every other
    // test in this file and still leak on the common case.
    const home = setupHome("oracle-clean", {
      _always: ["never-matches-anything-zzz"],
      [ENGAGEMENT_B]: ["beta-secret-token-plugh"],
    });
    const repo = makeRepo("oracle-clean-repo", {
      class: "customer-coupled",
      engagements: [ENGAGEMENT_A],
    });
    commit(repo, { "README.md": "nothing interesting here" }, "init");

    // remoteCheck off: the fixture has no origin remote, and a
    // customer-coupled repo without one fails that check — which would make
    // this a "has findings" case and defeat the point of the test.
    const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() =>
        audit({
          cwd: repo,
          json: true,
          hooksCheck: false,
          remoteCheck: false,
          redactAttribution: true,
        }),
      ),
    );
    assert.equal(result.exitCode, undefined, "fixture should be clean");
    assert.ok(!result.stdout.includes(ENGAGEMENT_A), "clean audit leaked an engagement id");
  });

  it("text output redacts the [engagement] suffix too", async () => {
    // A public repo's job log is as readable as a PR comment; --json is not
    // the only channel.
    const { home, repo } = engagementFixture("oracle-text");
    const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() =>
        check({ cwd: repo, path: join(repo, "notes.txt"), redactAttribution: true }),
      ),
    );
    assert.equal(result.exitCode, 1);
    assert.ok(!result.stdout.includes(ENGAGEMENT_B), "text output leaked an engagement id");
    assert.match(result.stdout, /attribution redacted/);
  });

  it("REPO_AEGIS_REDACT_ATTRIBUTION=1 has the same effect as the flag", async () => {
    const { home, repo } = engagementFixture("oracle-env");
    const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      withEnvAsync("REPO_AEGIS_REDACT_ATTRIBUTION", "1", () =>
        captureOutputAsync(() => audit({ cwd: repo, json: true, hooksCheck: false })),
      ),
    );
    assert.ok(!result.stdout.includes(ENGAGEMENT_B), "env-driven redaction did not apply");
  });
});

describe("--redact-attribution — what survives", () => {
  it("keeps the finding actionable: path, line, and counts remain", async () => {
    const { home, repo } = engagementFixture("survives");
    const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() =>
        check({ cwd: repo, json: true, path: join(repo, "notes.txt"), redactAttribution: true }),
      ),
    );
    const j = JSON.parse(result.stdout) as {
      hits: { path?: string; line: number; column: number; matchPreview: string }[];
      engagementsAffected: number;
      attributionRedacted: boolean;
      denySet: { files: string[]; patternCount: number };
    };
    assert.equal(j.attributionRedacted, true);
    assert.ok(j.hits.length > 0);
    assert.ok(j.hits[0]!.path?.includes("notes.txt"), "path must survive redaction");
    assert.equal(typeof j.hits[0]!.line, "number");
    assert.equal(j.engagementsAffected, 1, "the aggregate replaces per-hit attribution");
    // denySet.files is a list of marker-file stems — engagement ids by another
    // name. Redacted in place so the count still reports.
    assert.ok(j.denySet.files.includes("_always"), "_always is publishable and must remain");
    assert.ok(j.denySet.files.includes("<redacted>"), "engagement stems must be masked");
    assert.ok(j.denySet.patternCount > 0);
  });

  it("without the flag, attribution is present — local output is unchanged", async () => {
    const { home, repo } = engagementFixture("unredacted");
    const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() => check({ cwd: repo, json: true, path: join(repo, "notes.txt") })),
    );
    const j = JSON.parse(result.stdout) as {
      hits: { engagement?: string }[];
      attributionRedacted?: boolean;
    };
    assert.equal(j.hits[0]!.engagement, ENGAGEMENT_B, "local runs keep attribution");
    assert.equal(j.attributionRedacted, undefined, "flag-off output keeps its original shape");
  });
});

describe("--min-patterns / --require-deny-set", () => {
  it("exits 2 when the deny set is empty and a floor is demanded", async () => {
    // The fork-PR failure: the registry never arrived, so nothing was scanned
    // — which must not be reported as a clean scan.
    const home = setupHome("floor-empty", {});
    const repo = makeRepo("floor-empty-repo", { class: "private-strict" });
    commit(repo, { "README.md": "hello" }, "init");

    const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() =>
        audit({ cwd: repo, json: true, hooksCheck: false, requireDenySet: true }),
      ),
    );
    assert.equal(result.exitCode, 2, "a gate that could not run must not exit 0");
    assert.match(result.stderr, /DENY_SET_BELOW_FLOOR/);
  });

  it("without the floor, the same empty deny set still exits 0 — the default is unchanged", async () => {
    const home = setupHome("floor-default", {});
    const repo = makeRepo("floor-default-repo", { class: "private-strict" });
    commit(repo, { "README.md": "hello" }, "init");
    const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() => audit({ cwd: repo, json: true, hooksCheck: false })),
    );
    assert.equal(result.exitCode, undefined);
  });

  it("passes when the deny set meets the floor", async () => {
    const home = setupHome("floor-ok", { _always: ["aaa", "bbb", "ccc"] });
    const repo = makeRepo("floor-ok-repo", { class: "private-strict" });
    commit(repo, { "README.md": "hello" }, "init");
    const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() =>
        audit({ cwd: repo, json: true, hooksCheck: false, minPatterns: 3 }),
      ),
    );
    assert.equal(result.exitCode, undefined);
  });

  it("exits 2 when the deny set is non-empty but below an explicit floor", async () => {
    // Catches the softer version of the same failure: a registry that loaded
    // but silently lost an engagement.
    const home = setupHome("floor-short", { _always: ["aaa"] });
    const repo = makeRepo("floor-short-repo", { class: "private-strict" });
    commit(repo, { "README.md": "hello" }, "init");
    const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() =>
        audit({ cwd: repo, json: true, hooksCheck: false, minPatterns: 5 }),
      ),
    );
    assert.equal(result.exitCode, 2);
  });

  it("REPO_AEGIS_MIN_PATTERNS applies the floor from the environment", async () => {
    const home = setupHome("floor-env", {});
    const repo = makeRepo("floor-env-repo", { class: "private-strict" });
    commit(repo, { "README.md": "hello" }, "init");
    const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      withEnvAsync("REPO_AEGIS_MIN_PATTERNS", "1", () =>
        captureOutputAsync(() => audit({ cwd: repo, json: true, hooksCheck: false })),
      ),
    );
    assert.equal(result.exitCode, 2);
  });

  it("check fires the floor before its own no-deny-set early return", async () => {
    // `check` has a path that exits 0 with `status: "no-deny-set"`. That is
    // precisely the outcome the floor exists to reject, so the floor has to
    // run first.
    const home = setupHome("floor-check", {});
    const repo = makeRepo("floor-check-repo", { class: "private-strict" });
    commit(repo, { "README.md": "hello" }, "init");
    const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() =>
        check({ cwd: repo, json: true, path: join(repo, "README.md"), requireDenySet: true }),
      ),
    );
    assert.equal(result.exitCode, 2);
    assert.ok(!result.stdout.includes("no-deny-set"), "must not emit a clean-looking result");
  });
});
