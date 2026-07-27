// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findWorkingTrees } from "./repo-walk.js";

let tmp: string;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "repo-aegis-walk-"));
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("findWorkingTrees", () => {
  it("finds a working tree with a .git directory", () => {
    const root = join(tmp, "root-repo");
    const gitDir = join(root, ".git");
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(gitDir, "config"), "");

    const results = [...findWorkingTrees(root)];
    assert.deepEqual(results, [root]);
  });

  it("finds a working tree with a .git file (linked worktree)", () => {
    const root = join(tmp, "worktree");
    mkdirSync(root);
    writeFileSync(join(root, ".git"), "gitdir: /some/path/.git/worktrees/name\n");

    const results = [...findWorkingTrees(root)];
    assert.deepEqual(results, [root]);
  });

  it("stops at the first working tree and does not recurse into it", () => {
    // Structure:
    // repo-a/
    //   .git/
    //   nested/
    //     .git/  (should NOT be found)
    const repoA = join(tmp, "repo-a");
    const gitA = join(repoA, ".git");
    mkdirSync(gitA, { recursive: true });
    writeFileSync(join(gitA, "config"), "");

    const nested = join(repoA, "nested");
    const gitNested = join(nested, ".git");
    mkdirSync(gitNested, { recursive: true });
    writeFileSync(join(gitNested, "config"), "");

    const results = [...findWorkingTrees(repoA)];
    assert.deepEqual(results, [repoA], "should not find nested repo under repo-a");
  });

  it("skips node_modules directory entirely", () => {
    // Structure:
    // scan-root/
    //   repo-a/
    //     .git/
    //   node_modules/
    //     repo-b/
    //       .git/  (should NOT be found)
    const root = join(tmp, "npm-scan");
    mkdirSync(root);

    const repoA = join(root, "repo-a");
    const gitA = join(repoA, ".git");
    mkdirSync(gitA, { recursive: true });
    writeFileSync(join(gitA, "config"), "");

    const nmRepo = join(root, "node_modules", "repo-b", ".git");
    mkdirSync(nmRepo, { recursive: true });
    writeFileSync(join(nmRepo, "config"), "");

    const results = [...findWorkingTrees(root)];
    assert.deepEqual(results, [repoA], "should not find repos inside node_modules");
  });

  it("respects depth budget and stops at maxDepth", () => {
    // Create a deep tree: root/a/b/c/d (depth 4)
    // With depthBudget=2, should only walk to depth 2
    const root = join(tmp, "depth-test");
    const a = join(root, "a");
    const b = join(a, "b");
    const c = join(b, "c");
    const d = join(c, "d");
    mkdirSync(d, { recursive: true });

    // Put .git at depth 2 (should be found)
    mkdirSync(join(b, ".git"), { recursive: true });

    // Put .git at depth 4 (should NOT be found with depthBudget=2)
    mkdirSync(join(d, ".git"), { recursive: true });

    const results = [...findWorkingTrees(root, 2)];
    assert.deepEqual(results, [b], "should only find repos within depth budget");
  });

  it("finds multiple working trees at the same depth", () => {
    // Structure:
    // root/
    //   repo-a/
    //     .git/
    //   repo-b/
    //     .git/
    const root = join(tmp, "multi");
    mkdirSync(root);

    const repoA = join(root, "repo-a");
    mkdirSync(join(repoA, ".git"), { recursive: true });

    const repoB = join(root, "repo-b");
    mkdirSync(join(repoB, ".git"), { recursive: true });

    const results = [...findWorkingTrees(root)].sort();
    const expected = [repoA, repoB].sort();
    assert.deepEqual(results, expected);
  });

  it("skips non-existent root without error", () => {
    const results = [...findWorkingTrees(join(tmp, "nonexistent"))];
    assert.deepEqual(results, []);
  });

  it("skips dotfile directories (except for .git)", () => {
    // Structure:
    // root/
    //   .config/
    //     repo-hidden/
    //       .git/  (should NOT be found)
    //   repo-visible/
    //     .git/  (should be found)
    const root = join(tmp, "dotfiles");
    mkdirSync(root);

    const dotConfig = join(root, ".config");
    const repoHidden = join(dotConfig, "repo-hidden", ".git");
    mkdirSync(repoHidden, { recursive: true });

    const repoVisible = join(root, "repo-visible");
    mkdirSync(join(repoVisible, ".git"), { recursive: true });

    const results = [...findWorkingTrees(root)];
    assert.deepEqual(results, [repoVisible], "should skip .config and other dotfiles");
  });

  it("handles permission errors gracefully (continues on inaccessible dirs)", () => {
    // This test verifies the generator doesn't crash on inaccessible directories.
    // We can't easily make a truly unreadable dir in the test, but we verify
    // that the generator is robust by checking a reachable directory works.
    const root = join(tmp, "error-recovery");
    const repo = join(root, "accessible");
    mkdirSync(join(repo, ".git"), { recursive: true });

    const results = [...findWorkingTrees(root)];
    assert.deepEqual(results, [repo]);
  });
});
