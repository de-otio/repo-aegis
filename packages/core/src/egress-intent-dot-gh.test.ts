// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `dot gh` recognition (doc/plan-recognise-dot-gh.md §3.1, D1, D4, D5): the parser reads
// `node <path>/dot.mjs gh [--as <id>] [--explain] <gh args…>` and `dot gh …` as the `gh` call they make,
// and carries dot gh's own `--as` on the intent. Every other wrapper shape stays an `unparsed-shape`.
// The fixtures (T-numbers are the plan's §4) are placeholders: `o/r`, `/p/scripts/dot.mjs`, `/s/b.md`.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseEgressIntents, type EgressIntent } from "./egress-intent.js";

const NODE_DOT = "node /p/scripts/dot.mjs gh";
const CREATE = "pr create --repo o/r --title t --body-file /s/b.md";

function only(command: string): EgressIntent {
  const intents = parseEgressIntents(command);
  assert.equal(intents.length, 1, `expected exactly one intent for ${JSON.stringify(command)}, got ${JSON.stringify(intents)}`);
  return intents[0]!;
}

/** The command was not recognised: one fail-closed `unparsed-shape` intent, no wrapper. */
function assertUnparsed(command: string): void {
  const i = only(command);
  assert.equal(i.unresolved, "unparsed-shape", command);
  assert.equal(i.wrapper, undefined, command);
}

