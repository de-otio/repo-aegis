// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
