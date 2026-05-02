import * as vscode from "vscode";
import { probeVersion } from "./cli.js";
import { scanFile, applyDiagnostics, DIAGNOSTIC_SOURCE } from "./diagnostics.js";
import { RepoAegisStatusBar } from "./status-bar.js";
import { checkCurrentFile, showStatus, markersTest, type CommandDeps } from "./commands.js";

const CONFIG_NS = "repo-aegis";

interface ExtensionState {
  diagnostics: vscode.DiagnosticCollection;
  statusBar: RepoAegisStatusBar | null;
  /** True once the version probe has reported a working CLI. */
  cliAvailable: boolean;
}

let state: ExtensionState | null = null;

function getCli(): string {
  return vscode.workspace.getConfiguration(CONFIG_NS).get<string>("cli", "repo-aegis");
}

function getScanOnSave(): boolean {
  return vscode.workspace.getConfiguration(CONFIG_NS).get<boolean>("scanOnSave", true);
}

function getStatusBarEnabled(): boolean {
  return vscode.workspace.getConfiguration(CONFIG_NS).get<boolean>("statusBar", true);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const diagnostics = vscode.languages.createDiagnosticCollection(DIAGNOSTIC_SOURCE);
  context.subscriptions.push(diagnostics);

  state = {
    diagnostics,
    statusBar: null,
    cliAvailable: false,
  };

  const cli = getCli();
  const version = await probeVersion(cli);
  state.cliAvailable = version !== null;

  if (!state.cliAvailable) {
    // Show the not-found notice once and disable further behaviour.
    // Commands stay registered so the user can re-trigger after fixing
    // PATH; they'll fail with a friendly message via runCli.
    void vscode.window.showInformationMessage(
      "repo-aegis CLI not found on PATH. Install it from https://github.com/de-otio/repo-aegis.",
    );
  }

  // Status bar — only created when (a) CLI is available and (b) the
  // user hasn't opted out.
  if (state.cliAvailable && getStatusBarEnabled()) {
    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    state.statusBar = new RepoAegisStatusBar(item, { cli });
    state.statusBar.show();
    void state.statusBar.refresh();
    context.subscriptions.push({ dispose: () => state?.statusBar?.dispose() });
  }

  // Commands — registered regardless of CLI availability so error
  // surfaces stay consistent.
  const deps: CommandDeps = {
    getCli,
    diagnostics,
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("repo-aegis.checkCurrentFile", () => checkCurrentFile(deps)),
    vscode.commands.registerCommand("repo-aegis.status", async () => {
      await showStatus(deps);
      // Refresh the status bar after an explicit status invocation so
      // the cached label reflects any registry/repo edits that
      // happened while the bar was idle.
      await state?.statusBar?.refresh();
    }),
    vscode.commands.registerCommand("repo-aegis.markersTest", () => markersTest(deps)),
  );

  // Scan-on-save. Skipped silently when CLI missing or setting disabled.
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async doc => {
      if (!state?.cliAvailable) return;
      if (!getScanOnSave()) return;
      if (doc.uri.scheme !== "file") return;
      const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
      const result = await scanFile({
        cli: getCli(),
        filePath: doc.uri.fsPath,
        ...(folder ? { cwd: folder.uri.fsPath } : {}),
      });
      applyDiagnostics(diagnostics, doc.uri, result.diagnostics);
    }),
  );

  // React to setting changes for the status-bar visibility toggle.
  // We don't re-probe the CLI on every config change — the user
  // editing `repo-aegis.cli` is rare and a reload-window prompt would
  // be the right UX, but that's out of scope for v0.1.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (!state) return;
      if (e.affectsConfiguration(`${CONFIG_NS}.statusBar`)) {
        if (getStatusBarEnabled()) {
          state.statusBar?.show();
        } else {
          state.statusBar?.hide();
        }
      }
    }),
  );

  // Clear stale diagnostics when a file is closed.
  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument(doc => {
      if (doc.uri.scheme === "file") diagnostics.delete(doc.uri);
    }),
  );
}

export function deactivate(): void {
  state?.statusBar?.dispose();
  state?.diagnostics.dispose();
  state = null;
}
