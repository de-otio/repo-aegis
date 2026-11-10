// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
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
  auditLogPath,
} from "./paths.js";

// ---- audit log -----------------------------------------------------------
export {
  appendAuditRecord,
  isAuditLogEnabled,
  setAuditLogEnabled,
  activeAuditLogPath,
} from "./audit-log.js";
export type { AuditRecord } from "./audit-log.js";

// ---- registry ------------------------------------------------------------
export {
  loadRegistry,
  loadRegistryState,
  parseRegistryText,
  isActive,
  resolveEngagement,
  ALWAYS_BLOCK_RESERVED_ID,
  MAX_SUPPORTED_REGISTRY_SCHEMA_VERSION,
} from "./registry.js";
export type { Engagement, Registry, RegistryLoad, ResolveResult, Identity, OwnerIdentities } from "./registry.js";

// ---- remote URL parser ---------------------------------------------------
export {
  parseRemoteUrl,
  parseRemoteUrlResolved,
  resolveRemoteUrl,
  classifyRemoteUrl,
  looksLikeRemoteUrl,
} from "./remote-url.js";
// The pure ssh-config reader behind alias resolution (never `ssh -G`), and the
// URL(s) a `git push <remote>` writes to (pushurl, insteadOf, pushInsteadOf).
export { lookupSshHost, defaultSshDir, SSH_INCLUDE_MAX_DEPTH } from "./ssh-config.js";
export type { SshHostLookup, SshConfigOptions } from "./ssh-config.js";
export { resolvePushUrls, detectSshOverride, isSshPreservingCommand } from "./push-urls.js";
export type { ParsedRemote, RemoteUrlClass, RemoteTarget, RemoteTransport, SshOverrideKind } from "./remote-url.js";

// ---- working-tree resolution (path-aware hook) --------------------------
export {
  findEnclosingWorkingTree,
  resolveGitDir,
  getRemoteOrg,
  getRemoteUrl,
} from "./working-tree.js";

// ---- trust-boundary (path-aware hook) -----------------------------------
export {
  computeTrustBoundary,
  trustBoundariesOverlap,
} from "./trust-boundary.js";
export type { TrustBoundary } from "./trust-boundary.js";

// ---- first-touch classification (Phase 1 onboarding) --------------------
export { firstTouchClassify, redactOrg } from "./first-touch.js";
export type {
  FirstTouchResult,
  FirstTouchOptions,
  FirstTouchSkipReason,
  FirstTouchAlreadyClassified,
  FirstTouchApplied,
  FirstTouchNeedsConfirmation,
  FirstTouchSkipped,
} from "./first-touch.js";

// ---- registry mutation (Phase 2 onboarding) -----------------------------
export {
  addMarkerPattern,
  addMarkerPatterns,
  addTopLevelPatterns,
} from "./registry-mutate.js";
export type {
  AddMarkerPatternOptions,
  AddMarkerPatternResult,
  TopLevelPatternList,
} from "./registry-mutate.js";

// ---- toolchain-dotfile scanning (private-infra discovery) ----------------
export {
  scanEnvText,
  scanEnvSources,
  defaultEnvSources,
  hostToMarkerPattern,
  MIN_ENV_HOST_LENGTH,
} from "./env-scan.js";
export type {
  EnvSourceKind,
  EnvHostFinding,
  EnvSource,
  ScanEnvResult,
} from "./env-scan.js";

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
export {
  computeDenySet,
  loadExemptPaths,
  ALWAYS_FILE_STEM,
  PRIVATE_INFRA_FILE_STEM,
  SELF_IDENTITY_FILE_STEM,
  BUILTIN_ALWAYS_BLOCK_EXEMPT_PATHS,
} from "./deny-set.js";
export type { DenySet, DenySetFile, DenySetOptions } from "./deny-set.js";

// ---- scan primitives -----------------------------------------------------
export {
  scanText,
  scanTextDetailed,
  scanFile,
  scanDirectory,
  walkScanFiles,
  resolveScanTarget,
  SCAN_SKIP_DIRS,
  DEFAULT_MAX_SCAN_FILES,
  scanDiffText,
  scanDiffTextDetailed,
  scanStagedDiff,
  scanRange,
  scanNewRef,
  resolveNewRefBase,
  scanHistory,
  ALLOW_COMMENT,
  EMPTY_TREE_SHA,
} from "./scan.js";
export type {
  ScanHit,
  SkippedFile,
  HistoryHit,
  ScanOptions,
  ScanResult,
  DirectoryScanResult,
  DirectoryWalk,
  TextScanResult,
  NewRefMode,
  NewRefTarget,
  NewRefBase,
  NewRefScanResult,
} from "./scan.js";

// ---- remote reachability (already-public downgrade) ----------------------
export { remoteReachableCommits } from "./remote-reach.js";

