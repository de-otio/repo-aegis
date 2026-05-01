import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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

let tmp: string;
let nonGitDir: string;
let gitDir: string;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "repo-aegis-repo-"));
  nonGitDir = join(tmp, "non-git");
  gitDir = join(tmp, "git");
  execFileSync("mkdir", ["-p", nonGitDir, gitDir]);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: gitDir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: gitDir });
  execFileSync("git", ["config", "user.name", "test"], { cwd: gitDir });
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("readRepoConfig", () => {
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
