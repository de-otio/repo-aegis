// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { patternId } from "@de-otio/repo-aegis-core";
import { captureOutput, withEnv } from "../_test-utils.js";
import { check } from "./check.js";

let tmp: string;
let originalCwd: string;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "repo-aegis-check-test-"));
  originalCwd = process.cwd();
});

after(() => {
  process.chdir(originalCwd);
  rmSync(tmp, { recursive: true, force: true });
});

afterEach(() => {
  // Always restore the original cwd so a chdir into a deleted tmp dir
  // doesn't break later tests in unrelated suites.
  process.chdir(originalCwd);
});

function setupHome(name: string, fileSpec: Record<string, string[]> = {}): string {
  const home = join(tmp, name + "-home");
  const markersDir = join(home, "markers");
  mkdirSync(markersDir, { recursive: true });
  mkdirSync(join(home, "state"), { recursive: true });
  for (const [stem, patterns] of Object.entries(fileSpec)) {
    writeFileSync(join(markersDir, `${stem}.txt`), patterns.join("\n") + "\n");
  }
  return home;
}

interface RepoOpts {
  class?: string;
  engagements?: string[];
}

function makeRepo(name: string, opts: RepoOpts = {}): string {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  if (opts.class) {
    execFileSync("git", ["config", "repo-aegis.class", opts.class], { cwd: dir });
  }
  for (const e of opts.engagements ?? []) {
    execFileSync("git", ["config", "--add", "repo-aegis.engagement", e], { cwd: dir });
  }
  return dir;
}

function makeNonRepo(name: string): string {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("check — usage errors", () => {
  it("exits 2 with USAGE when no mode flag is given", () => {
    const home = setupHome("usage-zero");
    const repo = makeRepo("usage-zero-repo", { class: "private-strict" });
    process.chdir(repo);
    const result = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() => check({ json: true })),
    );
    assert.equal(result.exitCode, 2);
    const j = JSON.parse(result.stderr) as { code: string; error: string };
    assert.equal(j.code, "USAGE");
    assert.match(j.error, /staged|path|range|history/);
  });

  it("exits 2 with USAGE when multiple mode flags are given", () => {
    const home = setupHome("usage-multi");
    const repo = makeRepo("usage-multi-repo", { class: "private-strict" });
    process.chdir(repo);
    const result = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() => check({ staged: true, history: true, json: true })),
    );
    assert.equal(result.exitCode, 2);
    const j = JSON.parse(result.stderr) as { code: string };
    assert.equal(j.code, "USAGE");
  });
});

describe("check — NOT_GIT_REPO", () => {
  it("--staged outside a git repo exits 2 with NOT_GIT_REPO", () => {
    const home = setupHome("not-git-staged", { _always: ["leak-token"] });
    const notRepo = makeNonRepo("not-git-staged-dir");
    process.chdir(notRepo);
    const result = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() => check({ staged: true, json: true })),
    );
    assert.equal(result.exitCode, 2);
    const j = JSON.parse(result.stderr) as { code: string };
    assert.equal(j.code, "NOT_GIT_REPO");
  });

  it("--range outside a git repo exits 2 with NOT_GIT_REPO", () => {
    const home = setupHome("not-git-range", { _always: ["leak-token"] });
    const notRepo = makeNonRepo("not-git-range-dir");
    process.chdir(notRepo);
    const result = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() => check({ range: "main..HEAD", json: true })),
    );
    assert.equal(result.exitCode, 2);
    const j = JSON.parse(result.stderr) as { code: string };
    assert.equal(j.code, "NOT_GIT_REPO");
  });

  it("--history outside a git repo exits 2 with NOT_GIT_REPO", () => {
    const home = setupHome("not-git-history", { _always: ["leak-token"] });
    const notRepo = makeNonRepo("not-git-history-dir");
    process.chdir(notRepo);
    const result = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() => check({ history: true, json: true })),
    );
    assert.equal(result.exitCode, 2);
    const j = JSON.parse(result.stderr) as { code: string };
    assert.equal(j.code, "NOT_GIT_REPO");
  });
});

