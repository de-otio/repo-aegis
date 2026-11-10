// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// The emergency pause at the two git-hook entry points (complexity-review P1-E): pre-commit (`check --staged`) and
// pre-push (`check --push-ref|--range … --remote-url`). Each case has its control: the same run with no pause (or an
// expired or invalid one) is still refused, so a pause that does nothing, or does too much, fails here.
//
// The pause file is written relative to the real clock with an hour of margin each way, so "active" and "expired"
// never depend on how fast the test runs. Placeholder owners only (`acme`, `other-org`).
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureOutput, withEnv, lastJsonLine, scrubGitEnv, PERSON_ANCESTRY } from "../_test-utils.js";
import { check } from "./check.js";
import { mintPause, pausePath, setAncestryReaderForTests } from "@de-otio/repo-aegis-core";

const HOUR = 3_600_000;
const NOTICE = /repo-aegis: paused until \d\d:\d\d \(resume: repo-aegis resume\)/;

let tmp: string;
let originalCwd: string;
let restoreGitEnv: () => void;
before(() => {
  restoreGitEnv = scrubGitEnv();
  tmp = mkdtempSync(join(tmpdir(), "repo-aegis-check-pause-"));
  originalCwd = process.cwd();
});
after(() => {
  process.chdir(originalCwd);
  restoreGitEnv();
  rmSync(tmp, { recursive: true, force: true });
});
afterEach(() => process.chdir(originalCwd));

let n = 0;

function setupHome(): string {
  const home = join(tmp, `home${n++}`);
  mkdirSync(join(home, "markers"), { recursive: true });
  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(join(home, "markers", "_always.txt"), "leak-token\n");
  return home;
}

function makeRepo(opts: { class: string; visibility: string; origin: string }): string {
  const dir = join(tmp, `repo${n++}`);
  mkdirSync(dir, { recursive: true });
  const git = (...a: string[]): void => void execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "repo-aegis.class", opts.class);
  git("config", "repo-aegis.visibility", opts.visibility);
  git("config", "remote.origin.url", opts.origin);
  writeFileSync(join(dir, "a.txt"), "first\n");
  git("add", "-A");
  git("commit", "-q", "-m", "first");
  writeFileSync(join(dir, "b.txt"), "second\n");
  git("add", "-A");
  git("commit", "-q", "-m", "second");
  return dir;
}

/** Stage a file that holds an `_always` marker. */
function stageMarker(repo: string): void {
  writeFileSync(join(repo, "leak.txt"), "the leak-token is here\n");
  execFileSync("git", ["add", "leak.txt"], { cwd: repo, stdio: "ignore" });
}

type PauseKind = "active" | "expired" | "none" | "future" | "world-writable";

/** Write (or not) the pause file for `home`: relative to the real clock, an hour either way. */
function setPause(home: string, kind: PauseKind, repo?: string): void {
  const path = pausePath(home);
  const now = Date.now();
  if (kind === "none") return;
  if (kind === "active") {
    mintPause({ path, now: new Date(now - 60_000), durationMs: HOUR, ...(repo !== undefined && { repo }) });
  } else if (kind === "expired") {
    mintPause({ path, now: new Date(now - 2 * HOUR), durationMs: HOUR, ...(repo !== undefined && { repo }) });
  } else if (kind === "future") {
    mintPause({ path, now: new Date(now + HOUR), durationMs: HOUR, ...(repo !== undefined && { repo }) });
  } else {
    mintPause({ path, now: new Date(now - 60_000), durationMs: HOUR, ...(repo !== undefined && { repo }) });
    chmodSync(path, 0o666);
  }
}

function withStderrTty<T>(isTty: boolean, fn: () => T): T {
  const desc = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
  Object.defineProperty(process.stderr, "isTTY", { value: isTty, configurable: true, writable: true });
  setAncestryReaderForTests(() => PERSON_ANCESTRY);
  try {
    return fn();
  } finally {
    setAncestryReaderForTests(undefined);
    if (desc) Object.defineProperty(process.stderr, "isTTY", desc);
    else delete (process.stderr as { isTTY?: boolean }).isTTY;
  }
}

function run(home: string, opts: Parameters<typeof check>[0]): ReturnType<typeof captureOutput> {
  return withEnv("REPO_AEGIS_HOME", home, () =>
    withEnv("REPO_AEGIS_REGISTRY", join(tmp, "no-such-registry.yaml"), () =>
      withEnv("REPO_AEGIS_EGRESS_HUMAN", undefined, () => withStderrTty(false, () => captureOutput(() => check(opts)))),
    ),
  );
}

