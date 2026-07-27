// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scanText,
  scanTextDetailed,
  scanFile,
  scanStagedDiff,
  scanRange,
  scanHistory,
  scanDiffText,
  resolveNewRefBase,
  scanNewRef,
  EMPTY_TREE_SHA,
} from "./scan.js";
import { GitCommandError } from "./exceptions.js";
import { GlobTooBroadError } from "./globs.js";
import { patternId } from "./waivers.js";
import type { DenySet } from "./deny-set.js";
import type { RepoConfig } from "./repo.js";

const denySetWithPatterns = (patterns: string[]): DenySet => ({
  files: [],
  patterns,
  combinedRegex: patterns.join("|"),
  warnings: [],
});

let tmp: string;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "repo-aegis-scan-"));
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("scanText", () => {
  it("returns no hits with empty deny set", () => {
    const ds: DenySet = { files: [], patterns: [], combinedRegex: "", warnings: [] };
    assert.deepEqual(scanText("anything", ds), []);
  });

  it("returns no hits when text doesn't match", () => {
    const ds = denySetWithPatterns(["acme-corp", "betaco"]);
    assert.deepEqual(scanText("hello world", ds), []);
  });

  it("returns one hit per matching line", () => {
    const ds = denySetWithPatterns(["acme-corp", "betaco"]);
    const hits = scanText("first line\nsecond has acme-corp\nthird line\nfourth has betaco", ds);
    assert.equal(hits.length, 2);
    assert.equal(hits[0]!.line, 2);
    assert.equal(hits[1]!.line, 4);
  });

  it("computes accurate column number", () => {
    const ds = denySetWithPatterns(["acme-corp"]);
    const hits = scanText("padding acme-corp here", ds);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.column, 9);
  });

  it("redacts match by default (preview format)", () => {
    const ds = denySetWithPatterns(["acme-corp"]);
    const hits = scanText("see acme-corp", ds);
    assert.equal(hits[0]!.matchPreview, "acm***9");
    assert.ok(!hits[0]!.matchPreview.includes("corp"));
  });

  it("reveals literal when revealMatches is true", () => {
    const ds = denySetWithPatterns(["acme-corp"]);
    const hits = scanText("see acme-corp", ds, undefined, { revealMatches: true });
    assert.equal(hits[0]!.matchPreview, "acme-corp");
  });

  it("redaction never echoes the literal", () => {
    const ds = denySetWithPatterns(["very-specific-customer-name"]);
    const hits = scanText("contains very-specific-customer-name here", ds);
    assert.ok(!hits[0]!.matchPreview.includes("specific"));
    assert.ok(!hits[0]!.matchPreview.includes("customer"));
  });

  it("propagates path field when provided", () => {
    const ds = denySetWithPatterns(["acme"]);
    const hits = scanText("acme!", ds, "src/foo.ts");
    assert.equal(hits[0]!.path, "src/foo.ts");
  });

  it("case-insensitive matching", () => {
    const ds = denySetWithPatterns(["acme"]);
    const hits = scanText("see ACME-Corp", ds);
    assert.equal(hits.length, 1);
  });

  it("respects per-line allow comments by default", () => {
    const ds = denySetWithPatterns(["acme-corp"]);
    const text = [
      "this acme-corp has hit",
      "this acme-corp is fine // repo-aegis: allow synthetic fixture",
      "this acme-corp is also a hit",
    ].join("\n");
    const hits = scanText(text, ds);
    assert.equal(hits.length, 2);
    assert.equal(hits[0]!.line, 1);
    assert.equal(hits[1]!.line, 3);
  });

  it("recognises the allow comment in any comment style", () => {
    const ds = denySetWithPatterns(["acme-corp"]);
    const cases = [
      "acme-corp # repo-aegis: allow",
      "acme-corp /* repo-aegis: allow */",
      "acme-corp <!-- repo-aegis: allow -->",
      "acme-corp ;; repo-aegis: allow",
    ];
    for (const text of cases) {
      assert.equal(scanText(text, ds).length, 0, `should suppress: ${text}`);
    }
  });

  it("does NOT suppress when allow token is malformed", () => {
    const ds = denySetWithPatterns(["acme-corp"]);
    const text = "acme-corp # repo-aegis allow"; // missing colon
    assert.equal(scanText(text, ds).length, 1);
  });

  it("respectAllowComments=false bypasses suppression", () => {
    const ds = denySetWithPatterns(["acme-corp"]);
    const text = "acme-corp // repo-aegis: allow";
    const hits = scanText(text, ds, undefined, { respectAllowComments: false });
    assert.equal(hits.length, 1);
  });

  it("attributes the matched pattern to its source engagement", () => {
    // Two patterns from two different "engagements". Hit on the second
    // pattern should report engagement = "customer-b".
    const ds: DenySet = {
      files: [],
      patterns: ["alpha-marker", "bravo-marker"],
      patternSources: ["customer-a", "customer-b"],
      combinedRegex: "alpha-marker|bravo-marker",
      warnings: [],
    };
    const hits = scanText("see bravo-marker", ds);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.engagement, "customer-b");
  });

  it("omits engagement when patternSources is missing", () => {
    const ds = denySetWithPatterns(["lone-marker"]);
    const hits = scanText("see lone-marker", ds);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.engagement, undefined);
  });

  it("omits engagement when patternSources length mismatches", () => {
    const ds: DenySet = {
      files: [],
      patterns: ["a-marker", "b-marker"],
      patternSources: ["only-one"], // length mismatch
      combinedRegex: "a-marker|b-marker",
      warnings: [],
    };
    const hits = scanText("see a-marker", ds);
    assert.equal(hits[0]!.engagement, undefined);
  });
});

describe("scanFile", () => {
  it("returns hits from a real file", () => {
    const path = join(tmp, "test.txt");
    writeFileSync(path, "first line\nsecond has acme-corp here");
    const ds = denySetWithPatterns(["acme-corp"]);
    const r = scanFile(path, ds);
    assert.equal(r.hits.length, 1);
    assert.equal(r.skipped.length, 0);
  });

  it("skips binary files (NUL byte heuristic)", () => {
    const path = join(tmp, "binary.bin");
    writeFileSync(path, Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]));
    const ds = denySetWithPatterns(["a"]);
    const r = scanFile(path, ds);
    assert.equal(r.hits.length, 0);
    assert.equal(r.skipped.length, 1);
    assert.equal(r.skipped[0]!.reason, "binary");
  });

  it("skips files over the size limit", () => {
    const path = join(tmp, "big.txt");
    writeFileSync(path, "a".repeat(100));
    const ds = denySetWithPatterns(["a"]);
    const r = scanFile(path, ds, { maxFileBytes: 50 });
    assert.equal(r.hits.length, 0);
    assert.equal(r.skipped[0]!.reason, "too-large");
  });

  it("reports unreadable for missing files", () => {
    const ds = denySetWithPatterns(["a"]);
    const r = scanFile(join(tmp, "doesnotexist.txt"), ds);
    assert.equal(r.skipped[0]!.reason, "unreadable");
  });
});

function makeRepoConfig(cwd: string): RepoConfig {
  return {
    cwd,
    isGitRepo: true,
    class: "private-strict",
    classExplicit: true,
    engagements: [],
  };
}

function gitInit(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
}

function commit(dir: string, files: Record<string, string>, msg: string): string {
  for (const [p, c] of Object.entries(files)) {
    writeFileSync(join(dir, p), c);
    execFileSync("git", ["add", p], { cwd: dir });
  }
  execFileSync("git", ["commit", "-q", "-m", msg], { cwd: dir });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
}

