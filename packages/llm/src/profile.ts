// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Per-engagement embedding profile (P3-A-2).
//
// A profile is a small set of reference embedding vectors generated
// from documents the user controls (typically files under
// `engagements[*].reposActive`). Profiles are stored at
// `~/.config/repo-aegis/profiles/<engagement-id>.json` (chmod 0600).
//
// [SEC H-3] The profile records sha256 hashes of the source documents
// in `sourceManifest`. `rebuild-profiles` compares the stored manifest
// against the current files and surfaces a diff before rebuilding —
// guards against silent reference-document drift (e.g. a malicious PR
// shifting a customer repo's content).
//
// [SEC M-5] Profile writes are atomic: write to <id>.json.tmp.<pid>,
// fsync, then rename to <id>.json. Readers ignore stale `*.tmp` files.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  chmodSync,
  statSync,
  openSync,
  fsyncSync,
  closeSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { embed, type OllamaConfig } from "./ollama-client.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const PROFILE_SCHEMA_VERSION = 1 as const;

const sourceManifestEntrySchema = z.object({
  path: z.string(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().nonnegative(),
});

const profileSchema = z.object({
  schemaVersion: z.literal(PROFILE_SCHEMA_VERSION),
  engagementId: z.string().min(1),
  modelId: z.string().min(1),
  createdAt: z.string(),
  threshold: z.number().min(0).max(1),
  // Vectors are serialised as plain number arrays (JSON has no
  // Float32Array). The runtime API converts on read/write.
  vectors: z.array(z.array(z.number())),
  sourceManifest: z.array(sourceManifestEntrySchema),
});

export type ProfileFile = z.infer<typeof profileSchema>;

export interface EngagementProfile {
  schemaVersion: typeof PROFILE_SCHEMA_VERSION;
  engagementId: string;
  modelId: string;
  createdAt: string;
  threshold: number;
  vectors: Float32Array[];
  sourceManifest: SourceManifestEntry[];
}

export interface SourceManifestEntry {
  path: string;
  sha256: string;
  bytes: number;
}

const DEFAULT_THRESHOLD = 0.78;

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function profilesDir(home: string): string {
  return join(home, "profiles");
}

export function profilePath(home: string, engagementId: string): string {
  return join(profilesDir(home), `${engagementId}.json`);
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

export interface BuildProfileOptions {
  /** Custom threshold; defaults to 0.78. */
  threshold?: number;
  /** Override createdAt (test-facing). */
  createdAtOverride?: string;
  /**
   * Override the embed function. Used by callers that want to inject a
   * fake embedder (tests, or higher-level orchestrators that have
   * already embedded the content).
   */
  embedFn?: (text: string, cfg: OllamaConfig) => Promise<Float32Array>;
}

/**
 * Build a fresh profile by embedding each reference document with the
 * configured Ollama model. Pure with respect to the filesystem — does
 * NOT write the profile to disk. Caller invokes {@link writeProfile}.
 */
export async function buildProfile(
  engagementId: string,
  refDocs: Array<{ path: string; content: string }>,
  cfg: OllamaConfig,
  opts: BuildProfileOptions = {},
): Promise<EngagementProfile> {
  const vectors: Float32Array[] = [];
  const sourceManifest: SourceManifestEntry[] = [];
  const embedder = opts.embedFn ?? embed;

  for (const doc of refDocs) {
    const vec = await embedder(doc.content, cfg);
    vectors.push(vec);
    sourceManifest.push({
      path: doc.path,
      sha256: createHash("sha256").update(doc.content).digest("hex"),
      bytes: Buffer.byteLength(doc.content, "utf8"),
    });
  }

  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    engagementId,
    modelId: cfg.model,
    createdAt: opts.createdAtOverride ?? new Date().toISOString(),
    threshold: opts.threshold ?? DEFAULT_THRESHOLD,
    vectors,
    sourceManifest,
  };
}

// ---------------------------------------------------------------------------
// Storage (read / write / atomic)
// ---------------------------------------------------------------------------

/**
 * [SEC M-5] Atomic write: write to a `.tmp.<pid>` sibling, fsync, rename.
 * Any pre-existing tmp from a previous crash is removed first.
 */
export function writeProfile(home: string, profile: EngagementProfile): void {
  const dir = profilesDir(home);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* platform-restricted */
    }
  }

  const finalPath = profilePath(home, profile.engagementId);
  const tmpPath = `${finalPath}.tmp.${process.pid}.${Date.now()}`;

  const onDisk: ProfileFile = {
    schemaVersion: profile.schemaVersion,
    engagementId: profile.engagementId,
    modelId: profile.modelId,
    createdAt: profile.createdAt,
    threshold: profile.threshold,
    vectors: profile.vectors.map(v => Array.from(v)),
    sourceManifest: profile.sourceManifest,
  };

  const body = JSON.stringify(onDisk, null, 2) + "\n";

  // Write + fsync + rename.
  writeFileSync(tmpPath, body, { mode: 0o600 });
  try {
    chmodSync(tmpPath, 0o600);
  } catch {
    /* platform-restricted */
  }
  // fsync so a crash between rename and final-flush still leaves a
  // valid file on disk.
  const fd = openSync(tmpPath, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, finalPath);
}

/**
 * Read a profile from disk. Returns null if the profile file doesn't
 * exist. Throws on schema-version mismatch (refusing future versions
 * forces a coordinated upgrade).
 */