describe("pre-commit under a pause (check --staged)", () => {
  it("control: with no pause a marker hit is refused (exit 1)", () => {
    const home = setupHome();
    const repo = makeRepo({ class: "private-strict", visibility: "private", origin: "git@github.com:acme/x.git" });
    stageMarker(repo);
    assert.equal(run(home, { cwd: repo, staged: true }).exitCode, 1);
  });

  it("an active pause: the marker hit exits 0 with the notice, and the scan did not run", () => {
    const home = setupHome();
    const repo = makeRepo({ class: "private-strict", visibility: "private", origin: "git@github.com:acme/x.git" });
    stageMarker(repo);
    setPause(home, "active");
    const r = run(home, { cwd: repo, staged: true });
    assert.equal(r.exitCode, undefined, r.stdout + r.stderr);
    assert.match(r.stderr, NOTICE);
    assert.doesNotMatch(r.stdout + r.stderr, /marker hit|leak\.txt/);
  });

  it("--json says it was paused and reports no hits", () => {
    const home = setupHome();
    const repo = makeRepo({ class: "private-strict", visibility: "private", origin: "git@github.com:acme/x.git" });
    stageMarker(repo);
    setPause(home, "active");
    const r = run(home, { cwd: repo, staged: true, json: true });
    assert.equal(r.exitCode, undefined);
    const j = JSON.parse(r.stdout) as { status: string; notice: string; hits: unknown[] };
    assert.equal(j.status, "paused");
    assert.match(j.notice, NOTICE);
    assert.deepEqual(j.hits, []);
  });

  it("after expiry the refusal is back, with no command run to bring it back", () => {
    const home = setupHome();
    const repo = makeRepo({ class: "private-strict", visibility: "private", origin: "git@github.com:acme/x.git" });
    stageMarker(repo);
    setPause(home, "expired");
    assert.equal(run(home, { cwd: repo, staged: true }).exitCode, 1);
  });

  it("a future-dated or world-writable pause file is no pause", () => {
    for (const kind of ["future", "world-writable"] as const) {
      const home = setupHome();
      const repo = makeRepo({ class: "private-strict", visibility: "private", origin: "git@github.com:acme/x.git" });
      stageMarker(repo);
      setPause(home, kind);
      assert.equal(run(home, { cwd: repo, staged: true }).exitCode, 1, kind);
    }
  });

  it("--repo: covers the working repo whose origin matches (case-insensitively), not another", () => {
    const home = setupHome();
    const repo = makeRepo({ class: "private-strict", visibility: "private", origin: "git@github.com:Acme/X.git" });
    stageMarker(repo);
    setPause(home, "active", "acme/x");
    assert.equal(run(home, { cwd: repo, staged: true }).exitCode, undefined);

    const home2 = setupHome();
    setPause(home2, "active", "other-org/y");
    assert.equal(run(home2, { cwd: repo, staged: true }).exitCode, 1);
  });

  it("--repo with no origin to read is out of scope (never widened by guesswork)", () => {
    const home = setupHome();
    const repo = makeRepo({ class: "private-strict", visibility: "private", origin: "git@github.com:acme/x.git" });
    execFileSync("git", ["remote", "remove", "origin"], { cwd: repo, stdio: "ignore" });
    stageMarker(repo);
    setPause(home, "active", "acme/x");
    assert.equal(run(home, { cwd: repo, staged: true }).exitCode, 1);
  });

  it("an explicit --path scan is not paused: a person asked to read it", () => {
    const home = setupHome();
    const repo = makeRepo({ class: "private-strict", visibility: "private", origin: "git@github.com:acme/x.git" });
    writeFileSync(join(repo, "leak.txt"), "the leak-token is here\n");
    setPause(home, "active");
    assert.equal(run(home, { cwd: repo, path: "leak.txt" }).exitCode, 1);
  });
});

