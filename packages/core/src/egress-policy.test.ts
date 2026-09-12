// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEgressIntents, type EgressIntent } from "./egress-intent.js";
import {
  decideEgress,
  describeDestination,
  formatReceipt,
  isHumanPresent,
  isModeDependentPath,
  resolveDestinationOffline,
  scanPayloadAgainstDestination,
  EGRESS_HUMAN_ENV,
  type Destination,
  type DecideEgressOptions,
  type DestinationResolver,
} from "./egress-policy.js";
import type { Registry } from "./registry.js";
import type { TrustBoundary } from "./trust-boundary.js";
import { recordWorkingTree } from "./destination-cache.js";

const REGISTRY: Registry = {
  engagements: [
    { id: "customer-a", name: "Customer A", started: "2026-01-01", markers: [], githubOrgs: ["customer-a-org"] },
  ],
  alwaysBlock: [],
  personalOrgs: ["acme"],
  schemaVersion: 2,
} as unknown as Registry;

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

const PUBLIC = dest({ class: "public-eligible", visibility: "public", publicFacing: true });

function boundary(orgs: string[]): TrustBoundary {
  return { orgs: new Set(orgs), fromRemoteFallback: false, class: "private-strict", classExplicit: false };
}

function decide(command: string, over: Partial<DecideEgressOptions> = {}) {
  const intents = parseEgressIntents(command);
  return decideEgress({
    intents,
    cwd: "/work/svc",
    registry: REGISTRY,
    humanPresent: false,
    capabilities: { ask: true },
    resolveDestination: () => dest(),
    scanPayload: () => 0,
    trustBoundaryOf: () => boundary(["acme"]),
    findApproval: () => null,
    ...over,
  });
}

describe("decideEgress — shape rules are unconditional", () => {
  it("a: bare git push → PUSH_IMPLICIT_TARGET, even with humanPresent and no context", () => {
    const d = decide("git push", { humanPresent: true, resolveDestination: () => null });
    assert.equal(d.action, "deny");
    assert.equal(d.action === "deny" && d.code, "PUSH_IMPLICIT_TARGET");
  });

  it("a: remote without refspec is still implicit", () => {
    const d = decide("git push origin", { humanPresent: true });
    assert.equal(d.action === "deny" && d.code, "PUSH_IMPLICIT_TARGET");
  });

  it("b: egress after cd → EGRESS_AFTER_CD", () => {
    const d = decide("cd /work/svc && git push origin main", { humanPresent: true });
    assert.equal(d.action === "deny" && d.code, "EGRESS_AFTER_CD");
  });

  it("c: ;-chained egress → EGRESS_UNGUARDED_CHAIN", () => {
    const d = decide("git add -A ; git push origin main", { humanPresent: true });
    assert.equal(d.action === "deny" && d.code, "EGRESS_UNGUARDED_CHAIN");
  });

  it("c: ||-chained egress → EGRESS_UNGUARDED_CHAIN", () => {
    const d = decide("make || git push origin main", { humanPresent: true });
    assert.equal(d.action === "deny" && d.code, "EGRESS_UNGUARDED_CHAIN");
  });

  it("&&-chained egress passes the shape rules", () => {
    const d = decide("git add -A && git push origin main", { humanPresent: true });
    assert.equal(d.action, "allow");
  });

  it("the 2026-09-08 incident command is refused by a, b and c — a wins by order", () => {
    const d = decide(
      "cd /work/svc && python3 regen.py ; git add -A && git commit -m x ; git push",
      { humanPresent: true, resolveDestination: () => null },
    );
    assert.equal(d.action === "deny" && d.code, "PUSH_IMPLICIT_TARGET");
  });

  it("d: the 2026-09-07 incident command → PAYLOAD_MODE_DEPENDENT_PATH", () => {
    const d = decide('gh pr create --title x --body-file "$TMPDIR/pr-body.md" --repo acme/svc', {
      humanPresent: true,
    });
    assert.equal(d.action === "deny" && d.code, "PAYLOAD_MODE_DEPENDENT_PATH");
    assert.ok(d.action === "deny" && d.reason.includes("pr-body.md"));
    assert.ok(d.action === "deny" && !d.reason.includes("$TMPDIR/pr-body.md"), "reason carries the basename only");
  });

  it("d: relative payload path is refused", () => {
    const d = decide("gh pr create -t x --body-file pr-body.md", { humanPresent: true });
    assert.equal(d.action === "deny" && d.code, "PAYLOAD_MODE_DEPENDENT_PATH");
  });

  it("d: stdin payload is fine", () => {
    const d = decide("gh pr create -t x --body-file -", { humanPresent: true });
    assert.equal(d.action, "allow");
  });

  it("d: the session scratchpad is fine", () => {
    const d = decide(
      "gh pr create -t x --body-file /private/tmp/claude-501/-proj/1234-abcd/scratchpad/pr-body-1234.md",
      { humanPresent: true },
    );
    assert.equal(d.action, "allow");
  });
});

