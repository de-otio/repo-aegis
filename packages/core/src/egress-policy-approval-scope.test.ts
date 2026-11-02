// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Approval scoping at rule g (issue #151, decision D7;
// doc/plan-unregistered-owner-egress.md §3.2, §3.9, §5.1, §5.4).
//
// A `*` approval is no longer a global wildcard: it covers a destination only
// when the owner is in `personalOrgs`, or when the call has no repository
// destination at all (`npm publish`). Every test here drives the REAL approval
// finder over a REAL approvals file, so each one fails if `*` were still a
// global wildcard.
//
// Fixture (placeholders only): personal org `acme`, engagement `customer-a`
// owning `customer-a-org`, allowed upstream `upstream-org/lib`; `stranger` is
// registered nowhere.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { UNKNOWN_VISIBILITY_HINT } from "./visibility-lookup.js";
import { parseEgressIntents } from "./egress-intent.js";
import {
  decideEgress,
  findApprovalDefault,
  type DecideEgressOptions,
  type Destination,
  type EgressDecision,
} from "./egress-policy.js";
import { mintApproval } from "./egress-approval.js";
import type { Registry } from "./registry.js";
import type { TrustBoundary } from "./trust-boundary.js";

const REGISTRY: Registry = {
  engagements: [
    { id: "eng-zeta", name: "Zeta Engagement", started: "2026-01-01", markers: [], githubOrgs: ["customer-a-org"] },
  ],
  alwaysBlock: [],
  personalOrgs: ["acme"],
  allowedUpstreams: ["upstream-org/lib"],
  schemaVersion: 2,
} as unknown as Registry;

const NO_OWNERS: Registry = { engagements: [], alwaysBlock: [], personalOrgs: [], schemaVersion: 2 };

function publicDest(org: string, repo: string): Destination {
  return {
    org,
    repo,
    class: "public-eligible",
    visibility: "public",
    publicFacing: true,
    classKnown: true,
  };
}

function boundary(orgs: string[]): TrustBoundary {
  return { orgs: new Set(orgs), fromRemoteFallback: false, class: "private-strict", classExplicit: false };
}

function withHome<T>(fn: () => T): T {
  const home = mkdtempSync(join(tmpdir(), "egress-approval-scope-"));
  const prior = process.env["REPO_AEGIS_HOME"];
  process.env["REPO_AEGIS_HOME"] = home;
  try {
    return fn();
  } finally {
    if (prior === undefined) delete process.env["REPO_AEGIS_HOME"];
    else process.env["REPO_AEGIS_HOME"] = prior;
    rmSync(home, { recursive: true, force: true });
  }
}

function decide(command: string, destination: Destination | null, over: Partial<DecideEgressOptions> = {}): EgressDecision {
  return decideEgress({
    intents: parseEgressIntents(command),
    cwd: "/work/svc",
    registry: REGISTRY,
    registryState: "loaded",
    humanPresent: false,
    capabilities: { ask: true },
    resolveDestination: () => destination,
    scanPayload: () => 0,
    trustBoundaryOf: () => boundary(["acme", "customer-a-org", "upstream-org", "stranger"]),
    findApproval: findApprovalDefault,
    lookupVisibility: () => "public",
    ...over,
  });
}

type Form = readonly [org: string, repo: string];

function assertCovered(d: EgressDecision, label: string): void {
  assert.equal(d.action, "allow", `${label}: ${JSON.stringify(d)}`);
  assert.ok(d.action === "allow" && d.approval !== undefined, `${label}: allowed by an approval`);
}

function assertNeedsHuman(d: EgressDecision, label: string): string {
  assert.ok(d.action === "ask" || d.action === "deny", `${label}: ${JSON.stringify(d)}`);
  assert.equal(d.code, "PUBLIC_EGRESS_NEEDS_HUMAN", label);
  return d.reason;
}

