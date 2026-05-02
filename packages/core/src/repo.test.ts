// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  readRepoConfig,
  addEngagement,
  addEngagements,
  removeEngagement,
  setClass,
  unsetClass,
  REPO_CLASSES,
} from "./repo.js";
import { NotAGitRepoError } from "./exceptions.js";

// Each describe block owns its own tmp/gitDir/nonGitDir to avoid cross-block
// state leakage when a test fails mid-cleanup. Previously a single file-level
// `before` allocated one tmp directory shared across every describe; a
// failure inside any `it` could leave git config in a state that broke later
// blocks. Per-describe fresh dirs make each block hermetic.

function mkGitDir(parent: string, name: string): string {
  const dir = join(parent, name);
  execFileSync("mkdir", ["-p", dir]);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
  return dir;
}

describe("readRepoConfig", () => {
  let tmp: string;
  let nonGitDir: string;
  let gitDir: string;

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "repo-aegis-repo-rrc-"));
    nonGitDir = join(tmp, "non-git");
    execFileSync("mkdir", ["-p", nonGitDir]);
    gitDir = mkGitDir(tmp, "git");
  });

  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns isGitRepo=false outside a git repo", () => {
    const cfg = readRepoConfig(nonGitDir);
    assert.equal(cfg.isGitRepo, false);
    assert.equal(cfg.class, "private-strict");
    assert.equal(cfg.engagements.length, 0);
  });

  it("returns isGitRepo=true with default class inside a git repo without config", () => {
    const cfg = readRepoConfig(gitDir);
    assert.equal(cfg.isGitRepo, true);
    assert.equal(cfg.class, "private-strict");
    assert.equal(cfg.classExplicit, false);
  });

  it("reads class when set", () => {
    setClass("public-eligible", gitDir);
    const cfg = readRepoConfig(gitDir);
    assert.equal(cfg.class, "public-eligible");
    assert.equal(cfg.classExplicit, true);
    unsetClass(gitDir);
  });

  it("falls back to private-strict when class value is invalid", () => {
    execFileSync("git", ["config", "repo-aegis.class", "bogus"], { cwd: gitDir });
    const cfg = readRepoConfig(gitDir);
    assert.equal(cfg.class, "private-strict");
    unsetClass(gitDir);
  });
});

describe("addEngagement / removeEngagement", () => {
  let tmp: string;
  let nonGitDir: string;
  let gitDir: string;

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "repo-aegis-repo-eng-"));
    nonGitDir = join(tmp, "non-git");
    execFileSync("mkdir", ["-p", nonGitDir]);
    gitDir = mkGitDir(tmp, "git");
  });

  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("adds and removes an engagement idempotently", () => {
    const r1 = addEngagement("customer-a", gitDir);
    assert.equal(r1, true);
    const r2 = addEngagement("customer-a", gitDir);
    assert.equal(r2, false); // already present
    const cfg = readRepoConfig(gitDir);
    assert.ok(cfg.engagements.includes("customer-a"));
    const removed = removeEngagement("customer-a", gitDir);
    assert.equal(removed, true);
    const cfg2 = readRepoConfig(gitDir);
    assert.ok(!cfg2.engagements.includes("customer-a"));
  });

  it("removeEngagement returns false when not present", () => {
    const r = removeEngagement("never-was-set", gitDir);
    assert.equal(r, false);
  });

  it("supports multiple engagements (multi-value config)", () => {
    addEngagement("customer-a", gitDir);
    addEngagement("customer-b", gitDir);
    const cfg = readRepoConfig(gitDir);
    assert.deepEqual([...cfg.engagements].sort(), ["customer-a", "customer-b"]);
    removeEngagement("customer-a", gitDir);
    removeEngagement("customer-b", gitDir);
  });

  it("addEngagements multi-add returns only newly-added ids", () => {
    addEngagement("customer-a", gitDir);
    const added = addEngagements(["customer-a", "customer-b", "customer-c"], gitDir);
    assert.deepEqual(added.sort(), ["customer-b", "customer-c"]);
    removeEngagement("customer-a", gitDir);
    removeEngagement("customer-b", gitDir);
    removeEngagement("customer-c", gitDir);
  });

  it("escapes regex-special characters in engagement id when removing", () => {
    // ids shouldn't typically have special chars, but verify the escape works
    addEngagement("customer.a", gitDir);
    addEngagement("customer-a", gitDir);
    removeEngagement("customer.a", gitDir);
    const cfg = readRepoConfig(gitDir);
    // customer-a should still be present; only customer.a removed
    assert.ok(cfg.engagements.includes("customer-a"));
    assert.ok(!cfg.engagements.includes("customer.a"));
    removeEngagement("customer-a", gitDir);
  });

  it("throws NotAGitRepoError outside a git repo", () => {
    assert.throws(() => addEngagement("x", nonGitDir), NotAGitRepoError);
    assert.throws(() => removeEngagement("x", nonGitDir), NotAGitRepoError);
  });
});

