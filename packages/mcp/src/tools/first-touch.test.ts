// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Unit tests for the `aegis_classify_first_touch` MCP tool. The tests
// drive `firstTouchClassify` directly (the impl function exported from
// the tool module) so we can spin up real git fixtures and a real
// registry per case without paying the MCP transport overhead. The
// server-side smoke test in server.test.ts covers tool registration
// and one end-to-end call.

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firstTouchClassify, redactOrg } from "./first-touch.js";

let tmp: string;
let gitDir: string;
let nonGitDir: string;
let registryPath: string;

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function setRemote(cwd: string, url: string): void {
  try {
    git(cwd, ["remote", "remove", "origin"]);
  } catch {
    /* not set */
  }
  git(cwd, ["remote", "add", "origin", url]);
}

function removeRemote(cwd: string): void {
  try {
    git(cwd, ["remote", "remove", "origin"]);
  } catch {
    /* not set */
  }
}

function unsetClass(cwd: string): void {
  try {
    execFileSync("git", ["config", "--unset", "repo-aegis.class"], {
      cwd,
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    /* not set */
  }
  try {
    execFileSync("git", ["config", "--unset-all", "repo-aegis.engagement"], {
      cwd,
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    /* not set */
  }
}

function writeRegistry(body: string): void {
  writeFileSync(registryPath, body, { mode: 0o600 });
}

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "repo-aegis-first-touch-"));
  gitDir = join(tmp, "git");
  nonGitDir = join(tmp, "non-git");
  registryPath = join(tmp, "engagements.yaml");
  mkdirSync(gitDir, { recursive: true });
  mkdirSync(nonGitDir, { recursive: true });
  git(gitDir, ["init", "-q", "-b", "main"]);
  git(gitDir, ["config", "user.email", "test@example.com"]);
  git(gitDir, ["config", "user.name", "test"]);
  process.env["REPO_AEGIS_REGISTRY"] = registryPath;
});

after(() => {
  delete process.env["REPO_AEGIS_REGISTRY"];
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  unsetClass(gitDir);
  removeRemote(gitDir);
});

describe("firstTouchClassify — skipped paths", () => {
  it("non-git cwd → status: skipped, reason: non-git", () => {
    const result = firstTouchClassify({ cwd: nonGitDir });
    assert.equal(result.status, "skipped");
    if (result.status === "skipped") {
      assert.equal(result.reason, "non-git");
    }
  });

  it("git repo with no remote → status: skipped, reason: no-remote", () => {
    writeRegistry(`schemaVersion: 2\nengagements: []\n`);
    const result = firstTouchClassify({ cwd: gitDir });
    assert.equal(result.status, "skipped");
    if (result.status === "skipped") {
      assert.equal(result.reason, "no-remote");
    }
  });

  it("non-github remote → status: skipped, reason: non-github-host", () => {
    writeRegistry(`schemaVersion: 2\nengagements: []\n`);
    setRemote(gitDir, "git@gitlab.com:foo/bar.git");
    const result = firstTouchClassify({ cwd: gitDir });
    assert.equal(result.status, "skipped");
    if (result.status === "skipped") {
      assert.equal(result.reason, "non-github-host");
    }
  });

  it("registry not found → status: skipped, reason: registry-not-found", () => {
    rmSync(registryPath, { force: true });
    setRemote(gitDir, "git@github.com:foo/bar.git");
    const result = firstTouchClassify({ cwd: gitDir });
    assert.equal(result.status, "skipped");
    if (result.status === "skipped") {
      assert.equal(result.reason, "registry-not-found");
    }
  });
});

describe("firstTouchClassify — already-classified", () => {
  it("returns status: already-classified when class is already set", () => {
    writeRegistry(`schemaVersion: 2\nengagements: []\n`);
    setRemote(gitDir, "git@github.com:foo/bar.git");
    execFileSync("git", ["config", "repo-aegis.class", "private-strict"], {
      cwd: gitDir,
    });
    const result = firstTouchClassify({ cwd: gitDir });
    assert.equal(result.status, "already-classified");
    if (result.status === "already-classified") {
      assert.equal(result.class, "private-strict");
    }
  });
});

describe("firstTouchClassify — applied", () => {
  it("personalOrgs match → applied, class: public-eligible", () => {
    writeRegistry(`schemaVersion: 2
personalOrgs: [my-handle]
engagements: []
`);
    setRemote(gitDir, "git@github.com:my-handle/dotfiles.git");
    const result = firstTouchClassify({ cwd: gitDir });
    assert.equal(result.status, "applied");
    if (result.status === "applied") {
      assert.equal(result.class, "public-eligible");
      assert.equal(result.engagement, null);
      assert.equal(result.markerWarning, null);
    }
  });

  it("engagement match with markers → applied, class: customer-coupled, markerWarning: null", () => {
    writeRegistry(`schemaVersion: 2
engagements:
  - id: foo-corp
    name: Foo Corp
    githubOrgs: [foo-corp]
    markers: [foo-marker]
`);
    setRemote(gitDir, "git@github.com:foo-corp/proj.git");
    const result = firstTouchClassify({ cwd: gitDir });
    assert.equal(result.status, "applied");
    if (result.status === "applied") {
      assert.equal(result.class, "customer-coupled");
      assert.equal(result.engagement, "foo-corp");
      assert.equal(result.markerWarning, null);
    }
  });

  it("[SEC H-5] engagement match with zero markers → applied with markerWarning", () => {
    writeRegistry(`schemaVersion: 2
engagements:
  - id: bare-co
    name: Bare Co
    githubOrgs: [bare-co]
    markers: []
`);
    setRemote(gitDir, "git@github.com:bare-co/proj.git");
    const result = firstTouchClassify({ cwd: gitDir });
    assert.equal(result.status, "applied");
    if (result.status === "applied") {
      assert.deepEqual(result.markerWarning, {
        engagementId: "bare-co",
        count: 0,
      });
    }
  });
});

describe("firstTouchClassify — needs-confirmation", () => {
  it("unknown org → status: needs-confirmation with redactedOrg", () => {
    writeRegistry(`schemaVersion: 2\nengagements: []\n`);
    setRemote(gitDir, "git@github.com:unknown-org/proj.git");
    const result = firstTouchClassify({ cwd: gitDir });
    assert.equal(result.status, "needs-confirmation");
    if (result.status === "needs-confirmation") {
      assert.equal(result.org, "unknown-org");
      assert.notEqual(result.redactedOrg, result.org);
      assert.match(result.redactedOrg, /^un\*\*\*g$/);
      assert.ok("newEngagement" in result.suggestion);
    }
  });

  it("does not mutate per-repo config on needs-confirmation", () => {
    writeRegistry(`schemaVersion: 2\nengagements: []\n`);
    setRemote(gitDir, "git@github.com:another-unknown/proj.git");
    firstTouchClassify({ cwd: gitDir });
    // git config --get exits 0 with value, or 1 if unset; we expect 1.
    let threw = false;
    try {
      execFileSync("git", ["config", "--get", "repo-aegis.class"], {
        cwd: gitDir,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      threw = true;
    }
    assert.equal(threw, true, "class should not be set");
  });

  it("[SEC H-5] redactedOrg is the same as org when org < 4 chars", () => {
    assert.equal(redactOrg("ab"), "ab");
    assert.equal(redactOrg("abc"), "abc");
    assert.equal(redactOrg("abcd"), "ab***d");
    assert.equal(redactOrg("acme-corp"), "ac***p");
  });
});
