// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Change D (doc/plan-engagement-repo-consistency.md): the gh command as typed, for the words a receipt prints.
// `repo delete`, `archive` and `rename` all share the policy verb `gh-repo-edit`; a receipt must not say `gh repo edit`
// for a `gh repo delete`.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseEgressIntents } from "./egress-intent.js";
import { describeIntentCommand, describeVerb } from "./egress-policy.js";

function only(command: string) {
  const i = parseEgressIntents(command);
  assert.equal(i.length, 1, command);
  return i[0]!;
}

describe("EgressIntent.ghCommand", () => {
  const CASES: Array<[string, string | undefined]> = [
    ["gh repo delete org-a/x --yes", "repo delete"],
    ["gh repo archive org-a/x --yes", "repo archive"],
    ["gh repo rename new-name -R org-a/x --yes", "repo rename"],
    ["gh repo create org-a/new --private", "repo create"],
    ["gh pr create --repo org-a/x -t t --body-file /s/b.md", "pr create"],
    ["gh pr merge 1 --repo org-a/x", "pr merge"],
    ["gh release upload v1 a.zip --repo org-a/x", "release upload"],
    ["gh --repo org-a/x pr create -t t -b b", "pr create"],
    // `gh api` has no subcommand word; it keeps its own label.
    ["gh api -X POST repos/org-a/x/issues -f title=t", undefined],
  ];
  for (const [command, expected] of CASES) {
    it(`${command} → ${expected ?? "(none)"}`, () => {
      assert.equal(only(command).ghCommand, expected);
    });
  }

  it("only plain command words are kept: nothing from the command line that is not a gh command word is printed", () => {
    for (const word of ["Repo", "repo_delete", "re po", "r$(x)", "1repo", "x".repeat(40)]) {
      const intents = parseEgressIntents(`gh repo ${word} org-a/x`);
      for (const i of intents) assert.equal(i.ghCommand === undefined || /^[a-z][a-z-]{0,30} [a-z][a-z-]{0,30}$/.test(i.ghCommand), true, word);
    }
  });
});

describe("describeIntentCommand", () => {
  it("names the command as typed, not the policy group's label", () => {
    const del = only("gh repo delete org-a/x --yes");
    assert.equal(describeVerb(del.verb), "gh repo edit");
    assert.equal(describeIntentCommand(del), "gh repo delete");
  });

  it("is unchanged where the label was already the command", () => {
    assert.equal(describeIntentCommand(only("gh pr create --repo org-a/x -t t --body-file /s/b.md")), "gh pr create");
  });

  it("falls back to the verb's label when the parser kept no command", () => {
    const api = only("gh api -X POST repos/org-a/x/issues -f title=t");
    assert.equal(describeIntentCommand(api), describeVerb(api.verb));
    assert.equal(describeIntentCommand({ verb: "npm-publish" }), "npm publish");
  });
});
