// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { existsSync } from "node:fs";
import {
  computeDenySet,
  loadRegistryState,
  scanFile,
  CustomerCoupledNoEngagementError,
  EXIT_HIT,
  pauseNotice,
  type PauseState,
  type RepoJson,
  type ScanHit,
  type SkippedFile,
  type Registry,
  refusalTrailer,
} from "@de-otio/repo-aegis-core";
import { decideHookAction, ENCRYPTED_REGISTRY_NOTICE, NEWER_SCHEMA_ERROR, type HookDecision } from "./hook-policy.js";
import { parseHookWriteFields, readHookStdin, WRITE_HOOK_INPUT_MAX_BYTES } from "./hook-input.js";
import { pauseCoveringWorkingRepo, recordPausedAllow } from "../pause-scope.js";

/** A scan hit without the text of its match. */
function stripMatchText(hit: unknown): unknown {
  if (hit === null || typeof hit !== "object") return hit;
  const { matchPreview: _preview, ...rest } = hit as Record<string, unknown>;
  return rest;
}

interface HookOptions {
  /** When true, do not exit non-zero on hits — return as if clean. Useful
   * for advisory-only configurations (rarely needed; default off). */
  advisory?: boolean;
  /**
   * The host whose payload arrives on stdin: `cursor` reads `file_path` from the root of an
   * `afterFileEdit` payload (plan T1d); anything else is the Claude Code shape (`tool_input.file_path`).
   */
  agent?: string;
}

/** Added to Cursor's non-zero answers (plan T1d). */
export const CURSOR_DETECTION_ONLY =
  "repo-aegis: this check ran AFTER Cursor saved the edit (afterFileEdit cannot block it), so it is detection " +
  "only and the file is already on disk. The pre-commit hook is the gate: the commit is refused until the marker is removed.";

// The payload's fields (hook-input.ts, parseHookWriteFields): `filePath`, the file the agent just
// wrote/edited, and `cwd`, the session's working directory (the launcher boundary; see the cwd-source
// discussion in doc/bugs/repo-aegis-check-write-flake.md). A payload past 1 MiB is read from its start
// (#156): the file itself is scanned from disk, so only its path is needed.

/** What the agent is told when a cut-off payload did not show which file was written. */
const NOT_SCANNED_REASON =
  "repo-aegis: this write's hook payload is larger than 1 MiB and the file path could not be read from its " +
  "start, so the file that was written has NOT been scanned for markers. Tell your human which file you wrote; " +
  `they can scan it with \`repo-aegis check --path <file>\`. ${refusalTrailer("HOOK_INPUT_TOO_LARGE")}`;

function emitJsonAndExit(value: unknown, exitCode: number): never {
  // Claude Code's hook contract forwards stderr (not stdout) to the agent
  // when a hook exits non-zero. Emitting the JSON diagnostic on stderr in
  // that case is the only way the agent learns *why* its tool call was
  // blocked. Exit-0 emissions stay on stdout for backward compatibility
  // with consumers that pipe the hook's normal output.
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(JSON.stringify(value, null, 2) + "\n");
  process.exit(exitCode);
}

/**
 * `repo-aegis hook scan-after-write` — the Claude Code PostToolUse hook
 * entry point. Reads the tool-result JSON from stdin, extracts the
 * file_path the agent just wrote, and:
 *
 *   - Resolves the destination working tree from `file_path` (not from
 *     `cwd`), so writes into a different repo are scanned against
 *     *that* repo's classification + deny set rather than fail-closing
 *     on `OUTSIDE_WORKING_TREE`.
 *   - When the destination is unclassified, scans against `_always`
 *     and emits a `DEST_UNCLASSIFIED` warning.
 *   - When the file lives outside any git tree (e.g. `/tmp/foo`),
 *     scans against `_always`-only.
 *   - Scans the post-write file content against the resolved deny set;
 *     a marker hit exits 1 with a redacted `hits` payload.
 *
 * Cross-org write refusal lives in PreToolUse — `repo-aegis hook
 * check-write` — where a non-zero exit blocks the tool *before* it
 * runs. PostToolUse fires after the tool's effect lands, so its exit
 * cannot un-write the file. The `CROSS_ORG_WRITE` branch below is
 * retained as defence-in-depth for installs that predate v0.3.0 and
 * have not re-run `install claude-md` to pick up the PreToolUse
 * registration; for those installs it surfaces detection-and-alert,
 * not prevention.
 *
 * Exit semantics:
 *   - 0 if no file_path / file missing / clean,
 *   - 1 on a marker hit,
 *   - 2 on `CROSS_ORG_WRITE` (defence-in-depth) or hard registry errors.
 *
 * The hook NEVER reveals literal markers. `--verbose` is not honoured.
 */
