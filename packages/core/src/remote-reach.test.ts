// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { remoteReachableCommits } from "./remote-reach.js";

// SAFETY: every case runs against throwaway repos under a per-suite temp
// dir, with GIT_CONFIG_GLOBAL/SYSTEM redirected to files under that same
// temp dir. No test reads or writes the developer's real global git
// config. A real local bare remote is used (per the task's instruction)
// so `refs/remotes/*` genuinely exist rather than being faked.

let root: string;
let env: NodeJS.ProcessEnv;

before(() => {
  root = mkdtempSync(join(tmpdir(), "repo-aegis-remote-reach-"));
  env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: join(root, "gitconfig-global"),
    GIT_CONFIG_SYSTEM: join(root, "gitconfig-system"),
    GIT_CONFIG_NOSYSTEM: "1",
  };
  writeFileSync(env["GIT_CONFIG_GLOBAL"]!, "");
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env }).trim();
}

function commit(cwd: string, file: string, contents: string, message: string): string {
  writeFileSync(join(cwd, file), contents);
  git(cwd, ["add", file]);
  git(cwd, ["commit", "-q", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

/**
 * Bare remote + a clone with `origin` set up and fetched, so
 * `refs/remotes/origin/*` genuinely exist (not synthesised).
 */
function makeRemoteAndClone(name: string): { bare: string; clone: string } {
  const bare = join(root, `${name}-bare.git`);
  mkdirSync(bare);
  git(bare, ["init", "-q", "--bare", "--initial-branch=main"]);

  const seed = join(root, `${name}-seed`);
  mkdirSync(seed);
  git(seed, ["init", "-q", "--initial-branch=main"]);
  git(seed, ["config", "user.email", "t@t.com"]);
  git(seed, ["config", "user.name", "t"]);
  commit(seed, "seed.txt", "seed", "seed");
  git(seed, ["remote", "add", "origin", bare]);
  git(seed, ["push", "-q", "origin", "main"]);

  const clone = join(root, `${name}-clone`);
  git(root, ["clone", "-q", bare, clone]);
  git(clone, ["config", "user.email", "t@t.com"]);
  git(clone, ["config", "user.name", "t"]);
  return { bare, clone };
}

describe("remoteReachableCommits", () => {
  it("returns every commit reachable from refs/remotes/<remote>/*", () => {
    const { clone } = makeRemoteAndClone("basic");
    const headSha = git(clone, ["rev-parse", "origin/main"]);

    const set = remoteReachableCommits({ cwd: clone, isGitRepo: true }, "origin");
    assert.ok(set.has(headSha), "the pushed commit must be in the reachable set");
  });

  it("does not include a commit that exists only locally, never pushed", () => {
    const { clone } = makeRemoteAndClone("local-only");
    const localSha = commit(clone, "local.txt", "local", "local-only commit");

    const set = remoteReachableCommits({ cwd: clone, isGitRepo: true }, "origin");
    assert.equal(set.has(localSha), false, "an unpushed commit must not read as remote-reachable");
  });

  it("fails closed (empty set) when the repo has no such remote", () => {
    const { clone } = makeRemoteAndClone("no-remote");
    const set = remoteReachableCommits({ cwd: clone, isGitRepo: true }, "nonexistent-remote");
    assert.equal(set.size, 0);
  });

  it("fails closed (empty set) when repo.isGitRepo is false, without spawning git", () => {
    const set = remoteReachableCommits({ cwd: join(root, "does-not-exist"), isGitRepo: false }, "origin");
    assert.equal(set.size, 0);
  });

  it("fails closed (empty set) when cwd is not actually a git repo", () => {
    const notRepo = join(root, "plain-dir");
    mkdirSync(notRepo, { recursive: true });
    const set = remoteReachableCommits({ cwd: notRepo, isGitRepo: true }, "origin");
    assert.equal(set.size, 0);
  });

  it("a single rev-list covers multiple commits (not a spawn-per-commit design)", () => {
    const { clone } = makeRemoteAndClone("multi");
    const sha1 = commit(clone, "a.txt", "a", "a");
    const sha2 = commit(clone, "b.txt", "b", "b");
    git(clone, ["push", "-q", "origin", "main"]);
    git(clone, ["fetch", "-q", "origin"]);

    const set = remoteReachableCommits({ cwd: clone, isGitRepo: true }, "origin");
    assert.ok(set.has(sha1));
    assert.ok(set.has(sha2));
  });
});
