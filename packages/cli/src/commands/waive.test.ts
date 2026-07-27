// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureOutput, withEnv } from "../_test-utils.js";
import { waive } from "./waive.js";

let tmp: string;
let originalCwd: string;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "repo-aegis-waive-test-"));
  originalCwd = process.cwd();
});

after(() => {
  process.chdir(originalCwd);
  rmSync(tmp, { recursive: true, force: true });
});

afterEach(() => {
  process.chdir(originalCwd);
});

function makeRepo(name: string): string {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  return dir;
}

/** A 40-hex-char blob sha built by concatenation at runtime — never a
 * literal secret-shaped string on disk (self-hygiene: this repo scans
 * itself). */
function fakeBlob(seed: string): string {
  const hex = Buffer.from(seed).toString("hex");
  return (hex + "0".repeat(40)).slice(0, 40);
}

/** Runs `fn` with `process.stdin.isTTY` forced to `value`, restoring the
 * original descriptor afterward. `waive`'s CONTROL 2 gate reads exactly
 * this property. */
function withStdinTTY<T>(value: boolean | undefined, fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });
  try {
    return fn();
  } finally {
    if (original) {
      Object.defineProperty(process.stdin, "isTTY", original);
    } else {
      // @ts-expect-error -- deleting a property that may not have existed originally
      delete process.stdin.isTTY;
    }
  }
}

function runWaive(home: string, opts: Parameters<typeof waive>[0]) {
  return withEnv("REPO_AEGIS_HOME", home, () =>
    withStdinTTY(true, () => captureOutput(() => waive({ ...opts, json: true }))),
  );
}

function setupHome(name: string): string {
  return join(tmp, `${name}-home`);
}

describe("waive — CONTROL 2: TTY gate", () => {
  it("refuses to add a waiver when stdin is not a TTY", () => {
    const home = setupHome("tty-refuse");
    const repo = makeRepo("tty-refuse-repo");
    process.chdir(repo);
    const result = withEnv("REPO_AEGIS_HOME", home, () =>
      withEnv("REPO_AEGIS_WAIVE_NONINTERACTIVE", undefined, () =>
        withStdinTTY(false, () =>
          captureOutput(() =>
            waive({
              pattern: "_always/aaaaaaaaaaaa",
              blob: fakeBlob("a"),
              reason: "test",
              approver: "alice",
              json: true,
            }),
          ),
        ),
      ),
    );
    assert.equal(result.exitCode, 2);
    const j = JSON.parse(result.stderr) as { code: string };
    assert.equal(j.code, "WAIVE_NONINTERACTIVE");
    assert.equal(existsSync(join(repo, ".repo-aegis.yml")), false, "must not write the file");
  });

  it("allows a non-TTY add when REPO_AEGIS_WAIVE_NONINTERACTIVE=1 is set", () => {
    const home = setupHome("tty-override");
    const repo = makeRepo("tty-override-repo");
    process.chdir(repo);
    const result = withEnv("REPO_AEGIS_HOME", home, () =>
      withEnv("REPO_AEGIS_WAIVE_NONINTERACTIVE", "1", () =>
        withStdinTTY(false, () =>
          captureOutput(() =>
            waive({
              pattern: "_always/aaaaaaaaaaaa",
              blob: fakeBlob("a"),
              reason: "test-fixture keypair",
              approver: "alice",
              json: true,
            }),
          ),
        ),
      ),
    );
    assert.equal(result.exitCode, undefined, `expected success; stderr: ${result.stderr}`);
    assert.equal(existsSync(join(repo, ".repo-aegis.yml")), true);
  });

  it("proceeds normally when stdin IS a TTY", () => {
    const home = setupHome("tty-yes");
    const repo = makeRepo("tty-yes-repo");
    process.chdir(repo);
    const result = runWaive(home, {
      pattern: "_always/aaaaaaaaaaaa",
      blob: fakeBlob("a"),
      reason: "test",
      approver: "alice",
    });
    assert.equal(result.exitCode, undefined, `expected success; stderr: ${result.stderr}`);
  });
});

describe("waive — CONTROL: only _always patterns are waivable", () => {
  it("refuses an engagement-scoped pattern id, pointing at `repo-aegis allow`", () => {
    const home = setupHome("not-waivable");
    const repo = makeRepo("not-waivable-repo");
    process.chdir(repo);
    const result = runWaive(home, {
      pattern: "alpha-org/deadbeefcafe",
      blob: fakeBlob("b"),
      reason: "test",
      approver: "alice",
    });
    assert.equal(result.exitCode, 2);
    const j = JSON.parse(result.stderr) as { code: string; error: string };
    assert.equal(j.code, "NOT_WAIVABLE");
    assert.match(j.error, /repo-aegis allow/);
    assert.equal(existsSync(join(repo, ".repo-aegis.yml")), false, "must not write the file");
  });

  it("refuses a _private_infra pattern id (also excluded, not just engagement ids)", () => {
    const home = setupHome("not-waivable-infra");
    const repo = makeRepo("not-waivable-infra-repo");
    process.chdir(repo);
    const result = runWaive(home, {
      pattern: "_private_infra/deadbeefcafe",
      blob: fakeBlob("c"),
      reason: "test",
      approver: "alice",
    });
    assert.equal(result.exitCode, 2);
    const j = JSON.parse(result.stderr) as { code: string };
    assert.equal(j.code, "NOT_WAIVABLE");
  });

  it("accepts an _always pattern id", () => {
    const home = setupHome("waivable");
    const repo = makeRepo("waivable-repo");
    process.chdir(repo);
    const result = runWaive(home, {
      pattern: "_always/deadbeefcafe",
      blob: fakeBlob("d"),
      reason: "test",
      approver: "alice",
    });
    assert.equal(result.exitCode, undefined, `expected success; stderr: ${result.stderr}`);
  });
});

