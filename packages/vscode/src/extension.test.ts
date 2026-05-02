// Smoke tests for the repo-aegis VSCode extension.
//
// These cover the vscode-free helpers (format / cli) only — the
// `vscode` module is not available outside the @vscode/test-electron
// harness, and pulling that in for v0.1 is more setup than it's worth.
// End-to-end coverage (real activate/deactivate, command registration,
// diagnostic rendering) lives behind that harness when we add it.
//
// Run with: node --test dist/**/*.test.js

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseJson } from "./cli.js";
import {
  formatStatusLabel,
  formatStatusTooltip,
  hitToDiagnosticShape,
} from "./format.js";
import type { StatusJson, ScanHit } from "./types.js";

function makeStatus(overrides: Partial<StatusJson> = {}): StatusJson {
  return {
    repo: {
      cwd: "/tmp/repo",
      isGitRepo: true,
      class: "private-strict",
      classExplicit: false,
      engagements: [],
    },
    allowedEngagements: [],
    denySet: { files: ["_always"], patternCount: 3 },
    alwaysBlock: { patternCount: 3 },
    warnings: [],
    ...overrides,
  };
}

describe("formatStatusLabel", () => {
  it("renders class • #engagements", () => {
    const s = makeStatus({
      repo: {
        cwd: "/tmp/repo",
        isGitRepo: true,
        class: "customer-coupled",
        classExplicit: true,
        engagements: ["customer-a"],
      },
    });
    assert.equal(formatStatusLabel(s), "customer-coupled • 1");
  });

  it("renders zero engagements", () => {
    const s = makeStatus();
    assert.equal(formatStatusLabel(s), "private-strict • 0");
  });

  it("falls back to a neutral label on null", () => {
    assert.equal(formatStatusLabel(null), "repo-aegis: unknown");
  });
});

describe("formatStatusTooltip", () => {
  it("includes class, engagements, deny set summary", () => {
    const s = makeStatus({
      repo: {
        cwd: "/tmp/repo",
        isGitRepo: true,
        class: "customer-coupled",
        classExplicit: true,
        engagements: ["customer-a", "customer-b"],
      },
      denySet: { files: ["_always", "customer-c"], patternCount: 12 },
    });
    const t = formatStatusTooltip(s);
    assert.match(t, /class: customer-coupled/);
    assert.match(t, /engagements: customer-a, customer-b/);
    assert.match(t, /deny set: 12 patterns across 2 file/);
  });

  it("renders (none) when no engagements", () => {
    const s = makeStatus();
    assert.match(formatStatusTooltip(s), /engagements: \(none\)/);
  });

  it("includes warnings when present", () => {
    const s = makeStatus({ warnings: ["registry stale"] });
    assert.match(formatStatusTooltip(s), /warnings:\n {2}- registry stale/);
  });

  it("falls back on null", () => {
    assert.equal(formatStatusTooltip(null), "repo-aegis: status unavailable");
  });
});

describe("hitToDiagnosticShape", () => {
  it("converts 1-indexed line/col to 0-indexed", () => {
    const hit: ScanHit = {
      path: "/tmp/x.ts",
      line: 42,
      column: 13,
      matchPreview: "[redacted]",
      engagement: "customer-b",
    };
    const d = hitToDiagnosticShape(hit);
    assert.equal(d.line, 41);
    assert.equal(d.column, 12);
    assert.equal(d.endColumn, 13);
    assert.equal(d.severity, "Warning");
    assert.equal(d.source, "repo-aegis");
    assert.equal(d.message, "customer-b marker");
    assert.equal(d.engagement, "customer-b");
  });

  it("treats missing engagement as 'unknown'", () => {
    const hit: ScanHit = {
      path: "/tmp/x.ts",
      line: 1,
      column: 1,
      matchPreview: "[redacted]",
    };
    const d = hitToDiagnosticShape(hit);
    assert.equal(d.engagement, "unknown");
    assert.equal(d.message, "unknown marker");
  });

  it("clamps zero/negative line/col to 0", () => {
    const hit = {
      path: "/tmp/x.ts",
      line: 0,
      column: 0,
      matchPreview: "[redacted]",
    } as ScanHit;
    const d = hitToDiagnosticShape(hit);
    assert.equal(d.line, 0);
    assert.equal(d.column, 0);
    assert.equal(d.endColumn, 1);
  });
});

describe("parseJson", () => {
  it("parses valid JSON", () => {
    const r = parseJson<{ a: number }>('{"a":1}');
    assert.deepEqual(r, { a: 1 });
  });

  it("returns null on empty stdout", () => {
    assert.equal(parseJson("   "), null);
  });

  it("returns null on malformed JSON", () => {
    assert.equal(parseJson("not json"), null);
  });
});
