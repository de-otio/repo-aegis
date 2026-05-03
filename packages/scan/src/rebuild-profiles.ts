// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Rebuild per-engagement embedding profiles for the Phase 3 semantic
// sweep. For each engagement with `reposActive`, walks one repo with
// `extractProse`, embeds the discovered prose files via Ollama, and
// writes an atomic `<engagementId>.json` profile file.
//
// [SEC H-3] On rebuild, surfaces a {@link ManifestDiff} between the
// existing profile (if any) and the freshly-hashed reference docs
// before any embed call — guards against silent reference-document
// drift (a malicious PR shifting a customer repo's content).
//
// [SEC M-2] Resource caps are inherited from `extractProse`: 16 KiB
// per file, 128 KiB total payload, 200 files / 4-deep / 20k-readdir
// per repo. Building one profile is therefore bounded.

import { existsSync } from "node:fs";
import {
  buildProfile,
  diffManifest,
  extractProse,
  readProfile,
  writeProfile,
  type EngagementProfile,
  type ManifestDiff,
  type OllamaConfig,
  type ProseFile,
} from "@de-otio/repo-aegis-llm";
import { repoAegisHome, type Engagement, type Registry } from "@de-otio/repo-aegis-core";

export interface RebuildProfilesOptions {
  registry: Registry;
  /** Aegis home directory (where `profiles/` lives). Defaults to {@link repoAegisHome}. */
  home?: string;
  /** Ollama embedding endpoint + model. */
  ollama: OllamaConfig;
  /** Override threshold for new profiles; default uses the LLM-package default. */
  threshold?: number;
  /**
   * If true, do not actually embed or write — just compute the
   * manifest diff between stored profiles and current reference docs
   * and return the report. Used by `--diff`.
   */
  dryRun?: boolean;
  /** Restrict to specific engagement ids (default: all engagements with reposActive). */
  onlyEngagements?: string[];
  /** Override the embed function (test seam). */
  embedFn?: (text: string, cfg: OllamaConfig) => Promise<Float32Array>;
  /**
   * Override the prose extractor (test seam). Default invokes the
   * real `extractProse` from `@de-otio/repo-aegis-llm`.
   */
  extractFn?: (root: string) => Promise<ProseFile[]>;
}

export interface PerEngagementResult {
  engagementId: string;
  /** Number of repos walked for this engagement (the first repo with prose). */
  reposConsidered: number;
  /** Number of prose docs that ended up in the profile. */
  docsEmbedded: number;
  /** Manifest diff against the previously-stored profile (null on first build). */
  diff: ManifestDiff | null;
  /** Set on dry-run; profile not written. */
  dryRun: boolean;
  /** Non-fatal reason this engagement was skipped, if applicable. */
  skipped?: "no-repos-active" | "no-prose-extracted" | "all-repos-missing";
  /** Hard error: embedding / write failed. */
  error?: string;
}

export interface RebuildProfilesResult {
  results: PerEngagementResult[];
  /** Total profiles successfully (re)built, excluding dry-run and skipped. */
  written: number;
  /** Total skipped (no repos / no prose). */
  skipped: number;
  /** Total failed (embed or write error). */
  failed: number;
}

/**
 * Build / rebuild profiles for every active engagement in the registry.
 *
 * "Active" here means `engagement.ended == null` AND
 * `engagement.reposActive` is non-empty. Engagements without
 * `reposActive` produce no profile (semantic sweep is opt-in by
 * supplying a representative repo).
 */
export async function rebuildProfiles(
  opts: RebuildProfilesOptions,
): Promise<RebuildProfilesResult> {
  const home = opts.home ?? repoAegisHome();
  const results: PerEngagementResult[] = [];
  const targetIds = opts.onlyEngagements
    ? new Set(opts.onlyEngagements)
    : null;

  for (const eng of opts.registry.engagements) {
    if (eng.ended) continue;
    if (targetIds && !targetIds.has(eng.id)) continue;
    const reposActive = eng.reposActive ?? [];
    if (reposActive.length === 0) {
      results.push({
        engagementId: eng.id,
        reposConsidered: 0,
        docsEmbedded: 0,
        diff: null,
        dryRun: !!opts.dryRun,
        skipped: "no-repos-active",
      });
      continue;
    }
    const r = await processEngagement(eng, reposActive, home, opts);
    results.push(r);
  }

  const written = results.filter(r => !r.dryRun && !r.skipped && !r.error).length;
  const skipped = results.filter(r => !!r.skipped).length;
  const failed = results.filter(r => !!r.error).length;
  return { results, written, skipped, failed };
}

async function processEngagement(
  eng: Engagement,
  reposActive: string[],
  home: string,
  opts: RebuildProfilesOptions,
): Promise<PerEngagementResult> {
  // Walk repos in order; use the first repo that yields prose.
  const extract =
    opts.extractFn ??
    (async (root: string) => {
      try {
        const bundle = await extractProse({ root });
        return bundle.files;
      } catch {
        return [];
      }
    });

  let chosenFiles: ProseFile[] | null = null;
  let reposConsidered = 0;
  let allMissing = true;
  for (const repo of reposActive) {
    if (!existsSync(repo)) continue;
    allMissing = false;
    reposConsidered++;
    const files = await extract(repo);
    if (files.length > 0) {
      chosenFiles = files;
      break;
    }
  }

  if (allMissing) {
    return {
      engagementId: eng.id,
      reposConsidered: 0,
      docsEmbedded: 0,
      diff: null,
      dryRun: !!opts.dryRun,
      skipped: "all-repos-missing",
    };
  }
  if (!chosenFiles || chosenFiles.length === 0) {
    return {
      engagementId: eng.id,
      reposConsidered,
      docsEmbedded: 0,
      diff: null,
      dryRun: !!opts.dryRun,
      skipped: "no-prose-extracted",
    };
  }

  const refDocs = chosenFiles.map(f => ({ path: f.path, content: f.content }));

  // Compute diff against the previously-stored profile.
  let diff: ManifestDiff | null = null;
  let prior: EngagementProfile | null = null;
  try {
    prior = readProfile(home, eng.id);
  } catch {
    prior = null;
  }
  if (prior) diff = diffManifest(prior.sourceManifest, refDocs);

  if (opts.dryRun) {
    return {
      engagementId: eng.id,
      reposConsidered,
      docsEmbedded: 0,
      diff,
      dryRun: true,
    };
  }

  try {
    const profile = await buildProfile(eng.id, refDocs, opts.ollama, {
      ...(opts.threshold !== undefined ? { threshold: opts.threshold } : {}),
      ...(opts.embedFn ? { embedFn: opts.embedFn } : {}),
    });
    writeProfile(home, profile);
    return {
      engagementId: eng.id,
      reposConsidered,
      docsEmbedded: profile.vectors.length,
      diff,
      dryRun: false,
    };
  } catch (err) {
    return {
      engagementId: eng.id,
      reposConsidered,
      docsEmbedded: 0,
      diff,
      dryRun: false,
      error: (err as Error).message,
    };
  }
}
