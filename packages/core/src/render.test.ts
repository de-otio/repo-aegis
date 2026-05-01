import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderMarkers } from "./render.js";
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
      },
      { markersDir: dir, flatPath: flat },
    );
    assert.ok(existsSync(flat));
    const body = readFileSync(flat, "utf8");
    assert.match(body, /acme/);
    assert.match(body, /PROJECT-X/);
  });
});