describe("pre-push under a pause (check --push-ref / --range with --remote-url)", () => {
  const PUBLIC = { class: "public-eligible", visibility: "public", origin: "git@github.com:acme/x.git" } as const;

  it("control: a public push with no person present is refused", () => {
    const home = setupHome();
    const repo = makeRepo(PUBLIC);
    const r = run(home, { cwd: repo, pushRef: "refs/heads/main", remoteUrl: "git@github.com:acme/x.git", json: true });
    assert.equal(r.exitCode, 2);
    assert.equal(lastJsonLine<{ code: string }>(r.stderr).code, "PUBLIC_PUSH_NEEDS_HUMAN");
  });

  it("an active pause: the public push passes, with the notice and no refusal", () => {
    const home = setupHome();
    const repo = makeRepo(PUBLIC);
    setPause(home, "active");
    const r = run(home, { cwd: repo, pushRef: "refs/heads/main", remoteUrl: "git@github.com:acme/x.git" });
    assert.equal(r.exitCode, undefined, r.stderr);
    assert.match(r.stderr, NOTICE);
    assert.doesNotMatch(r.stderr, /PUBLIC_PUSH_NEEDS_HUMAN/);
    // `--range` is the other pre-push shape.
    const r2 = run(home, { cwd: repo, range: "HEAD~1..HEAD", remoteUrl: "git@github.com:acme/x.git" });
    assert.equal(r2.exitCode, undefined, r2.stderr);
    assert.match(r2.stderr, NOTICE);
  });

  it("a pause also lifts the cross-org check and a marker in the pushed range", () => {
    const home = setupHome();
    const repo = makeRepo({ class: "private-strict", visibility: "private", origin: "git@github.com:acme/x.git" });
    writeFileSync(join(repo, "leak.txt"), "leak-token\n");
    execFileSync("git", ["add", "-A"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-q", "-m", "leak"], { cwd: repo, stdio: "ignore" });
    const args = { cwd: repo, range: "HEAD~1..HEAD", remoteUrl: "git@github.com:other-org/svc.git" } as const;
    assert.equal(run(home, args).exitCode, 2); // CROSS_ORG_PUSH, control
    setPause(home, "active");
    assert.equal(run(home, args).exitCode, undefined);
  });

  it("after expiry the refusal is back", () => {
    const home = setupHome();
    const repo = makeRepo(PUBLIC);
    setPause(home, "expired");
    const r = run(home, { cwd: repo, pushRef: "refs/heads/main", remoteUrl: "git@github.com:acme/x.git", json: true });
    assert.equal(r.exitCode, 2);
    assert.equal(lastJsonLine<{ code: string }>(r.stderr).code, "PUBLIC_PUSH_NEEDS_HUMAN");
  });

  it("a future-dated or world-writable pause file is no pause", () => {
    for (const kind of ["future", "world-writable"] as const) {
      const home = setupHome();
      const repo = makeRepo(PUBLIC);
      setPause(home, kind);
      const r = run(home, { cwd: repo, pushRef: "refs/heads/main", remoteUrl: "git@github.com:acme/x.git", json: true });
      assert.equal(r.exitCode, 2, kind);
    }
  });

  it("--repo a/b paused: a push to a/b passes (case-insensitively), a push to c/d is still refused", () => {
    const home = setupHome();
    const repo = makeRepo(PUBLIC);
    setPause(home, "active", "acme/x");
    const inScope = run(home, { cwd: repo, pushRef: "refs/heads/main", remoteUrl: "git@github.com:ACME/X.git" });
    assert.equal(inScope.exitCode, undefined, inScope.stderr);
    assert.match(inScope.stderr, NOTICE);
    const other = run(home, { cwd: repo, pushRef: "refs/heads/main", remoteUrl: "git@github.com:other-org/svc.git", json: true });
    assert.equal(other.exitCode, 2);
    assert.doesNotMatch(other.stderr, NOTICE);
  });

  it("--repo paused: a push whose destination cannot be resolved offline is out of scope", () => {
    const home = setupHome();
    const repo = makeRepo(PUBLIC);
    setPause(home, "active", "acme/x");
    const r = run(home, { cwd: repo, pushRef: "refs/heads/main", remoteUrl: "https://git.example.com/acme/x.git", json: true });
    // not a GitHub destination: pre-push judged nothing about it before, and a scoped pause adds nothing
    assert.equal(r.exitCode, undefined);
    assert.doesNotMatch(r.stderr + r.stdout, NOTICE);
  });

  it("without a remote URL (not a pre-push run) a --range scan is not paused", () => {
    const home = setupHome();
    const repo = makeRepo({ class: "private-strict", visibility: "private", origin: "git@github.com:acme/x.git" });
    writeFileSync(join(repo, "leak.txt"), "leak-token\n");
    execFileSync("git", ["add", "-A"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-q", "-m", "leak"], { cwd: repo, stdio: "ignore" });
    setPause(home, "active");
    assert.equal(run(home, { cwd: repo, range: "HEAD~1..HEAD" }).exitCode, 1);
  });
});
