// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureOutput, withEnv } from "../_test-utils.js";
import { approve, type ApproveOptions } from "./approve.js";
import { approvalsPath, auditLogPath, listApprovals, listPromptApprovals, recordPromptApproval } from "@de-otio/repo-aegis-core";

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
  it("--list shows the source of both kinds (text and JSON), prompt ones in seconds; --revoke p… and --revoke all cover them", () => {
    const home = join(root, "home");
    run(undefined, { revoke: "all", json: true });
    run("acme/term", { json: true });
    const p1 = recordPromptApproval({
      binding: { verb: "git-push", org: "acme", repo: "svc", ref: "main" },
      permissionMode: "default",
      home,
      now: T0,
    })!;
    const p2 = recordPromptApproval({
      binding: { verb: "gh-api-mutating", org: "acme", repo: "svc", endpoint: "repos/acme/svc/issues", method: "POST" },
      permissionMode: "acceptEdits",
      home,
      now: T0,
    })!;

    const json = JSON.parse(run(undefined, { list: true, json: true }).stdout) as { list: Array<{ id: string; source: string; verb?: string }> };
    assert.deepEqual(
      json.list.map(a => a.source).sort(),
      ["prompt", "prompt", "terminal"],
      "every entry carries its source, terminal ones included",
    );
    assert.equal(json.list.find(a => a.id === p1.id)?.verb, "git-push");

    const text = run(undefined, { list: true }).stdout;
    assert.match(text, /3 live approval\(s\)/);
    assert.match(text, /acme\/term  by .*  source terminal  expires /);
    assert.match(text, new RegExp(`${p1.id}  acme/svc \\(ref main\\)  by .*  source prompt  verb git-push  expires .*\\(120 s left\\)`));
    assert.match(text, /\(endpoint repos\/acme\/svc\/issues\)  by .*  source prompt  verb gh-api-mutating/);

    const one = run(undefined, { revoke: p1.id, json: true });
    assert.deepEqual((JSON.parse(one.stdout) as { revoked: string[] }).revoked, [p1.id]);
    assert.deepEqual(listPromptApprovals(home, T0).map(a => a.id), [p2.id]);
    assert.equal(listApprovals(path, T0).length, 1, "the terminal approval is untouched");

    const all = run(undefined, { revoke: "all", json: true });
    assert.equal((JSON.parse(all.stdout) as { revoked: string[] }).revoked.length, 2);
    assert.deepEqual(listPromptApprovals(home, T0), []);
    assert.match(run(undefined, { list: true }).stdout, /no live approvals/);
  });

  it("--revoke prompt removes the prompt approvals only: terminal ones stay (text and JSON)", () => {
    const home = join(root, "home");
    run(undefined, { revoke: "all", json: true });
    const t = JSON.parse(run("acme/keep", { json: true }).stdout) as { approval: { id: string } };
    const p1 = recordPromptApproval({ binding: { verb: "gh-pr-create", org: "acme", repo: "svc" }, permissionMode: "default", home, now: T0 })!;
    const p2 = recordPromptApproval({ binding: { verb: "git-push", org: "acme", repo: "svc", ref: "main" }, permissionMode: "acceptEdits", home, now: T0 })!;
    const j = JSON.parse(run(undefined, { revoke: "prompt", json: true }).stdout) as { revoked: string[] };
    assert.deepEqual([...j.revoked].sort(), [p1.id, p2.id].sort());
    assert.deepEqual(listPromptApprovals(home, T0), []);
    assert.deepEqual(listApprovals(path, T0).map(a => a.id), [t.approval.id]);
    assert.match(run(undefined, { revoke: "prompt" }).stdout, /revoked 0 approval\(s\)/);
    run(undefined, { revoke: "all", json: true });
  });

  it("a minted terminal approval is audited with source terminal", () => {
    const home = join(root, "home");
    mkdirSync(join(home, "state"), { recursive: true });
    writeFileSync(join(home, "state", "audit-log.json"), JSON.stringify({ enabled: true }));
    run("acme/audited", { json: true });
    const lines = readFileSync(auditLogPath(home), "utf8").trim().split("\n");
    const mint = lines.map(l => JSON.parse(l) as { action: string; details: Record<string, unknown> }).find(l => l.action === "egress-approval-mint");
    assert.equal(mint?.details["source"], "terminal");
    rmSync(join(home, "state", "audit-log.json"), { force: true });
    run(undefined, { revoke: "all", json: true });
  });

  it("records the mapped person's login and prints it; a '*' approval and an unmapped owner carry none", () => {
    const reg = join(root, "identities.yaml");
    writeFileSync(
      reg,
      "schemaVersion: 3\nidentities:\n  alice: { kind: gh-login, login: alice }\n  bot: { kind: github-app, app: example-bot }\n" +
        "personalOrgs:\n  - { name: example-org, person: alice, agent: bot }\n  - { name: bot-only, agent: bot }\n  - plain-org\nengagements: []\n",
    );
    const mapped = run("example-org/svc", { registryPath: reg, json: true });
    assert.equal(mapped.exitCode, undefined, mapped.stderr);
    assert.equal((JSON.parse(mapped.stdout) as { approval: { login?: string } }).approval.login, "alice");
    const text = run("example-org/*", { registryPath: reg });
    assert.match(text.stdout, /example-org\/\*  as alice  by /);
    assert.match(text.stdout, /bound to the GitHub account alice/);
    for (const target of ["*", "plain-org/x", "bot-only/x", "unknown-org/x"]) {
      const r = run(target, { registryPath: reg, json: true });
      assert.equal((JSON.parse(r.stdout) as { approval: { login?: string } }).approval.login, undefined, target);
    }
    const listed = run(undefined, { registryPath: reg, list: true });
    assert.match(listed.stdout, /as alice/);
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
    writeFileSync(join(root, "newer.yaml"), "schemaVersion: 99\nengagements: []\n");
    writeFileSync(join(root, "encrypted.yaml.age"), "age-encryption.org/v1\n");
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
    assert.match(w[0]!, /registry does not parse or validate/);
    assert.match(w[0]!, /will not help before then/);
    assert.doesNotMatch(w[0]!, /encrypt/);
  });

  it("a registry from a newer repo-aegis says to upgrade, not to repair", () => {
    const w = warningsOf("acme/svc", "newer.yaml");
    assert.equal(w.length, 1);
    assert.match(w[0]!, /written by a newer repo-aegis/);
    assert.match(w[0]!, /upgrades repo-aegis/);
  });

  it("an encrypted registry gets its own sentence: rule h is off while it is encrypted, and no 'could not be read' text", () => {
    for (const target of ["acme/svc", "stranger/*"]) {
      const w = warningsOf(target, "encrypted.yaml");
      assert.equal(w.length, 1, target);
      assert.match(w[0]!, /Rule h is off while the registry is encrypted/);
      assert.doesNotMatch(w[0]!, /could not be read|damaged/);
    }
    const star = warningsOf("*", "encrypted.yaml");
    assert.ok(star.some(n => /rule h is off while it is encrypted/.test(n)), star.join("|"));
    assert.ok(!star.some(n => /declares no personalOrgs/.test(n)), "an encrypted registry is not an empty one");
  });

  it("never lists registry contents: the warning for one owner names no other owner, engagement or upstream", () => {
    for (const target of ["stranger/*", "stranger/repo", "*"]) {
      const text = run(target, "owners.yaml").stdout;
      for (const secret of ["acme", "customer-a", "Customer A", "upstream-org"]) {
        assert.ok(!text.includes(secret), `${target}: ${JSON.stringify(secret)} leaked into: ${text}`);
      }
    }
  });

  it("refuses to mint for a name that is not a plausible GitHub owner/repo (it could never match), with no warning or command", () => {
    // GitHub owners cannot contain `_` or `.`, or start with `-`; such an approval would never match.
    const before = listApprovals(path, T0).length;
    for (const bad of ["bad_org/*", "bad.org/repo", "-/*", `${"a".repeat(40)}/*`, "acme/..", "Korp/*"]) {
      const r = run(bad, "owners.yaml", { json: true });
      assert.equal(r.exitCode, 2, `${bad}: ${r.stdout}`);
      assert.match(r.stderr, /USAGE/, bad);
      assert.ok(!/engagements add|upstreams add/.test(r.stdout + r.stderr), bad);
    }
    assert.equal(listApprovals(path, T0).length, before, "nothing was minted");
  });

  it("`approve <owner>/*` for an unregistered owner that has an allowed upstream says it covers only that owner's upstream repos, PR/issue verbs only, without naming the upstream", () => {
    const w = warningsOf("upstream-org/*", "owners.yaml");
    assert.equal(w.length, 1);
    assert.match(w[0]!, /covers only that owner's allowed upstream repositories, and only for PR and issue verbs/);
    assert.match(w[0]!, /everything else under it stays refused by rule h/);
    assert.ok(!w[0]!.includes("lib"), w[0]!);
    assert.ok(!/engagements add/.test(w[0]!), "no misleading 'register it' command for the softened case");
  });

  it("still refuses without a TTY before reading any registry or printing a warning", () => {
    const r = run("stranger/*", "owners.yaml", { stderrIsTTY: false, json: true });
    assert.equal(r.exitCode, 2);
    assert.ok(!/warning/.test(r.stdout));
  });

});
