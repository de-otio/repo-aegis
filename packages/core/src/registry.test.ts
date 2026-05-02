import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadRegistry,
  isActive,
  resolveEngagement,
  MAX_SUPPORTED_REGISTRY_SCHEMA_VERSION,
} from "./registry.js";
import { RegistryNotFoundError, RegistryParseError } from "./exceptions.js";

let tmp: string;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "repo-aegis-registry-"));
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeYaml(name: string, body: string): string {
  const p = join(tmp, name);
  writeFileSync(p, body);
  return p;
}

describe("loadRegistry", () => {
  it("loads a minimal valid registry with alwaysBlock", () => {
    const path = writeYaml(
      "minimal.yaml",
      `
always_block:
  - PROJECT-CODENAME-ALPHA

engagements:
  - id: customer-a
    name: Customer A
    markers:
      - acme-corp
`,
    );
    const reg = loadRegistry(path);
    assert.equal(reg.engagements.length, 1);
    assert.equal(reg.engagements[0]!.id, "customer-a");
    assert.equal(reg.alwaysBlock.length, 1);
    assert.equal(reg.alwaysBlock[0], "PROJECT-CODENAME-ALPHA");
  });

  it("treats missing always_block as empty", () => {
    const path = writeYaml(
      "no-always.yaml",
      `engagements:
  - id: customer-a
    name: Customer A
    markers: [acme]`,
    );
    const reg = loadRegistry(path);
    assert.equal(reg.alwaysBlock.length, 0);
  });

  it("throws RegistryNotFoundError when file missing", () => {
    assert.throws(() => loadRegistry(join(tmp, "nonexistent.yaml")), RegistryNotFoundError);
  });

  it("throws RegistryParseError for invalid YAML", () => {
    const path = writeYaml("invalid.yaml", "not: valid: yaml: at: all:");
    assert.throws(() => loadRegistry(path), RegistryParseError);
  });

  it("throws when missing top-level engagements key", () => {
    const path = writeYaml("missing-engagements.yaml", "always_block:\n  - foo");
    assert.throws(() => loadRegistry(path), RegistryParseError);
  });

  it("rejects engagement with id _always (reserved)", () => {
    const path = writeYaml(
      "reserved-id.yaml",
      `engagements:
  - id: _always
    name: Always
    markers: [foo]`,
    );
    assert.throws(() => loadRegistry(path), /reserved/);
  });

  it("requires markers to be a list", () => {
    const path = writeYaml(
      "no-markers.yaml",
      `engagements:
  - id: a
    name: A`,
    );
    assert.throws(() => loadRegistry(path), /markers/);
  });

  it("requires always_block to be a list of strings", () => {
    const path = writeYaml(
      "bad-always.yaml",
      `always_block: not_a_list
engagements: []`,
    );
    assert.throws(() => loadRegistry(path), RegistryParseError);
  });

  it("treats missing schemaVersion as version 1 (legacy)", () => {
    const path = writeYaml(
      "no-schema-version.yaml",
      `engagements:
  - id: customer-a
    name: Customer A
    markers: [foo]`,
    );
    const reg = loadRegistry(path);
    assert.equal(reg.schemaVersion, 1);
  });

  it("accepts schemaVersion: 1", () => {
    const path = writeYaml(
      "schema-v1.yaml",
      `schemaVersion: 1
engagements:
  - id: customer-a
    name: Customer A
    markers: [foo]`,
    );
    const reg = loadRegistry(path);
    assert.equal(reg.schemaVersion, 1);
  });

  it("rejects schemaVersion greater than max supported with an upgrade message", () => {
    const path = writeYaml(
      "schema-v99.yaml",
      `schemaVersion: 99
engagements:
  - id: customer-a
    name: Customer A
    markers: [foo]`,
    );
    assert.throws(
      () => loadRegistry(path),
      (err: unknown) =>
        err instanceof RegistryParseError &&
        /please upgrade/i.test(err.message) &&
        /99/.test(err.message),
    );
  });

  it("rejects non-numeric schemaVersion", () => {
    const path = writeYaml(
      "schema-bad.yaml",
      `schemaVersion: "not-a-number"
engagements:
  - id: customer-a
    name: Customer A
    markers: [foo]`,
    );
    assert.throws(() => loadRegistry(path), RegistryParseError);
  });

  it("MAX_SUPPORTED_REGISTRY_SCHEMA_VERSION is the current pinned version", () => {
    // Sanity guard: bumping this constant is intentional and should be
    // accompanied by a migration plan and updated tests.
    assert.equal(MAX_SUPPORTED_REGISTRY_SCHEMA_VERSION, 1);
  });
});

describe("isActive", () => {
  it("returns true when ended is null/undefined", () => {
    assert.equal(isActive({ id: "a", name: "A", markers: [] }), true);
    assert.equal(isActive({ id: "a", name: "A", ended: null, markers: [] }), true);
  });

  it("returns true within retention window", () => {
    const recent = new Date();
    recent.setMonth(recent.getMonth() - 6);
    assert.equal(
      isActive({ id: "a", name: "A", ended: recent.toISOString().slice(0, 10), markers: [] }, 12),
      true,
    );
  });

  it("returns false past retention window", () => {
    const old = new Date();
    old.setFullYear(old.getFullYear() - 2);
    assert.equal(
      isActive({ id: "a", name: "A", ended: old.toISOString().slice(0, 10), markers: [] }, 12),
      false,
    );
  });

  it("treats malformed dates as active (conservative)", () => {
    assert.equal(isActive({ id: "a", name: "A", ended: "not-a-date", markers: [] }), true);
  });
});

describe("resolveEngagement", () => {
  const reg = {
    engagements: [
      { id: "customer-a-2025", name: "Customer A", markers: [] },
      { id: "customer-b-2024", name: "Customer B", markers: [] },
      { id: "customer-c", name: "Acme Corp", markers: [] },
    ],
    alwaysBlock: [],
    schemaVersion: 1,
  };

  it("matches by exact id", () => {
    const r = resolveEngagement(reg, "customer-a-2025");
    assert.equal(r.match?.id, "customer-a-2025");
  });

  it("matches by exact name (case-insensitive)", () => {
    const r = resolveEngagement(reg, "customer a");
    assert.equal(r.match?.id, "customer-a-2025");
  });

  it("matches by fuzzy substring on id", () => {
    const r = resolveEngagement(reg, "2024");
    assert.equal(r.match?.id, "customer-b-2024");
  });

  it("returns no match with multiple candidates", () => {
    const r = resolveEngagement(reg, "customer");
    assert.equal(r.match, null);
    assert.ok(r.candidates.length >= 2);
  });

  it("returns no match and empty candidates when nothing matches", () => {
    const r = resolveEngagement(reg, "nonexistent");
    assert.equal(r.match, null);
    assert.equal(r.candidates.length, 0);
  });

  it("matches by name when name is distinct from id", () => {
    const r = resolveEngagement(reg, "acme corp");
    assert.equal(r.match?.id, "customer-c");
  });
});
