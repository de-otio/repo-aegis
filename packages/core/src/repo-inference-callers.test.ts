// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Change A2 (doc/plan-engagement-repo-consistency.md): the layers that DECIDE a class now see the inferred one, so
// a repository created mid-session in an engagement's org is that engagement's everywhere, and a push and a `gh`
// call to one repository agree. The field case: the engagement's id IS its org's name (`org-a`).
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scrubGitEnv } from "./_test-git-env.js";
import { computeDenySet } from "./deny-set.js";
import { parseEgressIntents } from "./egress-intent.js";
import { resolveDestinationOffline } from "./egress-policy.js";
import { addEngagements, readRepoConfig, removeEngagement } from "./repo.js";
import { readEffectiveRepoConfig } from "./repo-inference.js";
import { computeTrustBoundary } from "./trust-boundary.js";
import type { Registry } from "./registry.js";

const eng = (id: string, githubOrgs: string[]) => ({ id, name: id, started: "2026-01-01", markers: [], githubOrgs });
const REGISTRY = {
  engagements: [eng("org-a", ["org-a"]), eng("org-b", ["org-b"]), eng("dup-1", ["dup"]), eng("dup-2", ["dup"])],
  alwaysBlock: [],
  personalOrgs: ["mine"],
  schemaVersion: 2,
} as unknown as Registry;

describe("callers see the inferred class", () => {
  let restoreGitEnv: () => void;
  let root: string;
  let markers: string;
  let priorHome: string | undefined;

  function git(cwd: string, ...args: string[]): void {
    execFileSync("git", args, { cwd, stdio: "ignore" });
  }
  function repo(name: string, origin: string, config: Record<string, string> = {}): string {
    const dir = join(root, name);
    mkdirSync(dir);
    git(dir, "init", "-q");
    git(dir, "remote", "add", "origin", origin);
    for (const [k, v] of Object.entries(config)) git(dir, "config", k, v);
    return dir;
  }

  before(() => {
    restoreGitEnv = scrubGitEnv();
    root = mkdtempSync(join(tmpdir(), "repo-inference-callers-"));
    markers = join(root, "markers");
    mkdirSync(markers);
    writeFileSync(join(markers, "_always.txt"), "always-secret\n");
    writeFileSync(join(markers, "_self_identity.txt"), "own-company-codename\n");
    writeFileSync(join(markers, "org-a.txt"), "org-a-secret\n");
    writeFileSync(join(markers, "org-b.txt"), "org-b-secret\n");
    priorHome = process.env["REPO_AEGIS_HOME"];
    process.env["REPO_AEGIS_HOME"] = join(root, "home");
  });
  after(() => {
    if (priorHome === undefined) delete process.env["REPO_AEGIS_HOME"];
    else process.env["REPO_AEGIS_HOME"] = priorHome;
    restoreGitEnv();
    rmSync(root, { recursive: true, force: true });
  });

  const stems = (cfg: ReturnType<typeof readEffectiveRepoConfig>) =>
    computeDenySet(cfg, { markersDir: markers }).files.map(f => f.stem).sort();

  it("the deny set: the engagement's own markers and id are allowed in its own repo; others, always and self-identity are not", () => {
    const dir = repo("lib", "https://github.com/org-a/lib.git");
    const eff = readEffectiveRepoConfig(dir, REGISTRY);
    assert.deepEqual(stems(eff), ["_always", "_self_identity", "org-b"]);
    const set = computeDenySet(eff, { markersDir: markers });
    // The blocker of the field report: the engagement's own id, which a cross-repository `uses:` line must name.
    assert.equal(set.patterns.some(p => /org-a/i.test(p)), false);
    assert.equal(set.patterns.some(p => /org-b/i.test(p)), true);
  });

  it("without the registry the same repo stays private-strict and blocks the engagement's own id (the bug)", () => {
    const dir = repo("lib-raw", "https://github.com/org-a/lib.git");
    const raw = readEffectiveRepoConfig(dir, null);
    assert.deepEqual(stems(raw), ["_always", "org-a", "org-b"]);
  });

  it("an explicit class is judged as declared, whatever the remote says", () => {
    const dir = repo("declared", "https://github.com/org-a/lib.git", { "repo-aegis.class": "private-strict" });
    assert.deepEqual(stems(readEffectiveRepoConfig(dir, REGISTRY)), ["_always", "org-a", "org-b"]);
  });

  it("trust boundary: the engagement's orgs, no remote fallback", () => {
    const dir = repo("boundary", "https://github.com/org-a/lib.git");
    const b = computeTrustBoundary(dir, REGISTRY);
    assert.deepEqual([...b.orgs], ["org-a"]);
    assert.equal(b.fromRemoteFallback, false);
    assert.equal(b.class, "customer-coupled");
    assert.equal(b.classExplicit, false);
  });

  it("trust boundary of an unclassified repo in an unknown org is unchanged: the remote fallback", () => {
    const dir = repo("boundary-unknown", "https://github.com/stranger/lib.git");
    const b = computeTrustBoundary(dir, REGISTRY);
    assert.deepEqual([...b.orgs], ["stranger"]);
    assert.equal(b.fromRemoteFallback, true);
  });

  const intent = (c: string) => parseEgressIntents(c)[0]!;

  it("a push and a `gh --repo` call to the same repository are judged under the same class", () => {
    const dir = repo("same", "https://github.com/org-a/same.git");
    const elsewhere = repo("elsewhere", "https://github.com/mine/x.git", { "repo-aegis.class": "private-strict" });
    const viaPush = resolveDestinationOffline(intent("git push origin main"), dir, REGISTRY);
    const viaGh = resolveDestinationOffline(intent("gh pr create -t x -b y --repo org-a/same"), elsewhere, REGISTRY);
    assert.equal(viaPush?.class, "customer-coupled");
    assert.equal(viaGh?.class, "customer-coupled");
    assert.deepEqual(viaPush?.engagements, ["org-a"]);
    assert.deepEqual(viaGh?.engagements, ["org-a"]);
    assert.equal(viaPush?.inferredFromRegistry, true);
  });

  it("an org in two engagements is private-strict on both paths, never customer-coupled on one", () => {
    const dir = repo("dup", "https://github.com/dup/lib.git");
    const elsewhere = repo("elsewhere2", "https://github.com/mine/y.git", { "repo-aegis.class": "private-strict" });
    const viaPush = resolveDestinationOffline(intent("git push origin main"), dir, REGISTRY);
    const viaGh = resolveDestinationOffline(intent("gh pr create -t x -b y --repo dup/lib"), elsewhere, REGISTRY);
    assert.equal(viaPush?.class, "private-strict");
    assert.equal(viaGh?.class, "private-strict");
    assert.equal(viaGh?.inferredFromRegistry, undefined);
  });

  it("allow / deny still write and unset git config on an inferred repo (the raw reader is what they use)", () => {
    const dir = repo("mutators", "https://github.com/org-a/lib.git");
    assert.equal(readEffectiveRepoConfig(dir, REGISTRY).classInferred, true);
    assert.deepEqual(addEngagements(["org-a"], dir), ["org-a"]);
    assert.deepEqual(readRepoConfig(dir).engagements, ["org-a"]);
    assert.equal(removeEngagement("org-a", dir), true);
    assert.deepEqual(readRepoConfig(dir).engagements, []);
    assert.equal(removeEngagement("org-a", dir), false);
  });
});
