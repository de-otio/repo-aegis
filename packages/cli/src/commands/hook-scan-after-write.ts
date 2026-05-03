// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { existsSync } from "node:fs";
import {
  computeDenySet,
  loadRegistry,
  scanFile,
  CustomerCoupledNoEngagementError,
  RegistryEncryptedError,
  RegistryNotFoundError,
  EXIT_HIT,
  type RepoJson,
  type ScanHit,
  type SkippedFile,
  type Registry,
} from "@de-otio/repo-aegis-core";
import { decideHookAction, type HookDecision } from "./hook-policy.js";

interface HookOptions {
  /** When true, do not exit non-zero on hits — return as if clean. Useful
   * for advisory-only configurations (rarely needed; default off). */
  advisory?: boolean;
}

/**
 * Read all of stdin to a string. The Claude Code PostToolUse hook contract
 * sends a JSON tool-result payload on stdin. Sizes are typically a few
 * hundred bytes; we cap at 1 MiB to avoid an unbounded buffer.
 */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  const MAX = 1024 * 1024;
  for await (const chunk of process.stdin) {
    const b = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    total += b.length;
    if (total > MAX) {
      // Hook payload is unexpectedly large; ignore the rest. Hooks must
      // be silent on non-fatal anomalies — failing here would surface
      // as an "agent saw an error" event in the tool result, which is
      // exactly the wrong place for noise.
      break;
    }
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Extract the path of the file the agent just wrote/edited from the
 * Claude Code PostToolUse JSON payload. The agent contract puts it under
 * `tool_input.file_path` for Write/Edit/MultiEdit; some older shapes use
 * `tool_input.path`. Anything else => no path.
 */
function extractFilePath(json: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const root = parsed as Record<string, unknown>;
  const ti = root["tool_input"];
  if (!ti || typeof ti !== "object") return undefined;
  const tiObj = ti as Record<string, unknown>;
  for (const k of ["file_path", "path"]) {
    const v = tiObj[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

function emitJsonAndExit(value: unknown, exitCode: number): never {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
  process.exit(exitCode);
}

/**
 * `repo-aegis hook scan-after-write` — the Claude Code PostToolUse hook
 * entry point. Reads the tool-result JSON from stdin, extracts the
 * file_path the agent just wrote, and runs the path-aware policy:
 *
 *   - Resolves the destination working tree from `file_path` (not from
 *     `cwd`), so writes into a different repo are scanned against
 *     *that* repo's classification + deny set rather than fail-closing
 *     on `OUTSIDE_WORKING_TREE`.
 *   - When the source and destination working trees belong to
 *     different trust boundaries (different engagement orgs, no shared
 *     `personalOrgs` membership), refuses with `CROSS_ORG_WRITE`.
 *   - When the destination is unclassified, scans against `_always`
 *     and emits a `DEST_UNCLASSIFIED` warning.
 *   - When the file lives outside any git tree (e.g. `/tmp/foo`),
 *     scans against `_always`-only.
 *
 * Exit semantics:
 *   - 0 if no file_path / file missing / clean,
 *   - 1 on a marker hit,
 *   - 2 on `CROSS_ORG_WRITE` or hard registry errors.
 *
 * The hook NEVER reveals literal markers. `--verbose` is not honoured.
 */
export async function hookScanAfterWrite(opts: HookOptions = {}): Promise<void> {
  const stdinText = await readStdin();
  const filePath = extractFilePath(stdinText);

  if (!filePath) process.exit(0);
  if (!existsSync(filePath)) process.exit(0);

  let registry: Registry;
  try {
    registry = loadRegistry();
  } catch (err) {
    // Registry is required for trust-boundary computation. Surface
    // structured errors; otherwise stay silent (hook context).
    if (err instanceof RegistryNotFoundError) {
      // No registry => no engagements, no orgs. Treat the whole world
      // as one boundary and scan with an empty deny set. The agent
      // would have run `repo-aegis init` already if engagement scoping
      // were in use; the hook should not block plain installs.
      registry = { engagements: [], alwaysBlock: [], personalOrgs: [], schemaVersion: 2 };
    } else if (err instanceof RegistryEncryptedError) {
      emitJsonAndExit(
        {
          code: err.code,
          error: err.message,
        },
        2,
      );
    } else {
      emitJsonAndExit(
        {
          code: "REGISTRY_ERROR",
          error: (err as Error).message,
        },
        2,
      );
    }
  }

  const decision: HookDecision = decideHookAction({
    filePath,
    launcherCwd: process.cwd(),
    registry,
  });

  if (decision.action === "refuse") {
    emitJsonAndExit(
      {
        code: decision.code,
        error:
          `cross-org write refused: file ${filePath} lives in a working tree ` +
          `whose trust boundary (${decision.destOrgs.join(", ") || "unknown"}) ` +
          `does not overlap the launcher's (${decision.srcOrgs.join(", ") || "unknown"})`,
        details: {
          srcOrgs: decision.srcOrgs,
          destOrgs: decision.destOrgs,
          destTree: decision.destTree,
        },
      },
      2,
    );
  }

  // Both "scan" and "scan-with-warning" run a scan; only the warnings
  // payload differs.
  const repo = decision.repo;

  if (repo.isGitRepo && repo.class === "customer-coupled" && repo.engagements.length === 0) {
    const err = new CustomerCoupledNoEngagementError();
    emitJsonAndExit({ code: err.code, error: err.message }, 2);
  }

  const denySet = computeDenySet(repo);
  const warnings: Array<string | object> = [...denySet.warnings];
  if (decision.action === "scan-with-warning") {
    warnings.push({
      code: decision.warning.code,
      destTree: decision.warning.destTree,
      hasRemote: decision.warning.hasRemote,
    });
  }

  if (denySet.combinedRegex === "") {
    emitJsonAndExit(
      {
        hits: [],
        skipped: [],
        status: "no-deny-set",
        warnings,
      },
      0,
    );
  }

  let hits: ScanHit[] = [];
  let skipped: SkippedFile[] = [];
  try {
    const r = scanFile(
      filePath,
      denySet,
      { revealMatches: false, respectAllowComments: true },
      decision.workingTree ?? undefined,
    );
    hits = r.hits;
    skipped = r.skipped;
  } catch (err) {
    emitJsonAndExit({ error: (err as Error).message }, 2);
  }

  const repoJson: RepoJson = {
    cwd: repo.cwd,
    isGitRepo: repo.isGitRepo,
    class: repo.class,
    classExplicit: repo.classExplicit,
    engagements: repo.engagements,
  };

  const advisory = repo.class === "scratch" || !!opts.advisory;
  emitJsonAndExit(
    {
      mode: "path",
      hits,
      historyHits: [],
      skipped,
      repo: repoJson,
      denySet: { files: denySet.files.map(f => f.stem), patternCount: denySet.patterns.length },
      advisory,
      warnings,
    },
    hits.length > 0 && !advisory ? EXIT_HIT : 0,
  );
}