describe("isModeDependentPath", () => {
  const dependent = [
    "$TMPDIR/pr-body.md",
    "${TMPDIR}/pr-body.md",
    "$TMP/x",
    "%TEMP%\\x.md",
    "pr-body.md",
    "./pr-body.md",
    "../pr-body.md",
    "/var/folders/ab/cd/T/pr-body.md",
    "/private/var/folders/ab/cd/T/pr-body.md",
    "/tmp/claude-501/pr-body.md",
    "/private/tmp/claude-501/pr-body.md",
    "/tmp/claude-501/-proj/sess/tasks/x.md",
  ];
  const fine = [
    "-",
    "/home/u/notes/pr-body.md",
    "/tmp/claude-501/-proj/sess/scratchpad/pr-body.md",
    "/private/tmp/claude-501/-proj/sess/scratchpad/pr-body.md",
    "/tmp/pr-body.md",
    "C:\\Users\\u\\pr-body.md",
  ];
  for (const p of dependent) {
    it(`${p} is mode-dependent`, () => assert.equal(isModeDependentPath(p).dependent, true));
  }
  for (const p of fine) {
    it(`${p} is not`, () => assert.equal(isModeDependentPath(p).dependent, false));
  }
});

describe("decideEgress — context rules", () => {
  it("e: payload tree positively disjoint from destination → CROSS_ORG_EGRESS", () => {
    const d = decide("gh pr create -t x --body-file /work/customer/pr.md --repo acme/svc", {
      humanPresent: true,
      trustBoundaryOf: wt => (wt === "/work/customer" ? boundary(["customer-a-org"]) : boundary(["acme"])),
      // findEnclosingWorkingTree cannot resolve a fake path, so inject the
      // source via a resolver-side trick: the scanner never runs because e fires first.
    });
    // /work/customer does not exist on disk, so findEnclosingWorkingTree
    // yields null and rule e cannot fire for gh payloads here; the git-push
    // form below exercises the same rule with a resolvable source tree.
    assert.equal(d.action, "allow");
  });

  it("e: git push whose repo boundary is disjoint from the destination org → CROSS_ORG_EGRESS", () => {
    const d = decide("git push origin main", {
      humanPresent: true,
      resolveDestination: () => dest({ org: "customer-a-org", repo: "svc", classKnown: false }),
      trustBoundaryOf: () => boundary(["acme"]),
    });
    assert.equal(d.action === "deny" && d.code, "CROSS_ORG_EGRESS");
    assert.ok(d.action === "deny" && d.reason.includes("customer-a-org/svc"));
  });

  it("e: overlapping boundaries pass", () => {
    const d = decide("git push origin main", {
      humanPresent: true,
      resolveDestination: () => dest({ org: "acme" }),
      trustBoundaryOf: () => boundary(["acme", "acme-labs"]),
    });
    assert.equal(d.action, "allow");
  });

  it("e: empty source boundary fails open", () => {
    const d = decide("git push origin main", {
      humanPresent: true,
      resolveDestination: () => dest({ org: "customer-a-org", classKnown: false }),
      trustBoundaryOf: () => boundary([]),
    });
    assert.equal(d.action, "allow");
  });

  it("e: a throwing boundary computation fails open", () => {
    const d = decide("git push origin main", {
      humanPresent: true,
      trustBoundaryOf: () => {
        throw new Error("boom");
      },
    });
    assert.equal(d.action, "allow");
  });

  it("f: payload marker hit → PAYLOAD_MARKER_HIT, count only", () => {
    const d = decide("gh pr create -t x --body-file /abs/pr.md", {
      humanPresent: true,
      scanPayload: () => 3,
    });
    assert.equal(d.action === "deny" && d.code, "PAYLOAD_MARKER_HIT");
    assert.ok(d.action === "deny" && d.reason.includes("3 hits"));
  });

  it("f: unscannable payload (null) fails open", () => {
    const d = decide("gh pr create -t x --body-file /abs/missing.md", {
      humanPresent: true,
      scanPayload: () => null,
    });
    assert.equal(d.action, "allow");
  });

  it("f: a throwing scanner fails open", () => {
    const d = decide("gh pr create -t x --body-file /abs/pr.md", {
      humanPresent: true,
      scanPayload: () => {
        throw new Error("boom");
      },
    });
    assert.equal(d.action, "allow");
  });

  it("f: does not run without a resolved destination", () => {
    let called = false;
    const d = decide("gh pr create -t x --body-file /abs/pr.md", {
      humanPresent: true,
      resolveDestination: () => null,
      scanPayload: () => {
        called = true;
        return 9;
      },
    });
    assert.equal(d.action, "allow");
    assert.equal(called, false);
  });

  it("g: public destination, no human, ask available → ask", () => {
    const d = decide("git push origin main", { resolveDestination: () => PUBLIC });
    assert.equal(d.action, "ask");
    assert.equal(d.action === "ask" && d.code, "PUBLIC_EGRESS_NEEDS_HUMAN");
    assert.ok(d.action === "ask" && d.reason.includes("PUBLIC"));
    assert.ok(d.action === "ask" && d.reason.includes("main → acme/svc (public, public-eligible)"));
  });

  it("g: ask degrades to deny when the framework has no ask — never to allow", () => {
    const d = decide("git push origin main", { resolveDestination: () => PUBLIC, capabilities: { ask: false } });
    assert.equal(d.action, "deny");
    assert.equal(d.action === "deny" && d.code, "PUBLIC_EGRESS_NEEDS_HUMAN");
    assert.ok(d.action === "deny" && d.reason.includes(EGRESS_HUMAN_ENV));
  });

  it("g: public destination with a human present → allow", () => {
    const d = decide("git push origin main", { resolveDestination: () => PUBLIC, humanPresent: true });
    assert.equal(d.action, "allow");
  });

  it("g: public-eligible class with uncached visibility is public-facing", () => {
    const d = decide("git push origin main", {
      resolveDestination: () => dest({ class: "public-eligible", visibility: "unknown", publicFacing: true }),
    });
    assert.equal(d.action, "ask");
  });

  it("g: irreversible verbs need a human even on a private destination", () => {
    for (const cmd of [
      "gh pr merge 12 --squash",
      "gh release create v1 --notes-file /abs/n.md",
      "gh repo edit --visibility public",
      "npm publish",
      "gh workflow run deploy.yml",
    ]) {
      const d = decide(cmd, { resolveDestination: () => dest() });
      assert.equal(d.action, "ask", cmd);
    }
  });

  it("g: a live human approval for the destination stands in for a person — rule g only", () => {
    const approval = {
      id: "deadbeef",
      org: "acme",
      repo: "svc",
      createdAt: "2026-09-12T18:00:00.000Z",
      expiresAt: "2026-09-12T18:15:00.000Z",
      by: "op",
    };
    const seen: Array<{ org: string; repo: string; ref: string | undefined }> = [];
    const d = decide("git push origin main", {
      resolveDestination: () => PUBLIC,
      findApproval: (dest, ref) => {
        seen.push({ org: dest!.org, repo: dest!.repo, ref });
        return approval;
      },
    });
    assert.equal(d.action, "allow");
    assert.equal(d.action === "allow" && d.approval?.id, "deadbeef");
    assert.deepEqual(seen, [{ org: "acme", repo: "svc", ref: "main" }]);
    // The shape rules still win: an approval does not launder a bare push…
    assert.equal(decide("git push", { findApproval: () => approval }).action, "deny");
    // …nor a cross-org boundary, nor a payload marker hit (rules e/f run first).
    const cross = decide("git push origin main", {
      resolveDestination: () => dest({ org: "customer-a-org", repo: "thing", classKnown: false }),
      trustBoundaryOf: () => boundary(["acme"]),
      findApproval: () => approval,
    });
    assert.equal(cross.action === "deny" && cross.code, "CROSS_ORG_EGRESS");
    const hit = decide("gh pr create -t x --body-file /abs/b.md", {
      resolveDestination: () => PUBLIC,
      scanPayload: () => 1,
      findApproval: () => approval,
    });
    assert.equal(hit.action === "deny" && hit.code, "PAYLOAD_MARKER_HIT");
  });

  it("g: no approval → still asks; a throwing finder is no approval", () => {
    assert.equal(decide("git push origin main", { resolveDestination: () => PUBLIC, findApproval: () => null }).action, "ask");
    assert.equal(
      decide("git push origin main", {
        resolveDestination: () => PUBLIC,
        findApproval: () => {
          throw new Error("boom");
        },
      }).action,
      "ask",
    );
  });

  it("g: an irreversible verb with no destination consults the finder with null", () => {
    let got: unknown = "unset";
    const d = decide("npm publish", {
      resolveDestination: () => null,
      findApproval: dest => {
        got = dest;
        return { id: "aaaaaaaa", org: "*", repo: "*", createdAt: "", expiresAt: "", by: "op" };
      },
    });
    assert.equal(got, null);
    assert.equal(d.action, "allow");
  });

  it("g: the ask reason tells the human how to mint an approval", () => {
    const d = decide("git push origin main", { resolveDestination: () => PUBLIC, findApproval: () => null });
    assert.ok(d.action === "ask" && d.reason.includes("repo-aegis approve acme/svc"), d.action === "ask" ? d.reason : "");
  });

  it("g: irreversible verb fires even with no resolved destination", () => {
    const d = decide("npm publish", { resolveDestination: () => null });
    assert.equal(d.action, "ask");
    assert.ok(d.action === "ask" && d.reason.includes("unresolved destination"));
  });

  it("private destination, ordinary verb, no human → allow (fail open on context)", () => {
    assert.equal(decide("git push origin main").action, "allow");
    assert.equal(decide("gh pr create -t x -b y").action, "allow");
  });

  it("unresolvable destination, ordinary verb → allow", () => {
    assert.equal(decide("git push origin main", { resolveDestination: () => null }).action, "allow");
  });

  it("a throwing resolver fails open", () => {
    const d = decide("git push origin main", {
      resolveDestination: () => {
        throw new Error("boom");
      },
    });
    assert.equal(d.action, "allow");
  });

  it("h: scratch class is allowed", () => {
    const d = decide("git push origin main", {
      resolveDestination: () => dest({ class: "scratch" }),
    });
    assert.equal(d.action, "allow");
  });
});