describe("scanRange", () => {
  it("returns no hits when range has no matching additions", () => {
    const dir = join(tmp, "range-clean");
    gitInit(dir);
    const a = commit(dir, { "f.txt": "hello\n" }, "init");
    const b = commit(dir, { "f.txt": "hello\nworld\n" }, "add world");
    const r = scanRange(makeRepoConfig(dir), denySetWithPatterns(["secret-marker"]), `${a}..${b}`);
    assert.equal(r.hits.length, 0);
  });

  it("flags an added line that contains a marker", () => {
    const dir = join(tmp, "range-hit");
    gitInit(dir);
    const a = commit(dir, { "f.txt": "hello\n" }, "init");
    const b = commit(dir, { "f.txt": "hello\nleaked-marker-here\n" }, "leak");
    const r = scanRange(
      makeRepoConfig(dir),
      denySetWithPatterns(["leaked-marker"]),
      `${a}..${b}`,
    );
    assert.equal(r.hits.length, 1);
  });

  it("does NOT flag a removed line (only + lines)", () => {
    const dir = join(tmp, "range-removed");
    gitInit(dir);
    const a = commit(dir, { "f.txt": "removed-marker\n" }, "init");
    const b = commit(dir, { "f.txt": "" }, "remove");
    const r = scanRange(
      makeRepoConfig(dir),
      denySetWithPatterns(["removed-marker"]),
      `${a}..${b}`,
    );
    assert.equal(r.hits.length, 0);
  });

  it("redacts the literal in matchPreview by default", () => {
    const dir = join(tmp, "range-redact");
    gitInit(dir);
    const a = commit(dir, { "f.txt": "x\n" }, "init");
    const b = commit(dir, { "f.txt": "x\nspecific-leak-string\n" }, "leak");
    const r = scanRange(
      makeRepoConfig(dir),
      denySetWithPatterns(["specific-leak-string"]),
      `${a}..${b}`,
    );
    assert.ok(!r.hits[0]!.matchPreview.includes("specific-leak"));
  });
});

describe("scanRange diff parsing edge cases", () => {
  it("does NOT flag the literal '+++ b/<name>' header even when the path matches a pattern", () => {
    // Construct a scenario where the new filename itself contains the
    // marker. The hand-rolled `+`-line filter would have read
    // `+++ b/leaked-marker.txt` as added content (after slicing the
    // first `+`, the content `++ b/leaked-marker.txt` no longer starts
    // with `+`, but historically `+++` was special-cased only for the
    // header itself — pattern-matching the path is the false positive
    // here). parse-diff treats `+++ b/...` as a header and never emits
    // it as an `add` change.
    const dir = join(tmp, "range-rename-header");
    gitInit(dir);
    const a = commit(dir, { "ordinary.txt": "hello\n" }, "init");
    // Rename ordinary.txt to a name that contains the marker. No
    // content changes, so no `add` content lines should be emitted.
    execFileSync("git", ["mv", "ordinary.txt", "leaked-marker.txt"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "rename"], { cwd: dir });
    const b = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: dir,
      encoding: "utf8",
    }).trim();
    const r = scanRange(
      makeRepoConfig(dir),
      denySetWithPatterns(["leaked-marker"]),
      `${a}..${b}`,
    );
    assert.equal(
      r.hits.length,
      0,
      "filename in '+++ b/...' header must not be scanned as content",
    );
  });

  it("a pure rename (no content changes) yields no additions", () => {
    const dir = join(tmp, "range-rename-only");
    gitInit(dir);
    const a = commit(dir, { "old.txt": "the-secret-marker\n" }, "init");
    execFileSync("git", ["mv", "old.txt", "new.txt"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "rename"], { cwd: dir });
    const b = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: dir,
      encoding: "utf8",
    }).trim();
    const r = scanRange(
      makeRepoConfig(dir),
      denySetWithPatterns(["the-secret-marker"]),
      `${a}..${b}`,
    );
    assert.equal(
      r.hits.length,
      0,
      "pure rename has no `add` changes; pre-existing content must not be re-flagged",
    );
  });

  it("flags an added line whose literal content begins with '+'", () => {
    // A hunk line of `++added-marker` is, in unified-diff terms, an
    // `add` whose content is `+added-marker`. The hand-rolled filter
    // sliced one `+` off the front (correct), giving `+added-marker`,
    // so it would still flag — but the property under test is that
    // parse-diff also flags it (i.e. we didn't regress the
    // "+`-prefixed in-hunk content gets scanned" case).
    const dir = join(tmp, "range-plus-prefixed");
    gitInit(dir);
    const a = commit(dir, { "f.txt": "hello\n" }, "init");
    const b = commit(
      dir,
      { "f.txt": "hello\n+added-marker\n" },
      "add plus-prefixed line",
    );
    const r = scanRange(
      makeRepoConfig(dir),
      denySetWithPatterns(["added-marker"]),
      `${a}..${b}`,
    );
    assert.equal(r.hits.length, 1, "added line whose content starts with '+' must be flagged");
  });

  it("does NOT flag context (unchanged) lines whose content begins with '+'", () => {
    // With -U0 there are no context lines in scanRange's git invocation,
    // but feed a synthetic diff through extractAdditions via scanStagedDiff
    // would require staging. Instead, exercise the parser directly through
    // a multi-hunk scenario: two unrelated changes far apart in a file
    // already containing a '+'-prefixed line; only the actually-added
    // line should be flagged.
    const dir = join(tmp, "range-context-plus");
    gitInit(dir);
    // Pre-existing line "+context-marker" is committed (so it lives in
    // the file at base), then an unrelated benign change is added.
    const a = commit(
      dir,
      { "f.txt": "alpha\n+context-marker\nbeta\n" },
      "init with plus-prefixed context",
    );
    const b = commit(
      dir,
      { "f.txt": "alpha\n+context-marker\nbeta\nharmless\n" },
      "append harmless line",
    );
    const r = scanRange(
      makeRepoConfig(dir),
      denySetWithPatterns(["context-marker"]),
      `${a}..${b}`,
    );
    assert.equal(
      r.hits.length,
      0,
      "context line containing '+context-marker' must not be flagged when only an unrelated line was added",
    );
  });
});

describe("scanStagedDiff", () => {
  it("flags an added line in the staged diff", () => {
    const dir = join(tmp, "staged-hit");
    gitInit(dir);
    commit(dir, { "f.txt": "hello\n" }, "init");
    writeFileSync(join(dir, "f.txt"), "hello\nstaged-leak-marker\n");
    execFileSync("git", ["add", "f.txt"], { cwd: dir });
    const r = scanStagedDiff(
      makeRepoConfig(dir),
      denySetWithPatterns(["staged-leak-marker"]),
    );
    assert.equal(r.hits.length, 1);
  });

  it("does NOT flag the new filename in a staged rename whose path matches a pattern", () => {
    const dir = join(tmp, "staged-rename");
    gitInit(dir);
    commit(dir, { "ordinary.txt": "hello\n" }, "init");
    execFileSync("git", ["mv", "ordinary.txt", "leaked-marker.txt"], { cwd: dir });
    // staged but not committed
    const r = scanStagedDiff(
      makeRepoConfig(dir),
      denySetWithPatterns(["leaked-marker"]),
    );
    assert.equal(
      r.hits.length,
      0,
      "filename in '+++ b/...' header must not be scanned as content",
    );
  });
});

