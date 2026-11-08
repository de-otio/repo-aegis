// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// N8 (doc/plan-owner-identity.md §13.2): a recognised `dot gh` call whose literal owner has an identity mapped
// in the registry is DOT_GH_OWNER_MAPPED, decided before D2 (DOT_GH_WRITE_NEEDS_BOT). Unmapped owners keep the
// earlier behaviour. Fixture (placeholders): `mapped-org` has an identity entry, `o` is registered without one.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { intentRepoTargets, parseEgressIntents } from "./egress-intent.js";
import {
  decideEgress,
  SHAPE_RULE_CODES,
  type DecideEgressOptions,
  type Destination,
  type DestinationResolver,
} from "./egress-policy.js";
import type { Registry } from "./registry.js";
import type { TrustBoundary } from "./trust-boundary.js";

const IDENTITY_MAP = new Map([
  ["mapped-org", { agent: { kind: "github-app", app: "example-bot", name: "work-bot" } }],
  ["person-org", { person: { kind: "gh-login", login: "alice", name: "me" } }],
]);

const REGISTRY = {
  engagements: [],
  alwaysBlock: [],
  personalOrgs: ["o", "mapped-org", "person-org"],
  allowedUpstreams: [],
  schemaVersion: 3,
  identityMap: IDENTITY_MAP,
} as unknown as Registry;

const V2_REGISTRY = { ...REGISTRY, schemaVersion: 2, identityMap: undefined } as unknown as Registry;

function destOf(org: string, repo: string): Destination {
  return { org, repo, class: "private-strict", visibility: "private", publicFacing: false, classKnown: true };
}

const resolveDestination: DestinationResolver = intent => {
  const t = intentRepoTargets(intent)[0];
  return t === undefined ? destOf("o", "r") : destOf(t.org, t.repo ?? "*");
};

function decide(command: string, over: Partial<DecideEgressOptions> = {}) {
  return decideEgress({
    intents: parseEgressIntents(command),
    cwd: "/work/svc",
    registry: REGISTRY,
    registryState: "loaded",
    humanPresent: false,
    capabilities: { ask: true },
    resolveDestination,
    scanPayload: () => 0,
    trustBoundaryOf: (): TrustBoundary => ({ orgs: new Set(["o", "mapped-org", "person-org"]), fromRemoteFallback: false, class: "private-strict", classExplicit: false }),
    findApproval: () => null,
    lookupVisibility: () => null,
    ...over,
  });
}

function code(d: ReturnType<typeof decide>): string | undefined {
  return d.action === "allow" ? undefined : d.code;
}

const BODY = "--title t --body-file /s/b.md";

describe("N8: dot gh on a mapped owner is DOT_GH_OWNER_MAPPED", () => {
  const MAPPED_WRITES = [
    `dot gh --as bot pr create --repo mapped-org/r ${BODY}`,
    `dot gh --as bot pr create --repo=mapped-org/r ${BODY}`,
    `dot gh --as bot pr create -R mapped-org/r ${BODY}`,
    `dot gh --as bot pr create ${BODY} --repo mapped-org/r`,
    `dot gh pr create --repo mapped-org/r ${BODY}`,
    `dot gh --as owner pr create --repo mapped-org/r ${BODY}`,
    `dot gh --as bot pr create --repo Mapped-Org/r ${BODY}`,
    `dot gh --as bot pr comment https://github.com/mapped-org/r/pull/1 --body-file /s/b.md`,
    `dot gh --as bot api -X POST repos/mapped-org/r/issues -f title=t`,
    `node /p/scripts/dot.mjs gh --as bot pr create --repo mapped-org/r ${BODY}`,
    `/usr/local/bin/node /p/scripts/dot.mjs gh --as=bot pr create --repo mapped-org/r ${BODY}`,
    `dot gh --as bot pr create --repo person-org/r ${BODY}`,
  ];

  it("refuses a mapped owner named literally, in every spelling", () => {
    for (const c of MAPPED_WRITES) assert.equal(code(decide(c)), "DOT_GH_OWNER_MAPPED", c);
  });

  it("is decided before D2: a mapped owner with no --as is OWNER_MAPPED, not NEEDS_BOT", () => {
    assert.equal(code(decide(`dot gh pr create --repo mapped-org/r ${BODY}`)), "DOT_GH_OWNER_MAPPED");
    assert.equal(code(decide(`dot gh --as owner pr create --repo mapped-org/r ${BODY}`)), "DOT_GH_OWNER_MAPPED");
  });

  it("is not lifted by a person present or by an approval", () => {
    const c = `dot gh --as bot pr create --repo mapped-org/r ${BODY}`;
    assert.equal(code(decide(c, { humanPresent: true })), "DOT_GH_OWNER_MAPPED");
    const approval = { id: "a1", org: "mapped-org", repo: "r", expiresAt: "2999-01-01T00:00:00Z" } as unknown as ReturnType<NonNullable<DecideEgressOptions["findApproval"]>>;
    assert.equal(code(decide(c, { findApproval: () => approval })), "DOT_GH_OWNER_MAPPED");
  });

  it("names the plain gh fix and echoes neither the owner nor the arguments", () => {
    const d = decide(`dot gh --as bot pr create --repo mapped-org/r ${BODY}`);
    assert.ok(d.action === "deny");
    assert.match(d.reason, /gh <the same arguments>/);
    assert.match(d.reason, /\[DOT_GH_OWNER_MAPPED, see doc\/agent-guide\.md#dot_gh_owner_mapped\]/);
    assert.ok(!d.reason.includes("mapped-org"));
    assert.ok(!d.reason.includes("b.md"));
    assert.ok(SHAPE_RULE_CODES.has("DOT_GH_OWNER_MAPPED"));
  });

  it("keeps the earlier behaviour for an unmapped owner", () => {
    assert.deepEqual(decide(`dot gh --as bot pr create --repo o/r ${BODY}`), { action: "allow" });
    assert.equal(code(decide(`dot gh pr create --repo o/r ${BODY}`)), "DOT_GH_WRITE_NEEDS_BOT");
    assert.equal(code(decide(`dot gh --as owner pr create --repo o/r ${BODY}`)), "DOT_GH_WRITE_NEEDS_BOT");
    assert.deepEqual(decide(`dot gh --as owner pr create --repo o/r ${BODY}`, { humanPresent: true }), { action: "allow" });
  });

  it("keeps the earlier behaviour with no identity map at all (a v2 registry)", () => {
    assert.deepEqual(decide(`dot gh --as bot pr create --repo mapped-org/r ${BODY}`, { registry: V2_REGISTRY }), { action: "allow" });
    assert.equal(code(decide(`dot gh pr create --repo mapped-org/r ${BODY}`, { registry: V2_REGISTRY })), "DOT_GH_WRITE_NEEDS_BOT");
  });

  it("does not touch plain gh on a mapped owner", () => {
    assert.deepEqual(decide(`gh pr create --repo mapped-org/r ${BODY}`), { action: "allow" });
  });

  it("does not fire for a dot gh call that names no mapped owner literally", () => {
    // no literal owner: the cwd decides, which this rule does not read (D10 judges the missing target)
    assert.equal(code(decide(`dot gh --as bot pr create ${BODY}`)), "GH_PR_CREATE_IMPLICIT_TARGET");
    // `--explain` runs no gh
    assert.deepEqual(decide(`dot gh --explain --repo mapped-org/r pr create ${BODY}`), { action: "allow" });
  });
});
