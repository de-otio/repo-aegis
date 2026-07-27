// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compileGlob, compileGlobs, matchesCompiled, matchesAnyGlob, GlobTooBroadError } from "./globs.js";

// ---------------------------------------------------------------------
// Unit cases, one per contract bullet in globs.ts.
// ---------------------------------------------------------------------

describe("compileGlob: * within a segment", () => {
  it("matches zero or more chars within one segment", () => {
    const re = compileGlob("*.ts");
    assert.equal(re.test("a.ts"), true);
    assert.equal(re.test(".ts"), true);
    assert.equal(re.test("a.b.c.ts"), true);
  });

  it("never crosses /", () => {
    const re = compileGlob("*.ts");
    assert.equal(re.test("a/b.ts"), false);
  });
});

describe("compileGlob: ? within a segment", () => {
  it("matches exactly one non-/ char", () => {
    const re = compileGlob("a?.ts");
    assert.equal(re.test("ab.ts"), true);
    assert.equal(re.test("a.ts"), false); // zero chars, not one
    assert.equal(re.test("abc.ts"), false); // two chars, not one
  });

  it("never crosses /", () => {
    const re = compileGlob("a?ts");
    assert.equal(re.test("a/ts"), false);
  });
});

describe("compileGlob: ** crossing separators", () => {
  it("leading **/x matches a bare x at the root", () => {
    const re = compileGlob("**/x");
    assert.equal(re.test("x"), true);
    assert.equal(re.test("a/x"), true);
    assert.equal(re.test("a/b/x"), true);
  });

  it("trailing x/** matches x and anything under it", () => {
    const re = compileGlob("x/**");
    assert.equal(re.test("x"), true);
    assert.equal(re.test("x/a"), true);
    assert.equal(re.test("x/a/b"), true);
    assert.equal(re.test("y"), false);
  });

  it("middle a/**/b matches zero or more directories between a and b", () => {
    const re = compileGlob("a/**/b");
    assert.equal(re.test("a/b"), true);
    assert.equal(re.test("a/x/b"), true);
    assert.equal(re.test("a/x/y/b"), true);
    assert.equal(re.test("a/c"), false);
  });

  it("**/test/** matches test/a.ts (leading zero dirs, trailing one segment)", () => {
    const re = compileGlob("**/test/**");
    assert.equal(re.test("test/a.ts"), true);
  });

  it("**/test/** does not match a segment that merely contains 'test' as a substring", () => {
    const re = compileGlob("**/test/**");
    assert.equal(re.test("src/contest/a.ts"), false);
    assert.equal(re.test("testing/a.ts"), false);
  });

  it("**/*.test.* matches src/a.test.ts and a.test.ts", () => {
    const re = compileGlob("**/*.test.*");
    assert.equal(re.test("src/a.test.ts"), true);
    assert.equal(re.test("a.test.ts"), true);
    assert.equal(re.test("a.spec.ts"), false);
  });
});

describe("compileGlob: matching is case-sensitive and anchored", () => {
  it("is case-sensitive", () => {
    const re = compileGlob("**/Test/**");
    assert.equal(re.test("test/a.ts"), false);
    assert.equal(re.test("Test/a.ts"), true);
  });

  it("is a full-path match, not a substring match", () => {
    const re = compileGlob("a.ts");
    assert.equal(re.test("xa.tsx"), false);
    assert.equal(re.test("dir/a.ts"), false);
    assert.equal(re.test("a.ts"), true);
  });
});

describe("compileGlob: literal segments escape regex metacharacters", () => {
  it("treats a literal dot, plus, and parens as literal, not regex syntax", () => {
    const re = compileGlob("a.b+c(d).ts");
    assert.equal(re.test("a.b+c(d).ts"), true);
    // if the dot/plus/parens leaked through as regex syntax this would
    // wrongly match too (e.g. "." as "any char", "+" as repetition)
    assert.equal(re.test("aXb+c(d).ts"), false);
    assert.equal(re.test("a.bc(d).ts"), false);
  });
});

// ---------------------------------------------------------------------
// GlobTooBroadError
// ---------------------------------------------------------------------

describe("compileGlob: rejects globs that match everything", () => {
  for (const glob of ["", "   ", "*", "**", "**/*"]) {
    it(`throws GlobTooBroadError for ${JSON.stringify(glob)}`, () => {
      assert.throws(() => compileGlob(glob), GlobTooBroadError);
    });
  }

  it("the thrown error carries a stable code field", () => {
    try {
      compileGlob("**");
      assert.fail("expected GlobTooBroadError");
    } catch (err) {
      assert.ok(err instanceof GlobTooBroadError);
      assert.equal(err.code, "GLOB_TOO_BROAD");
    }
  });

  it("does not reject a glob that merely contains ** as part of a narrower pattern", () => {
    assert.doesNotThrow(() => compileGlob("**/test/**"));
    assert.doesNotThrow(() => compileGlob("**/*.test.*"));
  });
});