describe("waive — usage validation", () => {
  it("requires --reason", () => {
    const home = setupHome("usage-reason");
    const repo = makeRepo("usage-reason-repo");
    process.chdir(repo);
    const result = runWaive(home, { pattern: "_always/aaaaaaaaaaaa", blob: fakeBlob("e"), approver: "alice" });
    assert.equal(result.exitCode, 2);
    const j = JSON.parse(result.stderr) as { code: string };
    assert.equal(j.code, "USAGE");
  });

  it("requires --approver", () => {
    const home = setupHome("usage-approver");
    const repo = makeRepo("usage-approver-repo");
    process.chdir(repo);
    const result = runWaive(home, { pattern: "_always/aaaaaaaaaaaa", blob: fakeBlob("f"), reason: "test" });
    assert.equal(result.exitCode, 2);
    const j = JSON.parse(result.stderr) as { code: string };
    assert.equal(j.code, "USAGE");
  });

  it("rejects a malformed --blob (not 40 lowercase hex)", () => {
    const home = setupHome("usage-blob");
    const repo = makeRepo("usage-blob-repo");
    process.chdir(repo);
    const result = runWaive(home, {
      pattern: "_always/aaaaaaaaaaaa",
      blob: "not-a-sha",
      reason: "test",
      approver: "alice",
    });
    assert.equal(result.exitCode, 2);
    const j = JSON.parse(result.stderr) as { code: string };
    assert.equal(j.code, "USAGE");
  });

  it("rejects a malformed --expires", () => {
    const home = setupHome("usage-expires");
    const repo = makeRepo("usage-expires-repo");
    process.chdir(repo);
    const result = runWaive(home, {
      pattern: "_always/aaaaaaaaaaaa",
      blob: fakeBlob("g"),
      reason: "test",
      approver: "alice",
      expires: "not-a-date",
    });
    assert.equal(result.exitCode, 2);
  });
});

