// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureOutput, withEnv } from "../_test-utils.js";
import { approve, type ApproveOptions } from "./approve.js";
import { approvalsPath, listApprovals } from "@de-otio/repo-aegis-core";

const T0 = new Date("2026-09-12T18:00:00.000Z");

describe("approve", () => {
  let root: string;
  let path: string;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "repo-aegis-approve-"));
    path = approvalsPath(join(root, "home"));
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  function run(target: string | undefined, opts: Partial<ApproveOptions> = {}) {
    // REPO_AEGIS_HOME so the audit writer stays inside the fixture.
    return withEnv("REPO_AEGIS_HOME", join(root, "home"), () =>
      withEnv("REPO_AEGIS_EGRESS_HUMAN", "1", () =>
        captureOutput(() => approve(target, { path, now: () => T0, stderrIsTTY: true, ...opts })),
      ),
    );
  }

  it("refuses to mint without a TTY — and the env escape does not help", () => {
    const r = run("acme/svc", { stderrIsTTY: false, json: true });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /APPROVE_NEEDS_TTY/);
    assert.match(r.stderr, /never mint its own approval/);
    assert.deepEqual(listApprovals(path, T0), []);
  });

  it("mints with the default TTL and prints the id, scope and expiry", () => {
    const r = run("Acme/Svc", { json: true });
    assert.equal(r.exitCode, undefined, r.stderr);
    const j = JSON.parse(r.stdout) as { approval: { id: string; org: string; repo: string; expiresAt: string } };
    assert.equal(j.approval.org, "acme");
    assert.equal(j.approval.repo, "svc");
    assert.equal(j.approval.expiresAt, "2026-09-12T18:15:00.000Z");
    const text = run("acme/svc");
    assert.match(text.stdout, /repo-aegis approve: [0-9a-f]{8}  acme\/svc  by /);
    assert.match(text.stdout, /rule g only/);
  });

  it("honours --ttl and --ref, and refuses a TTL over a day or an unparseable one", () => {
    const r = run("acme/*", { ttl: "2h", ref: "refs/tags/v1.2.3", json: true });
    const j = JSON.parse(r.stdout) as { approval: { repo: string; ref?: string; expiresAt: string } };
    assert.equal(j.approval.repo, "*");
    assert.equal(j.approval.ref, "v1.2.3");
    assert.equal(j.approval.expiresAt, "2026-09-12T20:00:00.000Z");
    assert.equal(run("acme/svc", { ttl: "2d", json: true }).exitCode, 2);
    assert.equal(run("acme/svc", { ttl: "soon", json: true }).exitCode, 2);
  });

  it("refuses a target it cannot parse, and no target at all", () => {
    for (const bad of ["acme", "*/svc", "https://github.com/acme/svc", "a/b/c"]) {
      const r = run(bad, { json: true });
      assert.equal(r.exitCode, 2, bad);
      assert.match(r.stderr, /USAGE/);
    }
    assert.equal(run(undefined, { json: true }).exitCode, 2);
    assert.equal(run("   ", { json: true }).exitCode, 2);
  });

  it("--list shows live approvals; --revoke removes one or all", () => {
    const list = run(undefined, { list: true, json: true });
    const live = (JSON.parse(list.stdout) as { list: Array<{ id: string }> }).list;
    assert.ok(live.length >= 2);
    const one = run(undefined, { revoke: live[0]!.id, json: true });
    assert.deepEqual((JSON.parse(one.stdout) as { revoked: string[] }).revoked, [live[0]!.id]);
    const all = run(undefined, { revoke: "all", json: true });
    assert.equal((JSON.parse(all.stdout) as { revoked: string[] }).revoked.length, live.length - 1);
    assert.match(run(undefined, { list: true }).stdout, /no live approvals/);
    // --list and --revoke need no TTY: they publish nothing.
    assert.equal(run(undefined, { list: true, stderrIsTTY: false, json: true }).exitCode, undefined);
  });
});

