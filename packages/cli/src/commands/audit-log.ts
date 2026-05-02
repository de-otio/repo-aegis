// CLI subcommand group: `audit-log`.
//
// Operator-facing controls for the optional compliance trail. Default
// is OFF so existing users see no behaviour change after upgrade.
//
// Subcommands:
//   audit-log on             — enable
//   audit-log off            — disable
//   audit-log show [--all]   — print records (last 50 by default)
//   audit-log path           — print the active log file path

import { existsSync, readFileSync } from "node:fs";
import {
  auditLogPath,
  isAuditLogEnabled,
  setAuditLogEnabled,
} from "@de-otio/repo-aegis-core";
import { emitJson, emitText, type OutputOptions } from "../format.js";

interface ShowOptions extends OutputOptions {
  all?: boolean;
}

const DEFAULT_TAIL = 50;

export function auditLogOn(opts: OutputOptions): void {
  const wasOn = isAuditLogEnabled();
  setAuditLogEnabled(true);
  if (opts.json) {
    emitJson({ action: "audit-log-on", wasOn, isOn: true, path: auditLogPath() });
    return;
  }
  if (wasOn) {
    emitText("repo-aegis: audit log is already on");
  } else {
    emitText("repo-aegis: audit log enabled");
  }
  emitText(`  path: ${auditLogPath()}`);
}

export function auditLogOff(opts: OutputOptions): void {
  const wasOn = isAuditLogEnabled();
  setAuditLogEnabled(false);
  if (opts.json) {
    emitJson({ action: "audit-log-off", wasOn, isOn: false, path: auditLogPath() });
    return;
  }
  if (wasOn) {
    emitText("repo-aegis: audit log disabled");
  } else {
    emitText("repo-aegis: audit log is already off");
  }
}

export function auditLogPathCmd(opts: OutputOptions): void {
  const path = auditLogPath();
  const enabled = isAuditLogEnabled();
  const exists = existsSync(path);
  if (opts.json) {
    emitJson({ action: "audit-log-path", path, enabled, exists });
    return;
  }
  emitText(path);
}

export function auditLogShow(opts: ShowOptions): void {
  const path = auditLogPath();
  if (!existsSync(path)) {
    if (opts.json) {
      emitJson({ action: "audit-log-show", path, enabled: isAuditLogEnabled(), records: [] });
      return;
    }
    emitText(`repo-aegis: audit log is empty (${path})`);
    return;
  }
  const body = readFileSync(path, "utf8");
  const lines = body.split("\n").filter(l => l.length > 0);
  // Each line is a JSON record. Parse what we can; keep the raw line as
  // a fallback so a corrupt entry doesn't blank the rest of the output.
  const records = lines.map(line => {
    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch {
      return { _raw: line, _parseError: true } as Record<string, unknown>;
    }
  });
  const subset = opts.all ? records : records.slice(-DEFAULT_TAIL);
  if (opts.json) {
    emitJson({
      action: "audit-log-show",
      path,
      enabled: isAuditLogEnabled(),
      total: records.length,
      shown: subset.length,
      records: subset,
    });
    return;
  }
  for (const rec of subset) {
    emitText(JSON.stringify(rec));
  }
}