describe("check — GIT_ERROR", () => {
  it("--range with an invalid revspec exits 2 with GIT_ERROR", () => {
    // `git diff` here writes its own (locale-dependent) "fatal:" line to
    // the inherited stderr before scanRange throws and check emits the
    // JSON error. We can't rely on parsing the captured stderr as a
    // single JSON document; instead, match the JSON object on a line.
    const home = setupHome("git-error", { _always: ["leak-token"] });
    const repo = makeRepo("git-error-repo", { class: "private-strict" });
    process.chdir(repo);
    const result = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() =>
        check({ range: "definitely-not-a-real-ref..also-bogus", json: true }),
      ),
    );
    assert.equal(result.exitCode, 2);
    // Find the JSON line emitError wrote.
    const jsonLine = result.stderr
      .split("\n")
      .map(l => l.trim())
      .find(l => l.startsWith("{") && l.includes("GIT_ERROR"));
    assert.ok(
      jsonLine,
      `expected a GIT_ERROR JSON line in stderr; got:\n${result.stderr}`,
    );
    const j = JSON.parse(jsonLine!) as { code: string; error: string };
    assert.equal(j.code, "GIT_ERROR");
    assert.match(j.error, /git diff/);
  });
});

describe("check — customer-coupled-without-engagement", () => {
  it("exits 2 with CUSTOMER_COUPLED_NO_ENGAGEMENT when class=customer-coupled and no engagement set", () => {
    const home = setupHome("ccne", { _always: ["leak-token"] });
    const repo = makeRepo("ccne-repo", { class: "customer-coupled" });
    process.chdir(repo);
    const result = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() => check({ staged: true, json: true })),
    );
    assert.equal(result.exitCode, 2);
    const j = JSON.parse(result.stderr) as { code: string };
    assert.equal(j.code, "CUSTOMER_COUPLED_NO_ENGAGEMENT");
  });
});

describe("check — scanFile error path", () => {
  it("--path on a missing file is reported via skipped, not a thrown error", () => {
    // scanFile() handles ENOENT internally by adding the file to
    // `skipped` with reason "unreadable". The check command's
    // try/catch around scanFile is only reached when scanFile itself
    // throws (e.g. OutsideWorkingTreeError). For a missing file, the
    // command exits 0 with an empty hits array.
    const home = setupHome("path-missing", { _always: ["leak-token"] });
    const repo = makeRepo("path-missing-repo", { class: "private-strict" });
    process.chdir(repo);
    const target = join(repo, "does-not-exist.txt");
    const result = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() => check({ path: target, json: true })),
    );
    assert.equal(result.exitCode, undefined);
    const j = JSON.parse(result.stdout) as {
      hits: unknown[];
      skipped: { path: string; reason: string }[];
    };
    assert.equal(j.hits.length, 0);
    assert.ok(j.skipped.some(s => s.path === target && s.reason === "unreadable"));
  });

  it("--path outside the working tree exits 2 (OutsideWorkingTreeError)", () => {
    // This exercises the explicit try/catch -> emitError branch.
    const home = setupHome("path-outside", { _always: ["leak-token"] });
    const repo = makeRepo("path-outside-repo", { class: "private-strict" });
    // A file genuinely outside the repo working tree.
    const outside = join(tmp, "outside-target.txt");
    writeFileSync(outside, "harmless content\n");
    process.chdir(repo);
    const result = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() => check({ path: outside, json: true })),
    );
    assert.equal(result.exitCode, 2);
    const j = JSON.parse(result.stderr) as { error: string };
    assert.match(j.error, /outside the working tree/);
  });
});

describe("check — no-deny-set short-circuit", () => {
  it("returns status:no-deny-set when the markers dir is empty", () => {
    const home = setupHome("empty-markers"); // no fileSpec → empty markers dir
    const repo = makeRepo("empty-markers-repo", { class: "private-strict" });
    process.chdir(repo);
    const result = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() => check({ staged: true, json: true })),
    );
    assert.equal(result.exitCode, undefined);
    const j = JSON.parse(result.stdout) as {
      hits: unknown[];
      skipped: unknown[];
      status: string;
    };
    assert.equal(j.status, "no-deny-set");
    assert.equal(j.hits.length, 0);
  });
});

