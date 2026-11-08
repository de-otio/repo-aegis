// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// GH_AUTH_TOKEN_NETWORK and git (doc/plan-owner-identity.md §5.5, I17): a git subcommand that only works on
// the local repository is not a network call, so `gh auth token` next to `git tag` is allowed. Every other
// git invocation, and any global option that can change what git runs, still counts (fail closed).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkNetworkRules } from "./egress-network-rules.js";

const TOKEN = "export GH_TOKEN=\"$(gh auth token --hostname github.com --user someone)\"";

describe("GH_AUTH_TOKEN_NETWORK: local git subcommands are not network calls", () => {
  const LOCAL = [
    "git -C /x tag --sort=-creatordate",
    "git tag",
    "git log --oneline -5",
    "git status --short",
    "git rev-parse HEAD",
    "git describe --tags",
    "git -C /x -C y show HEAD",
    "git --git-dir=/x/.git log",
    "git --git-dir /x/.git --work-tree /x status",
    "git --no-pager diff",
    "git -P branch --list",
    "git for-each-ref refs/tags",
    "git config --get user.email",
  ];
  for (const g of LOCAL) {
    it(`allows the token next to: ${g}`, () => {
      assert.equal(checkNetworkRules(`${TOKEN}; ${g}`), null);
      assert.equal(checkNetworkRules(`${TOKEN}; ${g} | head -n 10`), null);
    });
  }

  it("allows the reported command: gh reads plus a local git tag listing", () => {
    const command =
      `${TOKEN}; R=example-org/example; gh repo view $R --json visibility; ` +
      `gh api "repos/$R/dependabot/alerts?state=open" --jq 'length'; gh pr list --repo $R --state open; ` +
      `gh release list --repo $R --limit 10; git -C /x/example tag --sort=-creatordate | head -n 10; ` +
      `gh run list --repo $R --limit 15`;
    assert.equal(checkNetworkRules(command), null);
  });
});

describe("GH_AUTH_TOKEN_NETWORK: every other git invocation still counts", () => {
  const NETWORK = [
    "git push origin main",
    "git fetch origin",
    "git pull",
    "git clone https://example.test/x.git",
    "git ls-remote origin",
    "git remote update",
    "git submodule update --init",
    "git send-email x.patch",
    "git archive --remote=origin HEAD",
    "git maintenance run --task=prefetch",
    "git -C /x push",
    "git -c alias.tag=push tag",
    "git -c core.sshCommand=x tag",
    "git --config-env=core.fsmonitor=X status",
    "git --exec-path=/tmp/x tag",
    "git -C /x --unknown-option tag",
    "git myalias",
    "git $SUB",
    "git",
    "git -C /x",
  ];
  for (const g of NETWORK) {
    it(`refuses the token next to: ${g}`, () => {
      assert.equal(checkNetworkRules(`${TOKEN}; ${g}`)?.code, "GH_AUTH_TOKEN_NETWORK");
    });
  }

  it("a network program anywhere in the line still counts, local git or not", () => {
    assert.equal(checkNetworkRules(`${TOKEN}; git tag; curl https://example.test/x`)?.code, "GH_AUTH_TOKEN_NETWORK");
    assert.equal(checkNetworkRules(`${TOKEN}; git status && git push`)?.code, "GH_AUTH_TOKEN_NETWORK");
  });

  it("git inside sh -c and a substitution is judged the same way", () => {
    assert.equal(checkNetworkRules(`${TOKEN}; sh -c 'git fetch'`)?.code, "GH_AUTH_TOKEN_NETWORK");
    assert.equal(checkNetworkRules(`${TOKEN}; echo $(git ls-remote origin)`)?.code, "GH_AUTH_TOKEN_NETWORK");
    assert.equal(checkNetworkRules(`${TOKEN}; echo $(git rev-parse HEAD)`), null);
  });
});