// ---- path globs (deny-set path exemptions) -------------------------------
export {
  compileGlob,
  compileGlobs,
  matchesCompiled,
  matchesAnyGlob,
  GlobTooBroadError,
} from "./globs.js";

// ---- reviewed-benign waivers --------------------------------------------
// Blob-scoped dismissal of a reviewed `_always` finding. The auditable
// alternative to `--no-verify`, which disables the whole hook.
export {
  WAIVABLE_STEM,
  NotWaivableError,
  WaiverParseError,
  patternId,
  assertWaivable,
  parseWaivers,
  isWaived,
  expiredWaivers,
} from "./waivers.js";
export type { Waiver } from "./waivers.js";

// ---- known non-secrets ---------------------------------------------------
// Documented example / placeholder credentials. Callers MUST scope this to
// `_always` matches only — see the module header.
export { isKnownNonSecret } from "./known-non-secrets.js";

// ---- hook scripts + liveness --------------------------------------------
// A client-side gate that is installed but disconnected is indistinguishable
// from one that is clean: both print nothing. `resolveHookState` is the
// liveness check that tells them apart.
export { hookScriptDigest, renderHookScript } from "./hook-scripts.js";
export {
  assertPinnable,
  fallbackVerdict,
  fallbackVerdictShell,
  parsePinFromScript,
  pinAssignments,
  pinGuard,
  pinnedHookCommand,
  isPinnedHookCommand,
  managedHookCommand,
  isManagedHookCommand,
  MANAGED_ID_PATH,
  PIN_VERSION_PATTERN,
  pinProblem,
  shellQuote,
  shellUnquote,
  type EnforcementPin,
  type FallbackVerdict,
  type ManagedHookContext,
  type PinGuardOptions,
} from "./enforcement-pin.js";
export type { HookName } from "./hook-scripts.js";
export { resolveHookState } from "./hooks-state.js";
export type {
  HookState,
  HookScriptState,
  HookStateOrigin,
  HookStateCode,
} from "./hooks-state.js";

// ---- secret-shaped markers (universal, not engagement-scoped) -----------
export { scanForSecrets, summariseHits } from "./secret-markers.js";
export type { SecretMarkerKind, SecretMarkerHit } from "./secret-markers.js";

// ---- public-repo egress hygiene (private-registry URL leak prevention) ---
export {
  scanRegistryEgress,
  egressParserFor,
  isEgressRelevant,
  isHostAllowed,
  defaultEgressPolicy,
  egressPolicyFromRegistry,
  loadEgressPolicy,
  DEFAULT_ALLOWED_REGISTRY_HOSTS,
  readCachedVisibility,
  isPublicFacing,
  treatAsPublicDestination,
} from "./egress.js";
// Issue #114: an unknown destination visibility is looked up once at egress
// time and cached; a failed lookup leaves it unknown, i.e. treated as public.
export {
  lookupVisibilityViaGh,
  effectiveVisibilityLookup,
  refreshUnknownVisibility,
  VISIBILITY_LOOKUP_ENV,
  VISIBILITY_LOOKUP_TIMEOUT_MS,
  UNKNOWN_VISIBILITY_HINT,
} from "./visibility-lookup.js";
export type { VisibilityLookup } from "./visibility-lookup.js";
export type {
  RegistryFinding,
  EgressPolicy,
  EgressInputFile,
  RepoVisibility,
} from "./egress.js";