describe("approval scoping at rule g (D7): approval form × owner kind", () => {
  // [form minted, covers personal, covers customer, covers upstream]
  const CASES: Array<[form: Form, personal: boolean, customer: boolean, upstream: boolean]> = [
    [["*", "*"], true, false, false],
    [["acme", "*"], true, false, false],
    [["acme", "repo"], true, false, false],
    [["customer-a-org", "*"], false, true, false],
    [["customer-a-org", "repo"], false, true, false],
    [["upstream-org", "*"], false, false, true],
    [["upstream-org", "lib"], false, false, true],
  ];

  it("a minted approval covers exactly the owners its form names; `*` only the personal org", () => {
    for (const [[org, repo], personal, customer, upstream] of CASES) {
      withHome(() => {
        mintApproval({ target: { org, repo } });
        const form = `${org}/${repo}`;
        const personalD = decide("gh issue create --repo acme/repo --body x", publicDest("acme", "repo"));
        const customerD = decide("gh issue create --repo customer-a-org/repo --body x", publicDest("customer-a-org", "repo"));
        const upstreamD = decide("gh pr create --repo upstream-org/lib --body x", publicDest("upstream-org", "lib"));
        for (const [d, covered, kind] of [
          [personalD, personal, "personal"],
          [customerD, customer, "customer"],
          [upstreamD, upstream, "upstream"],
        ] as const) {
          if (covered) assertCovered(d, `${form} vs ${kind}`);
          else assertNeedsHuman(d, `${form} vs ${kind}`);
        }
      });
    }
  });

  it("`*` against a customer's PUBLIC repo asks: it is no longer a global wildcard", () => {
    withHome(() => {
      mintApproval({ target: { org: "*", repo: "*" } });
      const d = decide("gh issue create --repo customer-a-org/repo --body x", publicDest("customer-a-org", "repo"));
      assert.equal(d.action, "ask");
    });
  });

  it("`*` against an allowed upstream asks; the upstream needs <owner>/<repo> or <owner>/*", () => {
    withHome(() => {
      mintApproval({ target: { org: "*", repo: "*" } });
      const cmd = "gh pr create --repo upstream-org/lib --body x";
      assert.equal(decide(cmd, publicDest("upstream-org", "lib")).action, "ask");
      mintApproval({ target: { org: "upstream-org", repo: "lib" } });
      assertCovered(decide(cmd, publicDest("upstream-org", "lib")), "upstream-org/lib");
    });
  });

  it("an upstream repo inside a personal org is still not covered by `*`", () => {
    withHome(() => {
      mintApproval({ target: { org: "*", repo: "*" } });
      const registry = { ...REGISTRY, allowedUpstreams: ["acme/forked-lib"] } as Registry;
      const cmd = "gh pr create --repo acme/forked-lib --body x";
      assert.equal(decide(cmd, publicDest("acme", "forked-lib"), { registry }).action, "ask");
      assertCovered(decide("gh pr create --repo acme/other --body x", publicDest("acme", "other"), { registry }), "acme/other");
    });
  });

  it("`*` covers git push to a personal org's public repo, and not a customer's", () => {
    withHome(() => {
      mintApproval({ target: { org: "*", repo: "*" } });
      assertCovered(decide("git push origin main", publicDest("acme", "repo")), "personal");
      assert.equal(decide("git push origin main", publicDest("customer-a-org", "repo")).action, "ask");
    });
  });

  it("an unregistered owner: rule h refuses whatever approval exists; with rule h inert `*` still does not cover it", () => {
    withHome(() => {
      mintApproval({ target: { org: "*", repo: "*" } });
      mintApproval({ target: { org: "stranger", repo: "*" } });
      const cmd = "gh issue create --repo stranger/repo --body x";
      const refused = decide(cmd, publicDest("stranger", "repo"));
      assert.equal(refused.action === "deny" && refused.code, "UNREGISTERED_OWNER_EGRESS");
    });
    // Rule h skipped (no registry file): the approval matcher alone decides.
    withHome(() => {
      mintApproval({ target: { org: "*", repo: "*" } });
      const cmd = "gh issue create --repo stranger/repo --body x";
      const opts = { registry: NO_OWNERS, registryState: "missing" as const };
      assert.equal(decide(cmd, publicDest("stranger", "repo"), opts).action, "ask");
      mintApproval({ target: { org: "stranger", repo: "*" } });
      assertCovered(decide(cmd, publicDest("stranger", "repo"), opts), "stranger/*");
    });
  });
});

