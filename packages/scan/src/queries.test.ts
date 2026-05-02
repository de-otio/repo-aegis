// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseQueryFile, validateQueryFile } from "./queries.js";

let tmp: string;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "repo-aegis-scan-queries-test-"));
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeYaml(name: string, body: string): string {
  const path = join(tmp, name);
  writeFileSync(path, body);
  return path;
}

describe("parseQueryFile", () => {
  it("parses a minimal valid file", () => {
    const path = writeYaml(
      "ok.yaml",
      `queries:
  - name: customer-a-leaks
    query: '"customer-a-secret" org:de-otio'
`,
    );
    const f = parseQueryFile(path);
    assert.equal(f.queries.length, 1);
    assert.equal(f.queries[0]!.name, "customer-a-leaks");
  });

  it("throws when missing top-level 'queries' key", () => {
    const path = writeYaml("missing.yaml", `unrelated: 1\n`);
    assert.throws(() => parseQueryFile(path), /missing top-level/);
  });

  it("throws when 'queries' is not a list", () => {
    const path = writeYaml("not-list.yaml", `queries: scalar\n`);
    assert.throws(() => parseQueryFile(path), /must be a list/);
  });

  it("throws when file does not exist", () => {
    assert.throws(() => parseQueryFile(join(tmp, "nope.yaml")), /not found/);
  });

  it("throws on invalid YAML", () => {
    const path = writeYaml("bad.yaml", `queries:\n  - name: x\n   bad: indent`);
    assert.throws(() => parseQueryFile(path), /failed to parse/);
  });
});

describe("validateQueryFile", () => {
  it("accepts a well-formed query", () => {
    const result = validateQueryFile({
      queries: [{ name: "ok", query: '"foo" org:de-otio' }],
    });
    assert.equal(result.ok, true);
    assert.equal(result.queries.length, 1);
  });

  it("rejects entries missing 'name'", () => {
    const result = validateQueryFile({
      queries: [{ query: '"foo" org:de-otio' } as { query: string; name: string }],
    });
    assert.equal(result.ok, false);
    assert.ok(result.issues.some(i => i.reason.includes("name")));
  });

  it("rejects entries missing 'query'", () => {
    const result = validateQueryFile({
      queries: [{ name: "x" } as { name: string; query: string }],
    });
    assert.equal(result.ok, false);
    assert.ok(result.issues.some(i => i.reason.includes("query")));
  });

  it("rejects duplicate names", () => {
    const result = validateQueryFile({
      queries: [
        { name: "dup", query: "a org:de-otio" },
        { name: "dup", query: "b org:de-otio" },
      ],
    });
    assert.equal(result.ok, false);
    assert.ok(result.issues.some(i => i.reason.includes("duplicate")));
  });

  it("rejects queries missing org: filter", () => {
    const result = validateQueryFile({
      queries: [{ name: "no-org", query: '"foo"' }],
    });
    assert.equal(result.ok, false);
    assert.ok(result.issues.some(i => i.reason.includes("org:")));
  });

  it("rejects un-quoted multi-word phrases", () => {
    const result = validateQueryFile({
      queries: [{ name: "unquoted", query: "two words org:de-otio" }],
    });
    assert.equal(result.ok, false);
    assert.ok(result.issues.some(i => i.reason.includes("quoted")));
  });

  it("propagates excludeOrg and excludeRepo to valid entries", () => {
    const result = validateQueryFile({
      queries: [
        {
          name: "excl",
          query: '"foo" org:de-otio',
          excludeOrg: ["bots"],
          excludeRepo: ["de-otio/dot-notes"],
        },
      ],
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.queries[0]!.excludeOrg, ["bots"]);
    assert.deepEqual(result.queries[0]!.excludeRepo, ["de-otio/dot-notes"]);
  });
});
