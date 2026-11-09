// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { closeSync, fstatSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  approvalScopeOf,
  approvalsPath,
  findApproval,
  findLoginApproval,
  findAccountBoundApproval,
  findUncoveringStarApproval,
  starApprovalCovers,
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
/** A scope with no personal orgs: `*` covers nothing that names a destination. */
const SCOPE = approvalScopeOf({});
const DESTINATIONLESS = approvalScopeOf({}, true);

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
    assert.equal(findApproval({ org: "acme", repo: "svc" }, undefined, SCOPE, path, T0), null);
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
    assert.equal(findApproval({ org: "ACME", repo: "SVC" }, undefined, SCOPE, path, T0)?.id, a.id);
    assert.equal(findApproval({ org: "acme", repo: "svc" }, "refs/heads/main", SCOPE, path, T0)?.id, a.id);
    assert.equal(findApproval({ org: "acme", repo: "other" }, undefined, SCOPE, path, T0), null);
    assert.equal(findApproval({ org: "other", repo: "svc" }, undefined, SCOPE, path, T0), null);
  });

  it("TTL is capped at a day", () => {
    const a = mintApproval({ target: { org: "acme", repo: "capped" }, ttlMs: 10 * MAX_APPROVAL_TTL_MS, path, now: T0 });
    assert.equal(a.expiresAt, plus(MAX_APPROVAL_TTL_MS).toISOString());
  });

  it("expires: found one second before, gone one second after", () => {
    const a = mintApproval({ target: { org: "acme", repo: "ttl" }, ttlMs: 60_000, path, now: T0 });
    assert.equal(findApproval({ org: "acme", repo: "ttl" }, undefined, SCOPE, path, plus(59_000))?.id, a.id);
    assert.equal(findApproval({ org: "acme", repo: "ttl" }, undefined, SCOPE, path, plus(61_000)), null);
  });

  it("a ref-scoped approval matches that ref only, and never a command without one", () => {
    const a = mintApproval({ target: { org: "acme", repo: "ref" }, ref: "refs/heads/release", path, now: T0 });
    assert.equal(a.ref, "release");
    assert.equal(findApproval({ org: "acme", repo: "ref" }, "release", SCOPE, path, T0)?.id, a.id);
    assert.equal(findApproval({ org: "acme", repo: "ref" }, "refs/heads/release", SCOPE, path, T0)?.id, a.id);
    assert.equal(findApproval({ org: "acme", repo: "ref" }, "main", SCOPE, path, T0), null);
    assert.equal(findApproval({ org: "acme", repo: "ref" }, undefined, SCOPE, path, T0), null);
  });

  it("org wildcard; `*` is not a global wildcard (D7)", () => {
    const org = mintApproval({ target: { org: "wild", repo: "*" }, path, now: T0 });
    assert.equal(findApproval({ org: "wild", repo: "anything" }, "x", SCOPE, path, T0)?.id, org.id);
    assert.equal(findApproval({ org: "elsewhere", repo: "anything" }, "x", SCOPE, path, T0), null);
    const all = mintApproval({ target: { org: "*", repo: "*" }, path, now: T0 });
    // Without the owner in personalOrgs, `*` covers nothing that has a destination.
    assert.equal(findApproval({ org: "elsewhere", repo: "anything" }, "x", SCOPE, path, T0), null);
    const mine = approvalScopeOf({ personalOrgs: ["Elsewhere"] });
    assert.equal(findApproval({ org: "elsewhere", repo: "anything" }, "x", mine, path, T0)?.id, all.id);
    // A destination-less command (npm publish) is covered by `*` only, flagged explicitly.
    assert.equal(findApproval({ org: "*", repo: "*" }, undefined, DESTINATIONLESS, path, T0)?.id, all.id);
    // The `*`/`*` sentinel WITHOUT the flag (a GraphQL mutation) is not covered.
    assert.equal(findApproval({ org: "*", repo: "*" }, undefined, mine, path, T0), null);
    assert.equal(findApproval({ org: "*", repo: "*" }, undefined, SCOPE, path, T0), null);
    revokeApprovals(all.id, path);
    assert.equal(findApproval({ org: "*", repo: "*" }, undefined, DESTINATIONLESS, path, T0), null);
  });

  it("revoke one, revoke all; minting drops expired entries", () => {
    const keep = mintApproval({ target: { org: "acme", repo: "keep" }, path, now: T0 });
    const gone = mintApproval({ target: { org: "acme", repo: "gone" }, path, now: T0 });
    assert.deepEqual(revokeApprovals(gone.id, path), [gone.id]);
    assert.equal(findApproval({ org: "acme", repo: "gone" }, undefined, SCOPE, path, T0), null);
    assert.equal(findApproval({ org: "acme", repo: "keep" }, undefined, SCOPE, path, T0)?.id, keep.id);
    // Expired entries are pruned on the next mint.
    mintApproval({ target: { org: "acme", repo: "later" }, path, now: plus(2 * 86_400_000) });
    assert.equal(readApprovalStore(path).approvals.some(a => a.id === keep.id), false);
    assert.ok(revokeApprovals("all", path).length >= 1);
    assert.deepEqual(readApprovalStore(path).approvals, []);
  });

  it("a malformed store is no approval; malformed entries are dropped individually", () => {
    const bad = join(root, "bad.json");
    writeFileSync(bad, "{nope");
    assert.equal(findApproval({ org: "acme", repo: "svc" }, undefined, SCOPE, bad, T0), null);
    writeFileSync(
      bad,
      JSON.stringify({
        version: 1,
        approvals: [
          { id: "0a000000", org: "acme", repo: "svc", createdAt: T0.toISOString(), expiresAt: plus(60_000).toISOString(), by: "op" },
          { id: "bad", org: "acme" },
          "nonsense",
        ],
      }),
    );
    assert.equal(findApproval({ org: "acme", repo: "svc" }, undefined, SCOPE, bad, T0)?.id, "0a000000");
    assert.equal(readApprovalStore(bad).approvals.length, 1);
  });

  it("L4: an entry whose id is not what a mint produces, or whose expiresAt is not an ISO-8601 timestamp, is ignored", () => {
    const p = join(root, "shape.json");
    const base = { org: "acme", repo: "svc", createdAt: T0.toISOString(), by: "op" };
    const good = { ...base, id: "0a0b0c0d", expiresAt: plus(60_000).toISOString() };
    const bads = [
      { ...good, id: "../../etc" },
      { ...good, id: "0A0B0C0D" }, // upper-case: not what randomBytes().toString("hex") emits
      { ...good, id: "0a0b0c0" }, // short
      { ...good, id: "0a0b0c0d0" }, // long
      { ...good, id: "g00000000".slice(0, 8) }, // non-hex
      { ...good, expiresAt: "2099" }, // Date.parse accepts it, ISO-8601 date-time it is not
      { ...good, expiresAt: "tomorrow" },
      { ...good, expiresAt: "2099-01-01" }, // date only
      { ...good, expiresAt: "2099-01-01T00:00:00" }, // no zone
      { ...good, expiresAt: 4102444800000 }, // a number
    ];
    writeFileSync(p, JSON.stringify({ version: 1, approvals: [...bads, good] }));
    const kept = readApprovalStore(p).approvals;
    assert.deepEqual(kept.map(a => a.id), ["0a0b0c0d"]);
    assert.equal(findApproval({ org: "acme", repo: "svc" }, undefined, SCOPE, p, T0)?.id, "0a0b0c0d");
    // Offset forms of a real timestamp are still accepted.
    writeFileSync(p, JSON.stringify({ version: 1, approvals: [{ ...good, expiresAt: "2026-09-12T20:00:00+02:00" }] }));
    assert.equal(readApprovalStore(p).approvals.length, 1);
    // And whatever a mint writes round-trips.
    const minted = mintApproval({ target: { org: "acme", repo: "round" }, path: p, now: T0 });
    assert.ok(readApprovalStore(p).approvals.some(a => a.id === minted.id));
  });

  it("parseApprovalTarget refuses names that could never match (not plausible GitHub owners/repos)", () => {
    for (const bad of ["bad_org/*", "bad.org/repo", "-/*", `${"a".repeat(40)}/*`, "acme/..", "acme/.", "Korp/*", "acme/" + "r".repeat(101)]) {
      assert.equal(parseApprovalTarget(bad), null, bad);
    }
    assert.deepEqual(parseApprovalTarget("a".repeat(39) + "/" + "r".repeat(100)), {
      org: "a".repeat(39),
      repo: "r".repeat(100),
    });
    assert.deepEqual(parseApprovalTarget("Acme/My.Repo_1-x"), { org: "acme", repo: "my.repo_1-x" });
  });
});

