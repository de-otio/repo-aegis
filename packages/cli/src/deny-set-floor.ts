// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// The fail-closed floor, CLI side: turn core's pure decision
// (`denySetFloorShortfall`, with the rationale for the floor) into the
// standard error output and exit 2.
//
// It lives in the CLI rather than in the composite Action because the Action
// is only one of the callers: a local pre-push, a scheduled sweep, and the MCP
// server can all be handed a registry that isn't there. Enforcing it where the
// number is computed means every caller inherits it, and no caller has to
// parse JSON in bash to find out.
import { denySetFloorShortfall, type DenySetFloorInput } from "@de-otio/repo-aegis-core";
import { emitError, type OutputOptions } from "./format.js";

export interface DenySetFloorOptions extends OutputOptions, DenySetFloorInput {}

/** Exit 2 when the computed deny set is below the floor. */
export function enforceDenySetFloor(
  patternCount: number,
  markerFiles: readonly string[],
  opts: DenySetFloorOptions,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const shortfall = denySetFloorShortfall(patternCount, markerFiles.length, opts, env);
  if (shortfall === null) return;
  emitError(
    { code: shortfall.code, error: shortfall.error, details: shortfall.details },
    opts,
  );
}
