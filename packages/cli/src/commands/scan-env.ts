// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `repo-aegis scan-env` — discover this machine's private package-registry
// hosts from the developer's toolchain configs and offer them as markers.
//
// Companion to the egress check: `check`/`audit` catch a private host once it
// has reached a lockfile; this catches the configuration that puts it there.
// Explicitly invoked — never on the gate path — and **dry-run by default**, so
// it can never mutate the deny set as a side effect of being curious.
//
// Security posture:
//   - Hosts only. The parsers never read an auth token, and nothing here
//     persists a credential (see `core/env-scan.ts`).
//   - Nothing is written without an explicit `--accept <placement>`.

import { homedir } from "node:os";
import {
  defaultEnvSources,
  scanEnvSources,
  hostToMarkerPattern,
  addTopLevelPatterns,
  addMarkerPatterns,
  appendAuditRecord,
  MIN_ENV_HOST_LENGTH,
  EngagementNotFoundError,
  PatternValidationError,
  type EnvHostFinding,
} from "@de-otio/repo-aegis-core";
import { emitJson, emitText, emitError, type OutputOptions } from "../format.js";

/**
 * Where an accepted host should be recorded.
 *
 * `private-infra` is the default recommendation: a machine's registry host is
 * usually not attributable to one engagement, and it is legitimate in private
 * repos — so blocking it everywhere (`always-block`) would fire constantly in
 * exactly the repos where it belongs.
 */
export type ScanEnvPlacement = "private-infra" | "always-block" | "engagement";

export interface ScanEnvOptions extends OutputOptions {
  /** Persist accepted hosts to this placement. Omit for a dry run. */
  accept?: string;
  /** Engagement id — required when `--accept engagement`. */
  engagement?: string;
  /**
   * Override the home dir whose dotfiles are scanned. Deliberately NOT named
   * `home`: `--home` is a reserved global that repoints REPO_AEGIS_HOME, and
   * reusing it here silently redirected the registry.
   */
  scanHome?: string;
  /** Also scan project-level configs under this dir. Default: cwd. */
  from?: string;
  /** Override registry path; passed through to the mutators (tests). */
  registryPath?: string;
}

const PLACEMENTS: readonly ScanEnvPlacement[] = [
  "private-infra",
  "always-block",
  "engagement",
];

interface Candidate {
  finding: EnvHostFinding;
  pattern: string;
}

export function scanEnv(opts: ScanEnvOptions): void {
  const placement = opts.accept as ScanEnvPlacement | undefined;
  if (placement !== undefined && !PLACEMENTS.includes(placement)) {
    emitError(
      {
        code: "USAGE",
        error: `--accept must be one of: ${PLACEMENTS.join(", ")}`,
      },
      opts,
    );
  }
  if (placement === "engagement" && !opts.engagement) {
    emitError(
      { code: "USAGE", error: "--accept engagement requires --engagement <id>" },
      opts,
    );
  }

  const home = opts.scanHome ?? homedir();
  const cwd = opts.from ?? process.cwd();
  const { hosts, scanned, publicHostCount } = scanEnvSources(
    defaultEnvSources(home, cwd),
  );

  // Hosts too short to be safe as substring literals are dropped, not offered.
  const candidates: Candidate[] = [];
  const tooShort: string[] = [];
  for (const finding of hosts) {
    const pattern = hostToMarkerPattern(finding.host);
    if (pattern === null) {
      tooShort.push(finding.host);
      continue;
    }
    candidates.push({ finding, pattern });
  }

  if (candidates.length === 0) {
    if (opts.json) {
      emitJson({
        action: "scan-env",
        scanned,
        candidates: [],
        accepted: [],
        publicHostsFiltered: publicHostCount,
        tooShort,
      });
      return;
    }
    emitText(
      scanned.length === 0
        ? "scan-env: no toolchain config files found"
        : `scan-env: no private-registry hosts found in ${scanned.length} config file(s)`,
    );
    return;
  }

  // Dry run (the default): show what WOULD be added, persist nothing.
  if (placement === undefined) {
    if (opts.json) {
      emitJson({
        action: "scan-env",
        dryRun: true,
        scanned,
        publicHostsFiltered: publicHostCount,
        tooShort,
        candidates: candidates.map(c => ({
          host: c.finding.host,
          source: c.finding.source,
          kind: c.finding.kind,
          field: c.finding.field,
          pattern: c.pattern,
        })),
      });
      return;
    }
    emitText(
      `scan-env: ${candidates.length} private-registry host(s) in ${scanned.length} config file(s)`,
    );
    for (const c of candidates) {
      emitText(`  ${c.finding.host}`);
      emitText(`    from ${c.finding.source} (${c.finding.field})`);
    }
    emitText("");
    emitText("nothing written (dry run). To record these, re-run with one of:");
    emitText("  --accept private-infra              blocked in public-facing repos only (recommended)");
    emitText("  --accept always-block               blocked everywhere");
    emitText("  --accept engagement --engagement <id>   scoped to one engagement");
    if (tooShort.length > 0) {
      emitText("");
      emitText(
        `note: ${tooShort.length} host(s) skipped as too short (< ${MIN_ENV_HOST_LENGTH} chars) to match safely`,
      );
    }
    return;
  }

  // Persist.
  const patterns = candidates.map(c => c.pattern);
  let result;
  try {
    result =
      placement === "engagement"
        ? addMarkerPatterns(opts.engagement!, patterns, {
            ...(opts.registryPath !== undefined && { registryPath: opts.registryPath }),
            source: "scan-env",
          })
        : addTopLevelPatterns(
            placement === "always-block" ? "always_block" : "privateInfra",
            patterns,
            {
              ...(opts.registryPath !== undefined && { registryPath: opts.registryPath }),
              source: "scan-env",
            },
          );
  } catch (err) {
    if (err instanceof EngagementNotFoundError) {
      emitError({ code: err.code, error: err.message }, opts);
    }
    if (err instanceof PatternValidationError) {
      emitError(
        { code: err.code, error: "synthesised host patterns failed validation" },
        opts,
      );
    }
    emitError({ code: "WRITE_FAILED", error: (err as Error).message }, opts);
  }

  // Audit: counts and placement only — the patterns are private hostnames.
  try {
    appendAuditRecord({
      action: "scan-env-run",
      engagement: placement === "engagement" ? opts.engagement! : placement,
      details: {
        sourcesScanned: scanned.length,
        candidateCount: candidates.length,
        addedCount: result.added.length,
        skippedCount: result.skipped.length,
      },
    });
  } catch {
    /* audit log must not break user-facing ops */
  }

  if (opts.json) {
    emitJson({
      action: "scan-env",
      placement,
      scanned,
      added: result.added,
      skippedDuplicates: result.skipped,
      rendered: result.rendered,
      publicHostsFiltered: publicHostCount,
      tooShort,
    });
    return;
  }
  emitText(
    `scan-env: recorded ${result.added.length} host pattern(s) under ${placement}` +
      (result.skipped.length > 0 ? ` (${result.skipped.length} already present)` : ""),
  );
}