describe("scanHistory", () => {
  it("finds a commit whose diff contains a marker pattern", () => {
    const dir = join(tmp, "hist-hit");
    gitInit(dir);
    commit(dir, { "f.txt": "x\n" }, "init");
    const sha = commit(dir, { "f.txt": "x\nhistorical-marker-leak\n" }, "leaks-it");
    const hits = scanHistory(makeRepoConfig(dir), denySetWithPatterns(["historical-marker-leak"]));
    assert.ok(hits.length >= 1);
    assert.ok(hits.some(h => sha.startsWith(h.commitSha)));
  });

  it("returns empty when no commits match any pattern", () => {
    const dir = join(tmp, "hist-clean");
    gitInit(dir);
    commit(dir, { "f.txt": "boring\n" }, "init");
    const hits = scanHistory(makeRepoConfig(dir), denySetWithPatterns(["never-existed"]));
    assert.equal(hits.length, 0);
  });

  it("redacts the pattern by default", () => {
    const dir = join(tmp, "hist-redact");
    gitInit(dir);
    commit(dir, { "f.txt": "secret-pattern-x\n" }, "leak");
    const hits = scanHistory(makeRepoConfig(dir), denySetWithPatterns(["secret-pattern-x"]));
    assert.ok(hits.length >= 1);
    assert.ok(!hits[0]!.pattern.includes("secret-pattern"));
  });

  it("reveals literal pattern with revealMatches=true", () => {
    const dir = join(tmp, "hist-reveal");
    gitInit(dir);
    commit(dir, { "f.txt": "secret-pattern-y\n" }, "leak");
    const hits = scanHistory(
      makeRepoConfig(dir),
      denySetWithPatterns(["secret-pattern-y"]),
      { revealMatches: true },
    );
    assert.equal(hits[0]!.pattern, "secret-pattern-y");
  });

  it("multi-pattern scan: all patterns attributed in a single git invocation", () => {
    // Two distinct patterns, each leaked in a different commit. The
    // refactor combines patterns into one `git log -G '<a>|<b>'`
    // invocation; we verify that with a counting `git` shim on PATH
    // and assert exactly ONE git invocation drove the whole scan.
    const dir = join(tmp, "hist-multi");
    gitInit(dir);
    commit(dir, { "f.txt": "init\n" }, "init");
    const shaA = commit(
      dir,
      { "f.txt": "init\nalpha-leak-marker-here\n" },
      "leak alpha",
    );
    const shaB = commit(
      dir,
      { "f.txt": "init\nalpha-leak-marker-here\nbravo-leak-marker-here\n" },
      "leak bravo",
    );

    // Build a fake `git` on PATH that records each invocation to a
    // log file and then exec()s the real git so behaviour is
    // unchanged. Sufficient for invocation counting.
    const shimDir = mkdtempSync(join(tmp, "shim-"));
    const logPath = join(shimDir, "git-calls.log");
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const shim = `#!/usr/bin/env bash\necho "$@" >> "${logPath}"\nexec ${realGit} "$@"\n`;
    writeFileSync(join(shimDir, "git"), shim);
    execFileSync("chmod", ["+x", join(shimDir, "git")]);

    const prevPath = process.env["PATH"];
    process.env["PATH"] = `${shimDir}:${prevPath ?? ""}`;
    let hits;
    try {
      hits = scanHistory(
        makeRepoConfig(dir),
        denySetWithPatterns(["alpha-leak-marker", "bravo-leak-marker"]),
        { revealMatches: true },
      );
    } finally {
      if (prevPath !== undefined) process.env["PATH"] = prevPath;
      else delete process.env["PATH"];
    }

    // Only one git invocation should have been made by scanHistory.
    const calls = readFileSync(logPath, "utf8")
      .split("\n")
      .filter(Boolean);
    // Some calls may include `git log -G` and others come from the
    // shim itself only when scanHistory invoked git. The test gitInit
    // / commit helpers call `execFileSync("git", ...)` *directly* with
    // an absolute path resolved at import time, so they bypass the
    // shim and don't pollute the count. (We installed the shim AFTER
    // those commits.) Therefore exactly one entry is expected.
    assert.equal(
      calls.length,
      1,
      `expected exactly 1 git invocation, got ${calls.length}: ${calls.join(" | ")}`,
    );
    assert.ok(calls[0]!.includes("log"), `expected log subcommand, got: ${calls[0]}`);

    // Each pattern must attribute to the commit that *introduced* it.
    // (`git log -G` filters to commits where the diff content
    // matched. Once a line is present, subsequent commits that don't
    // touch it won't appear for that pattern.)
    const alphaHits = hits.filter(h => h.pattern === "alpha-leak-marker");
    const bravoHits = hits.filter(h => h.pattern === "bravo-leak-marker");
    assert.ok(
      alphaHits.some(h => shaA.startsWith(h.commitSha)),
      `alpha pattern should attribute to commit ${shaA.slice(0, 7)}`,
    );
    assert.ok(
      bravoHits.some(h => shaB.startsWith(h.commitSha)),
      `bravo pattern should attribute to commit ${shaB.slice(0, 7)}`,
    );
    assert.ok(
      !bravoHits.some(h => shaA.startsWith(h.commitSha)),
      `bravo pattern must NOT attribute to commit ${shaA.slice(0, 7)} (not introduced there)`,
    );
  });
});

/**
 * Regression suite for the `--diff-filter=ACM` → `ACMR` fix.
 *
 * `ACM` dropped rename entries while git's rename detection stayed on by
 * default, so moving a file and adding a marker in the same change made
 * the marker invisible to both hooks. Every test in this block fails
 * (0 hits instead of 1) if the filter loses its `R`.
 */
describe("diff filter covers renames", () => {
  /**
   * Rename detection is similarity-based: git only emits an `R` entry
   * when the post-image is close enough to the pre-image. A two-line
   * file that gains a line falls *under* the 50% threshold and is
   * reported as add+delete — which the old `ACM` filter caught by
   * accident. These tests therefore need a body substantial enough
   * that git genuinely classifies the change as a rename, and each one
   * asserts that premise before asserting the hit.
   */
  const renameableBody =
    Array.from({ length: 40 }, (_, i) => `stable line ${i}`).join("\n") + "\n";

  function assertGitSawARename(dir: string): void {
    const nameStatus = execFileSync("git", ["diff", "--cached", "--name-status"], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.match(
      nameStatus,
      /^R/m,
      `test premise broken: git did not detect a rename\n${nameStatus}`,
    );
  }

  it("flags a marker appended in the same staged change as a git mv", () => {
    const dir = join(tmp, "filter-staged-rename-modify");
    gitInit(dir);
    commit(dir, { "a.txt": renameableBody }, "init");
    execFileSync("git", ["mv", "a.txt", "b.txt"], { cwd: dir });
    writeFileSync(join(dir, "b.txt"), renameableBody + "renamed-leak-marker\n");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    assertGitSawARename(dir);
    const r = scanStagedDiff(
      makeRepoConfig(dir),
      denySetWithPatterns(["renamed-leak-marker"]),
    );
    assert.equal(
      r.hits.length,
      1,
      "rename+modify must be scanned; --diff-filter must include R",
    );
  });

  it("flags a marker appended in the same committed change as a git mv", () => {
    const dir = join(tmp, "filter-range-rename-modify");
    gitInit(dir);
    const a = commit(dir, { "a.txt": renameableBody }, "init");
    execFileSync("git", ["mv", "a.txt", "b.txt"], { cwd: dir });
    writeFileSync(join(dir, "b.txt"), renameableBody + "renamed-range-marker\n");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    assertGitSawARename(dir);
    execFileSync("git", ["commit", "-q", "-m", "move and leak"], { cwd: dir });
    const b = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: dir,
      encoding: "utf8",
    }).trim();
    const r = scanRange(
      makeRepoConfig(dir),
      denySetWithPatterns(["renamed-range-marker"]),
      `${a}..${b}`,
    );
    assert.equal(r.hits.length, 1, "rename+modify in a range must be scanned");
  });

  it("scans a copied file (arrives as an addition without copy detection)", () => {
    const dir = join(tmp, "filter-copy");
    gitInit(dir);
    commit(dir, { "orig.txt": "shared body\n" }, "init");
    writeFileSync(join(dir, "copy.txt"), "shared body\ncopied-leak-marker\n");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    const r = scanStagedDiff(
      makeRepoConfig(dir),
      denySetWithPatterns(["copied-leak-marker"]),
    );
    assert.equal(r.hits.length, 1);
  });

  it("does NOT flag a deleted file's content (D stays excluded)", () => {
    const dir = join(tmp, "filter-delete");
    gitInit(dir);
    commit(dir, { "gone.txt": "deleted-only-marker\n" }, "init");
    execFileSync("git", ["rm", "-q", "gone.txt"], { cwd: dir });
    const r = scanStagedDiff(
      makeRepoConfig(dir),
      denySetWithPatterns(["deleted-only-marker"]),
    );
    assert.equal(r.hits.length, 0, "removing content cannot leak it");
  });
});

