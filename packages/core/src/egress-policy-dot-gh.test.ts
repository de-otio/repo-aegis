// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// D2 and the decision for a recognised `dot gh` call (doc/plan-recognise-dot-gh.md §3.2, §3.3, §4).
//
// Fixture (placeholders): `o` is a registered private owner, `pub` a registered public one, `stranger`
// is registered nowhere. "Agent" means no person present. The resolver mimics the offline one for what
// matters here: an intent whose destination cannot be named gets the unresolved `*`/`*` destination.
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

const REGISTRY: Registry = {
  engagements: [],
  alwaysBlock: [],
  personalOrgs: ["o", "pub"],
  allowedUpstreams: [],
  schemaVersion: 2,
} as unknown as Registry;

const NODE_DOT = "node /p/scripts/dot.mjs gh";
const CREATE = "pr create --repo o/r --title t --body-file /s/b.md";

function destOf(org: string, repo: string): Destination {
  const isPublic = org === "pub";
  return {
    org,
    repo,
    class: isPublic ? "public-eligible" : "private-strict",
    visibility: isPublic ? "public" : "private",
    publicFacing: isPublic,
    classKnown: true,
  };
}

const resolveDestination: DestinationResolver = intent => {
  if (intent.unresolved !== undefined) {
    return {
      org: "*",
      repo: "*",
      class: "private-strict",
      visibility: "unknown",
      publicFacing: true,
      classKnown: false,
      assumedPublic: true,
      unresolved: intent.unresolved,
    };
  }
  const t = intentRepoTargets(intent)[0];
  if (t === undefined) return destOf("o", "r");
  const dest = destOf(t.org, t.repo ?? "*");
  return t.org === "stranger" ? { ...dest, visibility: "unknown", publicFacing: true, classKnown: false, assumedPublic: true } : dest;
};

function boundary(orgs: string[]): TrustBoundary {
  return { orgs: new Set(orgs), fromRemoteFallback: false, class: "private-strict", classExplicit: false };
}

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
    trustBoundaryOf: () => boundary(["o"]),
    findApproval: () => null,
    lookupVisibility: () => null,
    ...over,
  });
}

/** The decision as a comparable value: the action, its code, its reason. */
function outcome(d: ReturnType<typeof decide>): { action: string; code?: string; reason?: string } {
  return d.action === "allow" ? { action: "allow" } : { action: d.action, code: d.code, reason: d.reason };
}

function code(d: ReturnType<typeof decide>): string | undefined {
  return d.action === "allow" ? undefined : d.code;
}