// ---------------------------------------------------------------------
// The built-in default list item B (deny-set lane) will use. Assert one
// matching and one non-matching representative path per entry.
// ---------------------------------------------------------------------

describe("compileGlob: built-in exemption defaults", () => {
  const cases: { glob: string; matches: string[]; nonMatches: string[] }[] = [
    { glob: "**/test/**", matches: ["test/a.ts"], nonMatches: ["src/a.ts", "testing/a.ts"] },
    { glob: "**/tests/**", matches: ["tests/a.ts"], nonMatches: ["src/a.ts", "contests/a.ts"] },
    { glob: "**/__tests__/**", matches: ["src/__tests__/a.ts"], nonMatches: ["src/a.ts"] },
    { glob: "**/__fixtures__/**", matches: ["__fixtures__/a.json"], nonMatches: ["src/a.json"] },
    { glob: "**/fixtures/**", matches: ["src/fixtures/a.json"], nonMatches: ["src/a.json"] },
    { glob: "**/testdata/**", matches: ["pkg/testdata/a.txt"], nonMatches: ["pkg/data/a.txt"] },
    { glob: "**/*.test.*", matches: ["src/a.test.ts"], nonMatches: ["src/a.ts"] },
    { glob: "**/*.spec.*", matches: ["src/a.spec.ts"], nonMatches: ["src/a.ts"] },
    { glob: "**/*.fixture.*", matches: ["src/a.fixture.ts"], nonMatches: ["src/a.ts"] },
  ];

  for (const { glob, matches, nonMatches } of cases) {
    it(`${glob}: matches its representative paths`, () => {
      const re = compileGlob(glob);
      for (const p of matches) assert.equal(re.test(p), true, `expected ${glob} to match ${p}`);
      for (const p of nonMatches) assert.equal(re.test(p), false, `expected ${glob} to NOT match ${p}`);
    });
  }

  it("does not throw GlobTooBroadError for any built-in default", () => {
    const globs = cases.map(c => c.glob);
    assert.doesNotThrow(() => compileGlobs(globs));
  });
});

// ---------------------------------------------------------------------
// matchesAnyGlob / compileGlobs / matchesCompiled
// ---------------------------------------------------------------------

describe("matchesAnyGlob and precompiled variants", () => {
  const globs = ["**/test/**", "**/*.spec.*"];

  it("matchesAnyGlob matches when any glob in the list matches", () => {
    assert.equal(matchesAnyGlob("test/a.ts", globs), true);
    assert.equal(matchesAnyGlob("src/a.spec.ts", globs), true);
    assert.equal(matchesAnyGlob("src/a.ts", globs), false);
  });

  it("compileGlobs + matchesCompiled agree with matchesAnyGlob", () => {
    const compiled = compileGlobs(globs);
    for (const p of ["test/a.ts", "src/a.spec.ts", "src/a.ts"]) {
      assert.equal(matchesCompiled(p, compiled), matchesAnyGlob(p, globs));
    }
  });

  it("propagates GlobTooBroadError from a bad entry in the list", () => {
    assert.throws(() => matchesAnyGlob("x", ["**/test/**", "**"]), GlobTooBroadError);
  });
});

// ---------------------------------------------------------------------
// PROPERTY TEST
//
// compileGlob is a hand-rolled regex compiler for a security exemption
// primitive; a subtly wrong ** expansion would silently widen what the
// exemption covers. We check it against an independent, "obviously
// correct but slow" reference implementation: brute-force recursive
// segment matching, in the same spirit as regex backtracking but written
// directly against the segment-list semantics described in globs.ts
// (** = zero or more entire path segments).
//
// Deterministic: a seeded PRNG (mulberry32, no dependency) drives every
// random choice, so a failure is always reproducible by rerunning this
// file — no flakiness, per the repo's pinned-nondeterminism default.
// ---------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, xs: readonly T[]): T {
  const idx = Math.floor(rng() * xs.length);
  return xs[Math.min(idx, xs.length - 1)]!;
}