/**
 * Fail-closed behaviour. A scanner that answers "clean" because git
 * failed is worse than one that answers nothing, so every git failure
 * must surface as a GitCommandError rather than an empty hit list.
 */
describe("git failures fail closed", () => {
  it("scanHistory throws GitCommandError instead of reporting clean", () => {
    const dir = join(tmp, "fail-history");
    gitInit(dir);
    commit(dir, { "f.txt": "boring\n" }, "init");
    let thrown: unknown;
    try {
      scanHistory(makeRepoConfig(dir), denySetWithPatterns(["some-marker"]), {
        since: "no-such-ref-at-all",
      });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof GitCommandError, "must throw, not return []");
    assert.equal(thrown.code, "GIT_ERROR");
    assert.equal(thrown.subcommand, "log");
  });

  it("scanRange throws GitCommandError on an invalid range", () => {
    const dir = join(tmp, "fail-range");
    gitInit(dir);
    commit(dir, { "f.txt": "boring\n" }, "init");
    assert.throws(
      () => scanRange(makeRepoConfig(dir), denySetWithPatterns(["m"]), "nope..alsonope"),
      (err: unknown) =>
        err instanceof GitCommandError && err.code === "GIT_ERROR" && err.subcommand === "diff",
    );
  });

  it("the error message leaks neither pattern nor git stderr", () => {
    const dir = join(tmp, "fail-noleak");
    gitInit(dir);
    commit(dir, { "f.txt": "boring\n" }, "init");
    // A pattern distinctive enough that any echo of it is unmistakable.
    const pattern = "zzq-distinctive-pattern";
    let msg = "";
    try {
      scanHistory(makeRepoConfig(dir), denySetWithPatterns([pattern]), {
        since: "no-such-ref-at-all",
      });
    } catch (err) {
      msg = (err as Error).message;
    }
    assert.ok(msg.length > 0, "expected a thrown error");
    assert.ok(!msg.includes("zzq-distinctive"), `message echoed the pattern: ${msg}`);
    // git's own stderr for a bad revspec names the revspec; the message
    // must be built from the subcommand and status only.
    assert.ok(!msg.includes("no-such-ref-at-all"), `message embedded git stderr: ${msg}`);
  });
});

/**
 * Path and blob attribution on diff-mode hits. Before this, a hit from
 * `--staged` or `--range` carried only line/column and the CLI printed
 * `<staged>` for the location.
 */
describe("diff hits carry path and blob", () => {
  it("attributes each hit in a multi-file staged diff to its own file", () => {
    const dir = join(tmp, "path-multifile");
    gitInit(dir);
    commit(dir, { "one.txt": "x\n", "two.txt": "y\n" }, "init");
    writeFileSync(join(dir, "one.txt"), "x\nmulti-marker-one\n");
    writeFileSync(join(dir, "two.txt"), "y\nmulti-marker-two\n");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    const r = scanStagedDiff(
      makeRepoConfig(dir),
      denySetWithPatterns(["multi-marker-one", "multi-marker-two"]),
      { revealMatches: true },
    );
    assert.equal(r.hits.length, 2);
    const byPath = new Map(r.hits.map(h => [h.path, h.matchPreview]));
    assert.equal(byPath.get("one.txt"), "multi-marker-one");
    assert.equal(byPath.get("two.txt"), "multi-marker-two");
  });

  it("reports the post-rename path for a rename+modify hit", () => {
    const dir = join(tmp, "path-rename");
    gitInit(dir);
    // Body large enough for git to classify this as a rename rather
    // than add+delete (see the diff-filter suite for why that matters).
    const body = Array.from({ length: 40 }, (_, i) => `stable line ${i}`).join("\n") + "\n";
    commit(dir, { "before.txt": body }, "init");
    execFileSync("git", ["mv", "before.txt", "after.txt"], { cwd: dir });
    writeFileSync(join(dir, "after.txt"), body + "post-rename-marker\n");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    const r = scanStagedDiff(
      makeRepoConfig(dir),
      denySetWithPatterns(["post-rename-marker"]),
    );
    assert.equal(r.hits.length, 1);
    assert.equal(r.hits[0]!.path, "after.txt", "path must be the post-image path");
  });

  it("blob equals the staged post-image object and is a full-length sha", () => {
    const dir = join(tmp, "path-blob");
    gitInit(dir);
    commit(dir, { "f.txt": "x\n" }, "init");
    writeFileSync(join(dir, "f.txt"), "x\nblob-check-marker\n");
    execFileSync("git", ["add", "f.txt"], { cwd: dir });
    const expected = execFileSync("git", ["rev-parse", ":f.txt"], {
      cwd: dir,
      encoding: "utf8",
    }).trim();
    const r = scanStagedDiff(makeRepoConfig(dir), denySetWithPatterns(["blob-check-marker"]));
    assert.equal(r.hits.length, 1);
    // Full length, not the 7-12 char abbreviation git prints by default
    // — this is what `--full-index` buys.
    assert.match(r.hits[0]!.blob ?? "", /^[0-9a-f]{40}$|^[0-9a-f]{64}$/);
    assert.equal(r.hits[0]!.blob, expected);
  });

  it("reports a non-ASCII path unquoted and unescaped", () => {
    const dir = join(tmp, "path-non-ascii");
    gitInit(dir);
    const name = "grüße-日本語.txt";
    commit(dir, { "seed.txt": "x\n" }, "init");
    writeFileSync(join(dir, name), "unicode-path-marker\n");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    const r = scanStagedDiff(makeRepoConfig(dir), denySetWithPatterns(["unicode-path-marker"]));
    assert.equal(r.hits.length, 1);
    const got = r.hits[0]!.path ?? "";
    // The point of `-c core.quotePath=false`: no `"…\303\274…"` form.
    assert.ok(!got.includes("\\"), `path was octal-escaped: ${got}`);
    assert.ok(!got.startsWith('"'), `path was quoted: ${got}`);
    // Compare NFC-normalised: some filesystems hand back decomposed
    // forms, which is not what this test is about.
    assert.equal(got.normalize("NFC"), name.normalize("NFC"));
  });

  it("produces no hits and no path for a binary file", () => {
    const dir = join(tmp, "path-binary");
    gitInit(dir);
    commit(dir, { "seed.txt": "x\n" }, "init");
    // NUL byte makes git treat it as binary; the marker bytes are
    // present but git emits a "Binary files differ" stanza with no
    // chunk, so the parser never enters content state.
    writeFileSync(join(dir, "blob.bin"), Buffer.from("\0binary-marker\0", "binary"));
    execFileSync("git", ["add", "-A"], { cwd: dir });
    const r = scanStagedDiff(makeRepoConfig(dir), denySetWithPatterns(["binary-marker"]));
    assert.equal(r.hits.length, 0);
  });
});

/**
 * Parser-level tests against hand-written diff text — the cases that are
 * awkward or impossible to provoke through a real repo, including the
 * malformed inputs the streaming parser must not mis-attribute.
 */