describe("check — egress (private-registry in a public-facing repo)", () => {
  const PRIVATE = "https://npm.private-registry.example.com/foo/-/foo-1.0.0.tgz";
  const PUBLIC = "https://registry.npmjs.org/foo/-/foo-1.0.0.tgz";
  const lockWith = (url: string): string =>
    JSON.stringify({ packages: { "node_modules/foo": { resolved: url } } });
  const stage = (repo: string, file: string, content: string): void => {
    writeFileSync(join(repo, file), content);
    execFileSync("git", ["add", file], { cwd: repo });
  };
  type EgressJson = { egress: { host: string; file: string; kind: string }[] };

  it("blocks a staged private-registry lockfile in a public-eligible repo with NO deny set", () => {
    const home = setupHome("egress-pub"); // empty markers → no deny set
    const repo = makeRepo("egress-pub-repo", { class: "public-eligible" });
    process.chdir(repo);
    stage(repo, "package-lock.json", lockWith(PRIVATE));
    const result = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() => check({ staged: true, json: true })),
    );
    assert.equal(result.exitCode, 1);
    const j = JSON.parse(result.stdout) as EgressJson;
    assert.ok(
      j.egress.some(e => e.host === "npm.private-registry.example.com" && e.file === "package-lock.json"),
    );
  });

  it("reads the STAGED blob, not the working tree", () => {
    const home = setupHome("egress-staged-blob");
    const repo = makeRepo("egress-staged-blob-repo", { class: "public-eligible" });
    process.chdir(repo);
    stage(repo, "package-lock.json", lockWith(PRIVATE)); // staged = private
    writeFileSync(join(repo, "package-lock.json"), lockWith(PUBLIC)); // working tree = clean, unstaged
    const result = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() => check({ staged: true, json: true })),
    );
    assert.equal(result.exitCode, 1); // the staged (private) blob is what's flagged
    const j = JSON.parse(result.stdout) as EgressJson;
    assert.ok(j.egress.some(e => e.host === "npm.private-registry.example.com"));
  });

  it("does NOT flag in a private-strict repo (private-registry URLs are intended there)", () => {
    const home = setupHome("egress-private");
    const repo = makeRepo("egress-private-repo", { class: "private-strict" });
    process.chdir(repo);
    stage(repo, "package-lock.json", lockWith(PRIVATE));
    const result = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() => check({ staged: true, json: true })),
    );
    assert.equal(result.exitCode, undefined);
    const j = JSON.parse(result.stdout) as { status?: string; egress?: unknown[] };
    // No deny set + no egress findings → the no-deny-set short-circuit.
    assert.equal(j.status, "no-deny-set");
  });

  it("flags a staged .npmrc default registry in a public-eligible repo", () => {
    const home = setupHome("egress-npmrc");
    const repo = makeRepo("egress-npmrc-repo", { class: "public-eligible" });
    process.chdir(repo);
    stage(repo, ".npmrc", "registry=https://npm.private-registry.example.com/\n");
    const result = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() => check({ staged: true, json: true })),
    );
    assert.equal(result.exitCode, 1);
    const j = JSON.parse(result.stdout) as EgressJson;
    assert.ok(j.egress.some(e => e.file === ".npmrc" && e.kind === "npmrc"));
  });
});

/**
 * `--push-ref`: the pre-push path for a ref the remote does not have yet.
 *
 * Each repo here gets a real local bare remote and a real push, so
 * `refs/remotes/origin/*` exist for the resolver to compare against.
 */
