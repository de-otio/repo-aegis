// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderMarkers, MARKER_FORMAT_VERSION } from "./render.js";
import { computeDenySet } from "./deny-set.js";
import { PatternValidationError } from "./exceptions.js";

let tmp: string;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "repo-aegis-render-"));
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("renderMarkers", () => {
  it("writes _always.txt and per-engagement files", () => {
    const dir = join(tmp, "case-1");
    mkdirSync(dir, { recursive: true });
    const r = renderMarkers(
      {
        engagements: [
          { id: "customer-a", name: "A", markers: ["acme-corp"] },
          { id: "customer-b", name: "B", markers: ["betaco"] },
        ],
        alwaysBlock: ["PROJECT-CODENAME-ALPHA"],
        schemaVersion: 1,
      },
      { markersDir: dir, flatPath: join(dir, "..", "case-1.flat") },
    );
    assert.equal(r.invalidPatterns.length, 0);
    assert.equal(r.written.length, 3); // _always + 2 engagements
    assert.ok(existsSync(join(dir, "_always.txt")));
    assert.ok(existsSync(join(dir, "customer-a.txt")));
    assert.ok(existsSync(join(dir, "customer-b.txt")));
    const aBody = readFileSync(join(dir, "customer-a.txt"), "utf8");
    assert.match(aBody, /acme-corp/);
    assert.match(aBody, /; engagement: customer-a/);
  });

  it("dry-run writes nothing", () => {
    const dir = join(tmp, "case-dry");
    const r = renderMarkers(
      {
        engagements: [{ id: "customer-a", name: "A", markers: ["acme"] }],
        alwaysBlock: [],
        schemaVersion: 1,
      },
      { markersDir: dir, dryRun: true, flatPath: join(dir, ".flat") },
    );
    assert.ok(!existsSync(dir));
    assert.equal(r.written.length, 2); // _always + 1 engagement listed but not written
  });

  it("rejects bad patterns by throwing PatternValidationError", () => {
    const dir = join(tmp, "case-bad");
    mkdirSync(dir, { recursive: true });
    assert.throws(
      () =>
        renderMarkers(
          {
            engagements: [{ id: "customer-a", name: "A", markers: ["(unclosed"] }],
            alwaysBlock: [],
            schemaVersion: 1,
          },
          { markersDir: dir, flatPath: join(dir, ".flat") },
        ),
      PatternValidationError,
    );
    // verify no files were written
    assert.ok(!existsSync(join(dir, "customer-a.txt")));
  });

  it("removes stale per-engagement files no longer in registry", () => {
    const dir = join(tmp, "case-stale");
    mkdirSync(dir, { recursive: true });
    // Pre-existing stale file
    writeFileSync(join(dir, "old-engagement.txt"), "old-marker");
    const r = renderMarkers(
      {
        engagements: [{ id: "customer-a", name: "A", markers: ["acme"] }],
        alwaysBlock: [],
        schemaVersion: 1,
      },
      { markersDir: dir, flatPath: join(dir, ".flat") },
    );
    assert.ok(r.removed.some(p => p.endsWith("old-engagement.txt")));
    assert.ok(!existsSync(join(dir, "old-engagement.txt")));
  });

  it("excludes engagements past the retention window", () => {
    const dir = join(tmp, "case-retention");
    mkdirSync(dir, { recursive: true });
    const r = renderMarkers(
      {
        engagements: [
          { id: "active", name: "Active", markers: ["foo"] },
          { id: "past-retention", name: "Past", ended: "2020-01-01", markers: ["bar"] },
        ],
        alwaysBlock: [],
        schemaVersion: 1,
      },
      { markersDir: dir, retentionMonths: 12, flatPath: join(dir, ".flat") },
    );
    assert.ok(r.written.some(w => w.engagementId === "active"));
    assert.ok(!r.written.some(w => w.engagementId === "past-retention"));
  });

  it("writes the flat union file", () => {
    const dir = join(tmp, "case-flat");
    mkdirSync(dir, { recursive: true });
    const flat = join(tmp, "flat.txt");
    renderMarkers(
      {
        engagements: [{ id: "a", name: "A", markers: ["acme"] }],
        alwaysBlock: ["PROJECT-X"],
        schemaVersion: 1,
      },
      { markersDir: dir, flatPath: flat },
    );
    assert.ok(existsSync(flat));
    const body = readFileSync(flat, "utf8");
    assert.match(body, /acme/);
    assert.match(body, /PROJECT-X/);
  });

  it("writes the repo-aegis-marker-format header line as a comment", () => {
    const dir = join(tmp, "case-format-header");
    mkdirSync(dir, { recursive: true });
    renderMarkers(
      {
        engagements: [{ id: "customer-a", name: "A", markers: ["foo-marker"] }],
        alwaysBlock: ["GLOBAL-MARKER"],
        schemaVersion: 1,
      },
      { markersDir: dir, flatPath: join(tmp, "case-format-header.flat") },
    );

    const expected = `; repo-aegis-marker-format: ${MARKER_FORMAT_VERSION}`;

    // Per-engagement file: header line is present and is a `;`-comment.
    const engBody = readFileSync(join(dir, "customer-a.txt"), "utf8");
    assert.ok(
      engBody.includes(expected),
      `expected per-engagement file to contain "${expected}"; got:\n${engBody}`,
    );
    // _always file too.
    const alwaysBody = readFileSync(join(dir, "_always.txt"), "utf8");
    assert.ok(
      alwaysBody.includes(expected),
      `expected _always file to contain "${expected}"; got:\n${alwaysBody}`,
    );
    // Flat union too.
    const flatBody = readFileSync(join(tmp, "case-format-header.flat"), "utf8");
    assert.ok(
      flatBody.includes(expected),
      `expected flat union to contain "${expected}"; got:\n${flatBody}`,
    );

    // The header must be the SECOND line of the per-engagement file (after
    // the "generated by" comment) so it's discoverable at the top.
    const lines = engBody.split("\n");
    assert.equal(lines[1], expected);
  });

  it("marker-format header is ignored by the deny-set parser (round-trip)", () => {
    // Sanity check: the new header must not pollute the pattern set,
    // because deny-set treats any line starting with `;` as a comment.
    const dir = join(tmp, "case-format-roundtrip");
    mkdirSync(dir, { recursive: true });
    renderMarkers(
      {
        engagements: [{ id: "customer-a", name: "A", markers: ["foo-marker"] }],
        alwaysBlock: [],
        schemaVersion: 1,
      },
      { markersDir: dir, flatPath: join(tmp, "case-format-roundtrip.flat") },
    );
    const ds = computeDenySet(
      {
        cwd: dir,
        isGitRepo: false,
        class: "public-eligible",
        classExplicit: true,
        engagements: [],
      },
      { markersDir: dir },
    );
    // "foo-marker" is the file content; "customer-a" is the engagement
    // identifier auto-blocked as a self-marker (see computeDenySet). The header
    // comment lines must NOT appear.
    assert.deepEqual(ds.patterns, ["foo-marker", "customer-a"]);
    // No pattern in the deny set should be a comment line.
    for (const p of ds.patterns) {
      assert.ok(!p.startsWith(";"), `pattern leaked from header: ${p}`);
      assert.ok(!p.includes("repo-aegis-marker-format"), `format header leaked into patterns: ${p}`);
    }
  });

  it("exports MARKER_FORMAT_VERSION = 1", () => {
    assert.equal(MARKER_FORMAT_VERSION, 1);
  });
});