describe("approval scoping: destination-less verbs (npm publish)", () => {
  it("`*` covers npm publish, an <org>/* approval does not, and no approval asks", () => {
    withHome(() => {
      assert.equal(decide("npm publish", null).action, "ask");
      mintApproval({ target: { org: "acme", repo: "*" } });
      assert.equal(decide("npm publish", null).action, "ask");
      mintApproval({ target: { org: "*", repo: "*" } });
      assertCovered(decide("npm publish", null), "*");
    });
  });

  it("`*` covers npm publish even when the registry declares no personal orgs or no registry exists", () => {
    withHome(() => {
      mintApproval({ target: { org: "*", repo: "*" } });
      assertCovered(decide("npm publish", null, { registry: NO_OWNERS, registryState: "loaded" }), "no owners");
      assertCovered(decide("npm publish", null, { registry: NO_OWNERS, registryState: "missing" }), "missing");
    });
  });

  it("a null destination on a verb that is not npm publish is NOT destination-less", () => {
    withHome(() => {
      mintApproval({ target: { org: "*", repo: "*" } });
      // `gh repo create` is irreversible; with no resolvable destination, `*` must not cover it.
      assert.equal(decide("gh repo create acme/new --public", null).action, "ask");
    });
  });
});

describe("approval scoping: `*` against a GraphQL mutation", () => {
  const ENQ =
    "gh api graphql -F id=PR_kwDOAAAAAA -f query='mutation($id: ID!) { enqueuePullRequest(input: {pullRequestId: $id}) { clientMutationId } }'";
  const unresolved: Destination = {
    org: "*",
    repo: "*",
    class: "private-strict",
    visibility: "unknown",
    publicFacing: true,
    classKnown: false,
    assumedPublic: true,
    unresolved: "graphql-mutation",
  };

  it("under a loaded registry rule h refuses it before rule g, with `*` live", () => {
    withHome(() => {
      mintApproval({ target: { org: "*", repo: "*" } });
      const d = decide(ENQ, unresolved);
      assert.equal(d.action === "deny" && d.code, "UNREGISTERED_OWNER_EGRESS");
    });
  });

  it("the matcher does not rely on that ordering: with rule h inert, `*` still does not cover the `*`/`*` sentinel", () => {
    withHome(() => {
      mintApproval({ target: { org: "*", repo: "*" } });
      for (const registryState of ["missing", "loaded"] as const) {
        const d = decide(ENQ, unresolved, { registry: NO_OWNERS, registryState });
        assert.equal(d.action, "ask", registryState);
        assert.equal(d.action === "ask" && d.code, "PUBLIC_EGRESS_NEEDS_HUMAN");
        // No approve command that would not work is offered for an unresolved target.
        assert.ok(!(d.action === "ask" && /approve '\*'/.test(d.reason)), d.action === "ask" ? d.reason : "");
      }
    });
  });
});