describe("check — --push-ref", () => {
  function makeRepoWithRemote(name: string, opts: RepoOpts = {}): string {
    const dir = makeRepo(name, opts);
    const remote = join(tmp, `${name}-remote.git`);
    mkdirSync(remote, { recursive: true });
    execFileSync("git", ["init", "--bare", "-q", remote]);
    execFileSync("git", ["remote", "add", "origin", remote], { cwd: dir });
    return dir;
  }

  function commit(dir: string, file: string, content: string, msg: string): void {
    writeFileSync(join(dir, file), content);
    execFileSync("git", ["add", file], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", msg], { cwd: dir });
  }

  it("exits 0 with rangeMode nothing-new for a tag on an already-pushed commit", () => {
    // The incident this mode exists for: the historical marker below is
    // already on the remote, so pushing a tag that points at it must not
    // re-scan (and re-block on) the whole history.
    const home = setupHome("pushref-tag", { _always: ["zzq-historic-marker"] });
    const repo = makeRepoWithRemote("pushref-tag-repo", { class: "private-strict" });
    commit(repo, "f.txt", "zzq-historic-marker\n", "init");
    execFileSync("git", ["push", "-q", "origin", "main"], { cwd: repo });
    execFileSync("git", ["tag", "v1"], { cwd: repo });
    process.chdir(repo);

    const result = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() => check({ pushRef: "refs/tags/v1", json: true })),
    );
    assert.equal(result.exitCode, undefined, "a tag exposing nothing new must not block the push");
    const j = JSON.parse(result.stdout) as {
      mode: string;
      rangeMode: string;
      base?: string;
      hits: unknown[];
    };
    assert.equal(j.mode, "push-ref");
    assert.equal(j.rangeMode, "nothing-new");
    assert.equal(j.base, undefined);
    assert.equal(j.hits.length, 0);
  });

  it("text output for nothing-new names the remote it compared against", () => {
    const home = setupHome("pushref-text", { _always: ["zzq-historic-marker"] });
    const repo = makeRepoWithRemote("pushref-text-repo", { class: "private-strict" });
    commit(repo, "f.txt", "zzq-historic-marker\n", "init");
    execFileSync("git", ["push", "-q", "origin", "main"], { cwd: repo });
    execFileSync("git", ["tag", "v1"], { cwd: repo });
    process.chdir(repo);

    const result = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() => check({ pushRef: "refs/tags/v1" })),
    );
    assert.equal(result.exitCode, undefined);
    // The release-tag case: the whole output is the nothing-new line. No
    // waiver applied, so nothing is said about waivers — this is the message
    // an operator sees on every release push, and it must stay one line.
    assert.equal(
      result.stdout.trim(),
      "repo-aegis: nothing new to scan (ref already reachable from origin)",
    );
  });

  it("exits 1 on a marker in the one never-pushed commit a new branch carries", () => {
    const home = setupHome("pushref-hit", {
      _always: ["zzq-historic-marker", "zzq-fresh-marker"],
    });
    const repo = makeRepoWithRemote("pushref-hit-repo", { class: "private-strict" });
    commit(repo, "old.txt", "zzq-historic-marker\n", "init");
    execFileSync("git", ["push", "-q", "origin", "main"], { cwd: repo });
    execFileSync("git", ["checkout", "-q", "-b", "feature"], { cwd: repo });
    commit(repo, "new.txt", "zzq-fresh-marker\n", "leak");
    process.chdir(repo);

    const result = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() => check({ pushRef: "refs/heads/feature", json: true })),
    );
    assert.equal(result.exitCode, 1);
    const j = JSON.parse(result.stdout) as {
      rangeMode: string;
      hits: { path?: string }[];
    };
    assert.equal(j.rangeMode, "incremental");
    assert.equal(j.hits.length, 1, "only the new commit is in scope");
    assert.equal(j.hits[0]!.path, "new.txt");
  });

  it("--remote defaults to origin", () => {
    // Same fixture as the nothing-new case, with the flag omitted: if the
    // default were wrong, no remote-tracking refs would match and the mode
    // would fall back to full-history (and the historical marker would fire).
    const home = setupHome("pushref-default-remote", { _always: ["zzq-historic-marker"] });
    const repo = makeRepoWithRemote("pushref-default-remote-repo", { class: "private-strict" });
    commit(repo, "f.txt", "zzq-historic-marker\n", "init");
    execFileSync("git", ["push", "-q", "origin", "main"], { cwd: repo });
    execFileSync("git", ["tag", "v1"], { cwd: repo });
    process.chdir(repo);

    const result = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() => check({ pushRef: "refs/tags/v1", json: true })),
    );
    assert.equal(result.exitCode, undefined);
    const j = JSON.parse(result.stdout) as { rangeMode: string };
    assert.equal(j.rangeMode, "nothing-new");
  });

  it("an unknown remote name falls back to full-history rather than nothing-new", () => {
    // `refs/remotes/typo/*` does not exist, so nothing is known-shared.
    // Failing towards over-scanning is the only acceptable direction.
    const home = setupHome("pushref-bad-remote", { _always: ["zzq-historic-marker"] });
    const repo = makeRepoWithRemote("pushref-bad-remote-repo", { class: "private-strict" });
    commit(repo, "f.txt", "zzq-historic-marker\n", "init");
    execFileSync("git", ["push", "-q", "origin", "main"], { cwd: repo });
    execFileSync("git", ["tag", "v1"], { cwd: repo });
    process.chdir(repo);

    const result = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() => check({ pushRef: "refs/tags/v1", remote: "typo", json: true })),
    );
    assert.equal(result.exitCode, 1);
    const j = JSON.parse(result.stdout) as { rangeMode: string; hits: unknown[] };
    assert.equal(j.rangeMode, "full-history");
    assert.equal(j.hits.length, 1);
  });

  it("exits 2 with GIT_ERROR — never 0 — when rev-list fails", () => {
    const home = setupHome("pushref-git-error", { _always: ["zzq-historic-marker"] });
    const repo = makeRepoWithRemote("pushref-git-error-repo", { class: "private-strict" });
    commit(repo, "f.txt", "zzq-historic-marker\n", "init");
    execFileSync("git", ["push", "-q", "origin", "main"], { cwd: repo });
    process.chdir(repo);

    const result = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() => check({ pushRef: "refs/heads/no-such-ref", json: true })),
    );
    assert.equal(result.exitCode, 2, "an unresolvable ref must not read as a clean scan");
    const jsonLine = result.stderr
      .split("\n")
      .map(l => l.trim())
      .find(l => l.startsWith("{") && l.includes("GIT_ERROR"));
    assert.ok(jsonLine, `expected a GIT_ERROR JSON line in stderr; got:\n${result.stderr}`);
    const j = JSON.parse(jsonLine!) as { code: string; error: string };
    assert.equal(j.code, "GIT_ERROR");
    assert.match(j.error, /git rev-list/);
  });

  it("exits 2 with NOT_GIT_REPO outside a git repo", () => {
    const home = setupHome("pushref-not-git", { _always: ["zzq-historic-marker"] });
    const notRepo = makeNonRepo("pushref-not-git-dir");
    process.chdir(notRepo);
    const result = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() => check({ pushRef: "refs/tags/v1", json: true })),
    );
    assert.equal(result.exitCode, 2);
    const j = JSON.parse(result.stderr) as { code: string };
    assert.equal(j.code, "NOT_GIT_REPO");
  });

  it("exits 2 with USAGE when combined with --range", () => {
    const home = setupHome("pushref-usage");
    const repo = makeRepo("pushref-usage-repo", { class: "private-strict" });
    process.chdir(repo);
    const result = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() => check({ pushRef: "refs/tags/v1", range: "a..b", json: true })),
    );
    assert.equal(result.exitCode, 2);
    const j = JSON.parse(result.stderr) as { code: string; error: string };
    assert.equal(j.code, "USAGE");
    assert.match(j.error, /push-ref/);
  });

  it("sweeps egress over the resolved range too, not just marker hits", () => {
    // A new branch adding a private-registry lockfile in a public-facing
    // repo must still be caught: --push-ref narrows WHICH commits are in
    // scope, not WHICH checks run.
    const home = setupHome("pushref-egress");
    const repo = makeRepoWithRemote("pushref-egress-repo", { class: "public-eligible" });
    commit(repo, "README.md", "hello\n", "init");
    execFileSync("git", ["push", "-q", "origin", "main"], { cwd: repo });
    execFileSync("git", ["checkout", "-q", "-b", "feature"], { cwd: repo });
    commit(
      repo,
      "package-lock.json",
      JSON.stringify({
        packages: {
          "node_modules/foo": {
            resolved: "https://npm.private-registry.example.com/foo/-/foo-1.0.0.tgz",
          },
        },
      }),
      "add lockfile",
    );
    process.chdir(repo);

    const result = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() => check({ pushRef: "refs/heads/feature", json: true })),
    );
    assert.equal(result.exitCode, 1);
    const j = JSON.parse(result.stdout) as { egress: { host: string; file: string }[] };
    assert.ok(
      j.egress.some(
        e => e.host === "npm.private-registry.example.com" && e.file === "package-lock.json",
      ),
    );
  });
});

