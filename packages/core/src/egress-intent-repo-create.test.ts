// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `gh repo create`: the parser records the visibility the command asks for and whether it copies a
// tree or template into the new repository (doc/plan-engagement-repo-consistency.md, change C).
// Anything it cannot read with certainty is `unspecified`, which keeps the person check.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseEgressIntents, type EgressIntent } from "./egress-intent.js";

function only(command: string): EgressIntent {
  const intents = parseEgressIntents(command);
  assert.equal(intents.length, 1, `expected one intent for ${JSON.stringify(command)}`);
  return intents[0]!;
}

describe("gh repo create — createVisibility", () => {
  const CASES: Array<[string, string]> = [
    ["gh repo create org-a/new --private", "private"],
    ["gh repo create --private org-a/new", "private"],
    ["gh repo create org-a/new --internal", "internal"],
    ["gh repo create org-a/new --public", "public"],
    ["gh repo create org-a/new --private=true", "private"],
    ["gh repo create org-a/new --private=false", "unspecified"],
    ["gh repo create org-a/new --public=false", "unspecified"],
    ["gh repo create org-a/new --private=maybe", "unspecified"],
    ["gh repo create org-a/new --private --private", "unspecified"],
    ["gh repo create org-a/new --private --public", "unspecified"],
    ["gh repo create org-a/new --internal --private", "unspecified"],
    ["gh repo create org-a/new", "unspecified"],
    ['gh repo create org-a/new "$VIS"', "unspecified"],
    ["gh repo create org-a/new --private=$VIS", "unspecified"],
    ["gh repo create org-a/new --private --description $D", "unspecified"],
    // A value flag swallows the next token, as pflag does: the visibility flag is data, not a flag.
    ["gh repo create org-a/new -d --public", "unspecified"],
    ["gh repo create org-a/new --description=--private", "unspecified"],
    ["gh repo create org-a/new --description --private", "unspecified"],
    ["gh repo create org-a/new -d desc --private", "private"],
  ];
  for (const [command, expected] of CASES) {
    it(`${command} → ${expected}`, () => {
      assert.equal(only(command).createVisibility, expected);
    });
  }

  it("`gh repo fork` and other repo verbs never carry the fields", () => {
    for (const c of ["gh repo fork org-a/x --org org-b", "gh repo edit org-a/x --visibility private", "gh repo delete org-a/x --yes"]) {
      const i = only(c);
      assert.equal(i.createVisibility, undefined, c);
      assert.equal(i.createCopiesContent, undefined, c);
    }
  });
});

describe("gh repo create — createCopiesContent", () => {
  const COPIES = [
    "gh repo create org-a/new --private --source .",
    "gh repo create org-a/new --private -s .",
    "gh repo create org-a/new --private --source=. --push",
    "gh repo create org-a/new --private --push",
    "gh repo create org-a/new --private --template org-b/tmpl",
    "gh repo create org-a/new --private -p org-b/tmpl",
    "gh repo create org-a/new --private --clone",
    "gh repo create org-a/new --private -c",
  ];
  for (const c of COPIES) {
    it(`${c} copies content`, () => {
      assert.equal(only(c).createCopiesContent, true);
    });
  }

  it("an empty create with fixed-text options does not copy content", () => {
    const i = only("gh repo create org-a/new --private --add-readme --license mit --gitignore Node -d desc");
    assert.equal(i.createCopiesContent, undefined);
    assert.equal(i.createVisibility, "private");
  });
});
