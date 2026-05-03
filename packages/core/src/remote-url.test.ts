// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseRemoteUrl } from "./remote-url.js";

describe("parseRemoteUrl — accepted forms", () => {
  const cases: Array<[string, string, string]> = [
    // [input, org, repo]
    ["https://github.com/foo/bar", "foo", "bar"],
    ["https://github.com/foo/bar.git", "foo", "bar"],
    ["https://github.com/foo/bar/", "foo", "bar"],
    ["http://github.com/foo/bar", "foo", "bar"],
    ["http://github.com/foo/bar.git", "foo", "bar"],
    ["git@github.com:foo/bar", "foo", "bar"],
    ["git@github.com:foo/bar.git", "foo", "bar"],
    ["git@github.com-personal:foo/bar.git", "foo", "bar"],
    ["git@github.com-work:foo/bar.git", "foo", "bar"],
    ["git@github.com-MIXED_alias-1:foo/bar", "foo", "bar"],
    ["ssh://git@github.com/foo/bar.git", "foo", "bar"],
    ["ssh://git@github.com/foo/bar", "foo", "bar"],
    ["https://user@github.com/foo/bar.git", "foo", "bar"],
    ["https://user:token@github.com/foo/bar.git", "foo", "bar"],
    // Lowercasing
    ["https://github.com/Foo-Corp/Bar-Repo.git", "foo-corp", "bar-repo"],
    ["git@github.com:DELL/UMP.git", "dell", "ump"],
    // Whitespace trimmed
    ["  https://github.com/foo/bar.git  \n", "foo", "bar"],
    // Hyphens, digits, dots in repo names
    ["https://github.com/foo/bar.baz.git", "foo", "bar.baz"],
    ["https://github.com/foo/bar_baz", "foo", "bar_baz"],
    ["https://github.com/foo/bar-123", "foo", "bar-123"],
  ];

  for (const [input, org, repo] of cases) {
    it(`parses ${JSON.stringify(input)}`, () => {
      const parsed = parseRemoteUrl(input);
      assert.deepEqual(parsed, { host: "github.com", org, repo });
    });
  }
});

describe("parseRemoteUrl — rejected forms (return null)", () => {
  const cases: string[] = [
    // Non-string
    "",
    "   ",
    // Non-github hosts
    "https://gitlab.com/foo/bar.git",
    "git@gitlab.com:foo/bar.git",
    "https://bitbucket.org/foo/bar.git",
    "https://example.com/foo/bar",
    "git@example.com:foo/bar.git",
    // Self-hosted github-like host
    "https://github.example.com/foo/bar.git",
    "https://my-github.com/foo/bar.git",
    // Missing repo
    "https://github.com/foo",
    "https://github.com/foo/",
    "git@github.com:foo",
    // Missing org
    "https://github.com//bar",
    "git@github.com:/bar.git",
    // Org starting with hyphen
    "https://github.com/-bad/bar",
    "git@github.com:-bad/bar.git",
    // Extra path segments
    "https://github.com/foo/bar/tree/main",
    "https://github.com/foo/bar/issues/1",
    // Garbage
    "not a url",
    "://github.com/foo/bar",
    "github.com/foo/bar",
    // Empty parts
    "https://github.com/",
    "git@github.com:",
  ];

  for (const input of cases) {
    it(`rejects ${JSON.stringify(input)}`, () => {
      assert.equal(parseRemoteUrl(input), null);
    });
  }

  it("returns null for non-string input (typed)", () => {
    assert.equal(parseRemoteUrl(undefined), null);
    assert.equal(parseRemoteUrl(null), null);
    assert.equal(parseRemoteUrl(42), null);
    assert.equal(parseRemoteUrl({}), null);
    assert.equal(parseRemoteUrl([]), null);
  });
});

describe("parseRemoteUrl — fuzz", () => {
  it("never throws on random ASCII input", () => {
    const seed = 0xc0ffee;
    let s = seed;
    function rand(): number {
      // xorshift32 — deterministic
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      return Math.abs(s);
    }
    for (let i = 0; i < 1000; i++) {
      const len = rand() % 64;
      let str = "";
      for (let j = 0; j < len; j++) {
        str += String.fromCharCode(0x20 + (rand() % 95));
      }
      // Should never throw, regardless of input.
      const result = parseRemoteUrl(str);
      // Sanity: result is null or has the expected shape.
      if (result !== null) {
        assert.equal(typeof result.host, "string");
        assert.equal(typeof result.org, "string");
        assert.equal(typeof result.repo, "string");
      }
    }
  });
});
