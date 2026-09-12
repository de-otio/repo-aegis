// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `repo-aegis install shim [tool]` — writes `<home>/bin/<tool>` ahead of
// the real binary on PATH. Implemented in the L2 lane; see
// doc/design/egress-guard.md §3. `checkShim` feeds `doctor`.
import { emitError, type OutputOptions } from "../format.js";
import type { DoctorCheck } from "./doctor-checks.js";

export interface InstallShimOptions extends OutputOptions {
  uninstall?: boolean;
  force?: boolean;
}

export function installShim(_tool: string | undefined, _opts: InstallShimOptions): void {
  emitError({ code: "NOT_IMPLEMENTED", error: "install shim is not yet implemented" }, {});
}

/**
 * `doctor` checks for the shim: `SHIM_MISSING` when `<home>/bin/gh` does
 * not exist, `SHIM_NOT_FIRST` when it exists but another `gh` precedes it
 * on `PATH`. Returns `[]` until the L2 lane lands.
 */
export function checkShim(_env: NodeJS.ProcessEnv = process.env): DoctorCheck[] {
  return [];
}
