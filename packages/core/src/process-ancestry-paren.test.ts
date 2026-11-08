// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// parenthesisedPath replaces `/\((\/[^)]+)\)/` (code-scanning js/polynomial-redos): same result on every
// input, linear time.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parenthesisedPath } from "./process-ancestry.js";

const OLD = (argv: string): string | null => /\((\/[^)]+)\)/.exec(argv)?.[1] ?? null;

describe("parenthesisedPath", () => {
  const CASES = [
    "tmux: server (/private/tmp/tmux-501/default)",
    "tmux: server",
    "tmux: server ()",
    "tmux: server (/)",
    "tmux: server (/) (/tmp/x)",
    "tmux: server (relative) (/abs/sock)",
    "tmux: server (/a(b)c)",
    "tmux: server (/unterminated",
    "((/x)",
    "(/x)(/y)",
    "(/x",
    "",
    "(",
    "(/",
    "(/)",
    ")(/a)",
  ];
  for (const c of CASES) {
    it(`matches the old regex on ${JSON.stringify(c)}`, () => {
      assert.equal(parenthesisedPath(c), OLD(c));
    });
  }

  it("matches the old regex on random strings over the interesting alphabet", () => {
    // Deterministic LCG: the alphabet is the characters the pattern cares about plus one filler.
    let seed = 42;
    const next = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648);
    const alphabet = ["(", ")", "/", "a"];
    for (let k = 0; k < 5000; k++) {
      const len = next() % 12;
      let s = "";
      for (let j = 0; j < len; j++) s += alphabet[next() % alphabet.length];
      assert.equal(parenthesisedPath(s), OLD(s), JSON.stringify(s));
    }
  });

  it("is linear on a long line of `(/` with no `)`", () => {
    const hostile = "(/".repeat(200_000);
    const t = process.hrtime.bigint();
    assert.equal(parenthesisedPath(hostile), null);
    assert.ok(Number(process.hrtime.bigint() - t) / 1e6 < 200, "under 200 ms");
  });
});
