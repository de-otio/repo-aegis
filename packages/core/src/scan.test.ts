import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanText, scanFile } from "./scan.js";
import type { DenySet } from "./deny-set.js";

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
