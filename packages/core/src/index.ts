// Curated public API surface for `@de-otio/repo-aegis-core`.
//
// Every name re-exported below is part of the package's compatibility
// contract: renaming or removing one is a semver-major change. Items not
// listed here are intentionally internal — they may be re-shaped at any
// time without a major bump.
//
// To keep an item internal while still allowing intra-monorepo imports
// (tests, sibling packages reaching into specific modules), tag it with
// a `/** @internal */` JSDoc comment in its source module rather than
// re-exporting it from this file. api-extractor / consumers honour the
// hint; existing deep-path imports continue to resolve.

// ---- paths ---------------------------------------------------------------
export {
  repoAegisHome,
  registryPath,
  markersDir,
  statePath,
  leakContextFlagPath,
  lockFilePath,
  denySetCachePath,
  isHomeOverridden,
  flatMarkersPath,
} from "./paths.js";

// ---- registry ------------------------------------------------------------
export {
  loadRegistry,
  isActive,
  resolveEngagement,
  ALWAYS_BLOCK_RESERVED_ID,
  MAX_SUPPORTED_REGISTRY_SCHEMA_VERSION,
} from "./registry.js";
export type { Engagement, Registry, ResolveResult } from "./registry.js";

// ---- repo (per-repo config + engagement membership mutators) -------------
export {
  readRepoConfig,
  addEngagement,
  addEngagements,
  removeEngagement,
  setClass,
  unsetClass,
  REPO_CLASSES,
  RepoOverrideError,
  OVERRIDE_FILENAME,
} from "./repo.js";
export type { RepoClass, RepoConfig, RepoOverride } from "./repo.js";

// ---- deny set ------------------------------------------------------------
export { computeDenySet, ALWAYS_FILE_STEM } from "./deny-set.js";
export type { DenySet, DenySetFile, DenySetOptions } from "./deny-set.js";

// ---- scan primitives -----------------------------------------------------
export {
  scanText,
  scanFile,
  scanStagedDiff,
  scanRange,
  scanHistory,
  ALLOW_COMMENT,
} from "./scan.js";
export type { ScanHit, SkippedFile, HistoryHit, ScanOptions } from "./scan.js";

// ---- render --------------------------------------------------------------
export { renderMarkers, MARKER_FORMAT_VERSION } from "./render.js";
export type { RenderOptions, RenderedFile, RenderResult } from "./render.js";

// ---- redaction -----------------------------------------------------------
export { redactMatch, revealMatch } from "./redaction.js";
export type { RedactionMode } from "./redaction.js";

// ---- regex safety --------------------------------------------------------
// `validatePattern` (the single-pattern, in-process variant) is tagged
// `@internal` in its source. Callers should prefer `validatePatterns`
// (which can run strict, subprocess-backed validation). It remains
// re-exported here so existing intra-repo imports keep working without
// a coordinated breaking change.
export { validatePattern, validatePatterns, validateCombinedSize } from "./regex-safety.js";
export type { PatternValidationResult, ValidatePatternsOptions } from "./regex-safety.js";

// ---- exceptions ----------------------------------------------------------
export {
  RegistryNotFoundError,
  RegistryParseError,
  NotAGitRepoError,
  AmbiguousQueryError,
  EngagementNotFoundError,
  PatternValidationError,
  OutsideWorkingTreeError,
  LockTimeoutError,
  CustomerCoupledNoEngagementError,
} from "./exceptions.js";

// ---- exit codes ----------------------------------------------------------
export { EXIT_OK, EXIT_HIT, EXIT_USAGE } from "./exit-codes.js";

// ---- locking -------------------------------------------------------------
export { withLock, withLockSync } from "./lock.js";
export type { LockOptions } from "./lock.js";

// ---- canonical JSON shapes ----------------------------------------------
export type { RepoJson, EngagementJson } from "./types.js";
