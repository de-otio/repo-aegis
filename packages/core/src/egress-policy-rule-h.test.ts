// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Rule h: refuse non-interactive egress to an unregistered owner (issue #151,
// doc/plan-unregistered-owner-egress.md §3.1, §5.1, §5.4).
//
// Fixture (all names are placeholders): personal org `acme`, one engagement
// `customer-a` owning `customer-a-org`, and `upstream-org/lib` as an allowed
// upstream. `stranger` is registered nowhere.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEgressIntents } from "./egress-intent.js";
import {
  decideEgress,
  findApprovalDefault,
  type DecideEgressOptions,
  type Destination,
  type DestinationResolver,
} from "./egress-policy.js";
import { mintApproval } from "./egress-approval.js";
import type { Registry } from "./registry.js";
import type { TrustBoundary } from "./trust-boundary.js";

const H_REGISTRY: Registry = {
  engagements: [
    { id: "customer-a", name: "Customer A", started: "2026-01-01", markers: [], githubOrgs: ["customer-a-org"] },
  ],
  alwaysBlock: [],
  personalOrgs: ["acme"],
  allowedUpstreams: ["upstream-org/lib"],
  schemaVersion: 2,
} as unknown as Registry;

const EMPTY: Registry = { engagements: [], alwaysBlock: [], personalOrgs: [], schemaVersion: 2 };

const SCRATCH = "/private/tmp/claude-501/-proj/1234-abcd/scratchpad";

function dest(over: Partial<Destination> = {}): Destination {
  return {
    org: "acme",
    repo: "svc",
    class: "private-strict",
    visibility: "private",
    publicFacing: false,
    classKnown: true,
    ...over,
  };
}

/** A destination this machine knows nothing about: what the offline resolver yields for a stranger. */
function unknownDest(org: string, repo: string): Destination {
  return dest({
    org,
    repo,
    class: "private-strict",
    visibility: "unknown",
    publicFacing: true,
    classKnown: false,
    assumedPublic: true,
  });
}

function boundary(orgs: string[]): TrustBoundary {
  return { orgs: new Set(orgs), fromRemoteFallback: false, class: "private-strict", classExplicit: false };
}

function decide(command: string, over: Partial<DecideEgressOptions> = {}) {
  return decideEgress({
    intents: parseEgressIntents(command),
    cwd: "/work/svc",
    registry: H_REGISTRY,
    registryState: "loaded",
    humanPresent: false,
    capabilities: { ask: true },
    resolveDestination: () => dest(),
    scanPayload: () => 0,
    trustBoundaryOf: () => boundary(["acme"]),
    findApproval: () => null,
    ...over,
  });
}

interface Spy {
  approvalCalls: number;
  lookupCalls: number;
  boundaryCalls: number;
  scanCalls: number;
}

/** `decide` with every context hook counted, so "rule h came first" is observable. */
function decideH(command: string, org: string, repo: string, over: Partial<DecideEgressOptions> = {}) {
  const spy: Spy = { approvalCalls: 0, lookupCalls: 0, boundaryCalls: 0, scanCalls: 0 };
  const d = decide(command, {
    resolveDestination: () => unknownDest(org, repo),
    lookupVisibility: () => {
      spy.lookupCalls++;
      return null;
    },
    trustBoundaryOf: () => {
      spy.boundaryCalls++;
      return boundary(["acme"]);
    },
    scanPayload: () => {
      spy.scanCalls++;
      return 0;
    },
    // A live `*/*` approval, offered to anyone who asks.
    findApproval: () => {
      spy.approvalCalls++;
      return { id: "a1", org: "*", repo: "*", createdAt: "", expiresAt: "2099-01-01T00:00:00.000Z", by: "op" };
    },
    ...over,
  });
  return { d, spy };
}

/** Run `fn` with REPO_AEGIS_HOME pointing at a fresh temp directory. */
function withHome<T>(fn: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), "egress-rule-h-"));
  const prior = process.env["REPO_AEGIS_HOME"];
  process.env["REPO_AEGIS_HOME"] = home;
  try {
    return fn(home);
  } finally {
    if (prior === undefined) delete process.env["REPO_AEGIS_HOME"];
    else process.env["REPO_AEGIS_HOME"] = prior;
    rmSync(home, { recursive: true, force: true });
  }
}