describe("setClass / unsetClass", () => {
  let tmp: string;
  let nonGitDir: string;
  let gitDir: string;

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "repo-aegis-repo-cls-"));
    nonGitDir = join(tmp, "non-git");
    execFileSync("mkdir", ["-p", nonGitDir]);
    gitDir = mkGitDir(tmp, "git");
  });

  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("each REPO_CLASSES value can round-trip", () => {
    for (const cls of REPO_CLASSES) {
      setClass(cls, gitDir);
      const cfg = readRepoConfig(gitDir);
      assert.equal(cfg.class, cls);
    }
    unsetClass(gitDir);
  });

  it("unsetClass on already-unset config does not throw", () => {
    unsetClass(gitDir);
    unsetClass(gitDir);
    const cfg = readRepoConfig(gitDir);
    assert.equal(cfg.classExplicit, false);
  });

  it("setClass throws NotAGitRepoError outside a git repo", () => {
    assert.throws(() => setClass("public-eligible", nonGitDir), NotAGitRepoError);
  });
});

describe(".repo-aegis.yml overrides", () => {
  let tmp: string;
  let overrideRepo: string;
  const yamlPath = (dir: string): string => join(dir, ".repo-aegis.yml");
  const writeOverride = (dir: string, body: string): void => {
    writeFileSync(yamlPath(dir), body);
  };

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "repo-aegis-repo-yml-"));
    overrideRepo = mkGitDir(tmp, "override-repo");
  });

  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("yml provides class when git config does not", () => {
    writeOverride(overrideRepo, "class: customer-coupled\nengagements: [from-yml]\n");
    const cfg = readRepoConfig(overrideRepo);
    assert.equal(cfg.class, "customer-coupled");
    assert.equal(cfg.classExplicit, true);
    assert.equal(cfg.classFromOverride, true);
    assert.deepEqual(cfg.engagements, ["from-yml"]);
    assert.equal(cfg.engagementsFromOverride, true);
    rmSync(yamlPath(overrideRepo));
    unsetClass(overrideRepo);
  });

  it("git config wins over yml when both set", () => {
    execFileSync("git", ["config", "repo-aegis.class", "private-strict"], {
      cwd: overrideRepo,
    });
    execFileSync("git", ["config", "--add", "repo-aegis.engagement", "from-config"], {
      cwd: overrideRepo,
    });
    writeOverride(overrideRepo, "class: customer-coupled\nengagements: [from-yml]\n");
    const cfg = readRepoConfig(overrideRepo);
    assert.equal(cfg.class, "private-strict", "git config class wins");
    assert.equal(cfg.classFromOverride, undefined);
    assert.deepEqual(cfg.engagements, ["from-config"]);
    assert.equal(cfg.engagementsFromOverride, undefined);
    execFileSync("git", ["config", "--unset-all", "repo-aegis.class"], { cwd: overrideRepo });
    execFileSync("git", ["config", "--unset-all", "repo-aegis.engagement"], { cwd: overrideRepo });
    rmSync(yamlPath(overrideRepo));
  });

  it("invalid class in yml throws RepoOverrideError", async () => {
    const { RepoOverrideError } = await import("./repo.js");
    writeOverride(overrideRepo, "class: not-a-real-class\n");
    assert.throws(() => readRepoConfig(overrideRepo), RepoOverrideError);
    rmSync(yamlPath(overrideRepo));
  });

  it("non-array engagements throws RepoOverrideError", async () => {
    const { RepoOverrideError } = await import("./repo.js");
    writeOverride(overrideRepo, "engagements: customer-a\n");
    assert.throws(() => readRepoConfig(overrideRepo), RepoOverrideError);
    rmSync(yamlPath(overrideRepo));
  });

  it("malformed YAML throws RepoOverrideError", async () => {
    const { RepoOverrideError } = await import("./repo.js");
    writeOverride(overrideRepo, "class: customer-coupled\n  unindented: bad\n");
    assert.throws(() => readRepoConfig(overrideRepo), RepoOverrideError);
    rmSync(yamlPath(overrideRepo));
  });

  it("yml is found via git toplevel even from a subdirectory", () => {
    const sub = join(overrideRepo, "src", "deep");
    execFileSync("mkdir", ["-p", sub]);
    writeOverride(overrideRepo, "class: scratch\n");
    const cfg = readRepoConfig(sub);
    assert.equal(cfg.class, "scratch");
    assert.equal(cfg.classFromOverride, true);
    rmSync(yamlPath(overrideRepo));
  });

  it("works in non-git dirs (yml at cwd)", () => {
    const dir = join(tmp, "non-git-with-yml");
    execFileSync("mkdir", ["-p", dir]);
    writeOverride(dir, "class: scratch\n");
    const cfg = readRepoConfig(dir);
    assert.equal(cfg.isGitRepo, false);
    assert.equal(cfg.class, "scratch");
    assert.equal(cfg.classFromOverride, true);
  });
});
