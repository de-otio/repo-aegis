// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `gh repo create OWNER/REPO --private` needs no person (doc/plan-engagement-repo-consistency.md, change C).
// The waiver is narrow: every shape that can publish something keeps rule g. Placeholders only: `org-a` is an
// engagement's org, `mine` a personal org, `stranger` is registered nowhere.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scrubGitEnv } from "./_test-git-env.js";
import { parseEgressIntents } from "./egress-intent.js";
import {
  decideEgress,
  isPrivateRepoCreateWithoutContent,
  type DecideEgressOptions,
  type Destination,
  type DestinationResolver,
} from "./egress-policy.js";
import type { Registry } from "./registry.js";
import type { TrustBoundary } from "./trust-boundary.js";

const REGISTRY: Registry = {
  engagements: [{ id: "org-a", name: "Org A", started: "2026-01-01", markers: [], githubOrgs: ["org-a"] }],
  alwaysBlock: [],
  personalOrgs: ["mine"],
  schemaVersion: 2,
} as unknown as Registry;

describe("gh repo create — the private, content-free waiver", () => {
  let restoreGitEnv: () => void;
  let cwd: string;
  let priorHome: string | undefined;

  before(() => {
    restoreGitEnv = scrubGitEnv();
    cwd = mkdtempSync(join(tmpdir(), "egress-repo-create-"));
    execFileSync("git", ["init", "-q"], { cwd, stdio: "ignore" });
    // The destination cache is read under REPO_AEGIS_HOME: keep the developer's own out of it.
    priorHome = process.env["REPO_AEGIS_HOME"];
    process.env["REPO_AEGIS_HOME"] = join(cwd, "home");
  });

  after(() => {
    if (priorHome === undefined) delete process.env["REPO_AEGIS_HOME"];
    else process.env["REPO_AEGIS_HOME"] = priorHome;
    restoreGitEnv();
    rmSync(cwd, { recursive: true, force: true });
  });

  function decide(command: string, over: Partial<DecideEgressOptions> = {}) {
    return decideEgress({
      intents: parseEgressIntents(command),
      cwd,
      registry: REGISTRY,
      registryState: "loaded",
      humanPresent: false,
      capabilities: { ask: true },
      scanPayload: () => 0,
      trustBoundaryOf: (): TrustBoundary => ({
        orgs: new Set(["org-a", "mine"]),
        fromRemoteFallback: false,
        class: "private-strict",
        classExplicit: false,
      }),
      findApproval: () => null,
      lookupVisibility: () => null,
      ...over,
    });
  }

  const code = (d: ReturnType<typeof decide>): string | undefined => (d.action === "allow" ? undefined : d.code);

  const WAIVED = [
    "gh repo create org-a/new --private",
    "gh repo create org-a/new --internal",
    "gh repo create mine/new --private",
    "gh repo create --private org-a/new",
    "gh repo create ORG-A/new --private",
    "gh repo create org-a/new --private -d 'a description' --add-readme --license mit --gitignore Node",
  ];
  for (const command of WAIVED) {
    it(`allowed with no person present: ${command}`, () => {
      assert.equal(decide(command).action, "allow");
    });
  }

  const STILL_NEEDS_A_PERSON = [
    ["a public create", "gh repo create org-a/new --public"],
    ["no visibility flag", "gh repo create org-a/new"],
    ["--private=false", "gh repo create org-a/new --private=false"],
    ["two visibility flags", "gh repo create org-a/new --private --public"],
    ["a bare name (created under whichever account gh is logged into)", "gh repo create new --private"],
    ["a source tree", "gh repo create org-a/new --private --source ."],
    ["a source tree pushed", "gh repo create org-a/new --private --source . --push"],
    ["a template copied on GitHub's side", "gh repo create org-a/new --private --template org-a/tmpl"],
    ["a clone", "gh repo create org-a/new --private --clone"],
    ["a fork", "gh repo fork org-a/x --org org-a"],
  ] as const;
  for (const [why, command] of STILL_NEEDS_A_PERSON) {
    it(`still PUBLIC_EGRESS_NEEDS_HUMAN: ${why}`, () => {
      assert.equal(code(decide(command)), "PUBLIC_EGRESS_NEEDS_HUMAN");
    });
  }

  it("an owner registered nowhere is still refused by rule h, not waived", () => {
    assert.equal(code(decide("gh repo create stranger/new --private")), "UNREGISTERED_OWNER_EGRESS");
  });

  it("a shell expansion anywhere in the command keeps the person check", () => {
    assert.notEqual(decide('gh repo create org-a/new --private --description "$D"').action, "allow");
    assert.notEqual(decide("gh repo create org-a/new --private=$V").action, "allow");
  });

  it("a visibility already known to be public is never downgraded to private", () => {
    const publicKnown: DestinationResolver = () =>
      ({
        org: "org-a",
        repo: "new",
        class: "customer-coupled",
        visibility: "public",
        publicFacing: true,
        classKnown: true,
      }) satisfies Destination;
    assert.equal(code(decide("gh repo create org-a/new --private", { resolveDestination: publicKnown })), "PUBLIC_EGRESS_NEEDS_HUMAN");
  });

  it("a registry that did not load never waives", () => {
    for (const registryState of ["missing", "encrypted", "unparseable", "newer-schema"] as const) {
      assert.notEqual(decide("gh repo create org-a/new --private", { registryState }).action, "allow", registryState);
    }
  });

  it("isPrivateRepoCreateWithoutContent is false for every other verb", () => {
    for (const command of ["gh pr merge 1 --repo org-a/x", "gh release create v1 --repo org-a/x", "gh repo edit org-a/x --visibility private"]) {
      const intent = parseEgressIntents(command)[0]!;
      assert.equal(isPrivateRepoCreateWithoutContent(intent, REGISTRY, "loaded"), false, command);
    }
  });
});