describe("scanDiffText parser edge cases", () => {
  const ds = denySetWithPatterns(["parser-edge-marker"]);

  it("ignores content lines that appear before any chunk header", () => {
    const diff = [
      "diff --git a/f.txt b/f.txt",
      "index " + "0".repeat(40) + ".." + "1".repeat(40) + " 100644",
      "--- a/f.txt",
      "+++ b/f.txt",
      "+parser-edge-marker", // malformed: no @@ preceding it
      "",
    ].join("\n");
    assert.deepEqual(scanDiffText(diff, ds), []);
  });

  it("does not attribute a hit to a deleted post-image", () => {
    const diff = [
      "diff --git a/gone.txt b/gone.txt",
      "deleted file mode 100644",
      "index " + "1".repeat(40) + ".." + "0".repeat(40),
      "--- a/gone.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "+parser-edge-marker", // malformed for a deletion, but survivable
      "",
    ].join("\n");
    assert.deepEqual(scanDiffText(diff, ds), []);
  });

  it("does not carry a previous stanza's path or blob into the next", () => {
    const blobA = "a".repeat(40);
    const diff = [
      "diff --git a/first.txt b/first.txt",
      `index ${"0".repeat(40)}..${blobA} 100644`,
      "--- a/first.txt",
      "+++ b/first.txt",
      "@@ -0,0 +1 @@",
      "+parser-edge-marker",
      // Second stanza has no index line at all (mode-only change shape),
      // so blob must go back to unset rather than reuse the first.
      "diff --git a/second.txt b/second.txt",
      "--- a/second.txt",
      "+++ b/second.txt",
      "@@ -0,0 +1 @@",
      "+parser-edge-marker",
      "",
    ].join("\n");
    const hits = scanDiffText(diff, ds);
    assert.equal(hits.length, 2);
    assert.deepEqual(
      hits.map(h => [h.path, h.blob]),
      [
        ["first.txt", blobA],
        ["second.txt", undefined],
      ],
    );
  });

  it("treats rename-stanza headers as headers, taking the path from +++", () => {
    const diff = [
      "diff --git a/old-name.txt b/new-name.txt",
      "similarity index 87%",
      "rename from old-name.txt",
      "rename to new-name.txt",
      `index ${"1".repeat(40)}..${"2".repeat(40)} 100644`,
      "--- a/old-name.txt",
      "+++ b/new-name.txt",
      "@@ -1,0 +2 @@ context",
      "+parser-edge-marker",
      "",
    ].join("\n");
    const hits = scanDiffText(diff, ds);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.path, "new-name.txt");
    assert.equal(hits[0]!.line, 1, "header lines must not consume virtual line numbers");
  });

  it("rejects an abbreviated index sha rather than reporting a partial blob", () => {
    const diff = [
      "diff --git a/f.txt b/f.txt",
      "index 1234567..89abcde 100644", // no --full-index
      "--- a/f.txt",
      "+++ b/f.txt",
      "@@ -0,0 +1 @@",
      "+parser-edge-marker",
      "",
    ].join("\n");
    const hits = scanDiffText(diff, ds);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.blob, undefined);
  });

  it("unquotes a C-quoted path", () => {
    const diff = [
      'diff --git "a/we\\"ird.txt" "b/we\\"ird.txt"',
      "--- \"a/we\\\"ird.txt\"",
      "+++ \"b/we\\\"ird.txt\"",
      "@@ -0,0 +1 @@",
      "+parser-edge-marker",
      "",
    ].join("\n");
    const hits = scanDiffText(diff, ds);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.path, 'we"ird.txt');
  });

  it("returns nothing for an empty diff", () => {
    assert.deepEqual(scanDiffText("", ds), []);
  });
});

describe("scanRange streaming", () => {
  it("handles a multi-MB diff without OOM (streaming, not buffered whole)", () => {
    // Build a synthetic diff several MB in size by committing many
    // benign lines and one marker line. The streaming implementation
    // walks the diff in 64 KiB chunks; the prior buffer-the-whole-
    // diff implementation would still complete here, but the test is
    // worthwhile as a smoke test for the new code path on realistic
    // large inputs.
    const dir = join(tmp, "range-large");
    gitInit(dir);
    commit(dir, { "f.txt": "seed\n" }, "init");
    // ~3 MB of benign added content: 60_000 lines × ~50 bytes each.
    const benignLines: string[] = ["seed"];
    for (let i = 0; i < 60_000; i++) {
      benignLines.push(
        `benign-line-${i}-padding-padding-padding-padding-padding`,
      );
    }
    benignLines.push("hidden-streaming-marker-line");
    for (let i = 0; i < 100; i++) {
      benignLines.push(`tail-${i}`);
    }
    const a = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: dir,
      encoding: "utf8",
    }).trim();
    writeFileSync(join(dir, "f.txt"), benignLines.join("\n") + "\n");
    execFileSync("git", ["add", "f.txt"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "huge"], { cwd: dir });
    const b = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: dir,
      encoding: "utf8",
    }).trim();

    const r = scanRange(
      makeRepoConfig(dir),
      denySetWithPatterns(["hidden-streaming-marker"]),
      `${a}..${b}`,
    );
    assert.equal(r.hits.length, 1, "marker buried in MB of additions must still be found");
  });
});

/**
 * New-ref scanning (`resolveNewRefBase` / `scanNewRef`).
 *
 * Every repo here gets a **real local bare remote** and a real `git
 * push`, so `refs/remotes/origin/*` genuinely exist. That is the whole
 * point: the behaviour under test is "what do the remote-tracking refs
 * already reach", and a fixture that fakes those refs would test the
 * fake. Markers are obvious nonsense strings.
 */
function gitInitWithRemote(name: string): string {
  const dir = join(tmp, name);
  const remote = join(tmp, `${name}-remote.git`);
  mkdirSync(remote, { recursive: true });
  execFileSync("git", ["init", "--bare", "-q", remote]);
  gitInit(dir);
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: dir });
  return dir;
}

/** Push refs to the local bare remote, updating `refs/remotes/origin/*`. */
function push(dir: string, ...refs: string[]): void {
  execFileSync("git", ["push", "-q", "origin", ...refs], { cwd: dir });
}

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}

/** Run `fn` with an env var set, restoring the previous value after. */
function withEnv<T>(name: string, value: string | undefined, fn: () => T): T {
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
}

const ORIGIN = { remote: "origin" } as const;

