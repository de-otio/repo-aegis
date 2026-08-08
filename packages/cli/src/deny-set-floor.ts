// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// The fail-closed floor: refuse to report "clean" from a deny set that is
// smaller than the caller says it must be.
//
// The failure this exists for is specific and silent. A CI workflow restores
// the engagement registry from a secret; secrets are not exposed to
// `pull_request` runs from forks, so the restore step writes an empty file,
// the deny set computes to zero patterns, the scan matches nothing, and the
// job exits 0. A green check that scanned nothing looks exactly like a green
// check that scanned everything. The same shape occurs on a mistyped secret
// name, a rotated-away secret, a `registry` input pointing at a path that
// doesn't exist, and a registry that silently lost an engagement.
//
// It lives in the CLI rather than in the composite Action because the Action
// is only one of the callers: a local pre-push, a scheduled sweep, and the MCP
// server can all be handed a registry that isn't there. Enforcing it where the
// number is computed means every caller inherits it, and no caller has to
// parse JSON in bash to find out.
import { emitError, type OutputOptions } from "./format.js";

export interface DenySetFloorOptions extends OutputOptions {
  /** Minimum number of patterns the computed deny set must contain. */
  minPatterns?: number;
  /** Sugar for `--min-patterns 1`. */
  requireDenySet?: boolean;
}

/**
 * Resolve the effective floor from flags and env.
 *
 * `--min-patterns` wins over `--require-deny-set` when both are given, so a
 * workflow can set a real floor without having to remove the boolean the
 * template shipped with. `REPO_AEGIS_MIN_PATTERNS` is the env equivalent, for
 * the Action (which sets it once for every invocation rather than splicing a
 * flag into a user-supplied `args` string, where a consumer could overwrite
 * it).
 */
export function resolveMinPatterns(
  opts: DenySetFloorOptions,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (typeof opts.minPatterns === "number" && Number.isFinite(opts.minPatterns)) {
    return Math.max(0, Math.trunc(opts.minPatterns));
  }
  if (opts.requireDenySet) return 1;
  const fromEnv = env.REPO_AEGIS_MIN_PATTERNS;
  if (fromEnv !== undefined && fromEnv !== "") {
    const n = Number.parseInt(fromEnv, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

/**
 * Exit 2 when the computed deny set is below the floor.
 *
 * Exit 2, not 1: "the gate could not run" is a different fact from "the gate
 * ran and found something", and conflating them is what lets a broken gate
 * masquerade as a passing one. This matches the existing fail-closed
 * convention in `check` — a git failure exits 2 rather than reporting clean.
 *
 * The message names the likely causes because the operator reading it is
 * usually staring at a red CI job with no local reproduction: on their machine
 * the registry is right there and the floor is satisfied.
 */
export function enforceDenySetFloor(
  patternCount: number,
  markerFiles: readonly string[],
  opts: DenySetFloorOptions,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const floor = resolveMinPatterns(opts, env);
  if (floor === 0 || patternCount >= floor) return;

  emitError(
    {
      code: "DENY_SET_BELOW_FLOOR",
      error:
        `deny set has ${patternCount} pattern(s), below the required minimum of ${floor}. ` +
        `Refusing to report a result: a scan that had nothing to match is not a clean scan. ` +
        `Common causes: the engagement registry was not available (a fork PR cannot read ` +
        `secrets), REPO_AEGIS_REGISTRY points at a missing or empty file, or this repo's ` +
        `allowed engagements no longer resolve to any active marker file. ` +
        `Set --min-patterns 0 (or require-deny-set: 'false' on the Action) only if you ` +
        `intend this repo to be scanned with no deny set.`,
      details: { patternCount, minPatterns: floor, markerFiles: markerFiles.length },
    },
    opts,
  );
}
