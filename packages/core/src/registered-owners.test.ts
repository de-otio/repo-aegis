// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ownerAdmitted,
  registeredOwners,
  ruleHSkipNote,
  ruleHStatus,
  UPSTREAM_ADMITTED_VERBS,
} from "./registered-owners.js";
import type { EgressVerb } from "./egress-intent.js";
import type { Registry } from "./registry.js";

const REG = {
  engagements: [
    { id: "customer-a", name: "Customer A", markers: [], githubOrgs: ["Customer-A-Org", "customer-a-labs"] },
    { id: "customer-b", name: "Customer B", markers: [] }, // no githubOrgs at all
  ],
  alwaysBlock: [],
  personalOrgs: ["Acme"],
  allowedUpstreams: ["upstream-org/lib"],
} as unknown as Registry;

describe("registeredOwners", () => {
  it("is personalOrgs ∪ every engagement's githubOrgs, lower-cased", () => {
    assert.deepEqual([...registeredOwners(REG)].sort(), ["acme", "customer-a-labs", "customer-a-org"]);
  });

  it("does NOT include owners of allowedUpstreams (an upstream is not 'ours')", () => {
    assert.ok(!registeredOwners(REG).has("upstream-org"));
  });

  it("is empty for a registry that declares no owners", () => {
    assert.equal(registeredOwners({ engagements: [], alwaysBlock: [] }).size, 0);
    assert.equal(registeredOwners({ engagements: [{ id: "x", name: "X", markers: [] }], alwaysBlock: [] }).size, 0);
  });
});

describe("ruleHStatus / ruleHSkipNote", () => {
  it("missing and owner-less are skips; loaded-with-owners and unreadable are `applied`", () => {
    const none = { engagements: [], alwaysBlock: [] } as Registry;
    assert.equal(ruleHStatus("missing", REG), "skipped:missing");
    assert.equal(ruleHStatus("loaded", none), "skipped:no-owners");
    assert.equal(ruleHStatus("loaded", REG), "applied");
    assert.equal(ruleHStatus("unparseable", none), "applied", "unparseable refuses, it does not skip");
    assert.equal(ruleHStatus("newer-schema", none), "applied", "newer-schema asks or refuses, it does not skip");
    assert.equal(ruleHStatus("encrypted", REG), "skipped:encrypted", "encrypted runs as if there were no registry");
  });

  it("a skip note says which state applied and never carries registry contents", () => {
    assert.match(ruleHSkipNote("skipped:missing")!, /no registry file exists/);
    assert.match(ruleHSkipNote("skipped:no-owners")!, /declares no owners/);
    assert.match(ruleHSkipNote("skipped:encrypted")!, /the registry is encrypted, so repo-aegis runs as if there were none/);
    assert.match(ruleHSkipNote("skipped:encrypted")!, /`repo-aegis registry decrypt --identity <key>`/);
    assert.equal(ruleHSkipNote("applied"), null);
  });
});

describe("ownerAdmitted", () => {
  const owners = registeredOwners(REG);
  const admit = (org: string, repo: string, verb: EgressVerb, unresolved?: string) =>
    ownerAdmitted({ org, repo, ...(unresolved !== undefined && { unresolved }) }, { verb }, owners, REG);

  it("admits a registered owner for every verb, any case", () => {
    for (const verb of ["git-push", "gh-pr-create", "gh-release-create", "gh-api-mutating"] as const) {
      assert.equal(admit("acme", "x", verb), true, verb);
      assert.equal(admit("ACME", "X", verb), true, verb);
      assert.equal(admit("customer-a-org", "x", verb), true, verb);
    }
  });

  it("admits an org-level destination (repo `*`) of a registered owner", () => {
    assert.equal(admit("acme", "*", "gh-api-mutating"), true);
  });

  it("refuses an unregistered owner", () => {
    assert.equal(admit("stranger", "repo", "gh-issue-create"), false);
  });

  it("never admits an unresolved destination, even one with a registered-looking owner", () => {
    assert.equal(admit("acme", "x", "gh-api-mutating", "graphql-mutation"), false);
    assert.equal(admit("*", "*", "gh-api-mutating", "graphql-mutation"), false);
  });

  it("admits an exact allowedUpstreams entry for exactly the D6 verbs", () => {
    const d6: EgressVerb[] = [
      "gh-pr-create",
      "gh-pr-edit",
      "gh-pr-comment",
      "gh-pr-review",
      "gh-issue-create",
      "gh-issue-edit",
      "gh-issue-comment",
    ];
    assert.deepEqual([...UPSTREAM_ADMITTED_VERBS].sort(), [...d6].sort());
    for (const verb of d6) assert.equal(admit("upstream-org", "lib", verb), true, verb);
    for (const verb of [
      "git-push",
      "gh-pr-merge",
      "gh-release-create",
      "gh-release-edit",
      "gh-release-upload",
      "gh-repo-create",
      "gh-repo-edit",
      "gh-gist-create",
      "gh-workflow-run",
      "gh-api-mutating",
      "npm-publish",
    ] as const) {
      assert.equal(admit("upstream-org", "lib", verb), false, verb);
    }
  });

  it("upstream matching is exact: no wildcard, no other repo, no prefix", () => {
    assert.equal(admit("upstream-org", "other", "gh-pr-create"), false);
    assert.equal(admit("upstream-org", "*", "gh-pr-create"), false);
    assert.equal(admit("upstream-org", "lib-extra", "gh-pr-create"), false);
    assert.equal(admit("upstream-org", "li", "gh-pr-create"), false);
    assert.equal(admit("UPSTREAM-ORG", "LIB", "gh-pr-create"), true);
  });

  it("an absent allowedUpstreams admits no upstream", () => {
    const bare = { ...REG, allowedUpstreams: undefined } as Registry;
    assert.equal(ownerAdmitted({ org: "upstream-org", repo: "lib" }, { verb: "gh-pr-create" }, owners, bare), false);
  });
});