describe("resolveNewRefBase", () => {
  it("reports nothing-new for a tag on an already-pushed commit", () => {
    // The live incident: a release tag adds no commits, so the old
    // empty-tree fallback re-scanned all of history and blocked on a
    // benign historical match.
    const dir = gitInitWithRemote("newref-tag");
    commit(dir, { "f.txt": "zzq-historic-marker\n" }, "init");
    push(dir, "main");
    git(dir, "tag", "v1");

    const r = resolveNewRefBase(makeRepoConfig(dir), { ref: "refs/tags/v1", ...ORIGIN });
    assert.equal(r.mode, "nothing-new");
    // No base means no range, means `git diff` is never spawned at all.
    assert.equal(r.base, undefined);
  });

  it("reports nothing-new for an ANNOTATED tag (a tag object, not a commit)", () => {
    const dir = gitInitWithRemote("newref-annotated");
    commit(dir, { "f.txt": "zzq-historic-marker\n" }, "init");
    push(dir, "main");
    git(dir, "tag", "-a", "v1", "-m", "release");

    const r = resolveNewRefBase(makeRepoConfig(dir), { ref: "refs/tags/v1", ...ORIGIN });
    assert.equal(r.mode, "nothing-new", "rev-list must peel the tag object to its commit");
    assert.equal(r.base, undefined);
  });

  it("reports incremental with the pushed tip as base when one commit is new", () => {
    const dir = gitInitWithRemote("newref-incremental");
    commit(dir, { "f.txt": "seed\n" }, "init");
    push(dir, "main");
    const pushedTip = git(dir, "rev-parse", "HEAD");
    commit(dir, { "f.txt": "seed\nmore\n" }, "second");

    const r = resolveNewRefBase(makeRepoConfig(dir), { ref: "refs/heads/main", ...ORIGIN });
    assert.equal(r.mode, "incremental");
    assert.equal(r.base, pushedTip);
  });

  it("widens to the octopus merge-base when several boundaries exist", () => {
    const dir = gitInitWithRemote("newref-widened");
    commit(dir, { "f.txt": "seed\n" }, "init");
    const forkPoint = git(dir, "rev-parse", "HEAD");
    git(dir, "checkout", "-q", "-b", "line-a");
    commit(dir, { "a.txt": "a\n" }, "a");
    git(dir, "checkout", "-q", "main");
    git(dir, "checkout", "-q", "-b", "line-b");
    commit(dir, { "b.txt": "b\n" }, "b");
    push(dir, "main", "line-a", "line-b");
    // A new branch that merges two already-pushed lines: two boundary
    // commits, neither an ancestor of the other.
    git(dir, "checkout", "-q", "-b", "merged", "line-a");
    git(dir, "merge", "-q", "--no-ff", "-m", "merge b", "line-b");

    const r = resolveNewRefBase(makeRepoConfig(dir), { ref: "refs/heads/merged", ...ORIGIN });
    assert.equal(r.mode, "incremental-widened");
    // The widened base is a common ancestor of both boundaries, so the
    // range is a strict superset of the new commits: over-scan, never
    // under-scan.
    assert.equal(r.base, forkPoint);
  });

  it("reports full-history when no remote-tracking refs exist at all", () => {
    const dir = gitInitWithRemote("newref-no-remote-refs");
    commit(dir, { "f.txt": "zzq-historic-marker\n" }, "init");
    // Remote configured but never pushed to → refs/remotes/origin/* empty.
    const r = resolveNewRefBase(makeRepoConfig(dir), { ref: "refs/heads/main", ...ORIGIN });
    assert.equal(r.mode, "full-history");
    assert.equal(r.base, EMPTY_TREE_SHA);
  });

  it("reports full-history for a disjoint (root) history", () => {
    const dir = gitInitWithRemote("newref-orphan");
    commit(dir, { "f.txt": "seed\n" }, "init");
    push(dir, "main");
    git(dir, "checkout", "-q", "--orphan", "detached-line");
    execFileSync("git", ["rm", "-rq", "--cached", "."], { cwd: dir });
    commit(dir, { "o.txt": "o\n" }, "orphan root");

    const r = resolveNewRefBase(makeRepoConfig(dir), {
      ref: "refs/heads/detached-line",
      ...ORIGIN,
    });
    assert.equal(r.mode, "full-history", "nothing is shared, so nothing may be skipped");
    assert.equal(r.base, EMPTY_TREE_SHA);
  });

  it("throws GitCommandError when rev-list fails, rather than reporting nothing-new", () => {
    // The dangerous failure shape: an unresolvable ref producing an
    // empty rev-list output would read as "nothing to scan".
    const dir = gitInitWithRemote("newref-revlist-fail");
    commit(dir, { "f.txt": "seed\n" }, "init");
    push(dir, "main");

    let thrown: unknown;
    try {
      resolveNewRefBase(makeRepoConfig(dir), { ref: "refs/heads/no-such-ref", ...ORIGIN });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof GitCommandError, "must throw, not report nothing-new");
    assert.equal(thrown.code, "GIT_ERROR");
    assert.equal(thrown.subcommand, "rev-list");
    assert.ok(
      !thrown.message.includes("no-such-ref"),
      "the message must not embed git stderr or the refname",
    );
  });

  it("REPO_AEGIS_NEW_REF_FULL_SCAN=1 forces full-history on the tag case", () => {
    const dir = gitInitWithRemote("newref-escape-hatch");
    commit(dir, { "f.txt": "zzq-historic-marker\n" }, "init");
    push(dir, "main");
    git(dir, "tag", "v1");

    const r = withEnv("REPO_AEGIS_NEW_REF_FULL_SCAN", "1", () =>
      resolveNewRefBase(makeRepoConfig(dir), { ref: "refs/tags/v1", ...ORIGIN }),
    );
    assert.equal(r.mode, "full-history");
    assert.equal(r.base, EMPTY_TREE_SHA);
  });
});

describe("scanNewRef", () => {
  it("scans nothing — and finds nothing — for a tag on an already-pushed commit", () => {
    const dir = gitInitWithRemote("scan-newref-tag");
    commit(dir, { "f.txt": "zzq-historic-marker\n" }, "init");
    push(dir, "main");
    git(dir, "tag", "v1");

    const r = scanNewRef(
      makeRepoConfig(dir),
      denySetWithPatterns(["zzq-historic-marker"]),
      { ref: "refs/tags/v1", ...ORIGIN },
    );
    assert.equal(r.mode, "nothing-new");
    assert.equal(r.base, undefined);
    assert.equal(r.hits.length, 0, "a tag exposes nothing new; the history is already pushed");
  });

  it("flags a marker in the one never-pushed commit a tag carries", () => {
    const dir = gitInitWithRemote("scan-newref-tag-hit");
    commit(dir, { "f.txt": "seed\n" }, "init");
    push(dir, "main");
    commit(dir, { "leak.txt": "zzq-fresh-marker\n" }, "unpushed");
    git(dir, "tag", "v1");

    const r = scanNewRef(
      makeRepoConfig(dir),
      denySetWithPatterns(["zzq-fresh-marker"]),
      { ref: "refs/tags/v1", ...ORIGIN },
    );
    assert.equal(r.mode, "incremental");
    assert.equal(r.hits.length, 1);
    assert.equal(r.hits[0]!.path, "leak.txt");
  });

  it("scans ONLY the new commits of a brand-new branch", () => {
    const dir = gitInitWithRemote("scan-newref-branch");
    commit(dir, { "old.txt": "zzq-pushed-marker\n" }, "init");
    push(dir, "main");
    git(dir, "checkout", "-q", "-b", "feature");
    commit(dir, { "new.txt": "zzq-fresh-marker\n" }, "feature work");

    const r = scanNewRef(
      makeRepoConfig(dir),
      denySetWithPatterns(["zzq-pushed-marker", "zzq-fresh-marker"]),
      { ref: "refs/heads/feature", ...ORIGIN },
    );
    assert.equal(r.mode, "incremental");
    assert.equal(r.hits.length, 1, "the already-pushed marker must not fire again");
    assert.equal(r.hits[0]!.path, "new.txt");
  });

  it("flags a marker introduced by an EVIL MERGE, present in neither parent", () => {
    // Regression test for the design constraint: `git log -p <ref> --not
    // --remotes=<remote>` emits NO diff for a merge commit, so a marker
    // living only in the merge's own tree would go unscanned. A tree diff
    // from a resolved base compares end states and cannot miss it. Swap
    // this implementation for `git log -p` and this test fails.
    const dir = gitInitWithRemote("scan-newref-evil-merge");
    commit(dir, { "seed.txt": "seed\n" }, "init");
    git(dir, "checkout", "-q", "-b", "line-a");
    commit(dir, { "a.txt": "a\n" }, "a");
    git(dir, "checkout", "-q", "main");
    git(dir, "checkout", "-q", "-b", "line-b");
    commit(dir, { "b.txt": "b\n" }, "b");
    push(dir, "main", "line-a", "line-b");

    git(dir, "checkout", "-q", "-b", "evil", "line-a");
    // Non-conflicting merge, held open so the merge commit's tree can be
    // given content that exists in neither parent.
    git(dir, "merge", "--no-ff", "--no-commit", "line-b");
    writeFileSync(join(dir, "evil.txt"), "zzq-evil-merge-marker\n");
    execFileSync("git", ["add", "evil.txt"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "--no-edit"], { cwd: dir });

    const r = scanNewRef(
      makeRepoConfig(dir),
      denySetWithPatterns(["zzq-evil-merge-marker"]),
      { ref: "refs/heads/evil", ...ORIGIN },
    );
    assert.equal(r.mode, "incremental-widened");
    assert.equal(r.hits.length, 1, "content introduced by the merge itself must be scanned");
    assert.equal(r.hits[0]!.path, "evil.txt");
  });

  it("flags a marker in the new commit of a branch with several boundaries", () => {
    const dir = gitInitWithRemote("scan-newref-widened-hit");
    commit(dir, { "seed.txt": "seed\n" }, "init");
    git(dir, "checkout", "-q", "-b", "line-a");
    commit(dir, { "a.txt": "a\n" }, "a");
    git(dir, "checkout", "-q", "main");
    git(dir, "checkout", "-q", "-b", "line-b");
    commit(dir, { "b.txt": "b\n" }, "b");
    push(dir, "main", "line-a", "line-b");

    git(dir, "checkout", "-q", "-b", "combined", "line-a");
    git(dir, "merge", "-q", "--no-ff", "-m", "merge b", "line-b");
    commit(dir, { "leak.txt": "zzq-fresh-marker\n" }, "leak after merge");

    const r = scanNewRef(
      makeRepoConfig(dir),
      denySetWithPatterns(["zzq-fresh-marker"]),
      { ref: "refs/heads/combined", ...ORIGIN },
    );
    assert.equal(r.mode, "incremental-widened");
    assert.equal(r.hits.length, 1);
    assert.equal(r.hits[0]!.path, "leak.txt");
  });

  it("falls back to the whole history when no remote-tracking refs exist", () => {
    const dir = gitInitWithRemote("scan-newref-full");
    commit(dir, { "f.txt": "zzq-historic-marker\n" }, "init");

    const r = scanNewRef(
      makeRepoConfig(dir),
      denySetWithPatterns(["zzq-historic-marker"]),
      { ref: "refs/heads/main", ...ORIGIN },
    );
    assert.equal(r.mode, "full-history");
    assert.equal(r.base, EMPTY_TREE_SHA);
    assert.equal(r.hits.length, 1, "with nothing known-shared, everything is scanned");
  });

  it("REPO_AEGIS_NEW_REF_FULL_SCAN=1 makes the tag case fire on a historical marker", () => {
    const dir = gitInitWithRemote("scan-newref-escape-hatch");
    commit(dir, { "f.txt": "zzq-historic-marker\n" }, "init");
    push(dir, "main");
    git(dir, "tag", "v1");

    const r = withEnv("REPO_AEGIS_NEW_REF_FULL_SCAN", "1", () =>
      scanNewRef(
        makeRepoConfig(dir),
        denySetWithPatterns(["zzq-historic-marker"]),
        { ref: "refs/tags/v1", ...ORIGIN },
      ),
    );
    assert.equal(r.mode, "full-history");
    assert.equal(r.hits.length, 1);
  });

  it("propagates a git failure instead of returning an empty hit list", () => {
    const dir = gitInitWithRemote("scan-newref-fail");
    commit(dir, { "f.txt": "seed\n" }, "init");
    push(dir, "main");
    assert.throws(
      () =>
        scanNewRef(
          makeRepoConfig(dir),
          denySetWithPatterns(["zzq-fresh-marker"]),
          { ref: "refs/heads/nope", ...ORIGIN },
        ),
      (err: unknown) => err instanceof GitCommandError && err.code === "GIT_ERROR",
    );
  });
});