describe("waive — persistence preserves comments and unrelated keys", () => {
  it("round-trips class/engagements and comments untouched", () => {
    const home = setupHome("preserve");
    const repo = makeRepo("preserve-repo");
    writeFileSync(
      join(repo, ".repo-aegis.yml"),
      "# repo config\nclass: public-eligible  # inline note\nengagements:\n  - some-engagement\n",
    );
    process.chdir(repo);
    const result = runWaive(home, {
      pattern: "_always/aaaaaaaaaaaa",
      blob: fakeBlob("h"),
      reason: "test-fixture keypair",
      approver: "alice",
    });
    assert.equal(result.exitCode, undefined, `expected success; stderr: ${result.stderr}`);

    const raw = readFileSync(join(repo, ".repo-aegis.yml"), "utf8");
    assert.match(raw, /# repo config/);
    assert.match(raw, /# inline note/);
    assert.match(raw, /class: public-eligible/);
    assert.match(raw, /some-engagement/);
    assert.match(raw, /waivers:/);
    assert.match(raw, /pattern: _always\/aaaaaaaaaaaa/);
  });

  it("writes .repo-aegis.yml at the git toplevel even when invoked from a subdirectory", () => {
    const home = setupHome("toplevel");
    const repo = makeRepo("toplevel-repo");
    const sub = join(repo, "a", "b");
    mkdirSync(sub, { recursive: true });
    process.chdir(sub);
    const result = runWaive(home, {
      pattern: "_always/aaaaaaaaaaaa",
      blob: fakeBlob("i"),
      reason: "test",
      approver: "alice",
    });
    assert.equal(result.exitCode, undefined, `expected success; stderr: ${result.stderr}`);
    assert.equal(existsSync(join(repo, ".repo-aegis.yml")), true);
    assert.equal(existsSync(join(sub, ".repo-aegis.yml")), false);
  });
});

describe("waive — malformed waivers: block is a hard error", () => {
  it("exits 2 on an existing .repo-aegis.yml with an invalid waivers: entry", () => {
    const home = setupHome("malformed");
    const repo = makeRepo("malformed-repo");
    writeFileSync(
      join(repo, ".repo-aegis.yml"),
      "waivers:\n  - pattern: not-a-valid-pattern-id\n    blob: tooshort\n    reason: x\n    approver: y\n    date: 2026-01-01\n",
    );
    process.chdir(repo);
    const result = runWaive(home, { list: true });
    assert.equal(result.exitCode, 2);
    const j = JSON.parse(result.stderr) as { code: string };
    assert.equal(j.code, "WAIVER_PARSE");
  });
});

describe("waive --list", () => {
  it("reports no waivers when .repo-aegis.yml does not exist", () => {
    const home = setupHome("list-empty");
    const repo = makeRepo("list-empty-repo");
    process.chdir(repo);
    const result = runWaive(home, { list: true });
    assert.equal(result.exitCode, undefined);
    const j = JSON.parse(result.stdout) as { waivers: unknown[] };
    assert.deepEqual(j.waivers, []);
  });

  it("lists a waiver added via `waive`", () => {
    const home = setupHome("list-one");
    const repo = makeRepo("list-one-repo");
    process.chdir(repo);
    runWaive(home, {
      pattern: "_always/aaaaaaaaaaaa",
      blob: fakeBlob("j"),
      reason: "test",
      approver: "alice",
    });
    const result = runWaive(home, { list: true });
    const j = JSON.parse(result.stdout) as { waivers: Array<{ pattern: string; blob: string }> };
    assert.equal(j.waivers.length, 1);
    assert.equal(j.waivers[0]?.pattern, "_always/aaaaaaaaaaaa");
    assert.equal(j.waivers[0]?.blob, fakeBlob("j"));
  });
});

describe("waive --remove reverses waive", () => {
  it("removes a previously added waiver; a second remove is a no-op", () => {
    const home = setupHome("remove");
    const repo = makeRepo("remove-repo");
    process.chdir(repo);
    const blob = fakeBlob("k");
    const added = runWaive(home, {
      pattern: "_always/aaaaaaaaaaaa",
      blob,
      reason: "test",
      approver: "alice",
    });
    assert.equal(added.exitCode, undefined, `expected success; stderr: ${added.stderr}`);

    const afterList = runWaive(home, { list: true });
    assert.equal((JSON.parse(afterList.stdout) as { waivers: unknown[] }).waivers.length, 1);

    const removed = runWaive(home, { remove: true, pattern: "_always/aaaaaaaaaaaa", blob });
    assert.equal(removed.exitCode, undefined, `expected success; stderr: ${removed.stderr}`);
    const removedJson = JSON.parse(removed.stdout) as { removed: boolean };
    assert.equal(removedJson.removed, true);

    const finalList = runWaive(home, { list: true });
    assert.equal((JSON.parse(finalList.stdout) as { waivers: unknown[] }).waivers.length, 0);

    // Second remove of the same (pattern, blob): idempotent no-op, not an error.
    const removedAgain = runWaive(home, { remove: true, pattern: "_always/aaaaaaaaaaaa", blob });
    assert.equal(removedAgain.exitCode, undefined);
    const removedAgainJson = JSON.parse(removedAgain.stdout) as { removed: boolean };
    assert.equal(removedAgainJson.removed, false);
  });

  it("a different blob under the same pattern id is untouched by --remove", () => {
    const home = setupHome("remove-different-blob");
    const repo = makeRepo("remove-different-blob-repo");
    process.chdir(repo);
    const blobA = fakeBlob("l1");
    const blobB = fakeBlob("l2");
    runWaive(home, { pattern: "_always/aaaaaaaaaaaa", blob: blobA, reason: "a", approver: "alice" });
    runWaive(home, { pattern: "_always/aaaaaaaaaaaa", blob: blobB, reason: "b", approver: "alice" });

    runWaive(home, { remove: true, pattern: "_always/aaaaaaaaaaaa", blob: blobA });

    const list = runWaive(home, { list: true });
    const waivers = (JSON.parse(list.stdout) as { waivers: Array<{ blob: string }> }).waivers;
    assert.equal(waivers.length, 1);
    assert.equal(waivers[0]?.blob, blobB);
  });
});

describe("waive — re-running for the same (pattern, blob) updates rather than duplicates", () => {
  it("upserts: second call with a new reason replaces the first entry", () => {
    const home = setupHome("upsert");
    const repo = makeRepo("upsert-repo");
    process.chdir(repo);
    const blob = fakeBlob("m");
    runWaive(home, { pattern: "_always/aaaaaaaaaaaa", blob, reason: "first reason", approver: "alice" });
    runWaive(home, { pattern: "_always/aaaaaaaaaaaa", blob, reason: "second reason", approver: "bob" });

    const list = runWaive(home, { list: true });
    const waivers = (JSON.parse(list.stdout) as { waivers: Array<{ reason: string; approver: string }> }).waivers;
    assert.equal(waivers.length, 1, "must not duplicate");
    assert.equal(waivers[0]?.reason, "second reason");
    assert.equal(waivers[0]?.approver, "bob");
  });
});