describe("approval form × owner kind (D7, issue #151)", () => {
  // personal: acme · customer: customer-a-org · upstream: upstream-org/lib · unregistered: stranger
  const scope = approvalScopeOf({ personalOrgs: ["acme"], allowedUpstreams: ["upstream-org/lib", "acme/forked-lib"] });
  const OWNERS: Array<[kind: string, org: string, repo: string]> = [
    ["personal", "acme", "repo"],
    ["customer", "customer-a-org", "repo"],
    ["upstream", "upstream-org", "lib"],
    ["upstream's sibling", "upstream-org", "other"],
    ["unregistered", "stranger", "repo"],
    ["upstream inside a personal org", "acme", "forked-lib"],
  ];
  const FORMS: Array<[form: { org: string; repo: string }, covers: readonly string[]]> = [
    // `*` covers personal-org repos only, and not an upstream even inside a personal org.
    [{ org: "*", repo: "*" }, ["personal"]],
    [{ org: "acme", repo: "*" }, ["personal", "upstream inside a personal org"]],
    [{ org: "customer-a-org", repo: "*" }, ["customer"]],
    [{ org: "upstream-org", repo: "*" }, ["upstream", "upstream's sibling"]],
    [{ org: "stranger", repo: "*" }, ["unregistered"]],
    [{ org: "acme", repo: "repo" }, ["personal"]],
    [{ org: "customer-a-org", repo: "repo" }, ["customer"]],
    [{ org: "upstream-org", repo: "lib" }, ["upstream"]],
    [{ org: "stranger", repo: "repo" }, ["unregistered"]],
    [{ org: "acme", repo: "forked-lib" }, ["upstream inside a personal org"]],
  ];

  it("each form covers exactly the owner kinds it should, and `*` covers personal orgs only", () => {
    const root = mkdtempSync(join(tmpdir(), "egress-approval-matrix-"));
    try {
      for (const [form, covers] of FORMS) {
        const p = join(root, `${form.org}-${form.repo.replaceAll("*", "star")}.json`);
        const minted = mintApproval({ target: form, path: p, now: T0 });
        for (const [kind, org, repo] of OWNERS) {
          const found = findApproval({ org, repo }, undefined, scope, p, T0);
          const label = `${form.org}/${form.repo} vs ${kind} (${org}/${repo})`;
          if (covers.includes(kind)) assert.equal(found?.id, minted.id, label);
          else assert.equal(found, null, label);
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("owner case does not matter on either side", () => {
    const root = mkdtempSync(join(tmpdir(), "egress-approval-case-"));
    try {
      const p = join(root, "a.json");
      const star = mintApproval({ target: { org: "*", repo: "*" }, path: p, now: T0 });
      const upper = approvalScopeOf({ personalOrgs: ["ACME"], allowedUpstreams: ["Upstream-Org/Lib"] });
      assert.equal(findApproval({ org: "AcMe", repo: "Repo" }, undefined, upper, p, T0)?.id, star.id);
      assert.equal(findApproval({ org: "UPSTREAM-ORG", repo: "LIB" }, undefined, upper, p, T0), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a destination-less call is covered by `*` alone, never by an <org>/… approval", () => {
    const root = mkdtempSync(join(tmpdir(), "egress-approval-npm-"));
    try {
      const p = join(root, "a.json");
      const none = approvalScopeOf({ personalOrgs: ["acme"] }, true);
      mintApproval({ target: { org: "acme", repo: "*" }, path: p, now: T0 });
      assert.equal(findApproval({ org: "*", repo: "*" }, undefined, none, p, T0), null);
      const star = mintApproval({ target: { org: "*", repo: "*" }, path: p, now: T0 });
      assert.equal(findApproval({ org: "*", repo: "*" }, undefined, none, p, T0)?.id, star.id);
      // Even with an empty registry: `npm publish` was always covered by `*`.
      assert.equal(findApproval({ org: "*", repo: "*" }, undefined, approvalScopeOf({}, true), p, T0)?.id, star.id);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a ref-scoped `*` still needs the ref AND the personal owner", () => {
    const root = mkdtempSync(join(tmpdir(), "egress-approval-starref-"));
    try {
      const p = join(root, "a.json");
      const star = mintApproval({ target: { org: "*", repo: "*" }, ref: "release", path: p, now: T0 });
      assert.equal(findApproval({ org: "acme", repo: "r" }, "release", scope, p, T0)?.id, star.id);
      assert.equal(findApproval({ org: "acme", repo: "r" }, "main", scope, p, T0), null);
      assert.equal(findApproval({ org: "customer-a-org", repo: "r" }, "release", scope, p, T0), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("findUncoveringStarApproval reports a live `*` that does not cover, and why", () => {
    const root = mkdtempSync(join(tmpdir(), "egress-approval-gap-"));
    try {
      const p = join(root, "a.json");
      assert.equal(findUncoveringStarApproval({ org: "customer-a-org", repo: "r" }, undefined, scope, p, T0), null);
      const star = mintApproval({ target: { org: "*", repo: "*" }, path: p, now: T0 });
      const customer = findUncoveringStarApproval({ org: "customer-a-org", repo: "r" }, undefined, scope, p, T0);
      assert.equal(customer?.approval.id, star.id);
      assert.equal(customer?.gap, "not-personal");
      assert.equal(findUncoveringStarApproval({ org: "upstream-org", repo: "lib" }, undefined, scope, p, T0)?.gap, "upstream");
      // Covered, so nothing is "uncovered".
      assert.equal(findUncoveringStarApproval({ org: "acme", repo: "r" }, undefined, scope, p, T0), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("L1: the owner is tested as typed, before lower-casing: `Korp` with U+212A is not `korp`", () => {
    const kelvin = "Korp";
    assert.equal(kelvin.toLowerCase(), "korp", "the premise: lower-casing maps it onto a plain k");
    const korp = approvalScopeOf({ personalOrgs: ["korp"] });
    assert.equal(starApprovalCovers({ org: "korp", repo: "r" }, korp), true, "control: plain spelling is covered");
    assert.equal(starApprovalCovers({ org: kelvin, repo: "r" }, korp), false);
    assert.equal(starApprovalCovers({ org: "korp", repo: "Keep" }, korp), true, "starApprovalCovers judges the owner; findApproval also judges the repo");
    const root = mkdtempSync(join(tmpdir(), "egress-approval-kelvin-"));
    try {
      const p = join(root, "a.json");
      mintApproval({ target: { org: "*", repo: "*" }, path: p, now: T0 });
      mintApproval({ target: { org: "korp", repo: "*" }, path: p, now: T0 });
      assert.notEqual(findApproval({ org: "korp", repo: "r" }, undefined, korp, p, T0), null, "control");
      // Neither the `*` approval nor the `korp/*` approval matches the Kelvin spelling.
      assert.equal(findApproval({ org: kelvin, repo: "r" }, undefined, korp, p, T0), null);
      assert.equal(findApproval({ org: "korp", repo: "Keep" }, undefined, korp, p, T0), null);
      // Other non-ASCII owners likewise.
      assert.equal(findApproval({ org: "kоrp", repo: "r" }, undefined, korp, p, T0), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("login-bound approvals (doc/plan-owner-identity.md N3, A11)", () => {
  function store(fn: (p: string) => void): void {
    const root = mkdtempSync(join(tmpdir(), "egress-approval-login-"));
    try {
      fn(join(root, "a.json"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  const dest = { org: "example-org", repo: "svc" };

  it("records the login on an <org>/<repo> or <org>/* approval, and never on '*'", () => {
    store(p => {
      const a = mintApproval({ target: dest, login: "alice", path: p, now: T0 });
      const b = mintApproval({ target: { org: "example-org", repo: "*" }, login: "alice", path: p, now: T0 });
      const star = mintApproval({ target: { org: "*", repo: "*" }, login: "alice", path: p, now: T0 });
      assert.equal(a.login, "alice");
      assert.equal(b.login, "alice");
      assert.equal(star.login, undefined);
      assert.equal(readApprovalStore(p).approvals.find(x => x.id === star.id)?.login, undefined);
      assert.equal(readApprovalStore(p).approvals.find(x => x.id === a.id)?.login, "alice");
    });
  });

  it("findLoginApproval matches the login (case-insensitively), the repository or the whole owner, and nothing else", () => {
    store(p => {
      const a = mintApproval({ target: dest, login: "alice", path: p, now: T0 });
      assert.equal(findLoginApproval(dest, "alice", p, T0)?.id, a.id);
      assert.equal(findLoginApproval(dest, "ALICE", p, T0)?.id, a.id);
      assert.equal(findLoginApproval(dest, "bob", p, T0), null, "another login");
      assert.equal(findLoginApproval({ org: "example-org", repo: "other" }, "alice", p, T0), null, "another repository");
      assert.equal(findLoginApproval({ org: "other-org", repo: "svc" }, "alice", p, T0), null, "another owner");
      assert.equal(findLoginApproval({ org: "example-org", repo: "*" }, "alice", p, T0), null, "a repo approval does not cover the org");
    });
  });

  it("an approval with no login, a '*' approval, a ref-limited one and an expired one match nothing", () => {
    store(p => {
      mintApproval({ target: dest, path: p, now: T0 });
      mintApproval({ target: { org: "*", repo: "*" }, path: p, now: T0 });
      mintApproval({ target: dest, login: "alice", ref: "main", path: p, now: T0 });
      assert.equal(findLoginApproval(dest, "alice", p, T0), null);
      mintApproval({ target: dest, login: "alice", ttlMs: 1000, path: p, now: T0 });
      assert.equal(findLoginApproval(dest, "alice", p, new Date(T0.getTime() + 2000)), null, "expired");
      assert.notEqual(findLoginApproval(dest, "alice", p, T0), null, "control: live");
    });
  });

  it("findAccountBoundApproval: any login, the repository or the whole owner, nothing else (Phase U, U5)", () => {
    store(p => {
      assert.equal(findAccountBoundApproval(dest, p, T0), null, "no store");
      const a = mintApproval({ target: dest, login: "alice", path: p, now: T0 });
      assert.equal(findAccountBoundApproval(dest, p, T0)?.id, a.id);
      assert.equal(findAccountBoundApproval({ org: "EXAMPLE-ORG", repo: "SVC" }, p, T0)?.id, a.id, "case-insensitive");
      assert.equal(findAccountBoundApproval({ org: "example-org", repo: "other" }, p, T0), null, "another repository");
      assert.equal(findAccountBoundApproval({ org: "other-org", repo: "svc" }, p, T0), null, "another owner");
      assert.equal(findAccountBoundApproval(dest, p, new Date(T0.getTime() + DEFAULT_APPROVAL_TTL_MS + 1)), null, "expired");
    });
    store(p => {
      mintApproval({ target: { org: "example-org", repo: "*" }, login: "bob", path: p, now: T0 });
      assert.notEqual(findAccountBoundApproval(dest, p, T0), null, "<org>/* with a login covers the repository");
    });
  });

  it("findAccountBoundApproval: no login, a '*' approval, a ref-limited one or a non-ASCII owner match nothing", () => {
    store(p => {
      mintApproval({ target: dest, path: p, now: T0 });
      mintApproval({ target: { org: "*", repo: "*" }, path: p, now: T0 });
      mintApproval({ target: dest, login: "alice", ref: "main", path: p, now: T0 });
      assert.equal(findAccountBoundApproval(dest, p, T0), null);
      mintApproval({ target: { org: "korp", repo: "*" }, login: "alice", path: p, now: T0 });
      assert.equal(findAccountBoundApproval({ org: "Korp", repo: "svc" }, p, T0), null, "Kelvin sign is not k");
      assert.notEqual(findAccountBoundApproval({ org: "korp", repo: "svc" }, p, T0), null, "control: ASCII owner matches");
    });
  });

  it("<org>/* approval covers any repository of the owner", () => {
    store(p => {
      mintApproval({ target: { org: "example-org", repo: "*" }, login: "alice", path: p, now: T0 });
      assert.notEqual(findLoginApproval(dest, "alice", p, T0), null);
      assert.notEqual(findLoginApproval({ org: "example-org", repo: "*" }, "alice", p, T0), null);
    });
  });
});
