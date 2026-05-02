import * as vscode from "vscode";
import { runCli, parseJson, type RunCliOptions } from "./cli.js";
import { scanFile, applyDiagnostics } from "./diagnostics.js";
import { fetchStatus, formatStatusTooltip } from "./status-bar.js";
import type { MarkersTestJson } from "./types.js";

export interface CommandDeps {
  /** CLI path. Reads from configuration on each command invocation so the
   *  user can edit settings without restarting the extension. */
  getCli: () => string;
  diagnostics: vscode.DiagnosticCollection;
  /** Optional indirection seam for tests. */
  runner?: (opts: RunCliOptions) => Promise<{ code: number; stdout: string; stderr: string }>;
}

/**
 * Run a check on the active editor's file, surface a notification with
 * the result, and update the diagnostic collection.
 */
export async function checkCurrentFile(deps: CommandDeps): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showInformationMessage("repo-aegis: no active editor.");
    return;
  }
  const doc = editor.document;
  if (doc.uri.scheme !== "file") {
    void vscode.window.showInformationMessage(
      `repo-aegis: skipping ${doc.uri.scheme}:// document (only file:// is scanned).`,
    );
    return;
  }
  const cwd = workspaceFolderForUri(doc.uri);
  const result = await scanFile({
    cli: deps.getCli(),
    filePath: doc.uri.fsPath,
    ...(cwd !== undefined ? { cwd } : {}),
    ...(deps.runner !== undefined ? { runner: deps.runner } : {}),
  });
  applyDiagnostics(deps.diagnostics, doc.uri, result.diagnostics);
  if (result.diagnostics.length === 0) {
    void vscode.window.showInformationMessage(result.message);
  } else {
    void vscode.window.showWarningMessage(result.message);
  }
}

/**
 * Run `status --json` and surface the result as an information message
 * (truncated to a sensible length). The webview-panel variant is
 * deliberately not implemented — VSCode users who want the full JSON
 * can run the CLI in a terminal.
 */
export async function showStatus(deps: CommandDeps): Promise<void> {
  const cwd = activeWorkspaceCwd();
  const status = await fetchStatus({
    cli: deps.getCli(),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(deps.runner !== undefined ? { runner: deps.runner } : {}),
  });
  if (!status) {
    void vscode.window.showWarningMessage(
      "repo-aegis: could not get status. Is the CLI installed and is this a git repo?",
    );
    return;
  }
  void vscode.window.showInformationMessage(formatStatusTooltip(status), { modal: false });
}

/**
 * Prompt for a string and run `markers test <input> --json`. Reports
 * how many patterns matched. We deliberately do NOT pass --verbose, so
 * neither the user input nor the matched patterns are echoed back as
 * literals (the CLI redacts both).
 */
export async function markersTest(deps: CommandDeps): Promise<void> {
  const input = await vscode.window.showInputBox({
    prompt: "repo-aegis: test a string against this repo's deny set",
    placeHolder: "Some string suspected of tripping a marker",
    ignoreFocusOut: true,
  });
  if (input === undefined || input.length === 0) return;

  const cwd = activeWorkspaceCwd();
  const runner = deps.runner ?? runCli;
  const r = await runner({
    cli: deps.getCli(),
    args: ["markers", "test", input, "--json"],
    ...(cwd !== undefined ? { cwd } : {}),
  });
  const payload = parseJson<MarkersTestJson>(r.stdout);
  if (!payload) {
    void vscode.window.showErrorMessage(
      r.stderr.trim() || `repo-aegis: markers test failed (exit ${r.code}).`,
    );
    return;
  }
  const n = payload.hits.length;
  if (n === 0) {
    void vscode.window.showInformationMessage(
      `repo-aegis: no marker matched in this repo's deny set.`,
    );
    return;
  }
  // Report file-stem counts but not the engagements verbatim per stem
  // (still aggregated; the file stems are NOT literal markers, so this
  // is in line with the CLI's redacted output policy).
  const stems = new Set(payload.hits.map(h => h.fileStem));
  void vscode.window.showWarningMessage(
    `repo-aegis: ${n} marker hit${n === 1 ? "" : "s"} across ${stems.size} marker file${stems.size === 1 ? "" : "s"}.`,
  );
}

/** Best-effort workspace folder for a document URI. */
function workspaceFolderForUri(uri: vscode.Uri): string | undefined {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  return folder?.uri.fsPath;
}

/**
 * The cwd we hand to the CLI for status/markers. Prefers the active
 * editor's folder, falls back to the first workspace folder.
 */
function activeWorkspaceCwd(): string | undefined {
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (folder) return folder.uri.fsPath;
  }
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}