// ---------------------------------------------------------------------------
// Path-scoped `_always` exemptions (plan item B) + built-in known-non-secrets
// (plan item E).
//
// Every secret-shaped literal below is assembled at runtime from fragments.
// This repo scans itself (`self-hygiene.test.ts`); a complete PEM header or a
// complete AWS-key-shaped token committed here would trip its own deny set.
// ---------------------------------------------------------------------------

const DASHES = "-".repeat(5);
/** `_always` pattern: a PEM header shape. */
const PEM_PATTERN = `${DASHES}BEGIN [A-Z ]+PRIVATE KEY${DASHES}`;
/** A line matching it, likewise assembled rather than written out. */
const PEM_LINE = `${DASHES}BEGIN TESTONLY PRIVATE KEY${DASHES}`;

const AWS_PREFIX = "AK" + "IA";
/** `_always` pattern: the AWS access-key-id shape. */
const AWS_PATTERN = `${AWS_PREFIX}[A-Z0-9]{16}`;
/** AWS's published example key — a non-secret by construction. */
const AWS_EXAMPLE = `${AWS_PREFIX}IOSFODNN7` + "EXAMPLE";
/** Same shape, ordinary body: indistinguishable from a real credential. */
const AWS_REAL_SHAPE = `${AWS_PREFIX}ZZ7QRSTUVWXY2345`;

/** Engagement marker: obviously synthetic, no customer anywhere near it. */
const ENG_MARKER = "zetaquadrant";
/** Engagement marker that happens to contain the placeholder word. */
const ENG_EXAMPLE_MARKER = "NOTACUSTOMER-EXAMPLE";
/** `_private_infra` marker: an internal host, under a reserved TLD. */
const INFRA_PATTERN = "registry\\.internal\\.invalid";
const INFRA_LINE = "registry.internal.invalid";

const CLASSED_PATTERNS = [
  PEM_PATTERN,
  AWS_PATTERN,
  ENG_MARKER,
  ENG_EXAMPLE_MARKER,
  INFRA_PATTERN,
] as const;
const CLASSED_SOURCES = [
  "_always",
  "_always",
  "customer-z",
  "customer-z",
  "_private_infra",
] as const;

function classedDenySet(exemptPaths: string[]): DenySet {
  const patterns = [...CLASSED_PATTERNS];
  const patternSources = [...CLASSED_SOURCES];
  const pick = (want: boolean): string =>
    patterns.filter((_, i) => (patternSources[i] === "_always") === want).join("|");
  return {
    files: [],
    patterns,
    patternSources,
    combinedRegex: patterns.join("|"),
    strictRegex: pick(false),
    exemptibleRegex: pick(true),
    exemptPaths,
    warnings: [],
  };
}

const EXEMPT = ["**/test/**", "**/fixtures/**", "**/*.test.*"];