describe("decideEgress — severity across intents", () => {
  it("deny beats ask; ask beats allow; empty is allow", () => {
    const resolver: DestinationResolver = intent => (intent.verb === "git-push" ? PUBLIC : dest());
    const d = decide("git push origin main && gh pr create -t x --body-file rel.md", {
      resolveDestination: resolver,
    });
    assert.equal(d.action, "deny"); // rule d on the second intent beats the ask on the first
    const a = decide("git push origin main && gh pr create -t x -b y", { resolveDestination: resolver });
    assert.equal(a.action, "ask");
    assert.equal(decideEgress({ ...baseOpts(), intents: [] }).action, "allow");
  });
});

function baseOpts(): DecideEgressOptions {
  return {
    intents: [],
    cwd: "/work/svc",
    registry: REGISTRY,
    humanPresent: false,
    capabilities: { ask: true },
  };
}

describe("decideEgress — reasons never carry payload content or registry entries", () => {
  it("the reason for a marker hit names the file, not the match", () => {
    const d = decide("gh pr create -t x --body-file /abs/customer-a-secret-plan.md", {
      humanPresent: true,
      scanPayload: () => 1,
    });
    assert.equal(d.action, "deny");
    const text = JSON.stringify(d);
    assert.ok(!text.includes("Customer A"), "registry name must not appear");
    assert.ok(!text.includes("customer-a-org"), "registry org must not appear in a marker-hit reason");
  });
});

