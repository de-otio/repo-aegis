// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
/**
 * Behaviour comparison: old diff-parsing rules vs. the current parser.
 *
 * Threading path/blob state through the streaming diff parser is a
 * refactor of a state machine, and the failure mode that matters is not
 * "a unit test asserts the wrong path" — it is a *chunk-state*
 * regression that silently changes which lines count as added content,
 * or shifts the virtual line numbering, on some diff shape nobody wrote
 * a unit test for. Unit tests cannot cover that space; an old-vs-new
 * comparison over real `git diff` output can.
 *
 * So: `referenceScanDiff` below reimplements the *pre-change* rules
 * exactly as they stood (skip `diff --git` / `---` / `+++` / `\ No
 * newline`, `@@` enters chunk state, `+`-prefixed lines inside a chunk
 * are content with the leading `+` stripped, 1-indexed virtual line
 * numbers over added lines only). The corpus is real git output from
 * synthetic repos covering the shapes most likely to break a hand-rolled
 * parser. Every case must produce an identical hit set — same line,
 * column, and preview — modulo the newly-added `path` and `blob` fields.
 *
 * If a future change to the parser is *intended* to alter which lines
 * are treated as content, this file is what will notice, and the
 * reference implementation has to be updated in the same commit with a
 * note saying why.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanDiffText } from "./scan.js";
import { redactMatch } from "./redaction.js";
import type { DenySet } from "./deny-set.js";

/**
 * Obviously-synthetic nonsense tokens. Nothing here may resemble a real
 * secret: this repo scans its own source with the author's live deny
 * set, so a plausible-looking literal committed as a fixture is itself
 * the failure the tool exists to prevent.
 */
const MARKERS = ["qux-marker-alpha", "qux-marker-beta", "qux-marker-gamma"] as const;

const denySet: DenySet = {
  files: [],
  patterns: [...MARKERS],
  combinedRegex: MARKERS.join("|"),
  warnings: [],
};

interface RefHit {
  line: number;
  column: number;
  matchPreview: string;
}

/**
 * The parsing rules exactly as they were before path/blob threading.
 * Deliberately written as a flat loop with no shared helpers beyond
 * `redactMatch` (which is the redaction policy, not a parsing rule), so
 * a bug introduced in the production parser cannot hide here too.
 */
function referenceScanDiff(diff: string): RefHit[] {
  const re = new RegExp(denySet.combinedRegex, "i");
  const allow = /repo-aegis:\s*allow\b/i;
  const hits: RefHit[] = [];
  let inChunk = false;
  let virtualLine = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      inChunk = false;
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("+++ ")) continue;
    if (line.startsWith("@@")) {
      inChunk = true;
      continue;
    }
    if (line.startsWith("\\ No newline")) continue;
    if (!inChunk) continue;
    if (!line.startsWith("+")) continue;
    const content = line.slice(1);
    virtualLine += 1;
    const m = content.match(re);
    if (!m || !m[0]) continue;
    if (allow.test(content)) continue;
    hits.push({
      line: virtualLine,
      column: (m.index ?? 0) + 1,
      matchPreview: redactMatch(m[0], "preview"),
    });
  }
  return hits;
}

// ---- corpus construction --------------------------------------------------

const root = mkdtempSync(join(tmpdir(), "repo-aegis-compare-"));

after(() => {
  rmSync(root, { recursive: true, force: true });
});

function git(dir: string, args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function repo(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "test"]);
  return dir;
}

function write(dir: string, rel: string, body: string | Buffer): void {
  writeFileSync(join(dir, rel), body);
}

function commitAll(dir: string, msg: string): string {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", msg]);
  return git(dir, ["rev-parse", "HEAD"]).trim();
}

/**
 * Mirrors the argv the production scanners use, so the corpus is the
 * same *shape* of output the real parser consumes. Both implementations
 * are then fed the identical captured text, which is what makes the
 * comparison exact.
 */
function diffText(dir: string, extra: readonly string[]): string {
  return git(dir, [
    "-c",
    "core.quotePath=false",
    "diff",
    "--full-index",
    "--no-color",
    ...extra,
  ]);
}

const body = (n: number): string =>
  Array.from({ length: n }, (_, i) => `stable line ${i}`).join("\n") + "\n";

interface Case {
  name: string;
  diff: string;
  /** Whether this case is expected to contain at least one marker hit. */
  expectHits: boolean;
}

