import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanText, scanFile, scanRange, scanHistory } from "./scan.js";
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
});