const ISSUE_COMMANDS = [
  "gh issue create --body x",
  "gh pr comment --body x",
  "gh api -X POST repos/stranger/repo/issues -f body=x",
  `gh pr create --body-file ${SCRATCH}/b.md --repo stranger/repo`,
  "git push git@github.com:stranger/repo.git main",
];

describe("rule h — unregistered owner", () => {
  it("refuses each of the issue's five commands, and no approval finder is consulted", () => {
    for (const cmd of ISSUE_COMMANDS) {
      const { d, spy } = decideH(cmd, "stranger", "repo");
      assert.equal(d.action, "deny", cmd);
      assert.equal(d.action === "deny" && d.code, "UNREGISTERED_OWNER_EGRESS", cmd);
      assert.equal(spy.approvalCalls, 0, `${cmd}: an approval must not even be consulted`);
      assert.equal(d.action === "deny" && d.destination?.org, "stranger", cmd);
    }
  });

  it("refuses with the REAL approvals store holding `*/*`, `stranger/*` and `stranger/repo` (which DO satisfy rule g for a registered owner)", () => {
    withHome(() => {
      for (const target of [
        { org: "*", repo: "*" },
        { org: "stranger", repo: "*" },
        { org: "stranger", repo: "repo" },
      ]) {
        mintApproval({ target });
      }
      for (const cmd of ISSUE_COMMANDS) {
        const refused = decide(cmd, {
          resolveDestination: () => unknownDest("stranger", "repo"),
          findApproval: findApprovalDefault,
        });
        assert.equal(refused.action === "deny" && refused.code, "UNREGISTERED_OWNER_EGRESS", cmd);
      }
      // Control: the same store IS live. A registered public destination is
      // covered by it at rule g, so the refusals above are rule h's doing and
      // not an empty or unreadable store.
      for (const cmd of ISSUE_COMMANDS) {
        const covered = decide(cmd, {
          resolveDestination: () =>
            dest({ org: "acme", repo: "repo", class: "public-eligible", visibility: "public", publicFacing: true }),
          findApproval: findApprovalDefault,
        });
        assert.equal(covered.action, "allow", cmd);
        assert.ok(covered.action === "allow" && covered.approval !== undefined, cmd);
      }
    });
  });

  it("the same five against a registered owner behave exactly as with rule h off (v0.10.3 behaviour)", () => {
    const variants: Array<[string, Destination]> = [
      ["private", dest({ org: "acme", repo: "repo" })],
      ["public", dest({ org: "acme", repo: "repo", class: "public-eligible", visibility: "public", publicFacing: true })],
      ["uncached", unknownDest("acme", "repo")],
    ];
    for (const cmd of ISSUE_COMMANDS) {
      for (const [label, d] of variants) {
        const common = { resolveDestination: () => d, findApproval: () => null };
        const on = decide(cmd, { ...common, registryState: "loaded" });
        const off = decide(cmd, { ...common, registryState: "missing" });
        assert.deepEqual(on, off, `${cmd} [${label}]`);
      }
    }
    // The table is not vacuous: the public variant still asks.
    const pub = decide(ISSUE_COMMANDS[0]!, { resolveDestination: () => variants[1]![1], findApproval: () => null });
    assert.equal(pub.action, "ask");
  });

  it("a customer's org (an engagement's githubOrgs) is registered", () => {
    const { d } = decideH("gh issue create --body x", "customer-a-org", "x", {
      resolveDestination: () => dest({ org: "customer-a-org", repo: "x", visibility: "private" }),
    });
    assert.equal(d.action, "allow");
  });

  it("a person present passes rule h", () => {
    const { d, spy } = decideH("gh issue create --body x", "stranger", "repo", { humanPresent: true });
    assert.equal(d.action, "allow");
    assert.equal(spy.approvalCalls, 0);
    assert.equal(spy.lookupCalls, 1, "the rest of the pipeline still runs for a person");
  });

  describe("registry state (D4, revised)", () => {
    it("missing: rule h is skipped, and the rest of the guard still stops an unknown destination", () => {
      const { d } = decideH("gh issue create --body x", "stranger", "repo", {
        registryState: "missing",
        registry: EMPTY,
        findApproval: () => null,
      });
      assert.notEqual(d.action === "deny" && d.code, "UNREGISTERED_OWNER_EGRESS");
      assert.equal(d.action, "ask");
    });

    it("missing: the state decides, not the registry object that was passed", () => {
      const { d } = decideH("gh issue create --body x", "stranger", "repo", { registryState: "missing" });
      assert.notEqual(d.action === "deny" && d.code, "UNREGISTERED_OWNER_EGRESS");
    });

    it("loaded with no owners: rule h is skipped", () => {
      const { d } = decideH("gh issue create --body x", "stranger", "repo", {
        registryState: "loaded",
        registry: EMPTY,
        findApproval: () => null,
      });
      assert.notEqual(d.action === "deny" && d.code, "UNREGISTERED_OWNER_EGRESS");
      assert.equal(d.action, "ask");
    });

    it("loaded with only allowedUpstreams (no owners): rule h is skipped", () => {
      const { d } = decideH("git push git@github.com:stranger/repo.git main", "stranger", "repo", {
        registry: { ...EMPTY, allowedUpstreams: ["upstream-org/lib"] },
      });
      assert.notEqual(d.action === "deny" && d.code, "UNREGISTERED_OWNER_EGRESS");
    });

    it("loaded with owners: rule h judges", () => {
      const { d } = decideH("gh issue create --body x", "stranger", "repo", { registryState: "loaded" });
      assert.equal(d.action === "deny" && d.code, "UNREGISTERED_OWNER_EGRESS");
    });

    it("unreadable: refused even for an owner the unreadable file would have listed", () => {
      // The callers fall back to an empty registry on an unreadable file …
      const empty = decideH("gh issue create --body x", "acme", "repo", {
        registryState: "unreadable",
        registry: EMPTY,
        resolveDestination: () => dest(),
      });
      assert.equal(empty.d.action === "deny" && empty.d.code, "UNREGISTERED_OWNER_EGRESS");
      // … and a registry object that lists the owner cannot override the state.
      const listed = decideH("gh issue create --body x", "acme", "repo", {
        registryState: "unreadable",
        resolveDestination: () => dest(),
      });
      assert.equal(listed.d.action === "deny" && listed.d.code, "UNREGISTERED_OWNER_EGRESS");
      assert.equal(listed.spy.approvalCalls, 0);
    });

    it("unreadable: says the registry could not be read and how to fix it (decrypt or repair); a person's step, no registry contents", () => {
      const { d } = decideH("gh issue create --body x", "acme", "repo", {
        registryState: "unreadable",
        resolveDestination: () => dest(),
      });
      assert.ok(d.action === "deny");
      assert.match(d.reason, /could not be read/);
      assert.match(d.reason, /encrypted/);
      assert.match(d.reason, /repo-aegis registry decrypt --identity/);
      assert.match(d.reason, /repair/);
      assert.match(d.reason, /No approval covers this/);
      assert.match(d.reason, /a person runs, from a terminal/);
      assert.ok(!d.reason.includes("customer-a-org"), "registry contents must not leak");
    });

    it("unreadable: an unresolved destination is refused too; a person passes", () => {
      const unresolved = dest({ org: "*", repo: "*", unresolved: "graphql-mutation", publicFacing: true, classKnown: false });
      const refused = decideH("gh api graphql -f query=x", "*", "*", {
        registryState: "unreadable",
        resolveDestination: () => unresolved,
      });
      assert.equal(refused.d.action === "deny" && refused.d.code, "UNREGISTERED_OWNER_EGRESS");
      const person = decideH("gh api graphql -f query=x", "*", "*", {
        registryState: "unreadable",
        resolveDestination: () => unresolved,
        humanPresent: true,
      });
      assert.equal(person.d.action, "allow");
    });

    it("unreadable: a command with no destination (npm publish) is not rule h's business", () => {
      const { d } = decideH("npm publish", "stranger", "repo", {
        registryState: "unreadable",
        resolveDestination: () => null,
        findApproval: () => null,
      });
      assert.notEqual(d.action === "deny" && d.code, "UNREGISTERED_OWNER_EGRESS");
      assert.equal(d.action, "ask"); // rule g, as today
    });

    it("unreadable: a person passes", () => {
      const { d } = decideH("gh issue create --body x", "stranger", "repo", {
        registryState: "unreadable",
        humanPresent: true,
      });
      assert.equal(d.action, "allow");
    });

    it("unreadable: the shape rules still win by order", () => {
      const { d } = decideH("git push", "stranger", "repo", { registryState: "unreadable" });
      assert.equal(d.action === "deny" && d.code, "PUSH_IMPLICIT_TARGET");
    });
  });

  describe("allowedUpstreams (D6)", () => {
    const UP = "upstream-org/lib";
    const ADMITTED = [
      `gh pr create --repo ${UP} -t x -b y`,
      `gh pr edit 1 --repo ${UP} -b y`,
      `gh pr comment 1 --repo ${UP} -b y`,
      `gh pr review 1 --repo ${UP} -c -b y`,
      `gh issue create --repo ${UP} -t x -b y`,
      `gh issue edit 1 --repo ${UP} -b y`,
      `gh issue comment 1 --repo ${UP} -b y`,
    ];

    it("passes rule h for PR, issue and comment verbs, then still needs a person at rule g", () => {
      for (const cmd of ADMITTED) {
        const { d } = decideH(cmd, "upstream-org", "lib", { findApproval: () => null });
        assert.notEqual(d.action === "deny" && d.code, "UNREGISTERED_OWNER_EGRESS", cmd);
        assert.equal(d.action, "ask", `${cmd}: an upstream is not 'ours', so rule g still asks`);
        assert.equal(d.action === "ask" && d.code, "PUBLIC_EGRESS_NEEDS_HUMAN", cmd);
      }
    });

    it("an explicit approval for exactly that upstream then covers rule g", () => {
      const approval = {
        id: "u1",
        org: "upstream-org",
        repo: "lib",
        createdAt: "",
        expiresAt: "2099-01-01T00:00:00.000Z",
        by: "op",
      };
      const { d } = decideH(ADMITTED[0]!, "upstream-org", "lib", {
        findApproval: dst => (dst?.org === "upstream-org" && dst.repo === "lib" ? approval : null),
      });
      assert.equal(d.action, "allow");
      assert.equal(d.action === "allow" && d.approval?.id, "u1");
    });

    it("does not lift rule h for git push, merge, release, repo, workflow or gh api writes", () => {
      for (const cmd of [
        `git push git@github.com:${UP}.git main`,
        `gh pr merge 1 --repo ${UP}`,
        `gh release create v1 --repo ${UP} --notes-file ${SCRATCH}/n.md`,
        `gh repo edit ${UP} --visibility public`,
        `gh workflow run x.yml --repo ${UP}`,
        `gh api -X POST repos/${UP}/issues -f body=x`,
      ]) {
        const { d, spy } = decideH(cmd, "upstream-org", "lib");
        assert.equal(d.action === "deny" && d.code, "UNREGISTERED_OWNER_EGRESS", cmd);
        assert.equal(spy.approvalCalls, 0, cmd);
      }
    });

    it("is exact: another repo of the same owner, or the owner alone, is refused", () => {
      for (const repo of ["other", "lib2", "Lib-x", "*"]) {
        const { d } = decideH(`gh pr create --repo upstream-org/${repo} -t x -b y`, "upstream-org", repo);
        assert.equal(d.action === "deny" && d.code, "UNREGISTERED_OWNER_EGRESS", repo);
      }
    });

    it("matches case-insensitively, as owners and repos themselves do", () => {
      const { d } = decideH(ADMITTED[0]!, "Upstream-Org", "LIB");
      assert.notEqual(d.action === "deny" && d.code, "UNREGISTERED_OWNER_EGRESS");
    });

    it("an upstream does not make its owner registered for other verbs on other repos", () => {
      const { d } = decideH("gh issue create --repo upstream-org/other --body x", "upstream-org", "other");
      assert.equal(d.action === "deny" && d.code, "UNREGISTERED_OWNER_EGRESS");
    });
  });

  it("an unresolved GraphQL mutation is refused without a person, and passes rule h with one (then rule g as today)", () => {
    const ENQ =
      "gh api graphql -F id=PR_kwDOAAAAAA -f query='mutation($id: ID!) { enqueuePullRequest(input: {pullRequestId: $id}) { clientMutationId } }'";
    const unresolved = dest({
      org: "*",
      repo: "*",
      unresolved: "graphql-mutation",
      publicFacing: true,
      classKnown: false,
      assumedPublic: true,
    });
    for (const capabilities of [{ ask: true }, { ask: false }]) {
      const { d, spy } = decideH(ENQ, "*", "*", { resolveDestination: () => unresolved, capabilities });
      assert.equal(d.action === "deny" && d.code, "UNREGISTERED_OWNER_EGRESS");
      assert.equal(spy.approvalCalls, 0, "not even a `*` approval is consulted");
    }
    const person = decideH(ENQ, "*", "*", { resolveDestination: () => unresolved, humanPresent: true });
    assert.equal(person.d.action, "allow");
  });

  it("owner case: --repo Stranger/Repo is refused and --repo ACME/x is admitted (real resolver)", () => {
    withHome(home => {
      const real = (command: string) =>
        decideEgress({
          intents: parseEgressIntents(command),
          cwd: home,
          registry: H_REGISTRY,
          registryState: "loaded",
          humanPresent: false,
          capabilities: { ask: true },
          lookupVisibility: () => "private",
          scanPayload: () => 0,
          trustBoundaryOf: () => boundary(["acme"]),
          findApproval: () => null,
        });
      const refused = real("gh issue create --repo Stranger/Repo --body x");
      assert.equal(refused.action === "deny" && refused.code, "UNREGISTERED_OWNER_EGRESS");
      assert.ok(refused.action === "deny" && refused.destination?.org === "stranger");
      assert.equal(real("gh issue create --repo ACME/x --body x").action, "allow");
    });
  });

  it("precedes the visibility lookup, rule e and rule f: none runs for an unregistered owner", () => {
    const { d, spy } = decideH("git push git@github.com:stranger/repo.git main", "stranger", "repo");
    assert.equal(d.action === "deny" && d.code, "UNREGISTERED_OWNER_EGRESS");
    assert.equal(spy.lookupCalls, 0, "no `gh repo view` against an owner the guard is about to refuse");
    assert.equal(spy.boundaryCalls, 0, "rule e did not run");
    assert.equal(spy.scanCalls, 0, "rule f did not run");
    // Control: for a registered owner with an unknown visibility the same stubs ARE reached.
    const reg = decideH("git push git@github.com:acme/repo.git main", "acme", "repo");
    assert.equal(reg.spy.lookupCalls, 1);
  });

  it("a cross-org push to an unregistered owner is rule h, not CROSS_ORG_EGRESS", () => {
    const { d } = decideH("git push git@github.com:stranger/repo.git main", "stranger", "repo", {
      trustBoundaryOf: () => boundary(["acme"]),
    });
    assert.equal(d.action === "deny" && d.code, "UNREGISTERED_OWNER_EGRESS");
  });

  it("rule h on any intent denies the command line", () => {
    const resolver: DestinationResolver = intent =>
      intent.verb === "git-push" ? unknownDest("stranger", "r") : dest();
    const d = decide("gh issue create -t x -b y && git push git@github.com:stranger/r.git main", {
      resolveDestination: resolver,
    });
    assert.equal(d.action === "deny" && d.code, "UNREGISTERED_OWNER_EGRESS");
  });

  it("property: any GitHub-charset owner outside the registry is refused for `gh issue create --repo <owner>/r`, whatever the approvals store holds", () => {
    withHome(home => {
      mintApproval({ target: { org: "*", repo: "*" } });
      // A fixed-seed LCG: deterministic, so a failure reproduces.
      let seed = 0x2f6e2b1;
      const next = (n: number): number => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed % n;
      };
      const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
      const CHARSET = ALNUM + "-";
      const genOwner = (): string => {
        const len = 1 + next(20);
        let o = ALNUM[next(ALNUM.length)]!;
        for (let i = 1; i < len; i++) o += CHARSET[next(CHARSET.length)]!;
        return o;
      };
      let checked = 0;
      while (checked < 60) {
        const owner = genOwner();
        // The registry varies too: a random owner set (split between
        // personalOrgs and an engagement's githubOrgs) and random upstreams,
        // none of which names the destination's owner.
        const others: string[] = [];
        for (let n = next(5); n > 0; n--) {
          const o = genOwner().toLowerCase();
          if (o !== owner.toLowerCase()) others.push(o);
        }
        const personal = others.filter((_, i) => i % 2 === 0);
        const customer = others.filter((_, i) => i % 2 === 1);
        // Never an empty owner set: rule h is skipped for one (D4).
        if (personal.length === 0 && customer.length === 0) personal.push("acme");
        const registry: Registry = {
          engagements: [
            { id: "customer-x", name: "Customer X", started: "2026-01-01", markers: [], githubOrgs: customer },
          ],
          alwaysBlock: [],
          personalOrgs: personal,
          allowedUpstreams: others.map(o => `${o}/lib`),
          schemaVersion: 2,
        } as unknown as Registry;
        checked++;
        const d = decideEgress({
          intents: parseEgressIntents(`gh issue create --repo ${owner}/r --body x`),
          cwd: home,
          registry,
          registryState: "loaded",
          humanPresent: false,
          capabilities: { ask: true },
          findApproval: findApprovalDefault,
          lookupVisibility: () => "public",
          scanPayload: () => 0,
          trustBoundaryOf: () => boundary(["acme"]),
        });
        assert.equal(d.action === "deny" && d.code, "UNREGISTERED_OWNER_EGRESS", owner);
      }
    });
  });
});