export async function hookScanAfterWrite(opts: HookOptions = {}): Promise<void> {
  const input = await readHookStdin(WRITE_HOOK_INPUT_MAX_BYTES);
  const cursor = opts.agent === "cursor";
  const { filePath, cwd } = parseHookWriteFields(input.text, cursor ? "cursor" : "claude");
  // Cursor's `afterFileEdit` has no output schema and cannot block: say so on every non-zero answer, so
  // nobody reads a hit as a prevented write.
  // (The explicit `never` annotation on the binding is what keeps control-flow narrowing after a call.)
  // Set once the registry is known to be encrypted: every answer then carries the person-facing `systemMessage`
  // (Claude Code drops stderr on exit 0), once per call.
  let notice: string | undefined;
  // P1-E: set once a person's emergency pause covers this write. Detection is not paused: every answer still carries
  // what the scan found, but a marker hit becomes advice (exit 0, `advisory: true`), with the fixed notice and a
  // count. Every OTHER refusal (a cross-org write, an unreadable registry) is lifted only by a pause scoped to this
  // repository: a machine-wide pause keeps the cross-org checks on.
  let paused: PauseState | null = null;
  const emit: (value: unknown, exitCode: number) => never = (value, exitCode) => {
    if (paused !== null) {
      const lifted = exitCode === EXIT_HIT || (exitCode !== 0 && paused.repo !== undefined);
      const hits = (value as { hits?: unknown }).hits;
      const finalCode = lifted ? 0 : exitCode;
      // The audit record says "a pause let something through", so it is written only when the pause lifted a refusal
      // (a marker hit turned advisory, a cross-org or registry refusal lifted by a scoped pause): not for a clean write.
      if (lifted) recordPausedAllow("hook scan-after-write", { verb: "write" });
      const found = finalCode === 0 && Array.isArray(hits) && hits.length > 0 ? `; ${hits.length} marker hit(s) found, advisory while paused` : "";
      // At exit 0 this payload goes to stdout, which lands in the transcript, where a refusal's stderr would not:
      // a hit's `matchPreview` is the first characters of what matched, so it is dropped here (path, line, column
      // and the marker file's stem stay: that is where to look, not what was found).
      const body = finalCode === 0 && Array.isArray(hits) ? { ...(value as object), hits: hits.map(stripMatchText) } : (value as object);
      emitJsonAndExit({ ...body, ...(lifted && { advisory: true }), systemMessage: `${pauseNotice(paused)}${found}` }, finalCode);
    }
    emitJsonAndExit(
      {
        ...(value as object),
        ...(cursor && exitCode !== 0 && { note: CURSOR_DETECTION_ONLY }),
        ...(notice !== undefined && { systemMessage: notice }),
      },
      exitCode,
    );
  };

  if (!filePath) {
    if (input.truncated) emit({ code: "HOOK_INPUT_TOO_LARGE", error: NOT_SCANNED_REASON }, 2);
    process.exit(0);
  }
  if (!existsSync(filePath)) process.exit(0);
  paused = pauseCoveringWorkingRepo(cwd ?? process.cwd());

  // Missing: no registry => no engagements, no orgs. Treat the whole world as one boundary and scan with an empty
  // deny set. The agent would have run `repo-aegis init` already if engagement scoping were in use; the hook should
  // not block plain installs. Encrypted is read the same way (no plaintext to read; encryption at rest is
  // deprecated), so `_always` and engagement markers still scan. A registry that exists but cannot be read is
  // surfaced as REGISTRY_ERROR with fixed text (the parse error names orgs and engagement ids).
  const load = loadRegistryState();
  if (load.state === "newer-schema") emit({ code: "REGISTRY_ERROR", error: NEWER_SCHEMA_ERROR }, 2);
  if (load.state === "unparseable") {
    emit(
      {
        code: "REGISTRY_ERROR",
        error:
          "the registry cannot be read, so the cross-org write check cannot run. " +
          "Run `repo-aegis status` (or `repo-aegis doctor`) in a terminal to see why.",
      },
      2,
    );
  }
  if (load.state === "encrypted") notice = ENCRYPTED_REGISTRY_NOTICE;
  const registry: Registry =
    load.state === "loaded"
      ? load.registry
      : { engagements: [], alwaysBlock: [], personalOrgs: [], schemaVersion: 2 };

  const decision: HookDecision = decideHookAction({
    filePath,
    // Launcher boundary = session cwd from the payload, not the spawn
    // cwd. Falls back to process.cwd() when Claude Code omits `cwd`.
    launcherCwd: cwd ?? process.cwd(),
    registry,
  });

  if (decision.action === "refuse") {
    // Defence-in-depth path: with the v0.3.0 PreToolUse hook installed
    // we never reach here (the tool was blocked before running). For
    // installs that predate v0.3.0 this branch surfaces the cross-org
    // write to the agent — but the file is already on disk, so the
    // recovery is to revert, not to retry. The error message says
    // so explicitly.
    emit(
      {
        code: decision.code,
        error:
          `cross-org write detected post-write: file ${filePath} lives in a working tree ` +
          `whose trust boundary (${decision.destOrgs.join(", ") || "unknown"}) ` +
          `does not overlap the launcher's (${decision.srcOrgs.join(", ") || "unknown"}). ` +
          `The file is already on disk; revert it and re-run \`repo-aegis install claude-md\` ` +
          `to register the PreToolUse hook that prevents this class of write.`,
        details: {
          srcOrgs: decision.srcOrgs,
          destOrgs: decision.destOrgs,
          destTree: decision.destTree,
          remediation: "revert-and-upgrade-install",
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
    emit({ code: err.code, error: err.message }, 2);
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
    emit(
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
    emit({ error: (err as Error).message }, 2);
  }

  const repoJson: RepoJson = {
    cwd: repo.cwd,
    isGitRepo: repo.isGitRepo,
    class: repo.class,
    classExplicit: repo.classExplicit,
    engagements: repo.engagements,
  };

  const advisory = repo.class === "scratch" || !!opts.advisory;
  emit(
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