describe("check — redaction policy", () => {
  it("default mode: literal does NOT appear in stdout/stderr", () => {
    const home = setupHome("redact-default", { _always: ["leaked-secret-token"] });
    const repo = makeRepo("redact-default-repo", { class: "private-strict" });
    process.chdir(repo);
    const target = join(repo, "src.txt");
    writeFileSync(target, "this contains leaked-secret-token in plain text\n");
    const result = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() => check({ path: target, json: true })),
    );
    // We have a hit, and exit is 0 only because path mode never throws on hits
    // — actually check exits with EXIT_HIT (1) on hits. But in path mode the
    // file is realpathed so the path appears. The redaction invariant is that
    // the literal match value does not appear anywhere on stdout or stderr.
    assert.ok(!result.stdout.includes("leaked-secret-token"));
    assert.ok(!result.stderr.includes("leaked-secret-token"));
    const j = JSON.parse(result.stdout) as {
      hits: { matchPreview: string }[];
    };
    assert.ok(j.hits.length > 0, "expected at least one hit");
    for (const h of j.hits) {
      assert.ok(!h.matchPreview.includes("leaked-secret-token"));
    }
  });

  it("--verbose mode: literal DOES appear in stdout", () => {
    const home = setupHome("redact-verbose", { _always: ["another-secret-tok"] });
    const repo = makeRepo("redact-verbose-repo", { class: "private-strict" });
    process.chdir(repo);
    const target = join(repo, "src.txt");
    writeFileSync(target, "this contains another-secret-tok here\n");
    const result = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() =>
        check({ path: target, json: true, verbose: true }),
      ),
    );
    assert.ok(
      result.stdout.includes("another-secret-tok"),
      `expected literal in --verbose stdout; got: ${result.stdout}`,
    );
  });
});

