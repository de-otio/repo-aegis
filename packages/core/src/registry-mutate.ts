// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `addMarkerPattern` / `addMarkerPatterns` (P2-B-1) — core helper for
// programmatically appending validated regex patterns to an
// engagement's markers.
//
// [SEC M-3] Lock scope covers the entire load-modify-write-render
// cycle so concurrent callers (parallel `suggest-markers` runs against
// different engagements) cannot lose updates or leave the rendered
// markers stale relative to the registry.

import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { parseDocument, YAMLSeq, YAMLMap, Scalar, isMap } from "yaml";
import { registryPath as defaultRegistryPath } from "./paths.js";
import { loadRegistry } from "./registry.js";
import { renderMarkers } from "./render.js";
import { withLockSync } from "./lock.js";
import { validatePattern } from "./regex-safety.js";
import { appendAuditRecord } from "./audit-log.js";
import {
  EngagementNotFoundError,
  PatternValidationError,
} from "./exceptions.js";

export interface AddMarkerPatternOptions {
  /** Override the registry path (defaults to ~/.config/repo-aegis/engagements.yaml). */
  registryPath?: string;
  /**
   * When true, audit-log writes record the source the pattern came from
   * (e.g. `"suggest-markers"`). Caller-provided so the caller's verb
   * shows up in the trail. Default: `"manual"`.
   */
  source?: string;
}

export interface AddMarkerPatternResult {
  added: string[];
  skipped: string[];
  rendered: { written: number; removed: number };
}

function findEngagementNode(doc: ReturnType<typeof parseDocument>, id: string): YAMLMap | null {
  const seq = doc.get("engagements") as YAMLSeq | null;
  if (!seq || !seq.items) return null;
  for (const item of seq.items) {
    if (!isMap(item)) continue;
    const idNode = item.get("id");
    if (typeof idNode === "string" && idNode === id) return item as YAMLMap;
    if (idNode instanceof Scalar && idNode.value === id) return item as YAMLMap;
  }
  return null;
}

function readMarkers(node: YAMLMap): string[] {
  const seq = node.get("markers") as YAMLSeq | null;
  if (!seq || !seq.items) return [];
  const out: string[] = [];
  for (const item of seq.items) {
    if (typeof item === "string") out.push(item);
    else if (item instanceof Scalar && typeof item.value === "string")
      out.push(item.value);
  }
  return out;
}

/**
 * Append one or more validated regex patterns to an engagement's
 * markers. Held under a single registry lock for the entire
 * load-modify-write-render cycle (see [SEC M-3]). Idempotent: patterns
 * already present are reported in `skipped`, not re-added.
 *
 * Throws:
 *   - `EngagementNotFoundError` if no engagement with that id exists.
 *   - `PatternValidationError` if any pattern fails `validatePattern`.
 */
export function addMarkerPatterns(
  engagementId: string,
  patterns: string[],
  opts: AddMarkerPatternOptions = {},
): AddMarkerPatternResult {
  const path = opts.registryPath ?? defaultRegistryPath();
  const source = opts.source ?? "manual";

  // Validate every pattern up front. Fail closed before touching the
  // registry on the first bad pattern.
  const invalid: Array<{ pattern: string; reason: string }> = [];
  for (const p of patterns) {
    const v = validatePattern(p);
    if (!v.ok) {
      invalid.push({ pattern: p, reason: v.reason ?? "unknown" });
    }
  }
  if (invalid.length > 0) {
    throw new PatternValidationError(
      invalid.map(i => ({ ...i, engagementId })),
    );
  }

  // [SEC M-3] Lock spans the entire read-modify-write-render cycle.
  const result = withLockSync(() => {
    if (!existsSync(path)) {
      throw new Error(`registry not found at ${path}`);
    }
    const raw = readFileSync(path, "utf8");
    const doc = parseDocument(raw);

    const node = findEngagementNode(doc, engagementId);
    if (node === null) {
      throw new EngagementNotFoundError(engagementId);
    }

    let seq = node.get("markers") as YAMLSeq | null;
    if (!seq || !(seq instanceof YAMLSeq)) {
      seq = new YAMLSeq();
      node.set("markers", seq);
    }

    const existing = new Set(readMarkers(node));
    const added: string[] = [];
    const skipped: string[] = [];
    for (const p of patterns) {
      if (existing.has(p)) {
        skipped.push(p);
        continue;
      }
      seq.add(p);
      existing.add(p);
      added.push(p);
    }

    if (added.length > 0) {
      writeFileSync(path, doc.toString(), { mode: 0o600 });
      try {
        chmodSync(path, 0o600);
      } catch {
        /* platform-restricted */
      }
    }

    // Re-render markers regardless of whether new patterns landed:
    // skipped duplicates still represent a successful no-op for the
    // caller, and re-rendering keeps the markers/ output in sync if
    // anything else mutated the registry between previous render and
    // now (covered by the same lock).
    const reg = loadRegistry(path);
    const render = renderMarkers(reg);

    return {
      added,
      skipped,
      rendered: { written: render.written.length, removed: render.removed.length },
    };
  });

  // Audit (best-effort). Records id + counts only — never the literal
  // patterns themselves.
  try {
    appendAuditRecord({
      action: "engagements-add-marker",
      engagement: engagementId,
      details: {
        added: result.added.length,
        skipped: result.skipped.length,
        source,
      },
    });
  } catch {
    /* audit log must not break user-facing ops */
  }

  return result;
}

/**
 * Convenience wrapper: append a single pattern. Same semantics as
 * `addMarkerPatterns([pattern])`.
 */
export function addMarkerPattern(
  engagementId: string,
  pattern: string,
  opts: AddMarkerPatternOptions = {},
): AddMarkerPatternResult {
  return addMarkerPatterns(engagementId, [pattern], opts);
}