describe("dot gh — a write with no person present needs --as bot (D2)", () => {
  it("T1: node <path>/dot.mjs gh --as bot pr create is allowed (was: refused as an unparsed shape)", () => {
    assert.deepEqual(decide(`${NODE_DOT} --as bot ${CREATE}`), { action: "allow" });
  });

  it("T2: the same without --as is DOT_GH_WRITE_NEEDS_BOT (was: UNREGISTERED_OWNER_EGRESS, which names no fix)", () => {
    const d = decide(`${NODE_DOT} ${CREATE}`);
    assert.equal(d.action, "deny");
    assert.equal(code(d), "DOT_GH_WRITE_NEEDS_BOT");
  });

  it("T3: --as owner and --as work are refused the same way", () => {
    for (const as of ["owner", "work"]) {
      assert.equal(code(decide(`${NODE_DOT} --as ${as} ${CREATE}`)), "DOT_GH_WRITE_NEEDS_BOT", as);
    }
  });

  it("T4: --as=bot is allowed", () => {
    assert.deepEqual(decide(`${NODE_DOT} --as=bot ${CREATE}`), { action: "allow" });
  });

  it("T5: --as after a gh word is gh's own, so the write has no bot", () => {
    assert.equal(code(decide("dot gh pr create --as bot --repo o/r --title t --body-file /s/b.md")), "DOT_GH_WRITE_NEEDS_BOT");
  });

  it("T6: the bare word dot is allowed with --as bot, refused without", () => {
    assert.deepEqual(decide(`dot gh --as bot ${CREATE}`), { action: "allow" });
    assert.equal(code(decide(`dot gh ${CREATE}`)), "DOT_GH_WRITE_NEEDS_BOT");
  });

  it("T7: reads are allowed with any identity or none", () => {
    assert.deepEqual(decide("dot gh --repo o/r pr view 1"), { action: "allow" });
    assert.deepEqual(decide("dot gh --as owner api repos/o/r"), { action: "allow" });
  });

  it("T12: --explain is allowed whatever follows", () => {
    assert.deepEqual(decide(`dot gh --explain --repo o/r pr create --title t`), { action: "allow" });
  });

  it("dot gh's own malformed options run no gh, so they are allowed", () => {
    assert.deepEqual(decide(`dot gh --as= ${CREATE}`), { action: "allow" });
    assert.deepEqual(decide(`dot gh --as --explain ${CREATE}`), { action: "allow" });
  });

  it("T13: with a person present, --as owner is judged as plain gh and allowed", () => {
    assert.deepEqual(decide(`dot gh --as owner ${CREATE}`, { humanPresent: true }), { action: "allow" });
    assert.deepEqual(decide(`dot gh ${CREATE}`, { humanPresent: true }), { action: "allow" });
  });

  it("a write is any intent the remainder yields, resolved or not: an unknown shape needs --as bot too", () => {
    const cmd = "project item-add 1 --owner o --repo o/r";
    const owner = decide(`dot gh --as owner ${cmd}`);
    assert.equal(code(owner), "DOT_GH_WRITE_NEEDS_BOT");
    const bot = decide(`dot gh --as bot ${cmd}`);
    // With --as bot it is the plain gh decision for the same call.
    assert.deepEqual(outcome(bot), outcome(decide(`gh ${cmd}`)));
    assert.equal(code(bot), "UNREGISTERED_OWNER_EGRESS");
  });

  it("D2 comes before the shape rules: after a cd and with no --as it is DOT_GH_WRITE_NEEDS_BOT", () => {
    assert.equal(code(decide(`cd /x && dot gh ${CREATE}`)), "DOT_GH_WRITE_NEEDS_BOT");
  });

  it("an agent's other dot gh write verbs are refused without the bot", () => {
    for (const cmd of [
      "pr comment 12 --repo o/r --body-file /s/b.md",
      "issue create --repo o/r --title t --body-file /s/b.md",
      "api -X POST repos/o/r/pulls/12/requested_reviewers -f reviewers[]=x",
      "api repos/o/r/issues -f title=t",
    ]) {
      assert.equal(code(decide(`dot gh ${cmd}`)), "DOT_GH_WRITE_NEEDS_BOT", cmd);
      assert.deepEqual(decide(`dot gh --as bot ${cmd}`), { action: "allow" }, cmd);
    }
  });

  it("DOT_GH_WRITE_NEEDS_BOT is a shape rule: no rule h standing is attached to it", () => {
    assert.ok(SHAPE_RULE_CODES.has("DOT_GH_WRITE_NEEDS_BOT"));
  });
});

