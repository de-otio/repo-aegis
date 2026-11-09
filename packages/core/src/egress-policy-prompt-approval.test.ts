// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Prompt approvals at rule g (doc/design/egress-guard.md §4a.1).
//
// The agent hook records one when it asks, before the person answers, and must NEVER honour one: after a "no" the
// record is still live, and a second, different command to the same repository would pass on it (F1). The layers below
// the prompt (the `gh` shim, pre-push) pass `findPromptApproval`; the hook does not. These tests drive the REAL finder
// over a REAL directory, so each fails if the hook's decision started consulting prompt records.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scrubGitEnv } from "./_test-git-env.js";
import { parseEgressIntents } from "./egress-intent.js";
import {
  decideEgress,
  findApprovalDefault,
  findPromptApprovalDefault,
  PROMPT_APPROVAL_DENY_SENTENCE,
  type DecideEgressOptions,
  type Destination,
  type EgressDecision,
} from "./egress-policy.js";
import { mintApproval, recordPromptApproval, type PromptBinding } from "./egress-approval.js";
import type { Registry } from "./registry.js";
import type { TrustBoundary } from "./trust-boundary.js";

let restoreGitEnv: () => void;
before(() => {
  restoreGitEnv = scrubGitEnv();
});
after(() => {
  restoreGitEnv();
});

const REGISTRY: Registry = {
  engagements: [],
  alwaysBlock: [],
  personalOrgs: ["acme"],
  schemaVersion: 2,
} as unknown as Registry;

function publicDest(org: string, repo: string, extra: Partial<Destination> = {}): Destination {
  return { org, repo, class: "public-eligible", visibility: "public", publicFacing: true, classKnown: true, ...extra };
}

const boundary = (orgs: string[]): TrustBoundary => ({
  orgs: new Set(orgs),
  fromRemoteFallback: false,
  class: "private-strict",
  classExplicit: false,
});

function withHome<T>(fn: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), "egress-prompt-approval-"));
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
    trustBoundaryOf: () => boundary(["acme"]),
    findApproval: findApprovalDefault,
    lookupVisibility: () => "public",
    ...over,
  });
}

const record = (b: PromptBinding) => recordPromptApproval({ binding: b, permissionMode: "default" })!;
const PR: PromptBinding = { verb: "gh-pr-create", org: "acme", repo: "repo" };
const PR_CMD = "gh pr create --repo acme/repo --body x";

describe("the hook never honours a prompt record (F1)", () => {
  it("a record that matches the command exactly still leaves the hook's decision as `ask`", () => {
    withHome(() => {
      record(PR);
      const d = decide(PR_CMD, publicDest("acme", "repo")); // no findPromptApproval: this is the hook
      assert.equal(d.action, "ask");
    });
  });

  it("a record for ANOTHER command to the same repository does not turn this ask into an allow either", () => {
    withHome(() => {
      record({ verb: "git-push", org: "acme", repo: "repo", ref: "main" });
      assert.equal(decide(PR_CMD, publicDest("acme", "repo")).action, "ask");
      record({ verb: "gh-release-create", org: "acme", repo: "repo" });
      assert.equal(decide("git push origin main", publicDest("acme", "repo")).action, "ask");
    });
  });

  it("terminal approvals still turn the hook's ask into an allow, exactly as before", () => {
    withHome(() => {
      mintApproval({ target: { org: "acme", repo: "repo" } });
      const d = decide(PR_CMD, publicDest("acme", "repo"));
      assert.equal(d.action, "allow");
      assert.ok(d.action === "allow" && d.approval !== undefined);
    });
  });
});

