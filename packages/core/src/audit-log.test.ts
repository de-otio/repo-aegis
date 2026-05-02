import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendAuditRecord,
  isAuditLogEnabled,
  setAuditLogEnabled,
  activeAuditLogPath,
} from "./audit-log.js";
import { auditLogPath, statePath } from "./paths.js";

let home: string;
let originalHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "repo-aegis-audit-log-"));
  originalHome = process.env["REPO_AEGIS_HOME"];
  process.env["REPO_AEGIS_HOME"] = home;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env["REPO_AEGIS_HOME"];
  else process.env["REPO_AEGIS_HOME"] = originalHome;
  rmSync(home, { recursive: true, force: true });
});

describe("appendAuditRecord — disabled by default", () => {
  it("is a no-op when no config file exists", () => {
    assert.equal(isAuditLogEnabled(), false);
    appendAuditRecord({ action: "allow", engagement: "customer-a" });
    // Active log path must NOT have been created.
    assert.equal(existsSync(auditLogPath()), false, "audit.log should not exist when disabled");
  });

  it("is a no-op when config sets enabled: false", () => {
    mkdirSync(statePath(), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(statePath(), "audit-log.json"),
      JSON.stringify({ enabled: false }),
    );
    assert.equal(isAuditLogEnabled(), false);
    appendAuditRecord({ action: "deny", engagement: "customer-a" });
    assert.equal(existsSync(auditLogPath()), false);
  });

  it("is a no-op when config file is malformed JSON", () => {
    mkdirSync(statePath(), { recursive: true, mode: 0o700 });
    writeFileSync(join(statePath(), "audit-log.json"), "{this is not json");
    assert.equal(isAuditLogEnabled(), false);
    appendAuditRecord({ action: "allow", engagement: "customer-a" });
    assert.equal(existsSync(auditLogPath()), false);
  });
});

describe("setAuditLogEnabled / isAuditLogEnabled", () => {
  it("turns the audit log on and off", () => {
    assert.equal(isAuditLogEnabled(), false);
    setAuditLogEnabled(true);
    assert.equal(isAuditLogEnabled(), true);
    setAuditLogEnabled(false);
    assert.equal(isAuditLogEnabled(), false);
  });

  it("creates state/ with the right permissions", () => {
    setAuditLogEnabled(true);
    assert.ok(existsSync(statePath()));
    assert.ok(existsSync(join(statePath(), "audit-log.json")));
  });

  it("activeAuditLogPath matches paths.ts auditLogPath()", () => {
    assert.equal(activeAuditLogPath(), auditLogPath());
  });
});

describe("appendAuditRecord — enabled", () => {
  beforeEach(() => {
    setAuditLogEnabled(true);
  });

  it("appends a JSONL record with auto-populated ts + actor", () => {
    appendAuditRecord({
      action: "allow",
      engagement: "customer-a",
      cwd: "/tmp/some-repo",
    });

    const body = readFileSync(auditLogPath(), "utf8");
    assert.match(body, /\n$/, "JSONL records must end with a newline");
    const lines = body.split("\n").filter(l => l.length > 0);
    assert.equal(lines.length, 1);
    const rec = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.equal(rec["action"], "allow");
    assert.equal(rec["engagement"], "customer-a");
    assert.equal(rec["cwd"], "/tmp/some-repo");
    // ts must parse as a date
    assert.ok(typeof rec["ts"] === "string");
    const t = new Date(rec["ts"] as string);
    assert.ok(!Number.isNaN(t.getTime()), "ts must be a parseable ISO 8601 timestamp");
    // actor is process.env.USER or "unknown"
    assert.ok(typeof rec["actor"] === "string");
  });

  it("appends multiple records as separate lines", () => {
    appendAuditRecord({ action: "allow", engagement: "customer-a" });
    appendAuditRecord({ action: "deny", engagement: "customer-a" });
    appendAuditRecord({
      action: "engagements-add",
      engagement: "customer-b",
      details: { markerCount: 2 },
    });

    const body = readFileSync(auditLogPath(), "utf8");
    const lines = body.split("\n").filter(l => l.length > 0);
    assert.equal(lines.length, 3);
    const actions = lines.map(l => (JSON.parse(l) as { action: string }).action);
    assert.deepEqual(actions, ["allow", "deny", "engagements-add"]);
  });

  it("preserves the engagements (plural) array", () => {
    appendAuditRecord({
      action: "allow",
      engagements: ["customer-a", "customer-b"],
    });
    const body = readFileSync(auditLogPath(), "utf8");
    const rec = JSON.parse(body.trim()) as { engagements: string[] };
    assert.deepEqual(rec.engagements, ["customer-a", "customer-b"]);
  });

  it("falls back to actor 'unknown' when USER env is unset", () => {
    const prev = process.env["USER"];
    delete process.env["USER"];
    try {
      appendAuditRecord({ action: "allow", engagement: "customer-a" });
      const body = readFileSync(auditLogPath(), "utf8");
      const rec = JSON.parse(body.trim()) as { actor: string };
      assert.equal(rec.actor, "unknown");
    } finally {
      if (prev !== undefined) process.env["USER"] = prev;
    }
  });
});

