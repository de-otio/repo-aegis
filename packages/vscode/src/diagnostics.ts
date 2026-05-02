import * as vscode from "vscode";
import { runCli, parseJson, type RunCliOptions } from "./cli.js";
import { hitToDiagnosticShape } from "./format.js";
import type { CheckJson, ScanHit } from "./types.js";

export const DIAGNOSTIC_SOURCE = "repo-aegis";

/**
 * Convert a single ScanHit (1-indexed line/column from repo-aegis) into a
 * VSCode Diagnostic. Range is a 1-character span at the hit's position —
 * we don't know the literal length and the matchPreview is redacted.
 */
export function hitToDiagnostic(hit: ScanHit): vscode.Diagnostic {
  const shape = hitToDiagnosticShape(hit);
  const range = new vscode.Range(shape.line, shape.column, shape.line, shape.endColumn);
  const diag = new vscode.Diagnostic(range, shape.message, vscode.DiagnosticSeverity.Warning);
  diag.source = shape.source;
  diag.code = shape.engagement;
  return diag;
}

export interface ScanFileResult {
  /** True when the CLI ran cleanly (exit 0 or exit 1 with hits). */
  ok: boolean;
  /** Diagnostics for the scanned file. Empty when clean. */
  diagnostics: vscode.Diagnostic[];
  /** Raw JSON for debugging / status surfaces. Null if unparseable. */
  payload: CheckJson | null;
  /** Human-friendly message for command-result notifications. */
  message: string;
}

export interface ScanFileOptions {
  cli: string;
  filePath: string;
  cwd?: string;
  /** Indirection seam for tests. Defaults to the real `runCli`. */
  runner?: (opts: RunCliOptions) => Promise<{ code: number; stdout: string; stderr: string }>;
}

/**
 * Run `repo-aegis check --path <file> --json` and translate the result
 * into VSCode Diagnostics. Never throws on a non-zero exit code; only
 * rejects when the CLI is missing or the spawn itself fails.
 */
export async function scanFile(opts: ScanFileOptions): Promise<ScanFileResult> {
  const runner = opts.runner ?? runCli;
  const r = await runner({
    cli: opts.cli,
    args: ["check", "--path", opts.filePath, "--json"],
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
  });
  const payload = parseJson<CheckJson>(r.stdout);
  if (!payload) {
    return {
      ok: false,
      diagnostics: [],
      payload: null,
      message:
        r.stderr.trim() ||
        `repo-aegis: scan failed (exit ${r.code}); no JSON output. Is the CLI installed and on PATH?`,
    };
  }
  const diagnostics = (payload.hits ?? [])
    .filter(h => !h.path || pathsEqual(h.path, opts.filePath))
    .map(hitToDiagnostic);
  if (diagnostics.length === 0) {
    return {
      ok: true,
      diagnostics: [],
      payload,
      message: payload.advisory
        ? `repo-aegis: clean (advisory; class=${payload.repo.class})`
        : `repo-aegis: clean (${payload.denySet.patternCount} patterns checked)`,
    };
  }
  const noun = diagnostics.length === 1 ? "hit" : "hits";
  return {
    ok: true,
    diagnostics,
    payload,
    message: `repo-aegis: ${diagnostics.length} marker ${noun}${payload.advisory ? " (advisory)" : ""}`,
  };
}

/**
 * Case-sensitive path equality. We deliberately don't `realpath` here —
 * VSCode passes the same string the CLI sees, and the extra fs hit per
 * scan adds nothing.
 */
function pathsEqual(a: string, b: string): boolean {
  return a === b;
}

/**
 * Apply `result.diagnostics` to the given DiagnosticCollection at the
 * file URI. Public so tests can drive it without spawning the CLI.
 */
export function applyDiagnostics(
  collection: vscode.DiagnosticCollection,
  fileUri: vscode.Uri,
  diagnostics: vscode.Diagnostic[],
): void {
  if (diagnostics.length === 0) {
    collection.delete(fileUri);
  } else {
    collection.set(fileUri, diagnostics);
  }
}