describe("approval scoping: refusal text when a `*` approval does not cover (§3.9, §5.4)", () => {
  // The engagement id and name are deliberately NOT substrings of any org name
  // in play, so a bare-id leak cannot hide inside the destination's own name.
  const FORBIDDEN = ["acme", "eng-zeta", "Zeta Engagement", "upstream-org", "stranger", "payload-sentinel-xyz"];

  it("keeps the existing message and ADDS the `*` sentence: id, why, narrower quoted commands", () => {
    withHome(() => {
      const star = mintApproval({ target: { org: "*", repo: "*" } });
      const reason = assertNeedsHuman(
        decide("gh issue create --repo customer-a-org/repo --body x", publicDest("customer-a-org", "repo")),
        "customer",
      );
      // Every clause of the pre-existing ask text is still there.
      assert.ok(reason.startsWith("gh issue create: PUBLIC destination — customer-a-org/repo (public, public-eligible)"), reason);
      assert.match(reason, /\(from --repo\), from a non-interactive shell\. A person must approve this/);
      assert.ok(reason.includes("or mint an approval first: `repo-aegis approve customer-a-org/repo` from a terminal."), reason);
      // The added sentence.
      assert.ok(reason.includes(`A '*' approval (${star.id}, until ${star.expiresAt}) is live`), reason);
      assert.match(reason, /since 0\.11\.0 '\*' covers only personal-org repositories/);
      assert.match(reason, /customer-a-org is a customer org/);
      assert.ok(reason.includes("`repo-aegis approve 'customer-a-org/*'` (the whole org)"), reason);
      assert.ok(reason.includes("`repo-aegis approve customer-a-org/repo` (this repository only)"), reason);
      assert.match(reason, /A person runs, from a terminal/);
    });
  });

  it("works for the ask and the deny (no-ask host) shapes alike, keeping the human escape text on deny", () => {
    withHome(() => {
      mintApproval({ target: { org: "*", repo: "*" } });
      for (const ask of [true, false]) {
        const d = decide("git push origin main", publicDest("customer-a-org", "repo"), { capabilities: { ask } });
        assert.equal(d.action, ask ? "ask" : "deny");
        const reason = assertNeedsHuman(d, `ask=${ask}`);
        assert.ok(reason.includes("`repo-aegis approve 'customer-a-org/*'`"), reason);
        if (!ask) {
          assert.match(reason, /re-run it from a terminal, mint an approval first/);
          assert.match(reason, /or a human sets REPO_AEGIS_EGRESS_HUMAN=1 for this one invocation \(an agent never sets it\)/);
        }
      }
    });
  });

  it("keeps the visibility wording: an uncached destination is still `assumed public`, with the hint after the gap sentence", () => {
    withHome(() => {
      mintApproval({ target: { org: "*", repo: "*" } });
      const uncached: Destination = {
        ...publicDest("customer-a-org", "repo"),
        class: "private-strict",
        visibility: "unknown",
        classKnown: false,
        assumedPublic: true,
      };
      // The live lookup cannot answer, so the destination stays "assumed public".
      const reason = assertNeedsHuman(
        decide("gh issue create --repo customer-a-org/repo --body x", uncached, { lookupVisibility: () => null }),
        "uncached",
      );
      assert.ok(reason.includes("visibility uncached, treated as public"), reason);
      assert.ok(reason.includes(UNKNOWN_VISIBILITY_HINT), reason);
      assert.ok(reason.indexOf("is live, but since 0.11.0") < reason.indexOf(UNKNOWN_VISIBILITY_HINT), reason);
    });
  });

  it("the shim-unreachable deny also carries the sentence, and keeps its own code", () => {
    withHome(() => {
      mintApproval({ target: { org: "*", repo: "*" } });
      const d = decide("gh issue create --repo customer-a-org/repo --body x", publicDest("customer-a-org", "repo"), {
        capabilities: { ask: true, ghShimOnPath: false },
      });
      assert.equal(d.action === "deny" && d.code, "SHIM_UNREACHABLE_NEEDS_HUMAN");
      assert.ok(d.action === "deny" && d.reason.includes("'*' approval"), d.action === "deny" ? d.reason : "");
    });
  });

  it("M1: the gap lookup is behind the injection seam — an injected finder never reads the real store", () => {
    withHome(() => {
      mintApproval({ target: { org: "*", repo: "*" } }); // live `*` in the (temp) real home
      const cmd = "gh issue create --repo customer-a-org/repo --body x";
      const injected = assertNeedsHuman(decide(cmd, publicDest("customer-a-org", "repo"), { findApproval: () => null }), "injected");
      assert.ok(!injected.includes("'*' approval"), injected);
      // An injected gap finder is honoured, with no store at all.
      const star = { id: "deadbeef", org: "*", repo: "*", createdAt: "", expiresAt: "2099-01-01T00:00:00.000Z", by: "op" };
      const viaSeam = assertNeedsHuman(
        decide(cmd, publicDest("customer-a-org", "repo"), {
          findApproval: () => null,
          findUncoveredStar: () => ({ approval: star, gap: "not-personal" }),
        }),
        "seam",
      );
      assert.ok(viaSeam.includes("A '*' approval (deadbeef, until 2099-01-01T00:00:00.000Z) is live"), viaSeam);
      // A throwing gap finder degrades to the plain message, never to an allow.
      const thrown = decide(cmd, publicDest("customer-a-org", "repo"), {
        findApproval: () => null,
        findUncoveredStar: () => {
          throw new Error("boom");
        },
      });
      assert.equal(thrown.action, "ask");
    });
  });

  it("an upstream is named as an allowed upstream, not as a customer", () => {
    withHome(() => {
      mintApproval({ target: { org: "*", repo: "*" } });
      const reason = assertNeedsHuman(
        decide("gh pr create --repo upstream-org/lib --body x", publicDest("upstream-org", "lib")),
        "upstream",
      );
      assert.match(reason, /upstream-org\/lib is an allowed upstream/);
      assert.ok(reason.includes("repo-aegis approve 'upstream-org/*'"), reason);
    });
  });

  it("says nothing about a `*` approval when there is none, and the old message is byte-for-byte unchanged", () => {
    withHome(() => {
      const reason = assertNeedsHuman(
        decide("gh issue create --repo customer-a-org/repo --body x", publicDest("customer-a-org", "repo")),
        "no approval",
      );
      assert.ok(!reason.includes("'*' approval"), reason);
      assert.ok(reason.includes("repo-aegis approve customer-a-org/repo"), reason);
      assert.equal(
        reason,
        "gh issue create: PUBLIC destination — customer-a-org/repo (public, public-eligible) (from --repo), " +
          "from a non-interactive shell. A person must approve this, or mint an approval first: " +
          "`repo-aegis approve customer-a-org/repo` from a terminal.",
      );
    });
  });

  it("redaction oracle: no other owner, engagement id or registry content is printed", () => {
    withHome(() => {
      mintApproval({ target: { org: "*", repo: "*" } });
      const reason = assertNeedsHuman(
        decide("gh issue create --repo customer-a-org/repo --body x", publicDest("customer-a-org", "repo")),
        "oracle",
      );
      for (const bad of FORBIDDEN) assert.ok(!reason.includes(bad), `${JSON.stringify(bad)} leaked into: ${reason}`);
      // The bare engagement id appears nowhere, and the fixture proves the id is not hiding in a name.
      assert.ok(!reason.includes("eng-zeta"), reason);
      assert.ok(!"customer-a-org".includes("eng-zeta"));
    });
  });

  it("a destination whose name is not a plausible GitHub owner/repo gets no approve command at all", () => {
    withHome(() => {
      mintApproval({ target: { org: "*", repo: "*" } });
      const reason = assertNeedsHuman(
        // Rule h inert, so the destination reaches rule g.
        decide("gh issue create --repo x --body y", publicDest("evil$(touch x)", "repo"), {
          registry: NO_OWNERS,
          registryState: "missing",
        }),
        "invalid name",
      );
      assert.ok(!reason.includes("evil"), reason);
      assert.ok(!reason.includes("repo-aegis approve"), reason);
    });
  });
});

