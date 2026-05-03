// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
// Curated public API surface for `@de-otio/repo-aegis-scan`'s library
// entry-point.
//
// As with `@de-otio/repo-aegis-core/index.ts`, every name re-exported below
// is part of the package's compatibility contract. Items not listed here
// are intentionally internal. To keep an item internal while still allowing
// intra-monorepo deep imports (the CLI in `index.ts` does this), tag the
// declaration with `/** @internal */` JSDoc; do not add it to the list
// here.

// ---- runScan + supporting types -----------------------------------------
export { runScan } from "./run.js";
export type {
  RunOptions,
  RunResult,
  SearchClient,
  SearchClientResult,
} from "./run.js";

// ---- summary / per-query status types -----------------------------------
export type { RunSummary, QueryRunStatus } from "./types.js";

// ---- queries -------------------------------------------------------------
export { parseQueryFile, validateQueryFile } from "./queries.js";
export type { QueryValidationResult } from "./queries.js";
export type { QueryEntry, QueryFile } from "./types.js";

// ---- state ---------------------------------------------------------------
export {
  loadState,
  saveStateAtomic,
  hitKey,
  CURRENT_STATE_SCHEMA_VERSION,
  MAX_SUPPORTED_STATE_SCHEMA_VERSION,
} from "./state.js";
export type { ScanState } from "./types.js";

// ---- code-search hit shape ----------------------------------------------
export type { CodeSearchHit } from "./types.js";

// ---- output --------------------------------------------------------------
export { renderMarkdown } from "./output.js";

// ---- issue filer ---------------------------------------------------------
export { fileIssue } from "./issue-filer.js";
export type { IssueClient, FileIssueOptions, FileIssueResult } from "./issue-filer.js";

// ---- age (encrypt/decrypt) ----------------------------------------------
export { encryptFile, decryptFile, writeBufferTo, AgeNotFoundError, AgeError } from "./age.js";

// ---- octokit client ------------------------------------------------------
export { makeOctokitClient } from "./octokit-client.js";
export type { BlobClient } from "./octokit-client.js";

// ---- semantic sweep (Phase 3, P3-B) -------------------------------------
export { runSemanticSweep } from "./semantic-sweep.js";
export type {
  SemanticCandidate,
  SemanticSweepHit,
  SemanticSweepResult,
  RunSemanticSweepOptions,
} from "./semantic-sweep.js";

// ---- profile loading + rebuild (Phase 3, P3-B) --------------------------
export { loadAllProfiles } from "./profile-loader.js";
export type { LoadProfilesResult } from "./profile-loader.js";
export { rebuildProfiles } from "./rebuild-profiles.js";
export type {
  RebuildProfilesOptions,
  RebuildProfilesResult,
  PerEngagementResult,
} from "./rebuild-profiles.js";
