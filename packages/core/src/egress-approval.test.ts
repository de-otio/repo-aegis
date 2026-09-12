// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { closeSync, fstatSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  approvalsPath,
  findApproval,
  listApprovals,
  mintApproval,
  normaliseRef,
  parseApprovalTarget,
  parseTtl,
  readApprovalStore,
  revokeApprovals,
  DEFAULT_APPROVAL_TTL_MS,
  MAX_APPROVAL_TTL_MS,
} from "./egress-approval.js";

const T0 = new Date("2026-09-12T18:00:00.000Z");
const plus = (ms: number) => new Date(T0.getTime() + ms);

describe("parseTtl / parseApprovalTarget / normaliseRef", () => {
  it("durations", () => {
    assert.equal(parseTtl("15m"), 15 * 60_000);
    assert.equal(parseTtl("2h"), 2 * 3_600_000);
    assert.equal(parseTtl("90s"), 90_000);
    assert.equal(parseTtl("1d"), 86_400_000);
    assert.equal(parseTtl("10"), 10 * 60_000); // bare number = minutes
    assert.equal(parseTtl("  15m  "), 15 * 60_000); // trimmed, not matched with \s* runs
    for (const bad of ["", "0m", "-5m", "soon", "1w", "1.5.3h", "15 m"]) assert.equal(parseTtl(bad), null, bad);
    // js/polynomial-redos: a long run of tabs after a digit must not backtrack.
    const started = Date.now();
    assert.equal(parseTtl("0" + "\t".repeat(50_000) + "!"), null);
    assert.ok(Date.now() - started < 500, "parseTtl must not backtrack on adversarial whitespace");
  });

  it("targets", () => {
    assert.deepEqual(parseApprovalTarget("Acme/Svc"), { org: "acme", repo: "svc" });
    assert.deepEqual(parseApprovalTarget("acme/*"), { org: "acme", repo: "*" });
    assert.deepEqual(parseApprovalTarget("*"), { org: "*", repo: "*" });
    assert.deepEqual(parseApprovalTarget("acme/svc.git"), { org: "acme", repo: "svc" });
    for (const bad of ["acme", "*/svc", "a/b/c", "https://github.com/acme/svc", "ac me/svc", ""]) {
      assert.equal(parseApprovalTarget(bad), null, bad);
    }
  });

  it("refs", () => {
    assert.equal(normaliseRef("refs/heads/main"), "main");
    assert.equal(normaliseRef("refs/tags/v1.0"), "v1.0");
    assert.equal(normaliseRef("+main:main"), "main");
    assert.equal(normaliseRef("main"), "main");
  });
});