describe("rule h — refusal messages (§3.9, §5.4)", () => {
  /** What the redaction oracle must never see in a refusal for `stranger/repo`. */
  const FORBIDDEN = [
    "customer-a-org",
    "customer-a",
    "Customer A",
    "acme",
    "upstream-org",
    "payload-sentinel-xyz",
    SCRATCH,
  ];
  const STRANGER = dest({ org: "stranger", repo: "repo", visibility: "unknown", classKnown: false, publicFacing: true });

  function refuse(command: string, d: Destination = STRANGER, over: Partial<DecideEgressOptions> = {}): string {
    const out = decide(command, { resolveDestination: () => d, ...over });
    assert.equal(out.action, "deny", command);
    assert.ok(out.action === "deny");
    assert.equal(out.code, "UNREGISTERED_OWNER_EGRESS");
    return out.reason;
  }

  it("named owner: what, why, 'no approval', the fix marked as a person's step, the code, and where to read more", () => {
    const reason = refuse(`gh pr create --body-file ${SCRATCH}/payload-sentinel-xyz.md --repo stranger/repo`);
    assert.match(reason, /^gh pr create → stranger\/repo: refused\./, "what comes first");
    assert.match(reason, /The owner "stranger" is not registered \(in neither personalOrgs nor any engagement\)/, "why");
    assert.match(reason, /No approval covers this\./, "approval");
    assert.match(reason, /a person runs, from a terminal: repo-aegis engagements add --personal-org stranger/, "fix + who");
    assert.match(reason, /--github-org stranger/);
    assert.match(reason, /repo-aegis upstreams add stranger\/repo/);
    assert.match(reason, /Agents: do not run that yourself, retry or reroute; report this to your human\./);
    assert.match(
      reason,
      /\[UNREGISTERED_OWNER_EGRESS; details: repo-aegis explain UNREGISTERED_OWNER_EGRESS\]$/,
      "where to read more",
    );
  });

  it("the five parts appear in order", () => {
    const reason = refuse("gh issue create --body x");
    const marks = [
      "gh issue create → stranger/repo: refused.",
      'is not registered',
      "No approval covers this.",
      "a person runs, from a terminal:",
      "[UNREGISTERED_OWNER_EGRESS",
    ].map(m => reason.indexOf(m));
    assert.ok(marks.every(i => i >= 0), `all present: ${marks.join(",")}`);
    assert.deepEqual([...marks].sort((a, b) => a - b), marks, "in order");
  });

  it("every verb names its own verb and destination", () => {
    for (const [cmd, label] of [
      ["gh issue create --body x", "gh issue create"],
      ["gh pr comment --body x", "gh pr comment"],
      ["gh api -X POST repos/stranger/repo/issues -f body=x", "gh api (mutating)"],
      ["git push git@github.com:stranger/repo.git main", "git push"],
    ] as const) {
      const reason = refuse(cmd);
      assert.ok(reason.startsWith(`${label} → stranger/repo: refused.`), reason);
    }
  });

  it("redaction oracle: names only the destination owner, never registered owners, engagements, upstreams or the payload", () => {
    for (const cmd of [
      `gh pr create --body-file ${SCRATCH}/payload-sentinel-xyz.md --repo stranger/repo`,
      "git push git@github.com:stranger/repo.git main",
      "gh issue create --body x",
    ]) {
      const reason = refuse(cmd);
      for (const bad of FORBIDDEN) assert.ok(!reason.includes(bad), `${cmd}: must not contain "${bad}"`);
    }
    // The decision as a whole (what a layer prints as JSON) is held to the same bar.
    const out = decide(`gh pr create --body-file ${SCRATCH}/payload-sentinel-xyz.md --repo stranger/repo`, {
      resolveDestination: () => STRANGER,
    });
    const text = JSON.stringify({ code: out.action === "deny" && out.code, reason: out.action === "deny" && out.reason, destination: out.action === "deny" && out.destination });
    for (const bad of ["customer-a-org", "customer-a", "Customer A", "acme", "upstream-org", "payload-sentinel-xyz"]) {
      assert.ok(!text.includes(bad), `decision JSON must not contain "${bad}"`);
    }
  });

  it("unresolved GraphQL mutation: why the owner is unknowable, that '*' no longer covers it, the agent's alternative and a person's step", () => {
    const unresolved = dest({ org: "*", repo: "*", unresolved: "graphql-mutation", publicFacing: true, classKnown: false });
    const reason = refuse("gh api graphql -f query=x", unresolved);
    assert.ok(reason.startsWith("gh api graphql (mutation): refused."), reason);
    assert.match(reason, /names its target by node id/);
    assert.match(reason, /No approval covers this/);
    assert.match(reason, /'\*' approval no longer does/);
    assert.match(reason, /--repo <owner>\/<repo>/);
    assert.match(reason, /A person runs the original command, from a terminal/);
    assert.match(reason, /\[UNREGISTERED_OWNER_EGRESS; details: repo-aegis explain UNREGISTERED_OWNER_EGRESS\]$/);
    for (const bad of FORBIDDEN) assert.ok(!reason.includes(bad), bad);
  });

  it("allowed upstream with a verb it does not cover: names the destination itself, offers the agent's re-issue", () => {
    const reason = refuse("git push git@github.com:upstream-org/lib.git main", dest({ org: "upstream-org", repo: "lib" }));
    assert.ok(reason.startsWith("git push → upstream-org/lib: refused."), reason);
    assert.match(reason, /upstream-org\/lib is an allowed upstream/);
    assert.match(reason, /only PRs, issues and comments, not git push/);
    assert.match(reason, /No approval covers this/);
    assert.match(reason, /re-issue as: gh pr create --repo upstream-org\/lib/);
    // Only the destination is named: no registered owner, no engagement.
    for (const bad of ["customer-a-org", "customer-a", "Customer A", "acme"]) assert.ok(!reason.includes(bad), bad);
    // The agent's re-issue is not a person's step: no "do not run that yourself" trailer.
    assert.ok(!reason.includes("Agents: do not run that yourself"));
  });

  it("unreadable registry: names the destination owner only, and says how to repair", () => {
    const reason = refuse("gh issue create --body x", dest({ org: "stranger", repo: "repo" }), {
      registryState: "unreadable",
    });
    assert.ok(reason.startsWith("gh issue create → stranger/repo: refused."), reason);
    assert.match(reason, /could not be read/);
    assert.match(reason, /\[UNREGISTERED_OWNER_EGRESS; details: repo-aegis explain UNREGISTERED_OWNER_EGRESS\]$/);
    for (const bad of FORBIDDEN) assert.ok(!reason.includes(bad), bad);
  });
});