describe("scan — path-scoped `_always` exemptions", () => {
  it("a private-key shape under test/ is NOT flagged", () => {
    const ds = classedDenySet(EXEMPT);
    assert.deepEqual(scanText(PEM_LINE, ds, "test/keys/sample.pem"), []);
  });

  it("the same shape in src/ IS flagged", () => {
    const ds = classedDenySet(EXEMPT);
    const hits = scanText(PEM_LINE, ds, "src/keys.ts");
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.engagement, "_always");
  });

  it("a customer-marker literal in a test fixture is STILL FLAGGED", () => {
    // The load-bearing asymmetry. A secret shape in a fixture is a throwaway
    // by construction; a customer name in a fixture is a leak either way.
    const ds = classedDenySet(EXEMPT);
    const hits = scanText(`const c = "${ENG_MARKER}";`, ds, "test/fixtures/data.ts");
    assert.equal(hits.length, 1, "engagement markers are never path-exempt");
    assert.equal(hits[0]!.engagement, "customer-z");
  });

  it("a `_private_infra` host in a test fixture is STILL FLAGGED", () => {
    const ds = classedDenySet(EXEMPT);
    const hits = scanText(`registry=https://${INFRA_LINE}/`, ds, "test/fixtures/.npmrc");
    assert.equal(hits.length, 1, "_private_infra is not an exemptible class");
    assert.equal(hits[0]!.engagement, "_private_infra");
  });

  it("a line carrying BOTH an `_always` shape and an engagement marker, in an exempt path, is still flagged", () => {
    // Regression test for the two-regex split. Filtering AFTER a combined
    // match would drop this: the PEM shape sits first on the line, would
    // match, would be filtered as exempt, and the customer marker sitting
    // right behind it would never be reported at all.
    const ds = classedDenySet(EXEMPT);
    const line = `${PEM_LINE} # owned by ${ENG_MARKER}`;
    const hits = scanText(line, ds, "test/fixtures/mixed.txt");
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.engagement, "customer-z", "the engagement hit must survive");
  });

  it("exempts nothing when the deny set carries no exempt paths", () => {
    const ds = classedDenySet([]);
    assert.equal(scanText(PEM_LINE, ds, "test/keys/sample.pem").length, 1);
  });

  it("exempts nothing for a deny set with no strict/exemptible split (fail closed)", () => {
    // An older or hand-built DenySet cannot distinguish the classes, so it
    // must enforce everything rather than guess.
    const ds = classedDenySet(EXEMPT);
    delete ds.strictRegex;
    assert.equal(scanText(PEM_LINE, ds, "test/keys/sample.pem").length, 1);
  });

  it("never exempts when the path is unknown (fail closed)", () => {
    const ds = classedDenySet(EXEMPT);
    assert.equal(scanText(PEM_LINE, ds).length, 1);
  });

  it("never exempts an absolute path with no working tree to relativise against", () => {
    const ds = classedDenySet(EXEMPT);
    const hits = scanText(PEM_LINE, ds, "/somewhere/repo/test/keys/sample.pem");
    assert.equal(hits.length, 1, "an unrelativisable path is not exempt");
  });

  it("relativises an absolute path against the working tree when one is given", () => {
    const ds = classedDenySet(EXEMPT);
    const hits = scanText(PEM_LINE, ds, "/repo/test/x.pem", { workingTree: "/repo" });
    assert.deepEqual(hits, []);
  });

  it("`**` reaching the scanner is a loud error, not a silent repo-wide exemption", () => {
    // computeDenySet validates first, so this is defence in depth; the point
    // is that no code path turns a too-broad glob into "exempt everything".
    const ds = classedDenySet(["**"]);
    assert.throws(() => scanText(PEM_LINE, ds, "src/keys.ts"), GlobTooBroadError);
  });

  it("`ignorePathExemptions` restores the full pattern set (what audit uses)", () => {
    const ds = classedDenySet(EXEMPT);
    const hits = scanText(PEM_LINE, ds, "test/keys/sample.pem", {
      ignorePathExemptions: true,
    });
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.engagement, "_always");
  });

  it("scanFile honours the exemption using its workingTree argument", () => {
    const ds = classedDenySet(EXEMPT);
    const root = mkdtempSync(join(tmp, "exempt-file-"));
    mkdirSync(join(root, "test"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "test", "k.pem"), `${PEM_LINE}\n`);
    writeFileSync(join(root, "src", "k.pem"), `${PEM_LINE}\n`);
    writeFileSync(join(root, "test", "cust.txt"), `${ENG_MARKER}\n`);

    assert.deepEqual(scanFile(join(root, "test", "k.pem"), ds, {}, root).hits, []);
    assert.equal(scanFile(join(root, "src", "k.pem"), ds, {}, root).hits.length, 1);
    assert.equal(
      scanFile(join(root, "test", "cust.txt"), ds, {}, root).hits.length,
      1,
      "customer marker in an exempt path is still flagged",
    );
    // Without a working tree the absolute path cannot be relativised.
    assert.equal(scanFile(join(root, "test", "k.pem"), ds).hits.length, 1);
  });

  it("the diff scanner uses the post-image path from the stanza", () => {
    const ds = classedDenySet(EXEMPT);
    const mk = (path: string, added: string): string =>
      [
        `diff --git a/${path} b/${path}`,
        "index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644",
        `--- a/${path}`,
        `+++ b/${path}`,
        "@@ -0,0 +1 @@",
        `+${added}`,
        "",
      ].join("\n");

    assert.deepEqual(scanDiffText(mk("test/fixtures/k.pem", PEM_LINE), ds), []);
    assert.equal(scanDiffText(mk("src/k.pem", PEM_LINE), ds).length, 1);
    assert.equal(
      scanDiffText(mk("test/fixtures/c.txt", ENG_MARKER), ds).length,
      1,
      "engagement marker in an exempt path still blocks a commit",
    );
  });
});

describe("scan — built-in known-non-secret suppression", () => {
  it("suppresses a documented AWS example key and counts the suppression", () => {
    const ds = classedDenySet([]);
    const r = scanTextDetailed(`aws_access_key_id = ${AWS_EXAMPLE}`, ds, "src/config.ini");
    assert.deepEqual(r.hits, []);
    assert.equal(r.suppressedKnownNonSecrets, 1, "a silent suppression is unobservable");
  });

  it("flags the same shape with an ordinary body", () => {
    const ds = classedDenySet([]);
    const r = scanTextDetailed(`aws_access_key_id = ${AWS_REAL_SHAPE}`, ds, "src/config.ini");
    assert.equal(r.hits.length, 1);
    assert.equal(r.suppressedKnownNonSecrets, 0);
  });

  it("an engagement marker containing EXAMPLE is STILL FLAGGED", () => {
    // Suppression is scoped to `_always`. A customer marker that happens to
    // carry the word EXAMPLE is still a customer marker.
    const ds = classedDenySet([]);
    const r = scanTextDetailed(`ref: ${ENG_EXAMPLE_MARKER}`, ds, "src/notes.md");
    assert.equal(r.hits.length, 1);
    assert.equal(r.hits[0]!.engagement, "customer-z");
    assert.equal(r.suppressedKnownNonSecrets, 0);
  });

  it("a suppressed match does not hide a real marker later on the same line", () => {
    const ds = classedDenySet([]);
    const r = scanTextDetailed(`${AWS_EXAMPLE} used by ${ENG_MARKER}`, ds, "src/notes.md");
    assert.equal(r.hits.length, 1, "the search resumes past a suppressed match");
    assert.equal(r.hits[0]!.engagement, "customer-z");
    assert.equal(r.suppressedKnownNonSecrets, 1);
  });

  it("suppresses nothing when the deny set carries no attribution (fail closed)", () => {
    // Without patternSources the stem is unknown, so the `_always`-only
    // scoping cannot be established and nothing may be suppressed.
    const ds = classedDenySet([]);
    delete ds.patternSources;
    const r = scanTextDetailed(`key = ${AWS_EXAMPLE}`, ds, "src/config.ini");
    assert.equal(r.hits.length, 1);
    assert.equal(r.suppressedKnownNonSecrets, 0);
  });

  it("the count rides out on scanFile's result", () => {
    const ds = classedDenySet([]);
    const root = mkdtempSync(join(tmp, "known-nonsecret-"));
    writeFileSync(join(root, "config.ini"), `k = ${AWS_EXAMPLE}\n`);
    const r = scanFile(join(root, "config.ini"), ds, {}, root);
    assert.deepEqual(r.hits, []);
    assert.equal(r.suppressedKnownNonSecrets, 1);
  });
});

describe("scan — ScanHit.patternId (waiver key)", () => {
  it("is populated wherever attribution is, and keys on stem + pattern", () => {
    const ds = classedDenySet([]);
    const hits = scanText(`ref ${ENG_MARKER}`, ds, "src/a.ts");
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.patternId, patternId("customer-z", ENG_MARKER));
  });

  it("is absent when the deny set carries no attribution", () => {
    const ds = classedDenySet([]);
    delete ds.patternSources;
    const hits = scanText(`ref ${ENG_MARKER}`, ds, "src/a.ts");
    assert.equal(hits[0]!.patternId, undefined);
    assert.equal(hits[0]!.engagement, undefined);
  });

  it("rides out of the diff scanner alongside the blob, so a waiver can key on both", () => {
    const ds = classedDenySet([]);
    const blob = "2".repeat(40);
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      `index ${"1".repeat(40)}..${blob} 100644`,
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -0,0 +1 @@",
      `+const c = "${PEM_LINE}";`,
      "",
    ].join("\n");
    const hits = scanDiffText(diff, ds);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.blob, blob);
    assert.equal(hits[0]!.patternId, patternId("_always", PEM_PATTERN));
  });
});