// ---------------------------------------------------------------------------
// D: reviewed-benign waivers
// ---------------------------------------------------------------------------
//
// CROSS-LANE NOTE: `isWaived` matches on `(hit.patternId, hit.blob)`.
// `ScanHit.patternId` is being added to core/src/scan.ts by a parallel lane
// this wave; as of this writing it is not yet populated by the scanners, so
// any test below that depends on an ACTUAL scan hit being matched against a
// waiver (computed via core's own `patternId()` helper, so the expected id
// is correct once that field lands) will observe hits.length unchanged /
// waived.length 0 until that lands. Tests that don't need a matched hit
// (malformed-file handling, expired-waiver warning, the always-present
// `waived: N` line) are unaffected and pass today. See the task report.
describe("check — waivers (D)", () => {
  function writeOverride(repo: string, yamlText: string): void {
    writeFileSync(join(repo, ".repo-aegis.yml"), yamlText);
  }

  it('CROSS-LANE (pending patternId): a waived (pattern, blob) hit is skipped and counted in "waived"', () => {
    const home = setupHome("waiver-basic", { _always: ["zzq-waiver-secret"] });
    const repo = makeRepo("waiver-basic-repo", { class: "private-strict" });
    process.chdir(repo);
    const target = join(repo, "f.txt");
    writeFileSync(target, "zzq-waiver-secret\n");
    execFileSync("git", ["add", "f.txt"], { cwd: repo });

    // Baseline: no waiver yet, capture the real blob sha of the staged hit.
    const baseline = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() => check({ staged: true, json: true })),
    );
    const baseHits = (JSON.parse(baseline.stdout) as { hits: { blob?: string }[] }).hits;
    assert.equal(baseHits.length, 1, "fixture sanity: exactly one hit before waiving");
    const blob = baseHits[0]!.blob!;

    // patternId() is core's own stable, already-shipped helper — independent
    // of whether ScanHit exposes the field yet. `_always` file stem +
    // pattern text (the marker literal itself, since fixtures use the raw
    // string as the pattern) reproduces exactly what the scanner will
    // attribute once patternId lands.
    const id = patternId("_always", "zzq-waiver-secret");
    writeOverride(
      repo,
      `waivers:\n  - pattern: ${id}\n    blob: ${blob}\n    reason: test fixture\n    approver: alice\n    date: 2026-01-01\n`,
    );

    const result = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() => check({ staged: true, json: true })),
    );
    const j = JSON.parse(result.stdout) as {
      hits: unknown[];
      waived: { patternId?: string; blob?: string; reason?: string; approver?: string }[];
    };
    assert.equal(result.exitCode, undefined, "a fully waived finding must not block");
    assert.equal(j.hits.length, 0);
    assert.equal(j.waived.length, 1);
    assert.equal(j.waived[0]!.patternId, id);
    assert.equal(j.waived[0]!.blob, blob);
    // The human justification must survive into the output — a suppression
    // with no recorded reason is not auditable.
    assert.equal(j.waived[0]!.reason, "test fixture");
    assert.equal(j.waived[0]!.approver, "alice");
  });

  it("a different blob under the same pattern shape is still flagged", () => {
    const home = setupHome("waiver-diff-blob", { _always: ["zzq-waiver-secret"] });
    const repo = makeRepo("waiver-diff-blob-repo", { class: "private-strict" });
    process.chdir(repo);
    const target = join(repo, "f.txt");
    writeFileSync(target, "zzq-waiver-secret\n");
    execFileSync("git", ["add", "f.txt"], { cwd: repo });

    const id = patternId("_always", "zzq-waiver-secret");
    // A waiver for a blob that does NOT match this file's actual staged blob.
    // Quoted: an unquoted all-digit scalar (e.g. forty zeros) parses as a
    // YAML number, not a string, and would fail schema validation instead
    // of exercising the "different blob" path this test is for.
    writeOverride(
      repo,
      `waivers:\n  - pattern: ${id}\n    blob: "${"0".repeat(40)}"\n    reason: unrelated\n    approver: alice\n    date: 2026-01-01\n`,
    );

    const result = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() => check({ staged: true, json: true })),
    );
    assert.equal(result.exitCode, 1, "a waiver for a different blob must not suppress this hit");
    const j = JSON.parse(result.stdout) as { hits: unknown[]; waived: unknown[] };
    assert.equal(j.hits.length, 1);
    assert.equal(j.waived.length, 0);
  });

  it("an expired waiver does not apply and emits a warning", () => {
    const home = setupHome("waiver-expired", { _always: ["zzq-waiver-secret"] });
    const repo = makeRepo("waiver-expired-repo", { class: "private-strict" });
    process.chdir(repo);
    const target = join(repo, "f.txt");
    writeFileSync(target, "zzq-waiver-secret\n");
    execFileSync("git", ["add", "f.txt"], { cwd: repo });

    const id = patternId("_always", "zzq-waiver-secret");
    // Deliberately far in the past — the `expiredWaivers` check is a pure
    // string-date comparison against wall-clock `now`, so any past date is
    // stable for this assertion regardless of when the suite runs.
    writeOverride(
      repo,
      `waivers:\n  - pattern: ${id}\n    blob: "${"0".repeat(40)}"\n    reason: old\n    approver: alice\n    date: 2020-01-01\n    expires: 2020-02-01\n`,
    );

    const result = withEnv("REPO_AEGIS_HOME", home, () => captureOutput(() => check({ staged: true })));
    assert.match(result.stdout, /warning: 1 waiver\(s\) have expired/);
  });

  it("--ignore-waivers re-flags what would otherwise be waived", () => {
    const home = setupHome("waiver-ignore", { _always: ["zzq-waiver-secret"] });
    const repo = makeRepo("waiver-ignore-repo", { class: "private-strict" });
    process.chdir(repo);
    const target = join(repo, "f.txt");
    writeFileSync(target, "zzq-waiver-secret\n");
    execFileSync("git", ["add", "f.txt"], { cwd: repo });

    const baseline = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() => check({ staged: true, json: true })),
    );
    const blob = (JSON.parse(baseline.stdout) as { hits: { blob?: string }[] }).hits[0]!.blob!;
    const id = patternId("_always", "zzq-waiver-secret");
    writeOverride(
      repo,
      `waivers:\n  - pattern: ${id}\n    blob: ${blob}\n    reason: test\n    approver: alice\n    date: 2026-01-01\n`,
    );

    const result = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() => check({ staged: true, json: true, ignoreWaivers: true })),
    );
    assert.equal(result.exitCode, 1, "--ignore-waivers must restore blocking behaviour");
    const j = JSON.parse(result.stdout) as { hits: unknown[]; waived: unknown[] };
    assert.equal(j.hits.length, 1);
    assert.equal(j.waived.length, 0, "--ignore-waivers must not apply any waiver");
  });

  it("a malformed waivers: block is a hard error (exit 2), never a silent skip", () => {
    const home = setupHome("waiver-malformed", { _always: ["zzq-waiver-secret"] });
    const repo = makeRepo("waiver-malformed-repo", { class: "private-strict" });
    process.chdir(repo);
    writeFileSync(join(repo, "f.txt"), "zzq-waiver-secret\n");
    execFileSync("git", ["add", "f.txt"], { cwd: repo });
    // Missing required 'approver' and 'date'; 'blob' too short.
    writeOverride(repo, `waivers:\n  - pattern: _always/deadbeefcafe\n    blob: short\n    reason: x\n`);

    const result = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() => check({ staged: true, json: true })),
    );
    assert.equal(result.exitCode, 2);
    const j = JSON.parse(result.stderr) as { code: string };
    assert.equal(j.code, "WAIVER_PARSE");
  });

  // CONTROL 3 is "a waiver never applies silently", NOT "announce zero on
  // every run". This line lands in hook output on every commit, so a
  // permanent `waived: 0` would train people to skim past it — and past the
  // case that actually matters. Zero is silent in text mode; JSON always
  // carries the list for machine consumers.
  it("says nothing about waivers on a clean scan with no waivers file", () => {
    const home = setupHome("waiver-quiet-when-zero", { _always: ["zzq-unrelated-marker"] });
    const repo = makeRepo("waiver-quiet-when-zero-repo", { class: "private-strict" });
    process.chdir(repo);
    writeFileSync(join(repo, "f.txt"), "nothing interesting here\n");
    execFileSync("git", ["add", "f.txt"], { cwd: repo });

    const result = withEnv("REPO_AEGIS_HOME", home, () => captureOutput(() => check({ staged: true })));
    assert.equal(result.exitCode, undefined);
    assert.doesNotMatch(result.stdout, /waived/);
  });

  it("reports the count in text mode whenever a waiver actually suppressed a finding", () => {
    const marker = "zzq" + "-waived-shape-marker";
    const home = setupHome("waiver-reports-when-applied", { _always: [marker] });
    const repo = makeRepo("waiver-reports-when-applied-repo", { class: "private-strict" });
    process.chdir(repo);
    writeFileSync(join(repo, "f.txt"), `const x = "${marker}";\n`);
    execFileSync("git", ["add", "f.txt"], { cwd: repo });

    // Derive the (patternId, blob) the finding will carry, then waive exactly it.
    const probe = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() => check({ staged: true, json: true })),
    );
    const hit = (JSON.parse(probe.stdout) as { hits: { patternId?: string; blob?: string }[] }).hits[0];
    assert.ok(hit?.patternId && hit.blob, "expected the finding to carry patternId + blob");
    writeFileSync(
      join(repo, ".repo-aegis.yml"),
      `class: private-strict\nwaivers:\n  - pattern: ${hit.patternId}\n    blob: "${hit.blob}"\n` +
        `    reason: synthetic fixture\n    approver: test\n    date: 2026-07-26\n`,
    );

    const result = withEnv("REPO_AEGIS_HOME", home, () => captureOutput(() => check({ staged: true })));
    assert.equal(result.exitCode, undefined, "the waived finding must not block");
    assert.match(result.stdout, /repo-aegis: waived: 1 finding\(s\)/);
  });
});