describe("approval store", () => {
  let root: string;
  let path: string;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "egress-approval-"));
    path = approvalsPath(join(root, "home"));
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it("path and empty reads", () => {
    assert.equal(path, join(root, "home", "egress-approvals.json"));
    assert.deepEqual(readApprovalStore(path), { version: 1, approvals: [] });
    assert.deepEqual(listApprovals(path, T0), []);
    assert.equal(findApproval({ org: "acme", repo: "svc" }, undefined, path, T0), null);
  });

  it("mint: default TTL, 0600, by, id; found for the destination", () => {
    const a = mintApproval({ target: { org: "acme", repo: "svc" }, path, now: T0, by: "op" });
    assert.match(a.id, /^[0-9a-f]{8}$/);
    assert.equal(a.expiresAt, plus(DEFAULT_APPROVAL_TTL_MS).toISOString());
    assert.equal(a.by, "op");
    const fd = openSync(path, "r");
    try {
      assert.equal(fstatSync(fd).mode & 0o777, 0o600);
    } finally {
      closeSync(fd);
    }
    assert.equal(findApproval({ org: "ACME", repo: "SVC" }, undefined, path, T0)?.id, a.id);
    assert.equal(findApproval({ org: "acme", repo: "svc" }, "refs/heads/main", path, T0)?.id, a.id);
    assert.equal(findApproval({ org: "acme", repo: "other" }, undefined, path, T0), null);
    assert.equal(findApproval({ org: "other", repo: "svc" }, undefined, path, T0), null);
  });

  it("TTL is capped at a day", () => {
    const a = mintApproval({ target: { org: "acme", repo: "capped" }, ttlMs: 10 * MAX_APPROVAL_TTL_MS, path, now: T0 });
    assert.equal(a.expiresAt, plus(MAX_APPROVAL_TTL_MS).toISOString());
  });

  it("expires: found one second before, gone one second after", () => {
    const a = mintApproval({ target: { org: "acme", repo: "ttl" }, ttlMs: 60_000, path, now: T0 });
    assert.equal(findApproval({ org: "acme", repo: "ttl" }, undefined, path, plus(59_000))?.id, a.id);
    assert.equal(findApproval({ org: "acme", repo: "ttl" }, undefined, path, plus(61_000)), null);
  });

  it("a ref-scoped approval matches that ref only, and never a command without one", () => {
    const a = mintApproval({ target: { org: "acme", repo: "ref" }, ref: "refs/heads/release", path, now: T0 });
    assert.equal(a.ref, "release");
    assert.equal(findApproval({ org: "acme", repo: "ref" }, "release", path, T0)?.id, a.id);
    assert.equal(findApproval({ org: "acme", repo: "ref" }, "refs/heads/release", path, T0)?.id, a.id);
    assert.equal(findApproval({ org: "acme", repo: "ref" }, "main", path, T0), null);
    assert.equal(findApproval({ org: "acme", repo: "ref" }, undefined, path, T0), null);
  });

  it("org and global wildcards", () => {
    const org = mintApproval({ target: { org: "wild", repo: "*" }, path, now: T0 });
    assert.equal(findApproval({ org: "wild", repo: "anything" }, "x", path, T0)?.id, org.id);
    assert.equal(findApproval({ org: "elsewhere", repo: "anything" }, "x", path, T0), null);
    const all = mintApproval({ target: { org: "*", repo: "*" }, path, now: T0 });
    assert.equal(findApproval({ org: "elsewhere", repo: "anything" }, "x", path, T0)?.id, all.id);
    // A destination-less command (npm publish) is covered by `*` only.
    assert.equal(findApproval({ org: "*", repo: "*" }, undefined, path, T0)?.id, all.id);
    revokeApprovals(all.id, path);
    assert.equal(findApproval({ org: "*", repo: "*" }, undefined, path, T0), null);
  });

  it("revoke one, revoke all; minting drops expired entries", () => {
    const keep = mintApproval({ target: { org: "acme", repo: "keep" }, path, now: T0 });
    const gone = mintApproval({ target: { org: "acme", repo: "gone" }, path, now: T0 });
    assert.deepEqual(revokeApprovals(gone.id, path), [gone.id]);
    assert.equal(findApproval({ org: "acme", repo: "gone" }, undefined, path, T0), null);
    assert.equal(findApproval({ org: "acme", repo: "keep" }, undefined, path, T0)?.id, keep.id);
    // Expired entries are pruned on the next mint.
    mintApproval({ target: { org: "acme", repo: "later" }, path, now: plus(2 * 86_400_000) });
    assert.equal(readApprovalStore(path).approvals.some(a => a.id === keep.id), false);
    assert.ok(revokeApprovals("all", path).length >= 1);
    assert.deepEqual(readApprovalStore(path).approvals, []);
  });

  it("a malformed store is no approval; malformed entries are dropped individually", () => {
    const bad = join(root, "bad.json");
    writeFileSync(bad, "{nope");
    assert.equal(findApproval({ org: "acme", repo: "svc" }, undefined, bad, T0), null);
    writeFileSync(
      bad,
      JSON.stringify({
        version: 1,
        approvals: [
          { id: "ok000000", org: "acme", repo: "svc", createdAt: T0.toISOString(), expiresAt: plus(60_000).toISOString(), by: "op" },
          { id: "bad", org: "acme" },
          "nonsense",
        ],
      }),
    );
    assert.equal(findApproval({ org: "acme", repo: "svc" }, undefined, bad, T0)?.id, "ok000000");
    assert.equal(readApprovalStore(bad).approvals.length, 1);
  });
});