describe("dot gh — recognised shape (§3.1)", () => {
  it("T1: node <path>/dot.mjs gh --as bot … is the gh call it makes, carrying as: bot (was: unparsed-shape)", () => {
    const i = only(`${NODE_DOT} --as bot ${CREATE}`);
    assert.equal(i.verb, "gh-pr-create");
    assert.equal(i.repoFlag, "o/r");
    assert.deepEqual(i.payloadFiles, ["/s/b.md"]);
    assert.equal(i.unresolved, undefined);
    assert.deepEqual(i.wrapper, { kind: "dot-gh", as: "bot" });
  });

  it("T1: the same intent as the plain gh call, but for the wrapper", () => {
    const { wrapper, ...wrapped } = only(`${NODE_DOT} --as bot ${CREATE}`);
    assert.deepEqual(wrapper, { kind: "dot-gh", as: "bot" });
    assert.deepEqual(wrapped, only(`gh ${CREATE}`));
  });

  it("T2/T3: no --as is as: null; --as owner and --as work carry their name", () => {
    assert.deepEqual(only(`${NODE_DOT} ${CREATE}`).wrapper, { kind: "dot-gh", as: null });
    assert.deepEqual(only(`${NODE_DOT} --as owner ${CREATE}`).wrapper, { kind: "dot-gh", as: "owner" });
    assert.deepEqual(only(`${NODE_DOT} --as work ${CREATE}`).wrapper, { kind: "dot-gh", as: "work" });
  });

  it("T4: --as=bot", () => {
    assert.deepEqual(only(`${NODE_DOT} --as=bot ${CREATE}`).wrapper, { kind: "dot-gh", as: "bot" });
  });

  it("T5: an --as after a gh word belongs to gh, not to dot gh (as: null)", () => {
    const i = only("dot gh pr create --as bot --repo o/r --title t");
    assert.equal(i.verb, "gh-pr-create");
    assert.deepEqual(i.wrapper, { kind: "dot-gh", as: null });
  });

  it("T6: the bare word dot", () => {
    const i = only(`dot gh --as bot ${CREATE}`);
    assert.equal(i.verb, "gh-pr-create");
    assert.deepEqual(i.wrapper, { kind: "dot-gh", as: "bot" });
  });

  it("dot gh reads its own options the way dot gh does: in any order, the last --as wins", () => {
    assert.deepEqual(only(`dot gh --as owner --as bot ${CREATE}`).wrapper, { kind: "dot-gh", as: "bot" });
    assert.deepEqual(only(`dot gh --as bot --as=owner ${CREATE}`).wrapper, { kind: "dot-gh", as: "owner" });
    assert.deepEqual(only(`dot gh --as owner --as bot ${CREATE}`).wrapper, { kind: "dot-gh", as: "bot" });
    // dot gh checks for an empty --as only after the loop, so a later --as repairs it.
    assert.deepEqual(only(`dot gh --as= --as bot ${CREATE}`).wrapper, { kind: "dot-gh", as: "bot" });
  });

  it("an absolute path to node is recognised", () => {
    assert.deepEqual(only(`/usr/local/bin/node /p/scripts/dot.mjs gh --as bot ${CREATE}`).wrapper, { kind: "dot-gh", as: "bot" });
  });

  it("T7: reads through dot gh are no intent, whatever the identity", () => {
    assert.deepEqual(parseEgressIntents("dot gh --repo o/r pr view 1"), []);
    assert.deepEqual(parseEgressIntents("dot gh --as owner api repos/o/r"), []);
    assert.deepEqual(parseEgressIntents(`${NODE_DOT} --as bot pr list --repo o/r`), []);
  });

  it("a write other than pr create keeps its verb and target (api -X POST)", () => {
    const i = only("dot gh --as bot api -X POST repos/o/r/pulls/12/requested_reviewers -f reviewers[]=x");
    assert.equal(i.verb, "gh-api-mutating");
    assert.equal(i.apiEndpoint, "repos/o/r/pulls/12/requested_reviewers");
    assert.deepEqual(i.wrapper, { kind: "dot-gh", as: "bot" });
  });

  it("a target that cannot be named is as unresolved as for a plain gh", () => {
    const i = only(`${NODE_DOT} --as bot pr create --repo "$R" --title t`);
    assert.equal(i.unresolved, "opaque-repo");
    assert.deepEqual(i.wrapper, { kind: "dot-gh", as: "bot" });
  });

  it("words inside a message flag are data, as for a plain gh", () => {
    const i = only(`${NODE_DOT} --as bot pr create --repo o/r --title t --body "run gh issue create next"`);
    assert.equal(i.unresolved, undefined);
    assert.equal(i.verb, "gh-pr-create");
  });

  it("a second gh mention in the same segment is still reported (the backstop is not switched off)", () => {
    const intents = parseEgressIntents(`${NODE_DOT} --as bot pr view 1 --repo o/r bash -c 'gh issue create --repo o/r'`);
    assert.ok(
      intents.some(i => i.unresolved === "unparsed-shape"),
      JSON.stringify(intents),
    );
  });

  it("T14: after a cd it is the same intent, flagged precededByCd (the policy refuses it as it does a plain gh)", () => {
    const i = only(`cd /x && ${NODE_DOT} --as bot ${CREATE}`);
    assert.equal(i.precededByCd, true);
    assert.equal(i.joinedBy, "&&");
    assert.equal(i.verb, "gh-pr-create");
    assert.deepEqual(i.wrapper, { kind: "dot-gh", as: "bot" });
  });
});

describe("dot gh --explain (D4)", () => {
  it("T12: --explain runs no gh, so it is no intent", () => {
    assert.deepEqual(parseEgressIntents(`dot gh --explain --repo o/r ${CREATE.replace("--repo o/r ", "")}`), []);
    assert.deepEqual(parseEgressIntents(`${NODE_DOT} --as bot --explain ${CREATE}`), []);
    assert.deepEqual(parseEgressIntents(`${NODE_DOT} --explain --as=bot ${CREATE}`), []);
  });

  it("an --explain after a gh word is gh's, and the call is a write", () => {
    const i = only(`${NODE_DOT} --as bot ${CREATE} --explain`);
    assert.deepEqual(i.wrapper, { kind: "dot-gh", as: "bot" });
  });
});

describe("dot gh refuses its own malformed options and runs no gh, so there is no intent (splitOwnOptions)", () => {
  it("--as with no value, an empty value, or a value that starts with -", () => {
    assert.deepEqual(parseEgressIntents("dot gh --as"), []);
    assert.deepEqual(parseEgressIntents(`dot gh --as= ${CREATE}`), []);
    assert.deepEqual(parseEgressIntents(`dot gh --as '' ${CREATE}`), []);
    assert.deepEqual(parseEgressIntents(`dot gh --as --explain ${CREATE}`), []);
    assert.deepEqual(parseEgressIntents(`${NODE_DOT} --as -x ${CREATE}`), []);
  });
});

