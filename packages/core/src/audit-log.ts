// Operator audit log for repo-aegis.
//
// What this is: an append-only JSON Lines file that records
// state-changing operations (allow / deny / engagements add ... /
// install hooks / etc) so the operator can answer compliance questions
// like "did I allow customer-A in this repo on date X" from a single
// file rather than a git-archaeology session across .git/config and
// the engagement registry.
//
// Default state: OFF. The function is a fast-path no-op if the config
// file (`<home>/state/audit-log.json`) is absent or has
// `enabled: false`. Existing users see no behaviour change after
// upgrade.
//
// Marker safety: this module never writes literal marker patterns or
// matched substrings. Callers pass structural metadata only (engagement
// ids, action names, counts). The reviewer-test in `audit-log.test.ts`
// asserts that registry-resident literal patterns never appear in the
// audit log even when the recorded engagement-id matches.

import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { auditLogPath as defaultAuditLogPath, statePath } from "./paths.js";
import { withLockSync } from "./lock.js";

/**
 * Default rotation threshold: 10 MiB. Tuned so the active log stays
 * readable end-to-end with `cat` / `tail` without paging tools, but big
 * enough that a year of routine operator work fits in a handful of
 * rotated files.
 */
const DEFAULT_ROTATE_BYTES = 10 * 1024 * 1024;

export interface AuditRecord {
  /** ISO 8601 timestamp; auto-populated by appendAuditRecord. */
  ts: string;
  /** Action name, e.g. "engagements-add", "allow", "deny". */
  action: string;
  /** Operator identity from `process.env.USER` (falls back to "unknown"). */
  actor: string;
  /** Process working directory at time of action. */
  cwd?: string;
  /** Git toplevel for the repo the action targeted, when applicable. */
  repo?: string;
  /** Single engagement id (allow/deny single, engagements add/end/remove). */
  engagement?: string;
  /** Multiple engagement ids (variadic allow/deny). */
  engagements?: string[];
  /** Free-form structural details. NEVER include literal marker patterns. */
  details?: Record<string, unknown>;
}

interface AuditLogConfig {
  enabled: boolean;
  rotateBytes: number;
}

/**
 * Path to the audit-log opts file. Lives under `state/` alongside the
 * other operator-controlled flags (leak-context-mode, registry.encrypted).
 */
function auditLogConfigPath(): string {
  return `${statePath()}/audit-log.json`;
}

/**
 * Read the opts file. Absent / unparseable / `enabled: false` all map
 * to `{ enabled: false }`. Returning a typed shape keeps the call site
 * tidy: the caller checks one boolean.
 */
function readConfig(): AuditLogConfig {
  const path = auditLogConfigPath();
  if (!existsSync(path)) return { enabled: false, rotateBytes: DEFAULT_ROTATE_BYTES };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { enabled: false, rotateBytes: DEFAULT_ROTATE_BYTES };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { enabled: false, rotateBytes: DEFAULT_ROTATE_BYTES };
  }
  const obj = parsed as Record<string, unknown>;
  const enabled = obj["enabled"] === true;
  const rb = obj["rotateBytes"];
  const rotateBytes = typeof rb === "number" && rb > 0 ? rb : DEFAULT_ROTATE_BYTES;
  return { enabled, rotateBytes };
}

/**
 * Write `{ enabled }` to the opts file (preserving the rotateBytes
 * setting if one was configured). Used by the CLI's
 * `audit-log on`/`audit-log off` subcommands. Creates the state/ dir
 * with chmod 700 if missing; the file itself is chmod 600.
 */
export function setAuditLogEnabled(enabled: boolean): void {
  const path = auditLogConfigPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let prev: AuditLogConfig = { enabled: false, rotateBytes: DEFAULT_ROTATE_BYTES };
  if (existsSync(path)) prev = readConfig();
  const next = { enabled, rotateBytes: prev.rotateBytes };
  writeFileSync(path, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* platform-restricted */
  }
}

/**
 * Read the on/off bit for inspection (used by `audit-log path` and the
 * CLI's "show" subcommand to surface the active state). Does NOT enable
 * the log; that's setAuditLogEnabled's job.
 */
export function isAuditLogEnabled(): boolean {
  return readConfig().enabled;
}

/**
 * Path to the active audit-log file. Re-exported here as well as from
 * paths.ts so callers reaching for the writer don't have to hop modules.
 */
export function activeAuditLogPath(): string {
  return defaultAuditLogPath();
}

/**
 * Rotate the active log if it exceeds rotateBytes. The rotated copy is
 * named `audit.log.<iso>` (colons stripped so the filename is portable
 * across filesystems). A fresh empty file is created in place.
 *
 * Caller must hold the registry lock; rotation reads + renames the
 * active log and is racy without it.
 */
function maybeRotate(activePath: string, rotateBytes: number): void {
  if (!existsSync(activePath)) return;
  let size = 0;
  try {
    size = statSync(activePath).size;
  } catch {
    return;
  }
  if (size < rotateBytes) return;
  // Filename-safe ISO: 2026-05-02T12-34-56.789Z
  const isoStamp = new Date().toISOString().replace(/:/g, "-");
  const rotated = `${activePath}.${isoStamp}`;
  renameSync(activePath, rotated);
  try {
    chmodSync(rotated, 0o600);
  } catch {
    /* platform-restricted */
  }
}

/**
 * Append one record to the active audit log. ts and actor are filled in
 * here so callers don't have to plumb them through.
 *
 * Fast-path no-op when the audit log is OFF (config absent or
 * `enabled: false`). When ON, runs under withLockSync so concurrent
 * writers can't interleave a half-written line.
 *
 * Marker safety contract: callers MUST NOT pass literal marker patterns
 * or matched substrings in `details`. Engagement ids, counts, file
 * paths, and class names are fine; pattern source strings are not.
 */
export function appendAuditRecord(rec: Omit<AuditRecord, "ts" | "actor">): void {
  const cfg = readConfig();
  if (!cfg.enabled) return;

  const full: AuditRecord = {
    ts: new Date().toISOString(),
    action: rec.action,
    actor: process.env["USER"] ?? "unknown",
    ...(rec.cwd !== undefined && { cwd: rec.cwd }),
    ...(rec.repo !== undefined && { repo: rec.repo }),
    ...(rec.engagement !== undefined && { engagement: rec.engagement }),
    ...(rec.engagements !== undefined && { engagements: rec.engagements }),
    ...(rec.details !== undefined && { details: rec.details }),
  };

  const path = activeAuditLogPath();
  const dir = dirname(path);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    /* dir already exists or platform-restricted; appendFileSync will surface real errors */
  }

  withLockSync(() => {
    maybeRotate(path, cfg.rotateBytes);
    const line = JSON.stringify(full) + "\n";
    if (!existsSync(path)) {
      writeFileSync(path, line, { mode: 0o600 });
    } else {
      appendFileSync(path, line);
    }
    try {
      chmodSync(path, 0o600);
    } catch {
      /* platform-restricted */
    }
  });
}