describe("approve — mint-time scope warnings (issue #151, D7, plan §3.2/§3.9)", () => {
  let root: string;
  let path: string;
  const OWNERS_REGISTRY =
    "schemaVersion: 2\n" +
    "personalOrgs: [acme]\n" +
    "allowedUpstreams: [upstream-org/lib]\n" +
    "engagements:\n" +
    "  - id: customer-a\n" +
    "    name: Customer A\n" +
    "    started: '2026-01-01'\n" +
    "    markers: []\n" +
    "    githubOrgs: [customer-a-org]\n";
  const NO_PERSONAL_REGISTRY = "schemaVersion: 2\nengagements: []\n";

  before(() => {
    root = mkdtempSync(join(tmpdir(), "repo-aegis-approve-warn-"));
    path = approvalsPath(join(root, "home"));
    writeFileSync(join(root, "owners.yaml"), OWNERS_REGISTRY);
    writeFileSync(join(root, "no-personal.yaml"), NO_PERSONAL_REGISTRY);
    writeFileSync(join(root, "damaged.yaml"), "engagements: [unclosed\n");
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  function run(target: string, registry: string, opts: Partial<ApproveOptions> = {}) {
    return withEnv("REPO_AEGIS_HOME", join(root, "home"), () =>
      captureOutput(() =>
        approve(target, { path, now: () => T0, stderrIsTTY: true, registryPath: join(root, registry), ...opts }),
      ),
    );
  }

  function warningsOf(target: string, registry: string): string[] {
    const r = run(target, registry, { json: true });
    assert.equal(r.exitCode, undefined, r.stderr);
    return (JSON.parse(r.stdout) as { warnings?: string[] }).warnings ?? [];
  }

  it("`approve '*'` says it covers personalOrgs and npm publish only, in text and JSON", () => {
    const text = run("*", "owners.yaml");
    assert.equal(text.exitCode, undefined, text.stderr);
    assert.match(text.stdout, /warning: '\*' now covers repositories under your personalOrgs/);
    assert.match(text.stdout, /npm publish/);
    assert.match(text.stdout, /not cover customer orgs, allowed upstreams or unregistered owners/);
    const w = warningsOf("*", "owners.yaml");
    assert.equal(w.length, 1);
    assert.match(w[0]!, /personalOrgs/);
  });

  it("`approve '*'` with no personalOrgs says it currently covers npm publish only", () => {
    for (const registry of ["no-personal.yaml", "absent.yaml"]) {
      const w = warningsOf("*", registry);
      assert.equal(w.length, 2, registry);
      assert.match(w[1]!, /declares no personalOrgs, so '\*' currently covers npm publish only/);
      assert.match(w[1]!, /engagements add --personal-org <login>/);
    }
  });

  it("`approve <org>/*` for an unregistered org warns that rule h will still refuse, and how a person registers it", () => {
    const w = warningsOf("stranger/*", "owners.yaml");
    assert.equal(w.length, 1);
    assert.match(w[0]!, /"stranger" is not a registered owner/);
    assert.match(w[0]!, /rule h \(UNREGISTERED_OWNER_EGRESS\) will still refuse non-interactive egress there/);
    assert.match(w[0]!, /engagements add --personal-org stranger \(or --github-org stranger/);
    assert.ok(!/upstreams add/.test(w[0]!), "an org-wide approval is not an upstream");
    const text = run("stranger/*", "owners.yaml");
    assert.match(text.stdout, /warning: "stranger" is not a registered owner/);
  });

  it("`approve <org>/<repo>` for an unregistered org also offers `upstreams add <org>/<repo>`", () => {
    const w = warningsOf("Stranger/Repo", "owners.yaml");
    assert.equal(w.length, 1);
    assert.match(w[0]!, /upstreams add stranger\/repo/);
  });

  it("no warning for registered owners, an exact allowed upstream, or when rule h is inert", () => {
    assert.deepEqual(warningsOf("acme/svc", "owners.yaml"), []);
    assert.deepEqual(warningsOf("acme/*", "owners.yaml"), []);
    assert.deepEqual(warningsOf("customer-a-org/*", "owners.yaml"), []);
    assert.deepEqual(warningsOf("upstream-org/lib", "owners.yaml"), []);
    // The upstream's siblings are NOT admitted by the exact entry: warn.
    assert.equal(warningsOf("upstream-org/other", "owners.yaml").length, 1);
    // No registry file, or a registry with no owners: rule h does not run, nothing to warn about.
    assert.deepEqual(warningsOf("stranger/*", "absent.yaml"), []);
    assert.deepEqual(warningsOf("stranger/*", "no-personal.yaml"), []);
  });

  it("an unreadable registry gets a content-free warning that no approval helps until it is repaired", () => {
    const w = warningsOf("acme/svc", "damaged.yaml");
    assert.equal(w.length, 1);
    assert.match(w[0]!, /registry could not be read/);
    assert.match(w[0]!, /will not help before then/);
  });

  it("never lists registry contents: the warning for one owner names no other owner, engagement or upstream", () => {
    for (const target of ["stranger/*", "stranger/repo", "*"]) {
      const text = run(target, "owners.yaml").stdout;
      for (const secret of ["acme", "customer-a", "Customer A", "upstream-org"]) {
        assert.ok(!text.includes(secret), `${target}: ${JSON.stringify(secret)} leaked into: ${text}`);
      }
    }
  });

  it("names only what the person typed, and only if it passes safeDestination (no echo of a malformed name)", () => {
    // parseApprovalTarget already accepts `.`/`_` in an org; GitHub owners cannot contain them.
    for (const bad of ["bad_org/*", "bad.org/repo", "-/*"]) {
      const r = run(bad, "owners.yaml", { json: true });
      assert.equal(r.exitCode, undefined, `${bad}: ${r.stderr}`);
      const j = JSON.parse(r.stdout) as { warnings?: string[] };
      assert.deepEqual(j.warnings ?? [], [], bad);
      const text = run(bad, "owners.yaml").stdout;
      assert.ok(!/warning|engagements add|upstreams add/.test(text), `${bad}: ${text}`);
    }
  });

  it("still refuses without a TTY before reading any registry or printing a warning", () => {
    const r = run("stranger/*", "owners.yaml", { stderrIsTTY: false, json: true });
    assert.equal(r.exitCode, 2);
    assert.ok(!/warning/.test(r.stdout));
  });
});