describe("any other wrapper shape stays an unparsed-shape (D5)", () => {
  it("T11: node options before the script", () => {
    assertUnparsed(`node --require x /p/dot.mjs gh --as bot ${CREATE}`);
    assertUnparsed(`node -r x /p/dot.mjs gh --as bot ${CREATE}`);
    assertUnparsed(`node --import x /p/dot.mjs gh --as bot ${CREATE}`);
    assertUnparsed(`node -e 'x' /p/dot.mjs gh --as bot ${CREATE}`);
  });

  it("T11: NODE_OPTIONS or NODE_PATH set on the segment, by prefix, env or an earlier export", () => {
    assertUnparsed(`NODE_OPTIONS=--require=x node /p/dot.mjs gh --as bot ${CREATE}`);
    assertUnparsed(`NODE_PATH=/x node /p/dot.mjs gh --as bot ${CREATE}`);
    assertUnparsed(`env NODE_OPTIONS=--require=x node /p/dot.mjs gh --as bot ${CREATE}`);
    const exported = parseEgressIntents(`export NODE_OPTIONS=--require=x && node /p/dot.mjs gh --as bot ${CREATE}`);
    assert.ok(exported.length > 0 && exported.every(i => i.wrapper === undefined), JSON.stringify(exported));
  });

  it("T11: a script not named dot.mjs", () => {
    assertUnparsed(`node /p/other.mjs gh --as bot ${CREATE}`);
    assertUnparsed(`node /p/dot.mjs.evil gh --as bot ${CREATE}`);
  });

  it("T11: a script in a variable, a substitution or a glob", () => {
    assertUnparsed(`node "$S" gh --as bot ${CREATE}`);
    assertUnparsed(`node $(which dot)/dot.mjs gh --as bot ${CREATE}`);
    assertUnparsed(`node /p/scripts/*.mjs gh --as bot ${CREATE}`);
  });

  it("node as a relative path, and another program named dot.mjs's neighbour", () => {
    assertUnparsed(`./node /p/dot.mjs gh --as bot ${CREATE}`);
    assertUnparsed(`bun /p/dot.mjs gh --as bot ${CREATE}`);
  });

  it("a path to dot, or the word dot with another first word, is not recognised", () => {
    assertUnparsed(`/p/bin/dot gh --as bot ${CREATE}`);
    assertUnparsed(`dot --as bot gh ${CREATE}`);
  });
});

describe("the remainder is classified with the context a plain gh gets", () => {
  it("a built-in group with no shape is an unresolved write, so dot gh sees it as a write", () => {
    const i = only("dot gh --as owner project item-add 1 --owner o");
    assert.equal(i.verb, "gh-unknown");
    assert.equal(i.unresolved, "unknown-shape");
    assert.deepEqual(i.wrapper, { kind: "dot-gh", as: "owner" });
  });

  it("GH_REPO in the segment's prefix, or the caller's environment, names the target", () => {
    const prefixed = only("GH_REPO=o/r dot gh --as bot pr create --title t --body-file /s/b.md");
    assert.equal(prefixed.envRepo, "o/r");
    const inherited = parseEgressIntents("dot gh --as bot pr create --title t", { envRepo: "o/r" });
    assert.equal(inherited[0]?.envRepo, "o/r");
  });

  it("an earlier GH_REPO change on the line makes the target opaque, as for a plain gh", () => {
    const wrapped = parseEgressIntents("export GH_REPO=x/y; dot gh --as bot issue create --title t").at(-1);
    const plain = parseEgressIntents("export GH_REPO=x/y; gh issue create --title t").at(-1);
    assert.equal(plain?.unresolved, "env-override");
    assert.equal(wrapped?.unresolved, "env-override");
  });
});