// ---- egress guard (destination-aware publishing controls) ----------------
// One decision function behind the pre-push hook, the `gh` shim and the
// agent pre-command hooks. Shape rules are unconditional; context rules
// fail open; the decision is never a rewritten command.
export {
  parseEgressIntents,
  parseApiEndpoint,
  analyseApiEndpoint,
  classifyApiEndpoint,
  isEgressOverrideVariable,
  simpleCommands,
  parseRepoRef,
  intentRepoTargets,
  isGraphqlEndpoint,
  graphqlOperationKind,
  isGhBuiltinGroup,
} from "./egress-intent.js";
export { isGhConfigFile, ghConfigDirs, GH_CONFIG_FILES } from "./gh-config-paths.js";
export type { GhConfigPathContext } from "./gh-config-paths.js";
export {
  checkNetworkRules,
  checkIdentityHookRules,
  decideIdentityHookRules,
  ghVerbChangesIdentityState,
} from "./egress-network-rules.js";
export type { NetworkRuleCode, NetworkRuleHit, IdentityHookRuleCode, IdentityHookHit } from "./egress-network-rules.js";
export type {
  ApiEndpointClass,
  ApiEndpointTarget,
  EgressIntent,
  EgressVerb,
  GraphqlOperationKind,
  IntentUnresolved,
  ParseEgressOptions,
  RepoTarget,
  SegmentJoin,
} from "./egress-intent.js";
export { egressParseOptions, loadGhAliases, loadGitAliases, parseGitAliasEntries, ghConfigDir } from "./gh-env.js";
export { ghBaseRepo } from "./gh-base-repo.js";
export type { GhBaseRepo } from "./gh-base-repo.js";
export {
  decideEgress,
  resolveDestinationOffline,
  refreshDestinationVisibility,
  scanPayloadAgainstDestination,
  isHumanPresent,
  humanPresence,
  isModeDependentPath,
  describeVerb,
  describeDestination,
  describeDestinationForReceipt,
  formatReceipt,
  EGRESS_HUMAN_ENV,
  VERBS_NEEDING_HUMAN,
} from "./egress-policy.js";
// Machine-wide `<org>/<repo>` → checkout pointer table, so a destination named
// in full from a foreign directory is judged by its own declaration.
export {
  destinationCachePath,
  destinationKey,
  readDestinationCache,
  lookupDestination,
  describeWorkingTree,
  recordWorkingTree,
  resolveCachedDestination,
  DESTINATION_CACHE_FILE,
} from "./destination-cache.js";
export type { DestinationCache, DestinationCacheEntry } from "./destination-cache.js";
export type {
  EgressCode,
  EgressDecision,
  Destination,
  DestinationResolver,
  PayloadScanner,
  DecideEgressOptions,
  ApprovalFinder,
  RegistryState,
} from "./egress-policy.js";
export { registryUnreadable } from "./egress-policy.js";
// Rule h (issue #151): the one definition of "a registered owner", shared by
// every layer so the hook, the shim, pre-push and `doctor` cannot disagree.
export {
  registeredOwners,
  ownerAdmitted,
  firstUnadmittedCandidate,
  ruleHStatus,
  ruleHSkipNote,
  UPSTREAM_ADMITTED_VERBS,
} from "./registered-owners.js";
export type { OwnerCandidate, RuleHStatus } from "./registered-owners.js";
// The shared five-part refusal builder (what, why, approval, fix + who, where
// to read more), so the three enforcement layers cannot drift in wording.
export {
  refusal,
  refusalTrailer,
  safeDestination,
  isSafeOwner,
  isPrintableDestination,
  INVALID_DESTINATION_LABEL,
} from "./refusal.js";
export type { RefusalInput, RefusalFix } from "./refusal.js";
export {
  findApprovalDefault,
  findPromptApprovalDefault,
  PROMPT_APPROVAL_DENY_SENTENCE,
  findUncoveredStarDefault,
  uncoveredStarSentence,
  SHAPE_RULE_CODES,
  unregisteredOwnerReason,
} from "./egress-policy.js";
export type { UncoveredStarFinder, PromptApprovalFinder, HumanPresence } from "./egress-policy.js";
// Is a person behind this terminal? The process-ancestry walk (issue #151, PR 2b).
export {
  readProcessAncestry,
  judgeAncestry,
  classifyAncestor,
  positiveRoot,
  isTrustedAppPath,
  realExeOf,
  parseLsofTxt,
  trustedLsofPath,
  agentEnvSignal,
  checkTerminal,
  parsePsSnapshotLine,
  parseProcEntry,
  snapshotViaPs,
  trustedPsPath,
  makeDefaultLookup,
  setAncestryReaderForTests,
  testSeamsEnabled,
  MAX_ANCESTRY_DEPTH,
} from "./process-ancestry.js";
export type {
  AncestorInfo,
  AncestryChain,
  AncestryReader,
  AncestryVerdict,
  ExeResolver,
  MultiplexerProbe,
  RootContext,
  ProcessLookup,
  TerminalCheck,
  TerminalCheckOptions,
} from "./process-ancestry.js";
// Commands only a person may run, refused in agent Bash text (issue #151, PR 2b).
export {
  AGENT_RAN_HUMAN_COMMAND,
  AGENT_DETACHED_SESSION,
  findHumanOnlyCommand,
  HUMAN_VERB_PATHS,
  humanCommandRefusal,
  findDetachedStart,
  detachedStartRefusal,
} from "./human-commands.js";
export type { HumanOnlyHit, HumanOnlyKind, DetachedHit, DetachedKind } from "./human-commands.js";
// Human-minted, time-limited, destination-scoped approvals that satisfy
// rule g from a shell with no TTY (`repo-aegis approve`).
export {
  approvalsPath,
  parseTtl,
  parseApprovalTarget,
  readApprovalStore,
  listApprovals,
  mintApproval,
  revokeApprovals,
  findApproval,
  findLoginApproval,
  findAccountBoundApproval,
  findApprovalWithAnyLogin,
  findUncoveringStarApproval,
  approvalScopeOf,
  starApprovalCovers,
  normaliseRef,
  APPROVALS_FILE,
  DEFAULT_APPROVAL_TTL_MS,
  MAX_APPROVAL_TTL_MS,
  // Prompt approvals: a person's yes at the agent host's own prompt, for one exact command, for 2 minutes.
  PROMPT_APPROVALS_DIR,
  PROMPT_APPROVAL_TTL_MS,
  PROMPT_APPROVAL_MODES,
  promptApprovalsDir,
  promptBindingOf,
  recordPromptApproval,
  revokeAllPromptApprovals,
  isTargetedPromptVerb,
  listPromptApprovals,
  findPromptApproval,
  listAllApprovals,
  approvalSource,
  isPromptVerb,
} from "./egress-approval.js";
export type {
  PromptApproval,
  PromptBinding,
  PromptVerb,
  ListedApproval,
  RecordPromptOptions,
  EgressApproval,
  ApprovalStore,
  MintOptions,
  ApprovalScope,
  ApprovalScopeRegistry,
  StarApprovalGap,
} from "./egress-approval.js";

