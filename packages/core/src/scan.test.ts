// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanText, scanFile, scanStagedDiff, scanRange, scanHistory } from "./scan.js";
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
