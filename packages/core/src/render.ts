import { mkdirSync, writeFileSync, readdirSync, unlinkSync, chmodSync } from "node:fs";
import { join } from "node:path";
import {
  markersDir as defaultMarkersDir,
  flatMarkersPath as defaultFlatMarkersPath,
  repoAegisHome,
} from "./paths.js";
import { isActive, type Registry, type Engagement } from "./registry.js";
import { ALWAYS_FILE_STEM } from "./deny-set.js";
import { validatePatterns } from "./regex-safety.js";
import { PatternValidationError } from "./exceptions.js";

/**
 * Format version of marker files written by {@link renderMarkers}. Emitted
 * as the second header line (`; repo-aegis-marker-format: <N>`) of every
 * generated marker file. The deny-set parser ignores `;`-comment lines, so
 * older readers tolerate the field; future readers can branch on it. Per
 * design B14: writers must never lower this version.
 */
export const MARKER_FORMAT_VERSION = 1;

export interface RenderOptions {
  dryRun?: boolean;
  markersDir?: string;
  flatPath?: string;
  retentionMonths?: number;
  /**
   * If true (default), all marker patterns across the registry are validated
   * before any file is written. Patterns failing validation cause render to
   * throw `PatternValidationError` without writing.
   */
  validatePatterns?: boolean;
}

export interface RenderedFile {
  path: string;
  engagementId: string;
  patternCount: number;
}

export interface RenderResult {
  written: RenderedFile[];
  removed: string[];
  flat: string | null;
  invalidPatterns: { engagementId: string; pattern: string; reason: string }[];
}

/**
 * Generate per-engagement marker files from the registry.
 *
 * Behaviour:
 * 1. Validate every pattern across all engagements + alwaysBlock. If any
 *    fail validation, throw `PatternValidationError` and write nothing.
 * 2. Write `markers/_always.txt` from `reg.alwaysBlock`.
 * 3. For each engagement where `isActive(e, retentionMonths)` is true,
 *    write `markers/<id>.txt`.
 * 4. Compare existing marker files against the new set; delete files
 *    whose stem is not in the new set.
 * 5. Write the flat union `markers.txt` for back-compat.
 *
 * All files are written with mode 0600. The markers directory is created
 * with mode 0700.
 */
export function renderMarkers(reg: Registry, opts: RenderOptions = {}): RenderResult {
  const dir = opts.markersDir ?? defaultMarkersDir();
  const flatPath = opts.flatPath ?? defaultFlatMarkersPath();
  const retentionMonths = opts.retentionMonths ?? 12;
  const dryRun = opts.dryRun ?? false;
  const doValidate = opts.validatePatterns ?? true;

  const invalidPatterns: { engagementId: string; pattern: string; reason: string }[] = [];
  if (doValidate) {
    // Strict mode: subprocess-backed validation that can be preemptively
    // killed on catastrophic-backtracking patterns. Render is a manual,
    // infrequent operation; the ~50-200ms spawn overhead is acceptable.
    for (const e of reg.engagements) {
      const r = validatePatterns(e.markers, { strict: true });
      for (const inv of r.invalid) {
        invalidPatterns.push({ engagementId: e.id, pattern: inv.pattern, reason: inv.reason });
      }
    }
    const alwaysR = validatePatterns(reg.alwaysBlock, { strict: true });
    for (const inv of alwaysR.invalid) {
      invalidPatterns.push({
        engagementId: ALWAYS_FILE_STEM,
        pattern: inv.pattern,
        reason: inv.reason,
      });
    }
    if (invalidPatterns.length > 0) {
      throw new PatternValidationError(
        invalidPatterns.map(p => ({
          pattern: p.pattern,
          reason: p.reason,
          engagementId: p.engagementId,
        })),
      );
    }
  }

  const written: RenderedFile[] = [];
  const targetStems = new Set<string>([ALWAYS_FILE_STEM]);

  // Always-block file (even if alwaysBlock is empty: ensures the file exists,
  // simplifying downstream "compute deny set" logic).
  if (!dryRun) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* permission may be platform-restricted */
    }
  }
  const alwaysPath = join(dir, `${ALWAYS_FILE_STEM}.txt`);
  if (!dryRun) writeMarkerFile(alwaysPath, ALWAYS_FILE_STEM, reg.alwaysBlock);
  written.push({
    path: alwaysPath,
    engagementId: ALWAYS_FILE_STEM,
    patternCount: reg.alwaysBlock.length,
  });

  for (const e of reg.engagements) {
    if (!isActive(e, retentionMonths)) continue;
    targetStems.add(e.id);
    const path = join(dir, `${e.id}.txt`);
    if (!dryRun) writeMarkerFile(path, e.id, e.markers, e.name);
    written.push({ path, engagementId: e.id, patternCount: e.markers.length });
  }

  // Remove stale marker files whose stem is no longer in the target set.
  let existing: string[] = [];
  try {
    existing = readdirSync(dir).filter(f => f.endsWith(".txt"));
  } catch {
    /* dir may not exist yet in dry-run */
  }
  const removed: string[] = [];
  for (const fname of existing) {
    const stem = fname.replace(/\.txt$/, "");
    if (!targetStems.has(stem)) {
      const p = join(dir, fname);
      if (!dryRun) {
        try {
          unlinkSync(p);
        } catch {
          /* ignore */
        }
      }
      removed.push(p);
    }
  }

  // Flat union for back-compat.
  let flatWritten: string | null = null;
  if (!dryRun) {
    const flatBody = buildFlatUnion(reg, retentionMonths);
    writeFileSync(flatPath, flatBody, { mode: 0o600 });
    try {
      chmodSync(flatPath, 0o600);
    } catch {
      /* ignore */
    }
    flatWritten = flatPath;
  } else {
    flatWritten = flatPath;
  }

  // Best-effort: ensure home dir is mode 700 too.
  if (!dryRun) {
    try {
      chmodSync(repoAegisHome(), 0o700);
    } catch {
      /* ignore */
    }
  }

  return { written, removed, flat: flatWritten, invalidPatterns };
}

function writeMarkerFile(path: string, engagementId: string, patterns: string[], name?: string): void {
  const header =
    `; generated by repo-aegis render — do not edit by hand\n` +
    `; repo-aegis-marker-format: ${MARKER_FORMAT_VERSION}\n` +
    `; engagement: ${engagementId}${name ? ` (${name})` : ""}\n`;
  writeFileSync(path, header + patterns.join("\n") + (patterns.length > 0 ? "\n" : ""), {
    mode: 0o600,
  });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* ignore */
  }
}

function buildFlatUnion(reg: Registry, retentionMonths: number): string {
  const parts: string[] = [
    "; generated by repo-aegis render — back-compat union of all active engagements",
    `; repo-aegis-marker-format: ${MARKER_FORMAT_VERSION}`,
    "",
  ];
  if (reg.alwaysBlock.length > 0) {
    parts.push(`; ${ALWAYS_FILE_STEM}`);
    parts.push(...reg.alwaysBlock);
    parts.push("");
  }
  for (const e of reg.engagements as Engagement[]) {
    if (!isActive(e, retentionMonths)) continue;
    parts.push(`; ${e.id}${e.name ? ` (${e.name})` : ""}`);
    parts.push(...e.markers);
    parts.push("");
  }
  return parts.join("\n");
}
