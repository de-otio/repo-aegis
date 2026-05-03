// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Phase 3 — semantic audit sweep. For each candidate document the
// regex sweep flagged, embed it once, score it against every active
// engagement profile, and surface engagements whose reference docs
// are similar above their per-profile threshold.
//
// Hot-path independence: this module sits in `@de-otio/repo-aegis-scan`,
// not `@de-otio/repo-aegis-core`. The deterministic PostToolUse hook
// never imports from here. The import-graph guard test in
// `packages/core/src/import-graph.test.ts` enforces that.
//
// Output redaction: a {@link SemanticSweepHit} carries `engagementId`,
// `similarity` (number), and the candidate's repo+path+url — never
// the candidate's text content nor the profile's reference text.

import {
  embed,
  scoreCandidate,
  type EngagementProfile,
  type OllamaConfig,
  type SemanticHit,
} from "@de-otio/repo-aegis-llm";
import type { CodeSearchHit } from "./types.js";

export interface SemanticCandidate {
  /** The originating regex hit, used to attach repo+path+url to the result. */
  hit: CodeSearchHit;
  /** The candidate document body to embed. Caller is responsible for fetching. */
  content: string;
}

export interface SemanticSweepHit {
  engagementId: string;
  similarity: number;
  threshold: number;
  repo: string;
  path: string;
  url: string;
  /** Source query name from the originating regex hit, for grouping. */
  query: string;
}

export interface SemanticSweepResult {
  hits: SemanticSweepHit[];
  /**
   * Number of candidates whose embedding call failed (Ollama down /
   * timeout / endpoint validation). The sweep continues past failures
   * — semantic sweep is best-effort, never blocking.
   */
  embedErrors: number;
  /** Number of candidates successfully embedded. */
  embedded: number;
  /** Total candidates considered. */
  candidates: number;
}

export interface RunSemanticSweepOptions {
  candidates: SemanticCandidate[];
  profiles: EngagementProfile[];
  ollama: OllamaConfig;
  /**
   * Trim each candidate's content to this many UTF-8 bytes before
   * embedding. Most embedding models cap inputs around 8k tokens
   * (~32 KiB). Default 16 KiB. Pass `Infinity` to disable.
   */
  maxBytesPerCandidate?: number;
  /** Override the embed function (test seam). */
  embedFn?: (text: string, cfg: OllamaConfig) => Promise<Float32Array>;
}

const DEFAULT_MAX_BYTES_PER_CANDIDATE = 16 * 1024;

function truncateUtf8(s: string, maxBytes: number): string {
  if (!Number.isFinite(maxBytes)) return s;
  const buf = Buffer.from(s, "utf8");
  if (buf.byteLength <= maxBytes) return s;
  // Buffer slice may split a multi-byte sequence; toString("utf8") replaces
  // the trailing partial bytes with U+FFFD which is fine for embedding.
  return buf.subarray(0, Math.max(0, maxBytes)).toString("utf8");
}

/**
 * Embed every candidate and score it against the supplied profiles.
 * Pure with respect to disk and the network *after* the embeddings
 * have been computed (the embed call itself goes to Ollama).
 *
 * Embedding errors are tolerated: a single Ollama failure for one
 * candidate increments `embedErrors` and the sweep continues.
 *
 * No retries, no fallbacks. The semantic sweep is advisory — its
 * absence does not invalidate the regex sweep results.
 */
export async function runSemanticSweep(
  opts: RunSemanticSweepOptions,
): Promise<SemanticSweepResult> {
  const cap = opts.maxBytesPerCandidate ?? DEFAULT_MAX_BYTES_PER_CANDIDATE;
  const embedder = opts.embedFn ?? embed;
  const out: SemanticSweepHit[] = [];
  let embedErrors = 0;
  let embedded = 0;

  if (opts.profiles.length === 0) {
    return { hits: [], embedErrors: 0, embedded: 0, candidates: opts.candidates.length };
  }

  for (const cand of opts.candidates) {
    let vec: Float32Array;
    try {
      vec = await embedder(truncateUtf8(cand.content, cap), opts.ollama);
    } catch {
      embedErrors++;
      continue;
    }
    embedded++;
    const scored: SemanticHit[] = scoreCandidate(vec, opts.profiles);
    for (const s of scored) {
      out.push({
        engagementId: s.engagementId,
        similarity: s.similarity,
        threshold: s.threshold,
        repo: cand.hit.repo,
        path: cand.hit.path,
        url: cand.hit.url,
        query: cand.hit.query,
      });
    }
  }

  return {
    hits: out,
    embedErrors,
    embedded,
    candidates: opts.candidates.length,
  };
}