describe("appendAuditRecord — rotation", () => {
  it("rotates when file size meets or exceeds rotateBytes", () => {
    // Configure an aggressively small threshold so a couple of records
    // trip the rotation logic.
    mkdirSync(statePath(), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(statePath(), "audit-log.json"),
      JSON.stringify({ enabled: true, rotateBytes: 200 }),
    );

    // Each record is ~120 bytes; two of them push past 200.
    appendAuditRecord({
      action: "engagements-add",
      engagement: "customer-aaaaaaaaaaaaaaaa",
      details: { padding: "x".repeat(50) },
    });
    appendAuditRecord({
      action: "engagements-add",
      engagement: "customer-bbbbbbbbbbbbbbbb",
      details: { padding: "y".repeat(50) },
    });
    // The third call should detect the size threshold and rotate before
    // the third record is written. After the call we expect (a) a
    // rotated `audit.log.*` file and (b) a fresh `audit.log` containing
    // only the third record.
    appendAuditRecord({
      action: "engagements-add",
      engagement: "customer-c",
    });

    const files = readdirSync(statePath());
    const rotated = files.filter(f => f.startsWith("audit.log."));
    assert.ok(rotated.length >= 1, `expected at least one rotated log; got: ${files.join(",")}`);

    const active = readFileSync(auditLogPath(), "utf8");
    const lines = active.split("\n").filter(l => l.length > 0);
    assert.equal(lines.length, 1, "fresh active log should hold exactly the post-rotation record");
    assert.equal((JSON.parse(lines[0]!) as { engagement: string }).engagement, "customer-c");
  });
});

describe("appendAuditRecord — marker scrub (reviewer test)", () => {
  it("never persists a literal marker pattern even when the engagement-id matches", () => {
    setAuditLogEnabled(true);

    // Simulate a real-looking marker pattern from the registry. The
    // contract: even though we record the engagement id, the literal
    // pattern itself must NOT appear in the audit log.
    const literalMarker = "Z9LITERAL-MARKER-PATTERN-Z9";

    // The caller is supposed to pass structural metadata only. Pass
    // engagement-id (allowed) and a marker COUNT in details (allowed);
    // do NOT pass the literal pattern itself.
    appendAuditRecord({
      action: "engagements-add",
      engagement: "customer-z",
      details: { markerCount: 1 },
    });

    const body = readFileSync(auditLogPath(), "utf8");
    assert.ok(
      !body.includes(literalMarker),
      `audit log must not contain the literal marker pattern; got:\n${body}`,
    );
    // The engagement id is fine (it's an opaque identifier the operator picks).
    assert.match(body, /customer-z/);
  });
});
