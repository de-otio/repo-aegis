// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import * as vscode from "vscode";
import { runCli, parseJson, type RunCliOptions } from "./cli.js";
import { formatStatusLabel, formatStatusTooltip } from "./format.js";
import type { StatusJson } from "./types.js";

export { formatStatusLabel, formatStatusTooltip };

export interface StatusBarOptions {
  cli: string;
  cwd?: string;
  runner?: (opts: RunCliOptions) => Promise<{ code: number; stdout: string; stderr: string }>;
}

/** Run `repo-aegis status --json`. Returns null on any error. */
export async function fetchStatus(opts: StatusBarOptions): Promise<StatusJson | null> {
  const runner = opts.runner ?? runCli;
  try {
    const r = await runner({
      cli: opts.cli,
      args: ["status", "--json"],
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    });
    // status exits 0 even if not a git repo. exit !=0 means a real error.
    if (r.code !== 0 && r.code !== 1) return parseJson<StatusJson>(r.stdout);
    return parseJson<StatusJson>(r.stdout);
  } catch {
    return null;
  }
}

/**
 * Wraps a vscode.StatusBarItem with the repo-aegis label/tooltip
 * convention and provides a single `update()` entry point for the
 * extension lifecycle.
 */
export class RepoAegisStatusBar {
  private readonly item: vscode.StatusBarItem;
  private readonly opts: StatusBarOptions;

  constructor(item: vscode.StatusBarItem, opts: StatusBarOptions) {
    this.item = item;
    this.opts = opts;
    this.item.command = "repo-aegis.status";
    this.item.text = "repo-aegis: …";
    this.item.tooltip = "repo-aegis: querying status…";
  }

  async refresh(): Promise<StatusJson | null> {
    const status = await fetchStatus(this.opts);
    this.item.text = formatStatusLabel(status);
    this.item.tooltip = formatStatusTooltip(status);
    return status;
  }

  show(): void {
    this.item.show();
  }

  hide(): void {
    this.item.hide();
  }

  dispose(): void {
    this.item.dispose();
  }
}