// ---------------------------------------------------------------------------
// C: "already public" → warn, not block
// ---------------------------------------------------------------------------
describe("check — already-public downgrade (C)", () => {
  function makeRepoWithRemote(name: string, opts: RepoOpts = {}): string {
    const dir = makeRepo(name, opts);
    const remote = join(tmp, `${name}-remote.git`);
    mkdirSync(remote, { recursive: true });
    execFileSync("git", ["init", "--bare", "-q", remote]);
    execFileSync("git", ["remote", "add", "origin", remote], { cwd: dir });
    return dir;
  }

  function commit(dir: string, file: string, content: string, msg: string): void {
    writeFileSync(join(dir, file), content);
    execFileSync("git", ["add", file], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", msg], { cwd: dir });
  }

  it("--history: a hit whose commit is remote-reachable warns and exits 0 on a public-facing repo", () => {
    const home = setupHome("already-public-warn", { _always: ["zzq-already-public-marker"] });
    const repo = makeRepoWithRemote("already-public-warn-repo", { class: "public-eligible" });
    commit(repo, "f.txt", "zzq-already-public-marker\n", "init");
    execFileSync("git", ["push", "-q", "origin", "main"], { cwd: repo });
    process.chdir(repo);

    const result = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() => check({ history: true, json: true })),
    );
    assert.equal(
      result.exitCode,
      undefined,
      `expected exit 0 (downgraded to warning); stderr: ${result.stderr} stdout: ${result.stdout}`,
    );
    const j = JSON.parse(result.stdout) as {
      historyHits: { commitSha: string; alreadyPublic: boolean }[];
    };
    assert.equal(j.historyHits.length, 1);
    assert.equal(j.historyHits[0]!.alreadyPublic, true);
  });

  it("--history: the same marker in a commit no remote has still blocks (exit 1)", () => {
    const home = setupHome("already-public-block", { _always: ["zzq-already-public-marker"] });
    const repo = makeRepoWithRemote("already-public-block-repo", { class: "public-eligible" });
    // Deliberately never pushed: this commit exists only locally.
    commit(repo, "f.txt", "zzq-already-public-marker\n", "init");
    process.chdir(repo);

    const result = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() => check({ history: true, json: true })),
    );
    assert.equal(result.exitCode, 1, "an unpublished commit must still block");
    const j = JSON.parse(result.stdout) as { historyHits: { alreadyPublic: boolean }[] };
    assert.equal(j.historyHits.length, 1);
    assert.equal(j.historyHits[0]!.alreadyPublic, false);
  });

  it("--range mode still blocks the same content even though its commit is remote-reachable", () => {
    const home = setupHome("already-public-range", { _always: ["zzq-already-public-marker"] });
    const repo = makeRepoWithRemote("already-public-range-repo", { class: "public-eligible" });
    commit(repo, "base.txt", "unrelated\n", "base");
    execFileSync("git", ["push", "-q", "origin", "main"], { cwd: repo });
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    commit(repo, "f.txt", "zzq-already-public-marker\n", "add marker");
    execFileSync("git", ["push", "-q", "origin", "main"], { cwd: repo });
    process.chdir(repo);

    const result = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() => check({ range: `${baseSha}..HEAD`, json: true })),
    );
    assert.equal(
      result.exitCode,
      1,
      "--range must never downgrade, even though the tip commit is on the remote — a first-time addition of the same shape must still block",
    );
  });

  it("does not downgrade on a non-public-facing repo, even when the commit is remote-reachable", () => {
    const home = setupHome("already-public-private", { _always: ["zzq-already-public-marker"] });
    const repo = makeRepoWithRemote("already-public-private-repo", { class: "private-strict" });
    commit(repo, "f.txt", "zzq-already-public-marker\n", "init");
    execFileSync("git", ["push", "-q", "origin", "main"], { cwd: repo });
    process.chdir(repo);

    const result = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() => check({ history: true, json: true })),
    );
    assert.equal(result.exitCode, 1, "private-strict repos must still block; downgrade is public-facing only");
    const j = JSON.parse(result.stdout) as { historyHits: { alreadyPublic: boolean }[] };
    assert.equal(j.historyHits[0]!.alreadyPublic, false);
  });
});