function randomSegments(rng: () => number, alphabet: readonly string[], minLen: number, maxLen: number): string[] {
  const len = minLen + Math.floor(rng() * (maxLen - minLen + 1));
  const segs: string[] = [];
  for (let i = 0; i < len; i++) segs.push(pick(rng, alphabet));
  return segs;
}

/** Reference: does `pat` (one glob segment, no `**`, no `/`) match `seg` exactly? Classic recursive `*`/`?` matcher. */
function refMatchSegment(pat: string, seg: string): boolean {
  const memo = new Map<string, boolean>();
  function go(pi: number, si: number): boolean {
    const key = `${pi},${si}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let result: boolean;
    if (pi === pat.length) {
      result = si === seg.length;
    } else if (pat[pi] === "*") {
      result = false;
      for (let k = si; k <= seg.length && !result; k++) {
        result = go(pi + 1, k);
      }
    } else if (si === seg.length) {
      result = false;
    } else if (pat[pi] === "?") {
      result = go(pi + 1, si + 1);
    } else {
      result = pat[pi] === seg[si] && go(pi + 1, si + 1);
    }
    memo.set(key, result);
    return result;
  }
  return go(0, 0);
}

/** Reference: brute-force recursive segment-list matcher implementing "** = zero or more entire segments". */
function refMatchSegments(patSegs: readonly string[], pathSegs: readonly string[]): boolean {
  if (patSegs.length === 0) return pathSegs.length === 0;
  const [p, ...prest] = patSegs as [string, ...string[]];
  if (p === "**") {
    if (refMatchSegments(prest, pathSegs)) return true; // ** consumes zero segments
    if (pathSegs.length > 0 && refMatchSegments(patSegs, pathSegs.slice(1))) return true; // ** consumes one more segment, retry
    return false;
  }
  if (pathSegs.length === 0) return false;
  const [s, ...srest] = pathSegs as [string, ...string[]];
  return refMatchSegment(p, s) && refMatchSegments(prest, srest);
}

function refMatch(glob: string, path: string): boolean {
  return refMatchSegments(glob.split("/"), path.split("/"));
}

const BROAD = new Set(["*", "**", "**/*"]);

describe("compileGlob: property test against a brute-force reference matcher", () => {
  it("agrees with the reference matcher over thousands of random (glob, path) pairs", () => {
    const rng = mulberry32(0xc0ffee);
    const pathAlphabet = ["a", "b", "test", "tests", "ts", "a.ts", "a.test.ts", "foo.bar"];
    const globAlphabet = [...pathAlphabet, "*", "**", "?"];

    let compared = 0;
    let skippedBroad = 0;
    const TRIALS = 5000;

    for (let i = 0; i < TRIALS; i++) {
      const glob = randomSegments(rng, globAlphabet, 1, 4).join("/");
      const path = randomSegments(rng, pathAlphabet, 1, 4).join("/");

      if (BROAD.has(glob.trim()) || glob.trim() === "") {
        assert.throws(() => compileGlob(glob), GlobTooBroadError);
        skippedBroad++;
        continue;
      }

      const re = compileGlob(glob);
      const actual = re.test(path);
      const expected = refMatch(glob, path);
      assert.equal(
        actual,
        expected,
        `mismatch for glob=${JSON.stringify(glob)} path=${JSON.stringify(path)}: compileGlob=${actual} reference=${expected}`,
      );
      compared++;
    }

    // Sanity: the trial run actually exercised both branches, not just
    // one (a PRNG or alphabet bug could otherwise make this pass
    // vacuously with everything skipped as "too broad").
    assert.ok(compared > TRIALS / 2, `expected most trials to compare, got ${compared} compared / ${skippedBroad} skipped`);
  });

  it("agrees on a fixed regression set of hand-picked edge cases", () => {
    const cases: [string, string][] = [
      ["**", "a"], // (would throw; handled separately below)
      ["a/**/b", "a/b"],
      ["a/**/b", "a/x/y/b"],
      ["**/**", "a/b/c"],
      ["**/**/a", "a"],
      ["a/**", "a"],
      ["a/**", "a/b/c"],
      ["*", "a"], // (would throw; handled separately below)
      ["a*b", "aXXXb"],
      ["a?b", "aXb"],
      ["a?b", "aXXb"],
    ];
    for (const [glob, path] of cases) {
      if (BROAD.has(glob.trim())) {
        assert.throws(() => compileGlob(glob), GlobTooBroadError);
        continue;
      }
      const actual = compileGlob(glob).test(path);
      const expected = refMatch(glob, path);
      assert.equal(actual, expected, `mismatch for glob=${JSON.stringify(glob)} path=${JSON.stringify(path)}`);
    }
  });
});