function buildCorpus(): Case[] {
  const cases: Case[] = [];

  // 1. Multi-file change: several stanzas, markers in more than one file
  //    and more than one hunk, so a chunk-state bug shows up as a
  //    line-number shift rather than a missing hit.
  {
    const dir = repo("multi-file");
    write(dir, "one.txt", body(5));
    write(dir, "two.txt", body(5));
    write(dir, "three.txt", body(5));
    commitAll(dir, "init");
    write(dir, "one.txt", body(5) + `${MARKERS[0]} first\n`);
    write(dir, "two.txt", `${MARKERS[1]} leading\n` + body(5) + `${MARKERS[2]} trailing\n`);
    write(dir, "three.txt", body(5) + "harmless\n");
    git(dir, ["add", "-A"]);
    cases.push({
      name: "multi-file change",
      diff: diffText(dir, ["--cached", "--diff-filter=ACMR", "-U0"]),
      expectHits: true,
    });
    // Same change with context lines: exercises the ` `-prefixed and
    // `-`-prefixed branches that -U0 never produces.
    cases.push({
      name: "multi-file change with context (-U3)",
      diff: diffText(dir, ["--cached", "--diff-filter=ACMR", "-U3"]),
      expectHits: true,
    });
  }

  // 2. Rename + modify — the stanza shape the ACM→ACMR fix un-hid, with
  //    `similarity index` / `rename from` / `rename to` headers that the
  //    parser had never actually seen before.
  {
    const dir = repo("rename-modify");
    write(dir, "before.txt", body(40));
    commitAll(dir, "init");
    git(dir, ["mv", "before.txt", "after.txt"]);
    write(dir, "after.txt", body(40) + `${MARKERS[0]} appended\n`);
    git(dir, ["add", "-A"]);
    const diff = diffText(dir, ["--cached", "--diff-filter=ACMR", "-U0"]);
    assert.match(diff, /^rename to /m, "corpus premise: expected a rename stanza");
    cases.push({ name: "rename + modify", diff, expectHits: true });
  }

  // 3. Copy detection: `copy from` / `copy to` headers. Only emitted
  //    when explicitly requested, which is exactly why it belongs in the
  //    corpus — the parser must not choke if a caller ever asks for it.
  {
    const dir = repo("copy");
    write(dir, "src.txt", body(40));
    commitAll(dir, "init");
    write(dir, "dup.txt", body(40) + `${MARKERS[1]} in the copy\n`);
    git(dir, ["add", "-A"]);
    const diff = diffText(dir, [
      "--cached",
      "-C",
      "--find-copies-harder",
      "--diff-filter=ACMR",
      "-U0",
    ]);
    cases.push({ name: "copy", diff, expectHits: true });
  }

  // 4. Binary files, both stanza forms. The `--binary` form emits base85
  //    payload lines that are not preceded by any `@@`, so neither
  //    parser may ever treat them as content.
  {
    const dir = repo("binary");
    write(dir, "seed.txt", body(3));
    commitAll(dir, "init");
    // Marker text embedded next to a NUL so git classifies it binary.
    write(dir, "blob.bin", Buffer.concat([
      Buffer.from(`${MARKERS[2]} `, "utf8"),
      Buffer.from([0x00, 0x01, 0x02]),
      Buffer.from(`${MARKERS[0]}`, "utf8"),
    ]));
    git(dir, ["add", "-A"]);
    cases.push({
      name: "binary file (summary stanza)",
      diff: diffText(dir, ["--cached", "--diff-filter=ACMR", "-U0"]),
      expectHits: false,
    });
    cases.push({
      name: "binary file (--binary payload)",
      diff: diffText(dir, ["--cached", "--binary", "--diff-filter=ACMR", "-U0"]),
      expectHits: false,
    });
  }

  // 5. Merge commit: combined-diff format (`@@@`, two-column prefixes)
  //    plus the per-parent form. Both are diff text a caller could hand
  //    us, and the combined form is the one most likely to desync a
  //    hand-rolled parser.
  {
    const dir = repo("merge");
    write(dir, "base.txt", body(10));
    const first = commitAll(dir, "init");
    git(dir, ["checkout", "-q", "-b", "feature"]);
    write(dir, "base.txt", body(4) + `${MARKERS[0]} from feature\n` + body(3));
    commitAll(dir, "feature change");
    git(dir, ["checkout", "-q", "main"]);
    write(dir, "base.txt", body(4) + `${MARKERS[1]} from main\n` + body(3));
    commitAll(dir, "main change");
    try {
      git(dir, ["merge", "-q", "--no-edit", "feature"]);
    } catch {
      /* expected conflict; resolved below */
    }
    // Resolve with content present in neither parent — an "evil merge",
    // which is precisely the case a combined diff renders unusually.
    write(dir, "base.txt", body(4) + `${MARKERS[2]} resolved\n` + body(3));
    const merge = commitAll(dir, "merge feature");
    cases.push({
      name: "merge commit (combined diff, --cc)",
      diff: git(dir, ["show", "--cc", "--format=", "--no-color", merge]),
      expectHits: true,
    });
    cases.push({
      name: "merge commit (per-parent, -m)",
      diff: git(dir, ["show", "-m", "--format=", "--no-color", "--full-index", merge]),
      expectHits: true,
    });
    cases.push({
      name: "merge range diff",
      diff: diffText(dir, [`${first}..${merge}`, "--diff-filter=ACMR", "-U0"]),
      expectHits: true,
    });
  }

  // 6. Non-ASCII filename. With core.quotePath=false the path arrives as
  //    literal UTF-8; the parser must still find the same content hits.
  {
    const dir = repo("non-ascii");
    write(dir, "seed.txt", body(3));
    commitAll(dir, "init");
    write(dir, "grüße-日本語.txt", `${MARKERS[0]} unicode path\n`);
    git(dir, ["add", "-A"]);
    cases.push({
      name: "non-ASCII filename",
      diff: diffText(dir, ["--cached", "--diff-filter=ACMR", "-U0"]),
      expectHits: true,
    });
  }

  // 7. CRLF line endings: content lines carry a trailing \r, which must
  //    not shift columns or swallow lines.
  {
    const dir = repo("crlf");
    write(dir, "seed.txt", "alpha\r\nbeta\r\n");
    commitAll(dir, "init");
    write(dir, "seed.txt", `alpha\r\nbeta\r\n${MARKERS[1]}\r\ngamma\r\n`);
    git(dir, ["add", "-A"]);
    cases.push({
      name: "CRLF line endings",
      diff: diffText(dir, ["--cached", "--diff-filter=ACMR", "-U0"]),
      expectHits: true,
    });
  }

  // 8. No trailing newline: produces the `\ No newline at end of file`
  //    marker adjacent to a marker-bearing added line.
  {
    const dir = repo("no-eol");
    write(dir, "f.txt", "alpha\n");
    commitAll(dir, "init");
    write(dir, "f.txt", `alpha\n${MARKERS[2]} no trailing newline`);
    git(dir, ["add", "-A"]);
    const diff = diffText(dir, ["--cached", "--diff-filter=ACMR", "-U0"]);
    assert.match(diff, /\\ No newline/, "corpus premise: expected a no-newline marker");
    cases.push({ name: "no trailing newline", diff, expectHits: true });
  }

  // 9. Empty diff — the degenerate input both parsers must agree on.
  {
    const dir = repo("empty");
    write(dir, "f.txt", body(3));
    commitAll(dir, "init");
    cases.push({
      name: "empty diff",
      diff: diffText(dir, ["--cached", "--diff-filter=ACMR", "-U0"]),
      expectHits: false,
    });
  }

  // 10. Mode-change-only stanza: headers with no `index` line variants
  //     and no hunks at all.
  {
    const dir = repo("mode-only");
    write(dir, "s.sh", body(3));
    commitAll(dir, "init");
    git(dir, ["update-index", "--chmod=+x", "s.sh"]);
    cases.push({
      name: "mode change only",
      diff: diffText(dir, ["--cached", "--diff-filter=ACMR", "-U0"]),
      expectHits: false,
    });
  }

  return cases;
}

