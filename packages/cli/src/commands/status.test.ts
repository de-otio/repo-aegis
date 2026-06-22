// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureOutput, withEnv } from "../_test-utils.js";
import { status } from "./status.js";

let tmp: string;
let originalCwd: string;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "repo-aegis-status-test-"));
  originalCwd = process.cwd();
});
after(() => {
  process.chdir(originalCwd);
  rmSync(tmp, { recursive: true, force: true });
});
afterEach(() => process.chdir(originalCwd));

function setupHome(name: string): string {
  const home = join(tmp, name + "-home");
  mkdirSync(join(home, "markers"), { recursive: true });
  mkdirSync(join(home, "state"), { recursive: true });
  return home;
}

function makeRepo(name: string, cls: string, visibility?: string): string {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "repo-aegis.class", cls], { cwd: dir });
  if (visibility) {
    // Pre-seed the cache; the live `gh` probe is a no-op in tests (no remote),
    // so resolveVisibility falls back to this value deterministically.
    execFileSync("git", ["config", "repo-aegis.visibility", visibility], { cwd: dir });
  }
  return dir;
}

describe("status — visibility", () => {
  it("JSON reports cached visibility and publicFacing (misclassified-public case)", () => {
    const home = setupHome("status-vis-json");
    const repo = makeRepo("status-vis-json-repo", "private-strict", "public");
    process.chdir(repo);
    const result = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() => status({ json: true })),
    );
    const j = JSON.parse(result.stdout) as { visibility: string; publicFacing: boolean };
    assert.equal(j.visibility, "public");
    assert.equal(j.publicFacing, true); // public visibility enforces despite private-strict
  });

  it("text output shows the github line and the reclassify hint", () => {
    const home = setupHome("status-vis-text");
    const repo = makeRepo("status-vis-text-repo", "private-strict", "public");
    process.chdir(repo);
    const result = withEnv("REPO_AEGIS_HOME", home, () => captureOutput(() => status({})));
    assert.match(result.stdout, /github:\s+public/);
    assert.match(result.stdout, /egress-hygiene enforced/);
    assert.match(result.stdout, /class=public-eligible/);
  });

  it("private repo is not public-facing", () => {
    const home = setupHome("status-vis-private");
    const repo = makeRepo("status-vis-private-repo", "private-strict", "private");
    process.chdir(repo);
    const result = withEnv("REPO_AEGIS_HOME", home, () =>
      captureOutput(() => status({ json: true })),
    );
    const j = JSON.parse(result.stdout) as { visibility: string; publicFacing: boolean };
    assert.equal(j.visibility, "private");
    assert.equal(j.publicFacing, false);
  });
});