// ---- render --------------------------------------------------------------
export { renderMarkers, MARKER_FORMAT_VERSION } from "./render.js";
export type { RenderOptions, RenderedFile, RenderResult } from "./render.js";

// ---- redaction -----------------------------------------------------------
export { redactMatch, revealMatch } from "./redaction.js";
export type { RedactionMode } from "./redaction.js";

// ---- attribution redaction for published (CI) output ---------------------
export {
  isPublishableStem,
  isPublishablePatternId,
  redactHitAttribution,
  redactHits,
  redactStems,
  distinctEngagementCount,
  shouldRedactAttribution,
  REDACTED_STEM,
} from "./ci-output.js";
export type { AttributedHit } from "./ci-output.js";

// ---- regex safety --------------------------------------------------------
// `validatePattern` (the single-pattern, in-process variant) is tagged
// `@internal` in its source. Callers should prefer `validatePatterns`
// (which can run strict, subprocess-backed validation). It remains
// re-exported here so existing intra-repo imports keep working without
// a coordinated breaking change.
export {
  validatePattern,
  validatePatterns,
  validateCombinedSize,
  getRegexBackend,
} from "./regex-safety.js";
export type {
  PatternValidationResult,
  ValidatePatternsOptions,
  RegexBackend,
} from "./regex-safety.js";

// ---- exceptions ----------------------------------------------------------
export {
  RegistryNotFoundError,
  RegistryParseError,
  RegistryEncryptedError,
  RegistrySchemaTooNewError,
  NotAGitRepoError,
  AmbiguousQueryError,
  EngagementNotFoundError,
  PatternValidationError,
  OutsideWorkingTreeError,
  LockTimeoutError,
  CustomerCoupledNoEngagementError,
  GitCommandError,
} from "./exceptions.js";

// ---- exit codes ----------------------------------------------------------
export { EXIT_OK, EXIT_HIT, EXIT_USAGE } from "./exit-codes.js";

// ---- age (file-encryption helpers) --------------------------------------
// Wrapper around the `age` CLI. Used by the scan package's
// `encrypt-query` / `decrypt-query` commands and by the cli's
// `registry encrypt` / `registry decrypt` commands. The `age` binary
// is a runtime requirement; absence surfaces as `AgeNotFoundError`.
export {
  encryptFile,
  decryptFile,
  writeBufferTo,
  AgeNotFoundError,
  AgeError,
} from "./age.js";
export type { EncryptOptions, DecryptOptions } from "./age.js";

// ---- locking -------------------------------------------------------------
export { withLock, withLockSync } from "./lock.js";
export type { LockOptions } from "./lock.js";

// ---- canonical JSON shapes ----------------------------------------------
export type { RepoJson, EngagementJson } from "./types.js";

// ---- schema helpers ------------------------------------------------------
// `formatZodError` is the canonical "render a ZodError as a one-line
// human-readable message" helper. Sibling packages (cli, scan) own their
// own schemas (classify rules, queries) but import this so error wording
// is consistent across the surface.
export {
  formatZodError,
  ORG_NAME_REGEX,
  OWNER_REPO_REGEX,
  upstreamProblem,
  IDENTITY_NAME_REGEX,
  GH_LOGIN_REGEX,
  ghLoginProblem,
  REGISTRY_IDENTITIES_MIN_VERSION,
  personalOrgName,
} from "./schemas.js";
export type { IdentityDefinition, PersonalOrgEntry } from "./schemas.js";

// Which GitHub identity a `gh` call runs as (doc/plan-owner-identity.md §13.1). Pure; nothing calls it yet.
export { identityPresence, ghCallTargets, ghCallInfo, chooseIdentity, personLoginOf } from "./identity-choice.js";
export type {
  IdentityPresence,
  GhCallTarget,
  GhCallInfo,
  IdentityScope,
  IdentityRefusalCode,
  IdentityChoice,
  ChooseIdentityInput,
} from "./identity-choice.js";