describe("dot gh --as bot — everything else is judged as for plain gh (§3.2 step 3)", () => {
  it("T8: a public registered owner still needs a person", () => {
    const cmd = "pr create --repo pub/r --title t --body-file /s/b.md";
    const d = decide(`dot gh --as bot ${cmd}`);
    assert.equal(code(d), "PUBLIC_EGRESS_NEEDS_HUMAN");
    assert.deepEqual(outcome(d), outcome(decide(`gh ${cmd}`)));
  });

  it("T9: an unregistered owner is still refused", () => {
    const cmd = "pr create --repo stranger/r --title t --body-file /s/b.md";
    const d = decide(`dot gh --as bot ${cmd}`);
    assert.equal(code(d), "UNREGISTERED_OWNER_EGRESS");
    assert.deepEqual(outcome(d), outcome(decide(`gh ${cmd}`)));
  });

  it("T10: pr merge is the plain gh decision for pr merge", () => {
    const d = decide("dot gh --as bot pr merge 3 --repo o/r");
    assert.deepEqual(outcome(d), outcome(decide("gh pr merge 3 --repo o/r")));
    assert.equal(code(d), "PUBLIC_EGRESS_NEEDS_HUMAN");
  });

  it("T14: after a cd it is refused by rule b, as a plain gh is", () => {
    const d = decide(`cd /x && ${NODE_DOT} --as bot ${CREATE}`);
    assert.equal(code(d), "EGRESS_AFTER_CD");
    assert.equal(code(decide(`cd /x && gh ${CREATE}`)), "EGRESS_AFTER_CD");
  });

  it("a marker in the payload is refused as for plain gh (rule f)", () => {
    const scanPayload = () => 2;
    const d = decide(`${NODE_DOT} --as bot ${CREATE}`, { scanPayload });
    assert.equal(code(d), "PAYLOAD_MARKER_HIT");
    assert.deepEqual(outcome(d), outcome(decide(`gh ${CREATE}`, { scanPayload })));
  });

  it("an environment override on the segment is refused as for plain gh (shape rule b')", () => {
    assert.equal(code(decide(`HOME=/x ${NODE_DOT} --as bot ${CREATE}`)), "EGRESS_ENV_OVERRIDE");
  });

  it("GH_REPO in the prefix names the target of the remainder, as for plain gh (was: implicit target)", () => {
    const cmd = "pr create --title t --body-file /s/b.md";
    assert.deepEqual(decide(`GH_REPO=o/r dot gh --as bot ${cmd}`), { action: "allow" });
    assert.equal(code(decide(`dot gh --as bot ${cmd}`)), "GH_PR_CREATE_IMPLICIT_TARGET");
  });
});

describe("dot gh — any other wrapper shape stays refused (D5)", () => {
  it("T11: node options, NODE_OPTIONS, another script, a script in a variable", () => {
    for (const cmd of [
      `node --require x /p/dot.mjs gh --as bot ${CREATE}`,
      `NODE_OPTIONS=--require=x node /p/dot.mjs gh --as bot ${CREATE}`,
      `node /p/other.mjs gh --as bot ${CREATE}`,
      `node "$S" gh --as bot ${CREATE}`,
    ]) {
      const d = decide(cmd);
      assert.equal(d.action, "deny", cmd);
      assert.notEqual(code(d), "DOT_GH_WRITE_NEEDS_BOT", cmd);
    }
    assert.equal(code(decide(`node /p/other.mjs gh --as bot ${CREATE}`)), "UNREGISTERED_OWNER_EGRESS");
  });
});

describe("the refusal text (§3.3)", () => {
  const SECRET_TITLE = "SECRET-TITLE-XYZ";
  const d = decide(`${NODE_DOT} --as identity-x pr create --repo o/r --title ${SECRET_TITLE} --body-file /s/b.md`);
  const reason = d.action === "deny" ? d.reason : "";

  it("T15: names the corrected command literally", () => {
    assert.ok(reason.includes("dot gh --as bot <the same gh arguments>"), reason);
    assert.ok(reason.startsWith("repo-aegis: dot gh write without --as bot: refused."), reason);
    assert.ok(reason.endsWith("[DOT_GH_WRITE_NEEDS_BOT]"), reason);
  });

  it("T15: carries no gh argument, no repository and no identity from the command", () => {
    for (const leaked of [SECRET_TITLE, "b.md", "/s/", "o/r", "pr create", "identity-x", "/p/scripts"]) {
      assert.ok(!reason.includes(leaked), `${leaked} leaked into: ${reason}`);
    }
  });

  it("is the same text for every call (static)", () => {
    const other = decide("dot gh --as work issue create --repo pub/x --title other");
    assert.equal(other.action === "deny" && other.reason, reason);
  });

  it("tells the agent not to switch identity when the bot lacks a permission", () => {
    assert.ok(reason.includes("stop and report it to your human; do not switch to --as owner or plain gh"), reason);
  });
});
