// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
// Pure formatting helpers. No `vscode` import — kept out of the runtime
// extension graph so unit tests can exercise them under plain `node
// --test` without booting the VSCode test harness.

import type { StatusJson, ScanHit } from "./types.js";

/**
 *   class • #engagements
 * E.g. `customer-coupled • 1`. Falls back to a neutral placeholder when
 * the CLI couldn't produce status JSON.
 */
export function formatStatusLabel(status: StatusJson | null): string {
  if (!status) return "repo-aegis: unknown";
  return `${status.repo.class} • ${status.repo.engagements.length}`;
}

/**
 * Multi-line tooltip. Never includes literal marker patterns — only
 * file stems and counts.
 */
export function formatStatusTooltip(status: StatusJson | null): string {
  if (!status) return "repo-aegis: status unavailable";
  const lines: string[] = [];
  lines.push(`class: ${status.repo.class}`);
  lines.push(
    `engagements: ${status.repo.engagements.length === 0 ? "(none)" : status.repo.engagements.join(", ")}`,
  );
  lines.push(
    `deny set: ${status.denySet.patternCount} patterns across ${status.denySet.files.length} file(s)`,
  );
  if (status.warnings.length > 0) {
    lines.push("warnings:");
    for (const w of status.warnings) lines.push(`  - ${w}`);
  }
  return lines.join("\n");
}

/**
 * VSCode-free representation of a diagnostic, so the conversion logic
 * can be unit-tested without importing `vscode`. The extension wraps
 * this in a real `vscode.Diagnostic` at the call site.
 */
export interface DiagnosticShape {
  /** 0-indexed line. */
  line: number;
  /** 0-indexed column. */
  column: number;
  /** 0-indexed end column (exclusive). */
  endColumn: number;
  /** "Warning" — fixed for v0.1. */
  severity: "Warning";
  /** Always `repo-aegis`. */
  source: string;
  /** Human-facing message. */
  message: string;
  /** Engagement id (or "unknown"); also used as `code` on the real Diagnostic. */
  engagement: string;
}

/**
 * Convert a 1-indexed ScanHit (as emitted by the CLI) into a 0-indexed
 * DiagnosticShape. Defensive against missing/zero line/column values
 * which would otherwise produce a negative range.
 */
export function hitToDiagnosticShape(hit: ScanHit): DiagnosticShape {
  const line = Math.max(0, (hit.line ?? 1) - 1);
  const col = Math.max(0, (hit.column ?? 1) - 1);
  const engagement = hit.engagement && hit.engagement.length > 0 ? hit.engagement : "unknown";
  return {
    line,
    column: col,
    endColumn: col + 1,
    severity: "Warning",
    source: "repo-aegis",
    message: `${engagement} marker`,
    engagement,
  };
}
