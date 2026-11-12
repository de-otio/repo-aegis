// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyOwner, type OwnerRegistry } from "./owner-class.js";

const eng = (id: string, githubOrgs: string[]) => ({ id, name: id, started: "2026-01-01", markers: [], githubOrgs });

const REGISTRY = {
  engagements: [eng("eng-a", ["org-a", "org-a-labs"]), eng("eng-b", ["org-b", "shared-org"]), eng("eng-c", ["shared-org"])],
  personalOrgs: ["mine"],
} as unknown as OwnerRegistry;

describe("classifyOwner", () => {
  const CASES: Array<[string, ReturnType<typeof classifyOwner>]> = [
    ["org-a", { kind: "engagement", id: "eng-a" }],
    ["org-a-labs", { kind: "engagement", id: "eng-a" }],
    ["ORG-A", { kind: "engagement", id: "eng-a" }],
    ["Org-B", { kind: "engagement", id: "eng-b" }],
    ["mine", { kind: "personal" }],
    ["MINE", { kind: "personal" }],
    ["shared-org", { kind: "ambiguous", ids: ["eng-b", "eng-c"] }],
    ["stranger", { kind: "unknown" }],
    ["", { kind: "unknown" }],
  ];
  for (const [owner, expected] of CASES) {
    it(`${JSON.stringify(owner)} → ${expected.kind}`, () => {
      assert.deepEqual(classifyOwner(owner, REGISTRY), expected);
    });
  }

  it("an owner in personalOrgs and an engagement is ambiguous (the registry schema forbids it, a hand edit may not)", () => {
    const r = { engagements: [eng("eng-a", ["both"])], personalOrgs: ["both"] } as unknown as OwnerRegistry;
    assert.deepEqual(classifyOwner("both", r), { kind: "ambiguous", ids: ["eng-a"] });
  });

  it("a registry with no personalOrgs or githubOrgs is all unknown", () => {
    const r = { engagements: [{ id: "x", name: "x", started: "2026-01-01", markers: [] }] } as unknown as OwnerRegistry;
    assert.deepEqual(classifyOwner("org-a", r), { kind: "unknown" });
  });
});
