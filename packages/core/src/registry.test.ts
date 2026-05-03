// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
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
import {
  RegistryNotFoundError,
  RegistryParseError,
  RegistryEncryptedError,
} from "./exceptions.js";

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

  it("throws RegistryEncryptedError when only <path>.age exists", () => {
    const plain = join(tmp, "encrypted-only.yaml");
    const cipher = `${plain}.age`;
    writeFileSync(cipher, "age-encrypted-payload");
    assert.throws(
      () => loadRegistry(plain),
      (err: unknown) =>
        err instanceof RegistryEncryptedError &&
        err.code === "REGISTRY_ENCRYPTED" &&
        err.path === plain &&
        err.ciphertextPath === cipher &&
        /registry decrypt/.test(err.message),
    );
    rmSync(cipher);
  });

  it("prefers RegistryEncryptedError over RegistryNotFoundError when both states would apply", () => {
    // i.e. plaintext absent + ciphertext present => encrypted error,
    // not "not found". The agent gets a recoverable signal.
    const plain = join(tmp, "encrypted-vs-missing.yaml");
    writeFileSync(`${plain}.age`, "ciphertext");
    assert.throws(() => loadRegistry(plain), RegistryEncryptedError);
    rmSync(`${plain}.age`);
  });

  it("does not throw RegistryEncryptedError when plaintext exists alongside .age", () => {
    // Defensive: if for any reason both files coexist, the plaintext
    // wins (loadRegistry's whole job is to read the plaintext). The
    // CLI's encrypt/decrypt flow ensures this doesn't happen, but the
    // load path must not surprise callers.
    const plain = writeYaml(
      "both-exist.yaml",
      `engagements:
  - id: customer-a
    name: Customer A
    markers: [foo]`,
    );
    writeFileSync(`${plain}.age`, "ciphertext");
    const reg = loadRegistry(plain);
    assert.equal(reg.engagements.length, 1);
    rmSync(`${plain}.age`);
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
    assert.equal(MAX_SUPPORTED_REGISTRY_SCHEMA_VERSION, 2);
  });

  // -- schemaVersion 2: personalOrgs + engagements[*].githubOrgs --

  it("v1 file (no schemaVersion, no personalOrgs/githubOrgs) loads with empty defaults", () => {
    const path = writeYaml(
      "v1-defaults.yaml",
      `engagements:
  - id: customer-a
    name: Customer A
    markers: [foo]`,
    );
    const reg = loadRegistry(path);
    assert.equal(reg.schemaVersion, 1);
    assert.deepEqual(reg.personalOrgs, []);
    assert.equal(reg.engagements[0]!.githubOrgs, undefined);
  });

  it("loads schemaVersion 2 with personalOrgs and engagements[*].githubOrgs", () => {
    const path = writeYaml(
      "v2-full.yaml",
      `schemaVersion: 2
personalOrgs:
  - my-handle
  - my-oss-org
engagements:
  - id: foo-corp
    name: Foo Corp
    githubOrgs: [foo-corp, foo-corp-archived]
    markers: [foo]
  - id: bar-co
    name: Bar Co
    githubOrgs: [bar-co]
    markers: [bar]`,
    );
    const reg = loadRegistry(path);
    assert.equal(reg.schemaVersion, 2);
    assert.deepEqual(reg.personalOrgs, ["my-handle", "my-oss-org"]);
    assert.deepEqual(reg.engagements[0]!.githubOrgs, ["foo-corp", "foo-corp-archived"]);
    assert.deepEqual(reg.engagements[1]!.githubOrgs, ["bar-co"]);
  });

  it("rejects org name with uppercase characters", () => {
    const path = writeYaml(
      "v2-uppercase.yaml",
      `schemaVersion: 2
personalOrgs: [Bad-Org]
engagements: []`,
    );
    assert.throws(
      () => loadRegistry(path),
      (err: unknown) =>
        err instanceof RegistryParseError && /lowercase/i.test(err.message),
    );
  });

  it("rejects org name with leading hyphen", () => {
    const path = writeYaml(
      "v2-leading-hyphen.yaml",
      `schemaVersion: 2
engagements:
  - id: foo
    name: Foo
    githubOrgs: ["-bad"]
    markers: []`,
    );
    assert.throws(() => loadRegistry(path), RegistryParseError);
  });

  it("rejects org name with whitespace", () => {
    const path = writeYaml(
      "v2-whitespace.yaml",
      `schemaVersion: 2
engagements:
  - id: foo
    name: Foo
    githubOrgs: ["bad org"]
    markers: []`,
    );
    assert.throws(() => loadRegistry(path), RegistryParseError);
  });

  it("rejects empty string in githubOrgs", () => {
    const path = writeYaml(
      "v2-empty.yaml",
      `schemaVersion: 2
engagements:
  - id: foo
    name: Foo
    githubOrgs: [""]
    markers: []`,
    );
    assert.throws(() => loadRegistry(path), RegistryParseError);
  });

  it("rejects same org appearing in personalOrgs and engagements[*].githubOrgs (disjointness)", () => {
    const path = writeYaml(
      "v2-overlap.yaml",
      `schemaVersion: 2
personalOrgs: [my-handle]
engagements:
  - id: foo
    name: Foo
    githubOrgs: [my-handle]
    markers: []`,
    );
    assert.throws(
      () => loadRegistry(path),
      (err: unknown) =>
        err instanceof RegistryParseError &&
        /personalOrgs/.test(err.message) &&
        /my-handle/.test(err.message) &&
        /mutually exclusive/.test(err.message),
    );
  });

  it("rejects same org listed in two different engagements' githubOrgs (uniqueness)", () => {
    const path = writeYaml(
      "v2-dup.yaml",
      `schemaVersion: 2
engagements:
  - id: foo
    name: Foo
    githubOrgs: [shared-org]
    markers: []
  - id: bar
    name: Bar
    githubOrgs: [shared-org]
    markers: []`,
    );
    assert.throws(
      () => loadRegistry(path),
      (err: unknown) =>
        err instanceof RegistryParseError &&
        /shared-org/.test(err.message) &&
        /at most one engagement/.test(err.message) &&
        /foo/.test(err.message),
    );
  });

  it("rejects duplicate entries inside personalOrgs", () => {
    const path = writeYaml(
      "v2-personal-dup.yaml",
      `schemaVersion: 2
personalOrgs: [me, me]
engagements: []`,
    );
    assert.throws(
      () => loadRegistry(path),
      (err: unknown) =>
        err instanceof RegistryParseError && /duplicate/i.test(err.message),
    );
  });

  it("rejects schemaVersion 3 with the existing 'newer than supported' message", () => {
    const path = writeYaml(
      "v3.yaml",
      `schemaVersion: 3
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
        /3/.test(err.message),
    );
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