const corpus = buildCorpus();

// ---- the comparison -------------------------------------------------------

describe("diff parser behaviour comparison (old rules vs current)", () => {
  for (const c of corpus) {
    it(`matches the old parser on: ${c.name}`, () => {
      const expected = referenceScanDiff(c.diff);
      const actual = scanDiffText(c.diff, denySet);
      // Drop only the newly-added fields; everything the old parser
      // produced must be byte-identical, in the same order.
      const stripped = actual.map(h => ({
        line: h.line,
        column: h.column,
        matchPreview: h.matchPreview,
      }));
      assert.deepEqual(
        stripped,
        expected,
        `hit sets diverged for "${c.name}"\n` +
          `old: ${JSON.stringify(expected)}\nnew: ${JSON.stringify(stripped)}`,
      );
      assert.equal(
        actual.length > 0,
        c.expectHits,
        `case "${c.name}" ${c.expectHits ? "should" : "should not"} produce hits`,
      );
    });
  }

  it("the corpus is non-trivial (a vacuous all-empty comparison would pass)", () => {
    const total = corpus.reduce((n, c) => n + referenceScanDiff(c.diff).length, 0);
    assert.ok(total >= 10, `expected a substantive corpus, got ${total} reference hits`);
    assert.ok(
      corpus.filter(c => c.expectHits).length >= 6,
      "expected several hit-producing cases",
    );
  });

  it("every non-empty case actually produced diff text", () => {
    for (const c of corpus) {
      if (c.name === "empty diff") {
        assert.equal(c.diff.trim(), "", "the empty case must really be empty");
      } else {
        assert.ok(c.diff.length > 0, `case "${c.name}" captured no diff output`);
      }
    }
  });

  it("the new parser attaches a path to every hit that has a file stanza", () => {
    // Guards the actual point of the refactor: the comparison above is
    // blind to path/blob by construction, so assert separately that the
    // new fields are populated rather than quietly always undefined.
    const withPath = corpus
      .flatMap(c => scanDiffText(c.diff, denySet))
      .filter(h => h.path !== undefined);
    assert.ok(withPath.length >= 10, `expected paths on most hits, got ${withPath.length}`);
  });
});
