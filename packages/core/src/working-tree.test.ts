// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findEnclosingWorkingTree,
  resolveGitDir,
  getRemoteOrg,
} from "./working-tree.js";

let tmp: string;

before(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "repo-aegis-wt-")));
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function gitInit(dir: string): void {
  execFileSync("git", ["init", "-q", "--initial-branch=main", dir], { stdio: "ignore" });
}

function gitConfig(dir: string, key: string, value: string): void {
  execFileSync("git", ["-C", dir, "config", key, value], { stdio: "ignore" });
}

function commitNothing(dir: string): void {
  // Need at least one commit before `git worktree add`.
  gitConfig(dir, "user.email", "test@example.com");
  gitConfig(dir, "user.name", "Test");
  writeFileSync(join(dir, "README.md"), "x");
  execFileSync("git", ["-C", dir, "add", "README.md"], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", "initial"], { stdio: "ignore" });
}

describe("findEnclosingWorkingTree", () => {
  it("finds the enclosing working tree of a file in a regular repo", () => {
    const repo = join(tmp, "regular");
    mkdirSync(repo);
    gitInit(repo);
    const file = join(repo, "src", "foo.ts");
    mkdirSync(join(repo, "src"));
    writeFileSync(file, "x");
    assert.equal(findEnclosingWorkingTree(file), repo);
  });

  it("finds the working tree from a nested subdirectory", () => {
    const repo = join(tmp, "nested");
    mkdirSync(repo);
    gitInit(repo);
    const deep = join(repo, "a", "b", "c");
    mkdirSync(deep, { recursive: true });
    const file = join(deep, "deep.ts");
    writeFileSync(file, "x");
    assert.equal(findEnclosingWorkingTree(file), repo);
  });

  it("returns the worktree (not the parent repo) for a git worktree", () => {
    const main = join(tmp, "main-repo");
    mkdirSync(main);
    gitInit(main);
    commitNothing(main);
    const wt = join(tmp, "wt-feature");
    execFileSync("git", ["-C", main, "worktree", "add", "-q", "-b", "feat", wt], {
      stdio: "ignore",
    });
    const file = join(wt, "newfile.ts");
    writeFileSync(file, "x");
    assert.equal(findEnclosingWorkingTree(file), wt);
  });

  it("returns null for a path outside any git repo", () => {
    const outside = join(tmp, "no-git");
    mkdirSync(outside);
    writeFileSync(join(outside, "loose.txt"), "x");
    assert.equal(findEnclosingWorkingTree(join(outside, "loose.txt")), null);
  });

  it("follows symlinks (resolves to the destination's working tree)", () => {
    const repo = join(tmp, "sym-target");
    mkdirSync(repo);
    gitInit(repo);
    const target = join(repo, "real.ts");
    writeFileSync(target, "x");
    const linkDir = join(tmp, "sym-link");
    mkdirSync(linkDir);
    const link = join(linkDir, "alias.ts");
    symlinkSync(target, link);
    // Even though `link` lives outside `repo`, realpath resolves to
    // inside `repo`, and that's what we apply rules to.
    assert.equal(findEnclosingWorkingTree(link), repo);
  });

  it("works when the file does not yet exist (walks up to first existing ancestor)", () => {
    const repo = join(tmp, "no-file");
    mkdirSync(repo);
    gitInit(repo);
    const ghost = join(repo, "src", "not-yet.ts");
    // Don't create the file or its dir.
    assert.equal(findEnclosingWorkingTree(ghost), repo);
  });
});

describe("resolveGitDir", () => {
  it("returns <wt>/.git for a regular repo", () => {
    const repo = join(tmp, "rgd-regular");
    mkdirSync(repo);
    gitInit(repo);
    const gitDir = resolveGitDir(repo);
    assert.equal(gitDir, join(repo, ".git"));
  });

  it("resolves the linked gitdir for a worktree", () => {
    const main = join(tmp, "rgd-main");
    mkdirSync(main);
    gitInit(main);
    commitNothing(main);
    const wt = join(tmp, "rgd-wt");
    execFileSync("git", ["-C", main, "worktree", "add", "-q", "-b", "feat", wt], {
      stdio: "ignore",
    });
    const gitDir = resolveGitDir(wt);
    assert.ok(gitDir !== null);
    // Should point to <main>/.git/worktrees/<name>
    assert.match(gitDir!, /worktrees/);
  });

  it("returns null when .git is missing", () => {
    const dir = join(tmp, "rgd-bare");
    mkdirSync(dir);
    assert.equal(resolveGitDir(dir), null);
  });
});

describe("getRemoteOrg", () => {
  it("parses GitHub HTTPS URLs", () => {
    const repo = join(tmp, "remote-https");
    mkdirSync(repo);
    gitInit(repo);
    gitConfig(repo, "remote.origin.url", "https://github.com/Foo-Org/Bar.git");
    assert.equal(getRemoteOrg(repo), "foo-org");
  });

  it("parses GitHub SSH URLs", () => {
    const repo = join(tmp, "remote-ssh");
    mkdirSync(repo);
    gitInit(repo);
    gitConfig(repo, "remote.origin.url", "git@github.com:de-otio/repo-aegis.git");
    assert.equal(getRemoteOrg(repo), "de-otio");
  });

  it("parses ssh-config-alias URLs (`github.com-personal`)", () => {
    const repo = join(tmp, "remote-alias");
    mkdirSync(repo);
    gitInit(repo);
    gitConfig(repo, "remote.origin.url", "git@github.com-personal:de-otio/foo.git");
    assert.equal(getRemoteOrg(repo), "de-otio");
  });

  it("returns null when there is no origin remote", () => {
    const repo = join(tmp, "remote-none");
    mkdirSync(repo);
    gitInit(repo);
    assert.equal(getRemoteOrg(repo), null);
  });

  it("returns null for a non-GitHub remote", () => {
    const repo = join(tmp, "remote-non-gh");
    mkdirSync(repo);
    gitInit(repo);
    gitConfig(repo, "remote.origin.url", "https://gitlab.com/x/y.git");
    assert.equal(getRemoteOrg(repo), null);
  });

  it("returns null when the directory is not a working tree", () => {
    const dir = join(tmp, "remote-bare");
    mkdirSync(dir);
    assert.equal(getRemoteOrg(dir), null);
  });

  it("inherits the parent repo's origin from a linked worktree", () => {
    // Regression: pre-fix, worktrees returned null because
    // <wt-gitdir>/config does not exist — config lives in the
    // common gitdir, reached via the `commondir` pointer. The
    // hook's trust-boundary check then refused every cross-tree
    // write from a worktree with CROSS_ORG_WRITE, since the
    // worktree's boundary computed as empty even though the
    // parent had a perfectly good remote.
    const main = join(tmp, "remote-wt-main");
    mkdirSync(main);
    gitInit(main);
    gitConfig(main, "remote.origin.url", "git@github.com:de-otio/parent.git");
    commitNothing(main);
    const wt = join(tmp, "remote-wt-linked");
    execFileSync("git", ["-C", main, "worktree", "add", "-q", "-b", "feat", wt], {
      stdio: "ignore",
    });
    assert.equal(getRemoteOrg(wt), "de-otio");
  });
});
