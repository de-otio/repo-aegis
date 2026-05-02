import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