describe("isHumanPresent", () => {
  it("TTY on stderr → true", () => assert.equal(isHumanPresent({}, true), true));
  it("no TTY, env unset → false", () => assert.equal(isHumanPresent({}, false), false));
  it("no TTY, env=1 → true", () => assert.equal(isHumanPresent({ [EGRESS_HUMAN_ENV]: "1" }, false), true));
  it("env=0 is not an override", () => assert.equal(isHumanPresent({ [EGRESS_HUMAN_ENV]: "0" }, false), false));
});

describe("describeDestination / formatReceipt", () => {
  it("known class", () => {
    assert.equal(describeDestination(PUBLIC), "acme/svc (public, public-eligible)");
    assert.equal(formatReceipt(PUBLIC, "main"), "PUBLISHED → acme/svc (PUBLIC, class public-eligible): main");
  });
  it("unknown class", () => {
    const d = dest({ classKnown: false, visibility: "unknown" });
    assert.equal(describeDestination(d), "acme/svc (visibility unknown, class unknown)");
    assert.equal(formatReceipt(d, "PR #12"), "PUBLISHED → acme/svc (VISIBILITY UNKNOWN, class unknown): PR #12");
  });
  it("null", () => {
    assert.equal(describeDestination(null), "unresolved destination");
    assert.equal(formatReceipt(null, "x"), "PUBLISHED → (destination not resolved): x");
  });
});

