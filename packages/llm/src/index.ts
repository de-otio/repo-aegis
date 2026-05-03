// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// @de-otio/repo-aegis-llm — LLM-assisted helpers for repo-aegis.
//
// Hot-path independence: this package must never be transitively
// imported from gate code (`scan`, `render`, `check`,
// `hook scan-after-write`). The import-graph guard test in
// `packages/core/src/import-graph.test.ts` enforces this property.

export const PACKAGE_NAME = "@de-otio/repo-aegis-llm";

// ---- Ollama HTTP client (P2-A-1) + embeddings (P3-A-1) ------------------
export { chat, embed, cosine } from "./ollama-client.js";
export type {
  OllamaConfig,
  ChatRequest,
  ChatResponse,
} from "./ollama-client.js";
export { RemoteEndpointDisallowedError, OllamaError } from "./exceptions.js";

// ---- Prose extraction (P2-A-2) ------------------------------------------
export {
  extractProse,
  RootContainmentError,
  HARD_EXCLUSIONS,
} from "./prose-extraction.js";
export type {
  ProseExtractionOptions,
  ProseBundle,
  ProseFile,
  SkippedAfterResolveEntry,
} from "./prose-extraction.js";

// ---- Token-to-regex synthesis (P2-A-3) ----------------------------------
export { synthesizeMarker, PROMPT_SOURCE_MAP } from "./synthesis.js";
export type { TokenKind } from "./synthesis.js";

// ---- Filters (P2-A-4) ---------------------------------------------------
export {
  filterDictionary,
  filterExistingPatterns,
  filterDependencyNames,
  loadDefaultWordlist,
  parseWordlist,
} from "./filters.js";
export type { TokenT } from "./filters.js";

// ---- Token extraction (P2-A-5) ------------------------------------------
export {
  extractTokens,
  parseModelResponse,
  formatBundle,
  TOKEN_EXTRACTION_PROMPT_V1,
  BundleFenceCollisionError,
  BundleTooLargeError,
} from "./token-extraction.js";
export type {
  ExtractedToken,
  ExtractedTokenKind,
  ExtractedTokens,
  ExtractTokensOptions,
} from "./token-extraction.js";

// ---- Engagement profile (P3-A-2) + semantic-sweep helper (P3-B-1) ------
export {
  buildProfile,
  writeProfile,
  readProfile,
  diffManifest,
  cleanStaleProfileTemps,
  profileAgeDays,
  profilePath,
  profilesDir,
  scoreCandidate,
} from "./profile.js";
export type {
  EngagementProfile,
  ProfileFile,
  SourceManifestEntry,
  ManifestDiff,
  BuildProfileOptions,
  SemanticHit,
} from "./profile.js";
