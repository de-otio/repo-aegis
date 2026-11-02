// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseRegistryText } from "./registry.js";
import { RegistryParseError } from "./exceptions.js";
import { upstreamProblem } from "./schemas.js";

const reg = (upstreams: string[]): string =>
  `engagements: []\nallowedUpstreams:\n${upstreams.map(u => `  - ${u}`).join("\n")}\n`;

describe("allowedUpstreams entry validation", () => {
  const owner39 = "a".repeat(39);
  const repo100 = "r".repeat(100);

  it("accepts ordinary entries and the GitHub length limits exactly", () => {
    for (const ok of ["stranger/repo", "stranger/foo.js", "a/b_c-d", `${owner39}/${repo100}`]) {
      assert.equal(upstreamProblem(ok), null, ok);
      assert.deepEqual(parseRegistryText(reg([ok])).allowedUpstreams, [ok]);
    }
  });

  it("rejects over-long halves, wildcards, traversal names and a .git suffix", () => {
    for (const bad of [
      `${owner39}a/repo`,
      `owner/${repo100}r`,
      "stranger/*",
      "stranger/..",
      "stranger/.",
      "stranger/repo.git",
      "stranger/.git",
      "stranger",
      "a/b/c",
      "Stranger/Repo",
    ]) {
      assert.notEqual(upstreamProblem(bad), null, bad);
      assert.throws(() => parseRegistryText(reg([JSON.stringify(bad)])), RegistryParseError, bad);
    }
  });
});

describe("parseRegistryText", () => {
  it("applies the same schemaVersion policy as loadRegistry", () => {
    assert.throws(() => parseRegistryText("schemaVersion: 99\nengagements: []\n"), RegistryParseError);
  });

  it("rejects an org registered both as personal and under an engagement", () => {
    const text = `schemaVersion: 2
personalOrgs: [dup-org]
engagements:
  - id: e1
    name: E1
    markers: []
    githubOrgs: [dup-org]
`;
    assert.throws(() => parseRegistryText(text), RegistryParseError);
  });

  it("returns the registry for valid text", () => {
    const r = parseRegistryText("schemaVersion: 2\npersonalOrgs: [me]\nengagements: []\n");
    assert.deepEqual(r.personalOrgs, ["me"]);
  });
});