describe("resolveDestinationOffline — real git config", () => {
  let root: string;
  let repo: string;
  let other: string;
  /** A second, PRIVATE checkout in the same personal org — the 2026-09-12 cwd. */
  let priv: string;
  let priorHome: string | undefined;

  function git(cwd: string, args: string[]): void {
    execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "ignore"] });
  }

  before(() => {
    root = mkdtempSync(join(tmpdir(), "egress-policy-"));
    repo = join(root, "svc");
    other = join(root, "elsewhere");
    priv = join(root, "notes");
    mkdirSync(repo);
    mkdirSync(other);
    mkdirSync(priv);
    git(repo, ["init", "-q"]);
    git(repo, ["remote", "add", "origin", "git@github.com:acme/svc.git"]);
    git(repo, ["remote", "add", "customer", "https://github.com/customer-a-org/thing.git"]);
    git(repo, ["remote", "add", "gitlab", "git@gitlab.com:acme/svc.git"]);
    git(repo, ["config", "repo-aegis.class", "public-eligible"]);
    git(repo, ["config", "repo-aegis.visibility", "public"]);
    writeFileSync(join(repo, "README.md"), "hello\n");
    git(priv, ["init", "-q"]);
    git(priv, ["remote", "add", "origin", "git@github.com:acme/notes.git"]);
    git(priv, ["config", "repo-aegis.class", "private-strict"]);
    git(priv, ["config", "repo-aegis.visibility", "private"]);
    // The destination cache lives under REPO_AEGIS_HOME; point it at this
    // fixture so the tests neither read nor write the developer's own.
    priorHome = process.env["REPO_AEGIS_HOME"];
    process.env["REPO_AEGIS_HOME"] = join(root, "home");
  });

  after(() => {
    if (priorHome === undefined) delete process.env["REPO_AEGIS_HOME"];
    else process.env["REPO_AEGIS_HOME"] = priorHome;
    rmSync(root, { recursive: true, force: true });
  });

  function intent(command: string): EgressIntent {
    return parseEgressIntents(command)[0]!;
  }

  it("git push origin → origin's org/repo with the repo's own class and cached visibility", () => {
    const d = resolveDestinationOffline(intent("git push origin main"), repo);
    assert.deepEqual(d, {
      org: "acme",
      repo: "svc",
      class: "public-eligible",
      visibility: "public",
      publicFacing: true,
      classKnown: true,
      workingTree: repo,
    });
  });

  it("git push <foreign remote> → that org/repo, class unknown", () => {
    const d = resolveDestinationOffline(intent("git push customer main"), repo);
    assert.equal(d?.org, "customer-a-org");
    assert.equal(d?.repo, "thing");
    assert.equal(d?.classKnown, false);
    assert.equal(d?.publicFacing, false);
  });

  it("git push <url> parses the URL directly", () => {
    const d = resolveDestinationOffline(intent("git push git@github.com:acme/svc.git main"), other);
    assert.equal(d?.org, "acme");
    assert.equal(d?.classKnown, false); // `other` has no origin, so no local class applies
  });

  it("non-GitHub remote → null", () => {
    assert.equal(resolveDestinationOffline(intent("git push gitlab main"), repo), null);
  });

  it("unknown remote name → null", () => {
    assert.equal(resolveDestinationOffline(intent("git push nowhere main"), repo), null);
  });

  it("git -C <repo> resolves from that directory, not cwd", () => {
    const d = resolveDestinationOffline(intent(`git -C ${repo} push origin main`), other);
    assert.equal(d?.org, "acme");
    assert.equal(d?.classKnown, true);
  });

  it("gh --repo o/r matching origin → own class", () => {
    const d = resolveDestinationOffline(intent("gh pr create -t x -b y --repo acme/svc"), repo);
    assert.equal(d?.classKnown, true);
    assert.equal(d?.publicFacing, true);
  });

  it("gh --repo o/r elsewhere → org/repo known, class not", () => {
    const d = resolveDestinationOffline(intent("gh pr create -t x -b y --repo acme/other"), repo);
    assert.equal(d?.org, "acme");
    assert.equal(d?.repo, "other");
    assert.equal(d?.classKnown, false);
  });

  it("gh --repo into an engagement's org → customer-coupled, inferred from the registry", () => {
    const d = resolveDestinationOffline(
      intent("gh pr create -t x -b y --repo customer-a-org/thing"),
      other,
      REGISTRY,
    );
    assert.equal(d?.class, "customer-coupled");
    assert.equal(d?.classKnown, true);
    assert.equal(d?.inferredFromRegistry, true);
    assert.deepEqual(d?.engagements, ["customer-a"]);
    assert.equal(d?.publicFacing, false);
  });

  it("without a registry the same destination stays unknown", () => {
    const d = resolveDestinationOffline(intent("gh pr create -t x -b y --repo customer-a-org/thing"), other);
    assert.equal(d?.classKnown, false);
  });

  it("the inferred customer-coupled destination gets _self_identity in its deny set", () => {
    const home = join(root, "home");
    mkdirSync(join(home, "markers"), { recursive: true });
    writeFileSync(join(home, "markers", "_always.txt"), "");
    writeFileSync(join(home, "markers", "_self_identity.txt"), "internal-project-codename\n");
    writeFileSync(join(home, "markers", "customer-a.txt"), "customer-a-marker\n");
    // Not under `other` (which mkdtemp put under /var/folders — rule d would
    // refuse it before rule f ever ran, which is correct and beside the point).
    const bodyDir = mkdtempSync("/tmp/egress-policy-body-");
    const body = join(bodyDir, "pr-body.md");
    writeFileSync(body, "Ported from internal-project-codename, see the customer-a-marker doc.\n");
    const prior = process.env["REPO_AEGIS_HOME"];
    process.env["REPO_AEGIS_HOME"] = home;
    try {
      const dest = resolveDestinationOffline(
        intent("gh pr create -t x -b y --repo customer-a-org/thing"),
        other,
        REGISTRY,
      )!;
      // customer-a's own markers are excluded in customer-a's repo; the
      // operator's identity is exactly what must not enter it.
      assert.equal(scanPayloadAgainstDestination(body, dest, other), 1);
      const d = decideEgress({
        intents: parseEgressIntents(`gh pr create -t x --body-file ${body} --repo customer-a-org/thing`),
        cwd: other,
        registry: REGISTRY,
        humanPresent: true,
        capabilities: { ask: true },
      });
      assert.equal(d.action === "deny" && d.code, "PAYLOAD_MARKER_HIT");
    } finally {
      if (prior === undefined) delete process.env["REPO_AEGIS_HOME"];
      else process.env["REPO_AEGIS_HOME"] = prior;
      rmSync(bodyDir, { recursive: true, force: true });
    }
  });

  it("a push from the own repo into an engagement's org is CROSS_ORG_EGRESS via the inferred boundary", () => {
    const d = decideEgress({
      intents: parseEgressIntents("git push https://github.com/customer-a-org/thing.git main"),
      cwd: repo,
      registry: REGISTRY,
      humanPresent: true,
      capabilities: { ask: true },
    });
    assert.equal(d.action === "deny" && d.code, "CROSS_ORG_EGRESS");
  });

  it("gh --repo accepts host/o/r and a URL", () => {
    assert.equal(
      resolveDestinationOffline(intent("gh pr merge 1 --repo github.com/acme/svc"), repo)?.repo,
      "svc",
    );
    assert.equal(
      resolveDestinationOffline(intent("gh pr merge 1 --repo https://github.com/acme/svc"), repo)?.repo,
      "svc",
    );
  });

  it("gh without --repo → cwd's origin", () => {
    const d = resolveDestinationOffline(intent("gh pr create -t x -b y"), repo);
    assert.equal(d?.org, "acme");
    assert.equal(d?.classKnown, true);
  });

  it("gh in a directory with no origin → null", () => {
    assert.equal(resolveDestinationOffline(intent("gh pr create -t x -b y"), other), null);
  });

  it("npm publish → null (a registry, not a repository)", () => {
    assert.equal(resolveDestinationOffline(intent("npm publish"), repo), null);
  });

  it("end to end: the policy asks for a public push from the real repo", () => {
    const d = decideEgress({
      intents: parseEgressIntents("git push origin main"),
      cwd: repo,
      registry: REGISTRY,
      humanPresent: false,
      capabilities: { ask: true },
    });
    assert.equal(d.action, "ask");
  });

  it("end to end: a foreign-org push from the real repo is CROSS_ORG_EGRESS", () => {
    const d = decideEgress({
      intents: parseEgressIntents("git push customer main"),
      cwd: repo,
      registry: REGISTRY,
      humanPresent: true,
      capabilities: { ask: true },
    });
    assert.equal(d.action === "deny" && d.code, "CROSS_ORG_EGRESS");
  });

  // ---- gh api: the destination is in the path ---------------------------

  const MERGE = "gh api -X PUT repos/acme/svc/pulls/103/merge -f merge_method=squash";

  it("gh api repos/o/r/… is resolved from the path, not the cwd", () => {
    const d = resolveDestinationOffline(intent(MERGE), priv);
    assert.equal(d?.org, "acme");
    assert.equal(d?.repo, "svc"); // not `notes`, the cwd's origin
  });

  it("gh api orgs/o/… resolves to the org with repo `*`", () => {
    const d = resolveDestinationOffline(intent("gh api -X POST orgs/customer-a-org/repos -f name=x"), priv, REGISTRY);
    assert.equal(d?.org, "customer-a-org");
    assert.equal(d?.repo, "*");
    assert.equal(d?.class, "customer-coupled");
  });

  it("gh api with {owner}/{repo} placeholders resolves from the cwd, as gh does", () => {
    const d = resolveDestinationOffline(intent("gh api repos/{owner}/{repo}/issues -f title=x"), repo);
    assert.equal(d?.repo, "svc");
    assert.equal(d?.classKnown, true);
  });

  it("gh api graphql from a directory with no origin → null", () => {
    assert.equal(resolveDestinationOffline(intent("gh api graphql -f query=x"), other), null);
  });

  // ---- an uncached personal-org destination is treated as public --------

  it("an uncached destination in a personal org is assumed public-facing (with a registry)", () => {
    const d = resolveDestinationOffline(intent("gh pr create -t x -b y --repo acme/other"), priv, REGISTRY);
    assert.equal(d?.classKnown, false);
    assert.equal(d?.assumedPublic, true);
    assert.equal(d?.publicFacing, true);
    assert.equal(describeDestination(d), "acme/other (visibility uncached, treated as public, class unknown)");
    assert.equal(formatReceipt(d!, "PR #1"), "PUBLISHED → acme/other (VISIBILITY UNCACHED, TREATED AS PUBLIC, class unknown): PR #1");
  });

  it("… and the policy asks rather than allows", () => {
    const d = decideEgress({
      intents: parseEgressIntents("gh pr create -t x -b y --repo acme/other"),
      cwd: priv,
      registry: REGISTRY,
      humanPresent: false,
      capabilities: { ask: true },
    });
    assert.equal(d.action, "ask");
  });

  // ---- the machine-wide destination cache -------------------------------

  it("before the cache knows the destination: the merge from the private cwd is assumed public, not allowed", () => {
    const d = decideEgress({
      intents: parseEgressIntents(MERGE),
      cwd: priv,
      registry: REGISTRY,
      humanPresent: false,
      capabilities: { ask: true },
    });
    assert.equal(d.action, "ask");
    assert.ok(d.action === "ask" && d.destination?.assumedPublic === true);
  });

  it("once the public checkout is recorded, a foreign-cwd command is judged by its declaration", () => {
    assert.equal(recordWorkingTree(repo), "acme/svc");
    const d = resolveDestinationOffline(intent(MERGE), priv, REGISTRY);
    assert.deepEqual(d, {
      org: "acme",
      repo: "svc",
      class: "public-eligible",
      visibility: "public",
      publicFacing: true,
      classKnown: true,
      fromCache: true,
      workingTree: repo,
    });
    // `--repo` from elsewhere, the same way.
    const viaFlag = resolveDestinationOffline(intent("gh pr create -t x -b y --repo acme/svc"), other, REGISTRY);
    assert.equal(viaFlag?.fromCache, true);
    assert.equal(viaFlag?.publicFacing, true);
    // A remote URL given to git push from elsewhere, the same way.
    const viaUrl = resolveDestinationOffline(intent("git push git@github.com:acme/svc.git main"), other, REGISTRY);
    assert.equal(viaUrl?.fromCache, true);
  });

  it("the 2026-09-12 command: a merge into the public repo from the private checkout now asks, naming the destination", () => {
    const d = decideEgress({
      intents: parseEgressIntents(MERGE),
      cwd: priv,
      registry: REGISTRY,
      humanPresent: false,
      capabilities: { ask: true },
    });
    assert.equal(d.action, "ask");
    assert.ok(d.action === "ask" && d.reason.includes("acme/svc (public, public-eligible)"), d.action === "ask" ? d.reason : "");
    assert.ok(d.action === "ask" && d.reason.includes(`from the checkout at ${repo}`));
  });

  it("… and the receipt names the destination, not the cwd", () => {
    const dest = resolveDestinationOffline(intent(MERGE), priv, REGISTRY);
    assert.equal(formatReceipt(dest, "gh api (mutating)"), "PUBLISHED → acme/svc (PUBLIC, class public-eligible): gh api (mutating)");
  });

  it("the cache follows the live config: flipping the checkout's visibility flips the judgement", () => {
    git(repo, ["config", "repo-aegis.class", "private-strict"]);
    git(repo, ["config", "repo-aegis.visibility", "private"]);
    try {
      const d = resolveDestinationOffline(intent(MERGE), priv, REGISTRY);
      assert.equal(d?.publicFacing, false);
      assert.equal(d?.fromCache, true);
    } finally {
      git(repo, ["config", "repo-aegis.class", "public-eligible"]);
      git(repo, ["config", "repo-aegis.visibility", "public"]);
    }
  });

  it("the own-origin path is unchanged by the cache", () => {
    const d = resolveDestinationOffline(intent("git push origin main"), repo, REGISTRY);
    assert.equal(d?.fromCache, undefined);
    assert.equal(d?.workingTree, repo);
  });
});
