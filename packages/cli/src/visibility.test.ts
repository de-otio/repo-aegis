// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  probeGithubVisibility,
  cacheVisibility,
  resolveVisibility,
  type CommandRunner,
} from "./visibility.js";

interface Call {
  cmd: string;
  args: string[];
}

/** A runner that returns canned `gh` output and records every invocation. */
function fakeRunner(ghOut: string | null): { run: CommandRunner; calls: Call[] } {
  const calls: Call[] = [];
  const run: CommandRunner = (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "gh") return ghOut;
    return ""; // git config writes "succeed"
  };
  return { run, calls };
}

describe("probeGithubVisibility", () => {
  it("maps gh visibility values", () => {
    assert.equal(probeGithubVisibility("/x", fakeRunner("PUBLIC\n").run), "public");
    assert.equal(probeGithubVisibility("/x", fakeRunner("PRIVATE\n").run), "private");
    assert.equal(probeGithubVisibility("/x", fakeRunner("INTERNAL\n").run), "private");
  });
  it("returns unknown when gh fails or is unrecognised", () => {
    assert.equal(probeGithubVisibility("/x", fakeRunner(null).run), "unknown");
    assert.equal(probeGithubVisibility("/x", fakeRunner("???").run), "unknown");
  });
});

describe("cacheVisibility", () => {
  it("writes git config for a known visibility", () => {
    const { run, calls } = fakeRunner(null);
    cacheVisibility("/x", "public", run);
    const write = calls.find(c => c.cmd === "git");
    assert.ok(write);
    assert.deepEqual(write!.args, ["config", "repo-aegis.visibility", "public"]);
  });
  it("is a no-op for unknown", () => {
    const { run, calls } = fakeRunner(null);
    cacheVisibility("/x", "unknown", run);
    assert.equal(calls.length, 0);
  });
});

describe("resolveVisibility", () => {
  it("probes, caches, and returns when gh succeeds", () => {
    const { run, calls } = fakeRunner("PUBLIC");
    assert.equal(resolveVisibility("/x", run), "public");
    assert.ok(calls.some(c => c.cmd === "git" && c.args.includes("repo-aegis.visibility")));
  });

  it("falls back to the cached value when gh is unavailable", () => {
    let tmp: string | undefined;
    try {
      tmp = mkdtempSync(join(tmpdir(), "repo-aegis-vis-"));
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: tmp });
      execFileSync("git", ["config", "repo-aegis.visibility", "private"], { cwd: tmp });
      // gh probe returns null → resolveVisibility reads the real cached value.
      assert.equal(resolveVisibility(tmp, fakeRunner(null).run), "private");
    } finally {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// Keep a `before`/`after` pair so the file matches the suite's lifecycle
// conventions even though most cases are pure.
describe("visibility lifecycle", () => {
  let original: string;
  before(() => {
    original = process.cwd();
  });
  after(() => {
    process.chdir(original);
  });
  it("does not change cwd", () => {
    probeGithubVisibility(process.cwd(), fakeRunner("PUBLIC").run);
    assert.equal(process.cwd(), original);
  });
});