describe("approval scoping: owner names are tested as typed, before lower-casing (L1)", () => {
  it("`Korp` spelled with U+212A (KELVIN SIGN) is not covered by `*` for a personal org `korp`, nor by `korp/*`", () => {
    const kelvin = "Korp";
    assert.equal(kelvin.toLowerCase(), "korp", "the premise: lower-casing maps it onto a plain k");
    const registry = { ...REGISTRY, personalOrgs: ["korp"] } as Registry;
    withHome(() => {
      mintApproval({ target: { org: "*", repo: "*" } });
      mintApproval({ target: { org: "korp", repo: "*" } });
      // Control: the plain spelling IS covered.
      assertCovered(decide("gh issue create --repo korp/r --body x", publicDest("korp", "r"), { registry }), "korp");
      // Rule h inert, so the destination reaches rule g and the matcher alone decides.
      const d = decide("gh issue create --repo x/r --body x", publicDest(kelvin, "r"), {
        registry: NO_OWNERS,
        registryState: "missing",
      });
      assert.notEqual(d.action, "allow", JSON.stringify(d));
    });
  });
});

describe("approval scoping: gh gist create (§3.3 item 9)", () => {
  // A gist belongs to the authenticated account, not to the cwd's origin, so a
  // personal `*` approval must never cover a public paste. Today the resolver
  // attributes it to the cwd's origin (`acme/svc`, a personal org) and `*`
  // covers it. Fixed by PR 2c (resolver hardening); this pins the target.
  it(
    "is not covered by `*` from a personal checkout",
    { todo: "fails until PR 2c lands (plan §3.3 item 9: a gist is attributed to the account, not the cwd)" },
    () => {
      const repo = mkdtempSync(join(tmpdir(), "egress-gist-"));
      try {
        execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
        execFileSync("git", ["config", "remote.origin.url", "git@github.com:acme/svc.git"], { cwd: repo });
        execFileSync("git", ["config", "repo-aegis.class", "public-eligible"], { cwd: repo });
        execFileSync("git", ["config", "repo-aegis.visibility", "public"], { cwd: repo });
        withHome(() => {
          mintApproval({ target: { org: "*", repo: "*" } });
          const d = decideEgress({
            intents: parseEgressIntents("gh gist create --public"),
            cwd: repo,
            registry: REGISTRY,
            registryState: "loaded",
            humanPresent: false,
            capabilities: { ask: true },
            findApproval: findApprovalDefault,
            lookupVisibility: () => "public",
            scanPayload: () => 0,
            trustBoundaryOf: () => boundary(["acme"]),
          });
          assert.notEqual(d.action, "allow", "a `*` approval must not cover a public gist");
        });
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    },
  );
});