// ---------------------------------------------------------------------------
// `selfIdentity` -> the reserved `_self_identity` stem.
// ---------------------------------------------------------------------------

describe("renderMarkers — selfIdentity", () => {
  it("writes _self_identity.txt when the list is non-empty", () => {
    const dir = join(tmp, "case-self");
    mkdirSync(dir, { recursive: true });
    const r = renderMarkers(
      {
        engagements: [{ id: "customer-a", name: "A", markers: ["acme-corp"] }],
        alwaysBlock: [],
        selfIdentity: ["example-org", "internal-project-codename"],
        schemaVersion: 2,
      },
      { markersDir: dir, flatPath: join(tmp, "case-self.flat") },
    );
    assert.equal(r.invalidPatterns.length, 0);
    const body = readFileSync(join(dir, "_self_identity.txt"), "utf8");
    assert.match(body, /example-org/);
    assert.match(body, /internal-project-codename/);
    assert.match(body, /; engagement: _self_identity/);
    assert.ok(
      r.written.some(w => w.engagementId === "_self_identity" && w.patternCount === 2),
    );
  });

  it("writes no file at all when the list is empty or absent", () => {
    // The file's ABSENCE is the signal that this machine declares no identity;
    // an always-present empty file would be indistinguishable from a render
    // that silently dropped the list.
    const dir = join(tmp, "case-self-empty");
    mkdirSync(dir, { recursive: true });
    renderMarkers(
      { engagements: [], alwaysBlock: [], selfIdentity: [], schemaVersion: 2 },
      { markersDir: dir, flatPath: join(tmp, "case-self-empty.flat") },
    );
    assert.ok(!existsSync(join(dir, "_self_identity.txt")));
    renderMarkers(
      { engagements: [], alwaysBlock: [], schemaVersion: 2 },
      { markersDir: dir, flatPath: join(tmp, "case-self-empty.flat") },
    );
    assert.ok(!existsSync(join(dir, "_self_identity.txt")));
  });

  it("removes a stale _self_identity.txt once the list is emptied", () => {
    const dir = join(tmp, "case-self-stale");
    mkdirSync(dir, { recursive: true });
    const flat = join(tmp, "case-self-stale.flat");
    renderMarkers(
      { engagements: [], alwaysBlock: [], selfIdentity: ["example-org"], schemaVersion: 2 },
      { markersDir: dir, flatPath: flat },
    );
    assert.ok(existsSync(join(dir, "_self_identity.txt")));
    renderMarkers(
      { engagements: [], alwaysBlock: [], selfIdentity: [], schemaVersion: 2 },
      { markersDir: dir, flatPath: flat },
    );
    assert.ok(!existsSync(join(dir, "_self_identity.txt")));
  });

  it("validates identity patterns strictly and writes nothing when one is bad", () => {
    const dir = join(tmp, "case-self-invalid");
    mkdirSync(dir, { recursive: true });
    assert.throws(
      () =>
        renderMarkers(
          {
            engagements: [],
            alwaysBlock: [],
            selfIdentity: ["example-org", "(?<bad"],
            schemaVersion: 2,
          },
          { markersDir: dir, flatPath: join(tmp, "case-self-invalid.flat") },
        ),
      PatternValidationError,
    );
    assert.ok(!existsSync(join(dir, "_self_identity.txt")));
    assert.ok(!existsSync(join(dir, "_always.txt")), "nothing is written on a bad pattern");
  });

  it("attributes an invalid identity pattern to the _self_identity stem", () => {
    const dir = join(tmp, "case-self-attr");
    mkdirSync(dir, { recursive: true });
    try {
      renderMarkers(
        { engagements: [], alwaysBlock: [], selfIdentity: ["(?<bad"], schemaVersion: 2 },
        { markersDir: dir, flatPath: join(tmp, "case-self-attr.flat") },
      );
      assert.fail("expected PatternValidationError");
    } catch (err) {
      assert.ok(err instanceof PatternValidationError);
      assert.ok(
        err.invalid.some(pp => pp.engagementId === "_self_identity"),
        "the operator must be told which list the bad pattern came from",
      );
    }
  });

  it("is ABSENT from the flat markers.txt union", () => {
    // The flat file is for consumers with no notion of repo class. Including a
    // class-gated stem there would block the operator's own org name in every
    // repo the operator owns — the exact failure the gate exists to avoid.
    const dir = join(tmp, "case-self-flat");
    mkdirSync(dir, { recursive: true });
    const flat = join(tmp, "case-self-flat.flat");
    renderMarkers(
      {
        engagements: [{ id: "customer-a", name: "A", markers: ["acme-corp"] }],
        alwaysBlock: ["PROJECT-CODENAME-ALPHA"],
        selfIdentity: ["example-org"],
        privateInfra: ["registry\\.internal\\.invalid"],
        schemaVersion: 2,
      },
      { markersDir: dir, flatPath: flat },
    );
    const body = readFileSync(flat, "utf8");
    assert.ok(body.includes("acme-corp"), "engagement markers are in the union");
    assert.ok(body.includes("PROJECT-CODENAME-ALPHA"), "_always is in the union");
    assert.ok(!body.includes("example-org"), "_self_identity must not be");
    assert.ok(!body.includes("internal.invalid"), "_private_infra must not be either");
  });
});