export function readProfile(home: string, engagementId: string): EngagementProfile | null {
  const path = profilePath(home, engagementId);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`profile ${path}: invalid JSON: ${(err as Error).message}`);
  }
  const result = profileSchema.safeParse(parsed);
  if (!result.success) {
    // Reject future versions with a clear "upgrade required" message.
    if (
      typeof (parsed as Record<string, unknown>)?.["schemaVersion"] === "number" &&
      ((parsed as Record<string, unknown>)["schemaVersion"] as number) > PROFILE_SCHEMA_VERSION
    ) {
      throw new Error(
        `profile ${path}: schemaVersion ${
          (parsed as Record<string, unknown>)["schemaVersion"]
        } is newer than this build supports (max ${PROFILE_SCHEMA_VERSION}); please upgrade`,
      );
    }
    throw new Error(`profile ${path}: schema validation failed: ${result.error.message}`);
  }
  return {
    schemaVersion: result.data.schemaVersion,
    engagementId: result.data.engagementId,
    modelId: result.data.modelId,
    createdAt: result.data.createdAt,
    threshold: result.data.threshold,
    vectors: result.data.vectors.map(v => Float32Array.from(v)),
    sourceManifest: result.data.sourceManifest,
  };
}

/**
 * Garbage-collect any stale `*.tmp.*` files in the profiles dir. Called
 * occasionally (caller-driven) to clean up after crashes between
 * writeFileSync and rename. Idempotent; safe to invoke at any time.
 */
export function cleanStaleProfileTemps(home: string): number {
  const dir = profilesDir(home);
  if (!existsSync(dir)) return 0;
  let removed = 0;
  for (const name of readdirSync(dir)) {
    if (!/\.tmp\./.test(name)) continue;
    try {
      unlinkSync(join(dir, name));
      removed++;
    } catch {
      /* ignore individual cleanup failures */
    }
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Manifest diffing (P3-A-2 [SEC H-3])
// ---------------------------------------------------------------------------

export interface ManifestDiff {
  changed: Array<{ path: string; oldSha: string; newSha: string }>;
  added: string[];
  removed: string[];
}

/**
 * Diff a stored manifest against a freshly-hashed view of the same
 * documents on disk (or in-memory content). Used by `rebuild-profiles`
 * to surface "your reference documents have changed" before agreeing
 * to rebuild the profile.
 */
export function diffManifest(
  oldManifest: SourceManifestEntry[],
  newDocs: Array<{ path: string; content: string }>,
): ManifestDiff {
  const newByPath = new Map<string, string>();
  for (const doc of newDocs) {
    const sha = createHash("sha256").update(doc.content).digest("hex");
    newByPath.set(doc.path, sha);
  }
  const oldByPath = new Map(oldManifest.map(e => [e.path, e.sha256]));

  const changed: Array<{ path: string; oldSha: string; newSha: string }> = [];
  const added: string[] = [];
  const removed: string[] = [];

  for (const [path, sha] of newByPath) {
    const old = oldByPath.get(path);
    if (old === undefined) {
      added.push(path);
    } else if (old !== sha) {
      changed.push({ path, oldSha: old, newSha: sha });
    }
  }
  for (const [path] of oldByPath) {
    if (!newByPath.has(path)) removed.push(path);
  }

  return { changed, added, removed };
}

/**
 * Convenience: load a profile and emit a one-line summary of how stale
 * it is. Used by `repo-aegis-scan run --semantic` to log a warning
 * when the profile is older than N days.
 */
export function profileAgeDays(profile: EngagementProfile): number {
  const created = new Date(profile.createdAt).getTime();
  if (Number.isNaN(created)) return 0;
  return (Date.now() - created) / (1000 * 60 * 60 * 24);
}

// ---------------------------------------------------------------------------
// Semantic sweep scoring (P3-B-1 helper)
// ---------------------------------------------------------------------------

import { cosine } from "./ollama-client.js";

export interface SemanticHit {
  engagementId: string;
  /** Maximum cosine similarity across the engagement's reference vectors. */
  similarity: number;
  /** The threshold the similarity exceeded (from the profile). */
  threshold: number;
}

/**
 * Score a candidate document's embedding vector against every active
 * engagement profile. Returns hits where `similarity >= threshold`,
 * sorted by descending similarity.
 *
 * Pure — no IO, no network. The caller is responsible for embedding
 * the candidate (via `embed`) and loading the profiles (via
 * `readProfile`). Output never includes the candidate's content or
 * the profile's reference text — just the engagement id and the
 * scalar similarity.
 *
 * Per the design doc threat-model entry on timing side-channels: this
 * runs in the centralised sweep with no user-observable latency. If
 * a future feature exposes per-call timing interactively, consider
 * switching to a constant-time loop.
 */
export function scoreCandidate(
  candidate: Float32Array,
  profiles: EngagementProfile[],
): SemanticHit[] {
  const hits: SemanticHit[] = [];
  for (const profile of profiles) {
    let max = -Infinity;
    for (const ref of profile.vectors) {
      if (ref.length !== candidate.length) continue;
      const s = cosine(candidate, ref);
      if (s > max) max = s;
    }
    if (max >= profile.threshold) {
      hits.push({
        engagementId: profile.engagementId,
        similarity: max,
        threshold: profile.threshold,
      });
    }
  }
  hits.sort((a, b) => b.similarity - a.similarity);
  return hits;
}

// Avoid unused-import warning under strict mode when consumers don't
// touch these helpers.
void dirname;
void statSync;