describe("the shim (findPromptApproval set, no ask)", () => {
  const shim = (command: string, destination: Destination | null) =>
    decide(command, destination, { capabilities: { ask: false }, findPromptApproval: findPromptApprovalDefault });

  it("a matching gh-pr-create record allows, and the decision says the approval came from a prompt", () => {
    withHome(() => {
      const a = record(PR);
      const d = shim(PR_CMD, publicDest("acme", "repo"));
      assert.equal(d.action, "allow", JSON.stringify(d));
      assert.ok(d.action === "allow" && d.approval !== undefined);
      assert.equal(d.approval.id, a.id);
      assert.equal((d.approval as { source?: string }).source, "prompt");
    });
  });

  it("another verb to the same repository is denied, and the refusal says what a yes covers", () => {
    withHome(() => {
      record(PR);
      const d = shim("gh release create v1 --repo acme/repo", publicDest("acme", "repo"));
      assert.equal(d.action, "deny");
      assert.ok(d.action === "deny");
      assert.equal(d.code, "PUBLIC_EGRESS_NEEDS_HUMAN");
      assert.ok(d.reason.includes(PROMPT_APPROVAL_DENY_SENTENCE), d.reason);
      const other = shim("gh issue comment 5 --repo acme/repo --body x", publicDest("acme", "repo"));
      assert.equal(other.action, "deny");
    });
  });

  it("another repository is denied", () => {
    withHome(() => {
      record(PR);
      assert.equal(shim("gh pr create --repo acme/other --body x", publicDest("acme", "other")).action, "deny");
    });
  });

  it("without any record the refusal still carries the sentence (so it is not a dead end), and a hook without the finder does not", () => {
    withHome(() => {
      const withFinder = shim(PR_CMD, publicDest("acme", "repo"));
      assert.ok(withFinder.action === "deny" && withFinder.reason.includes(PROMPT_APPROVAL_DENY_SENTENCE));
      const without = decide(PR_CMD, publicDest("acme", "repo"), { capabilities: { ask: false } });
      assert.ok(without.action === "deny" && !without.reason.includes(PROMPT_APPROVAL_DENY_SENTENCE));
    });
  });

  it("an unresolved destination is covered by nothing, even by a record whose names are `*`", () => {
    withHome(() => {
      const dest = publicDest("*", "*", { unresolved: "graphql-mutation", assumedPublic: true, classKnown: false });
      const d = shim("gh api graphql -f query='mutation { x }'", dest);
      assert.notEqual(d.action, "allow");
    });
  });

  it("an expired record allows nothing", () => {
    withHome(home => {
      const past = new Date(Date.now() - 10 * 60_000);
      recordPromptApproval({ binding: PR, permissionMode: "default", home, now: past });
      assert.equal(shim(PR_CMD, publicDest("acme", "repo")).action, "deny");
    });
  });
});

describe("`asked`: every (intent, target) that judged ask", () => {
  const verbs = (d: EgressDecision) => (d.action === "ask" ? d.asked.map(a => a.intent.verb) : []);

  it("a compound push and PR gives two entries, each with its destination", () => {
    withHome(() => {
      const d = decide("git push origin main && gh pr create --repo acme/repo --body x", publicDest("acme", "repo"));
      assert.equal(d.action, "ask");
      assert.deepEqual(verbs(d), ["git-push", "gh-pr-create"]);
      assert.ok(d.action === "ask" && d.asked.every(a => a.destination?.org === "acme" && a.destination.repo === "repo"));
    });
  });

  it("an entry covered by a terminal approval is not asked: one entry", () => {
    withHome(() => {
      // covers the push to main (ref-limited), not the PR (a gh write names no ref)
      mintApproval({ target: { org: "acme", repo: "repo" }, ref: "main" });
      const d = decide("git push origin main && gh pr create --repo acme/repo --body x", publicDest("acme", "repo"));
      assert.equal(d.action, "ask");
      assert.deepEqual(verbs(d), ["gh-pr-create"]);
    });
  });

  it("a single ask gives exactly one entry", () => {
    withHome(() => {
      assert.deepEqual(verbs(decide(PR_CMD, publicDest("acme", "repo"))), ["gh-pr-create"]);
    });
  });

  it("a remote with two push URLs gives two entries, one per target", () => {
    withHome(() => {
      const dest = publicDest("acme", "repo", { alsoTargets: [publicDest("acme", "mirror")] });
      const d = decide("git push origin main", dest);
      assert.equal(d.action, "ask");
      assert.ok(d.action === "ask");
      assert.deepEqual(
        d.asked.map(a => `${a.destination?.org}/${a.destination?.repo}`),
        ["acme/repo", "acme/mirror"],
      );
    });
  });

  it("any deny means no ask at all", () => {
    withHome(() => {
      // a bare `gh pr create` is refused by the implicit-target shape rule, whatever else asked
      const d = decide("git push origin main && gh pr create --body x", publicDest("acme", "repo"));
      assert.equal(d.action, "deny");
    });
  });
});
