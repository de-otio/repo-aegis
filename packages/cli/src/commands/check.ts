// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import { currentEnforcementPin } from "../enforcement-pin.js";
import { helperOrder, readCredentialConfig } from "../git-credential-config.js";
import { helperCommand } from "./install-git-credential.js";
import {
  readRepoConfig,
  computeDenySet,
  scanFile,
  scanDirectory,
  walkScanFiles,
  DEFAULT_MAX_SCAN_FILES,
  resolveScanTarget,
  scanStagedDiff,
  scanRange,
  scanNewRef,
  resolveNewRefBase,
  scanHistory,
  scanRegistryEgress,
  isEgressRelevant,
  isPublicFacing,
  loadEgressPolicy,
  // Destination awareness (doc/design/egress-guard.md §2). The pre-push hook
  // is handed the remote URL as `$2`; `--remote-url` is how it reaches here.
  // Rule h parity (issue #151): the same owner set, registry-state semantics,
  // presence test and refusal builder as the agent hook and the `gh` shim.
  // `git` hands this hook the URL AFTER insteadOf/pushInsteadOf rewriting, so
  // only ssh aliases need resolving here (`resolveRemoteUrl`, pure, never `ssh -G`).
  resolveRemoteUrl,
  classifyRemoteUrl,
  checkTerminal,
  identityPresence,
  repoAegisHome,
  detectSshOverride,
  parseRemoteUrlResolved,
  safeDestination,
  registeredOwners,
  ownerAdmitted,
  ruleHStatus,
  ruleHSkipNote,
  unregisteredOwnerReason,
  refusal,
  type RefusalFix,
  type RegistryState,
  computeTrustBoundary,
  readCachedVisibility,
  treatAsPublicDestination,
  refreshUnknownVisibility,
  effectiveVisibilityLookup,
  UNKNOWN_VISIBILITY_HINT,
  type VisibilityLookup,
  recordWorkingTree,
  resolveCachedDestination,
  getRemoteUrl,
  EGRESS_HUMAN_ENV,
  findApproval,
  approvalScopeOf,
  findUncoveringStarApproval,
  uncoveredStarSentence,
  type ApprovalScope,
  loadRegistryState,
  registryUnreadable,
  appendAuditRecord,
  type Registry,
  type RepoVisibility,
  CustomerCoupledNoEngagementError,
  OVERRIDE_FILENAME,
  WaiverParseError,
  parseWaivers,
  isWaived,
  expiredWaivers,
  // NOTE: core/src/remote-reach.ts is new in this change; its export line
  // in core/src/index.ts is outside this lane's edit scope (index.ts is
  // owned by the integrator). See the task report for the exact line to add.
  remoteReachableCommits,
  redactHits,
  redactStems,
  distinctEngagementCount,
  shouldRedactAttribution,
  isPublishablePatternId,
  type ScanHit,
  type SkippedFile,
  type RepoJson,
  type HistoryHit,
  type RegistryFinding,
  type RepoConfig,
  type DirectoryScanResult,
  type NewRefBase,
  type Waiver,
  EXIT_HIT,
} from "@de-otio/repo-aegis-core";
import { emitJson, emitText, emitError, shouldRevealMatches } from "../format.js";
import { currentHumanPresent } from "../human-presence.js";
import { enforceDenySetFloor, type DenySetFloorOptions } from "../deny-set-floor.js";

interface CheckOptions extends DenySetFloorOptions {
  /**
   * Evaluate from this directory instead of `process.cwd()`. The global
   * `--cwd` flag is documented as applying to every subcommand uniformly
   * (design README, "Universal CLI flags"); `check` previously accepted it
   * and silently scanned the process cwd instead, which made `--cwd` look
   * like it worked while reporting another repo's state.
   */
  cwd?: string;
  staged?: boolean;
  path?: string;
  /**
   * With a directory `--path`: cap on how many files one run will read.
   * Hitting it is a refusal, never a truncated scan — see
   * `DEFAULT_MAX_SCAN_FILES`.
   */
  maxFiles?: number;
  range?: string;
  history?: boolean;
  /**
   * A ref being pushed that the remote does not have yet (pre-push's
   * zero remote-sha case). The scanned range is derived from what the
   * remote-tracking refs already reach — see `resolveNewRefBase`.
   */
  pushRef?: string;
  /** Remote name for --push-ref. Defaults to `origin`. */
  remote?: string;
  /**
   * The destination remote URL, as git hands it to `pre-push` in `$2`.
   *
   * This is the one place in the stack that sees *where* content is going at
   * the moment of egress. Present → the destination checks below run before
   * any content is scanned; absent → nothing changes, so every existing
   * caller (and every hook installed before this shipped) behaves exactly as
   * it did. Meaningful with `--push-ref` / `--range`; accepted in any mode
   * because refusing it elsewhere would only invite callers to drop it.
   */
  remoteUrl?: string;
  /**
   * Live lookup for a destination whose visibility is unknown (issue #114).
   * Not a CLI flag: injectable for tests. Defaults to `gh repo view` unless
   * `REPO_AEGIS_VISIBILITY_LOOKUP=0`.
   */
  lookupVisibility?: VisibilityLookup;
  /** With --history, only scan commits reachable from this revspec. */
  since?: string;
  maxFileBytes?: number;
  ignoreAllowlistComments?: boolean;
  /**
   * Audit-grade strict mode: do not apply reviewed-benign waivers from
   * `.repo-aegis.yml`, so every `_always` finding is reported even if a
   * waiver exists for it. A malformed `waivers:` block is still a hard
   * error regardless of this flag — see {@link loadWaiversOrExit}.
   */
  ignoreWaivers?: boolean;
  /**
   * Strip engagement attribution from the output — see `core/ci-output.ts`.
   * Set by the composite Action and by every generated CI workflow, because
   * a PR comment, an issue body, and a public job log are publication
   * channels and an engagement id is usually the customer's name.
   */
  redactAttribution?: boolean;
  json?: boolean;
  verbose?: boolean;
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/**
 * Is `path` a directory? False for anything that cannot be stat'ed — a
 * missing path stays `scanFile`'s to report, unchanged.
 */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Scan options plus the directory-only file cap, when one was given. */
function dirScanOpts<T extends object>(scanOpts: T, opts: CheckOptions): T & { maxFiles?: number } {
  return { ...scanOpts, ...(opts.maxFiles !== undefined && { maxFiles: opts.maxFiles }) };
}

/**
 * Git toplevel of `repo.cwd`, or `repo.cwd` itself when it isn't (or
 * isn't inside) a git repo. Mirrors the resolution
 * `readRepoConfig`'s internal `.repo-aegis.yml` loader uses in
 * `core/src/repo.ts` (that resolver is private to that module, so it is
 * re-derived here rather than imported) — `.repo-aegis.yml` must be
 * found at the same path a human editing the repo root would expect,
 * not wherever `check` happened to be invoked from inside the tree.
 */
function findRepoRoot(repo: RepoConfig): string {
  if (!repo.isGitRepo) return repo.cwd;
  const top = git(repo.cwd, ["rev-parse", "--show-toplevel"]);
  return top !== null && top.trim() !== "" ? top.trim() : repo.cwd;
}

/**
 * Load the `waivers:` list from `.repo-aegis.yml`, if the file exists.
 * `[]` when the file (or the `waivers:` key) is absent.
 *
 * A malformed `waivers:` block is a HARD ERROR (`emitError`, exit 2),
 * never a silent skip — this is deliberate and matches
 * {@link WaiverParseError}'s own doc comment: silently dropping a
 * malformed-but-intended entry would leave the operator believing a
 * finding is waived when it is not (surprising re-block on the next
 * run); silently keeping it could widen coverage without review. Both
 * are wrong, so this always throws through `emitError` rather than
 * falling back to `[]`. Loaded unconditionally (even under
 * `--ignore-waivers`) so a malformed file is caught regardless of that
 * flag — `--ignore-waivers` controls whether a *valid* waiver is
 * applied, not whether the file is allowed to be broken.
 */
function loadWaiversOrExit(repo: RepoConfig, opts: CheckOptions): Waiver[] {
  const path = join(findRepoRoot(repo), OVERRIDE_FILENAME);
  if (!existsSync(path)) return [];

  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(path, "utf8"));
  } catch (err) {
    emitError(
      { code: "WAIVER_PARSE", error: `failed to parse ${OVERRIDE_FILENAME}: ${(err as Error).message}` },
      opts,
    );
  }
  const waiversField =
    parsed !== null && parsed !== undefined && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)["waivers"]
      : undefined;

  try {
    return parseWaivers(waiversField);
  } catch (err) {
    if (err instanceof WaiverParseError) {
      emitError({ code: err.code, error: `${OVERRIDE_FILENAME}: ${err.message}` }, opts);
    }
    throw err;
  }
}

/** The "tip" ref of a diff range (`A..B` / `A...B` → `B`; bare ref → itself). */
function rangeTip(range: string): string {
  const parts = range.split(/\.{2,3}/);
  const tip = parts[parts.length - 1]?.trim();
  return tip && tip !== "" ? tip : range.trim();
}

/**
 * Gather the egress-relevant files (lockfiles / .npmrc) in scope for this run,
 * reading the bytes that will actually land:
 *   --staged   → the staged blob (`git show :path`), not the working tree;
 *   --range    → the file at the range tip (`git show <tip>:path`);
 *   --push-ref → the same, over the range the marker scan resolved
 *                (passed in as `range`, since the caller computes it);
 *   --path     → the working-tree file, when it is itself egress-relevant.
 * --history is out of scope (egress is a present-state policy).
 *
 * `range` is the *effective* range: `opts.range` for `--range`, and the
 * resolved `<base>..<ref>` for `--push-ref`. Passing it explicitly keeps
 * the two modes on one code path — a new ref that adds a private-registry
 * lockfile must be caught exactly as an existing-ref push would be.
 */
function gatherEgressInputs(
  repo: RepoConfig,
  opts: CheckOptions,
  range?: string,
): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];

  if (opts.path) {
    const abs = resolveScanTarget(opts.path, repo.cwd);
    if (!existsSync(abs)) return out;
    // A directory --path sweeps the tree for lockfiles and .npmrc the same
    // way it sweeps for markers; leaving it out would make the directory
    // form quietly weaker than the file form it replaces. The walk runs
    // twice over the tree (here and in `scanDirectory`), which is two
    // readdir passes against one pass of reading every file — not worth a
    // shared cache that would have to be threaded through both callers.
    if (isDirectory(abs)) {
      const walk = walkScanFiles(abs, opts.maxFiles !== undefined ? { maxFiles: opts.maxFiles } : {});
      for (const file of walk.files) {
        const rel = relative(repo.cwd, file);
        const label = rel === "" || rel.startsWith("..") ? file : rel;
        if (!isEgressRelevant(label)) continue;
        try {
          out.push({ path: label, text: readFileSync(file, "utf8") });
        } catch {
          /* unreadable: nothing to scan */
        }
      }
      return out;
    }
    if (!isEgressRelevant(opts.path)) return out;
    try {
      out.push({ path: opts.path, text: readFileSync(abs, "utf8") });
    } catch {
      /* unreadable: nothing to scan */
    }
    return out;
  }

  if (!repo.isGitRepo) return out;

  if (opts.staged) {
    const names = git(repo.cwd, ["diff", "--cached", "--name-only", "--diff-filter=ACMR"]);
    if (names === null) return out;
    for (const p of names.split("\n").map(s => s.trim()).filter(Boolean)) {
      if (!isEgressRelevant(p)) continue;
      const text = git(repo.cwd, ["show", `:${p}`]);
      if (text !== null) out.push({ path: p, text });
    }
    return out;
  }

  if (range) {
    const tip = rangeTip(range);
    const names = git(repo.cwd, ["diff", "--name-only", "--diff-filter=ACMR", range]);
    if (names === null) return out;
    for (const p of names.split("\n").map(s => s.trim()).filter(Boolean)) {
      if (!isEgressRelevant(p)) continue;
      const text = git(repo.cwd, ["show", `${tip}:${p}`]);
      if (text !== null) out.push({ path: p, text });
    }
    return out;
  }

  return out;
}

// ---------------------------------------------------------------------------
// Destination checks (doc/design/egress-guard.md §2)
// ---------------------------------------------------------------------------

/**
 * What `--json` reports about where this push is going. Deliberately small:
 * `<org>/<repo>`, the cached visibility, the repo's class, and the one derived
 * boolean the policy turns on. Never a remote URL (it can carry a username),
 * never registry contents.
 */
export interface CheckDestination {
  org: string;
  repo: string;
  visibility: RepoVisibility;
  class: RepoConfig["class"];
  publicFacing: boolean;
  /**
   * Where `class` / `visibility` came from: this repository's own config
   * (the remote is its origin), another checkout of the destination on this
   * machine (the machine-wide destination cache), or nothing — the remote
   * is a repository this machine holds no declaration about, and the values
   * above are this repository's, which is the best available and may be
   * wrong for it.
   */
  declaredBy: "origin" | "cache" | "none";
  /**
   * Present (true) when the destination is public-facing only because its
   * visibility is unknown — nothing cached, and the live lookup could not
   * answer (issue #114).
   */
  assumedPublic?: true;
}

/** The ref or range this run is about, for reasons and the receipt line. */
function refLabel(opts: CheckOptions): string {
  return opts.pushRef ?? opts.range ?? "(no ref)";
}

const EMPTY_REGISTRY: Registry = { engagements: [], alwaysBlock: [] };

/**
 * Load the registry, and say HOW (rule h, issue #151, decision D4), with the one
 * core loader every layer shares. `missing` and `encrypted` both run as if there
 * were no registry (an empty one, so the cross-org check still has the
 * remote-origin fallback inside `computeTrustBoundary`); `unparseable` and
 * `newer-schema` are unreadable: rule h refuses.
 *
 * For the trust-boundary comparison, `registry: null` means "skip the
 * cross-org check": a guardrail must not block on its own inability to
 * determine context (the spurious `CROSS_ORG_WRITE` flake,
 * doc/bugs/repo-aegis-check-write-flake.md).
 */
function loadRegistryForPush(): { registry: Registry | null; state: RegistryState } {
  const load = loadRegistryState();
  switch (load.state) {
    case "loaded":
      return { registry: load.registry, state: "loaded" };
    case "missing":
    case "encrypted":
      return { registry: EMPTY_REGISTRY, state: load.state };
    case "unparseable":
    case "newer-schema":
      return { registry: null, state: load.state };
  }
}

/** Best-effort audit trail for a refusal. Never content, never the URL. `destination` is `<org>/<repo>` or a label. */
function auditRefusal(code: string, repo: RepoConfig, destination: string, ref: string): void {
  try {
    appendAuditRecord({
      action: "check-egress-refused",
      cwd: repo.cwd,
      repo: repo.cwd,
      details: { code, destination, ref },
    });
  } catch {
    /* the audit log must never break the refusal itself */
  }
}

/**
 * A pre-push refusal on the shared five-part builder. The destination goes
 * through `safeDestination` inside `refusal()`: a name that is not a plausible
 * GitHub owner/repo is dropped from the text, along with every command built
 * from it. The ref is git's and may hold shell syntax (`$(…)`, `;`): it is
 * named in the text only when it is plain ref characters, and never inside a
 * command. It always rides in `details`. Nothing here names the registry's
 * contents.
 */
function pushRefusal(
  code: string,
  dest: { org: string; repo: string },
  ref: string,
  why: string,
  approval: string,
  fixes: readonly RefusalFix[],
): string {
  const safe = safeDestination(dest.org, dest.repo) ?? dest; // refusal() discards a name that failed
  const shownRef = /^[A-Za-z0-9._/+~^@-]{1,200}$/.test(ref) ? `${ref} ` : "";
  return refusal({
    code,
    destination: { verb: "git push", org: dest.org, repo: dest.repo },
    what: `git push ${shownRef}→ ${safe.org}/${safe.repo}`,
    why,
    approval,
    fixes,
  });
}

/**
 * The "does an approval help?" sentence of the PUBLIC_PUSH_NEEDS_HUMAN refusal.
 *
 * When a live `*` approval exists but does not cover the destination (D7), the
 * refusal says so, in the hook's own words (`uncoveredStarSentence`, shared
 * from core so the layers cannot drift), instead of leaving the operator to
 * conclude the guard is broken. It names only the destination owner and the
 * approval's id and expiry, never registry contents.
 */
function publicPushApprovalSentence(
  dest: { org: string; repo: string },
  ref: string | undefined,
  scope: ApprovalScope,
  registry: Registry,
): string {
  const base = `A live approval for ${dest.org}/${dest.repo} would cover this, and none exists.`;
  try {
    const star = findUncoveringStarApproval(dest, ref, scope);
    if (star === null) return base;
    return base + uncoveredStarSentence(dest, star.approval, star.gap, registry);
  } catch {
    return base;
  }
}

/** How a push URL travels: ssh for scp-like, ssh:// and ssh-config alias forms; http for everything else GitHub. */
function pushTransport(raw: string | undefined): "ssh" | "http" {
  const c = classifyRemoteUrl(raw);
  if (c.kind === "github") return c.transport;
  return c.kind === "alias" ? "ssh" : "http";
}

/**
 * Run the destination checks for `--remote-url` and return what `--json`
 * should report. Refusals exit through `emitError` (exit 2) and never return.
 *
 * Order matters: `CROSS_ORG_PUSH` is deterministic and offline, so it is
 * decided first and is unaffected by whether a human happens to be at the
 * keyboard. `PUBLIC_PUSH_NEEDS_HUMAN` is the softer gate underneath it.
 *
 * Rule h (`UNREGISTERED_OWNER_EGRESS`, issue #151) runs first of all, before
 * any cache write or live visibility lookup: it is offline, and a push the
 * guard is about to refuse must not send `gh repo view` to that owner. With no
 * person present, an owner outside `registeredOwners()` is refused whatever
 * approvals exist (D1). Registry states are the hook's and the shim's (D4):
 * `missing` and "no owners declared" skip; `unreadable` refuses.
 *
 * Out of scope, so `null` and no checks: a non-GitHub host and a local path,
 * as before. But a URL-shaped value that is NOT cleanly
 * `github.com/<owner>/<repo>` (or an ssh alias the pure ssh-config parser
 * cannot resolve) is not "no destination": it is an unresolved one, and rule h
 * refuses it for a caller with no person present (D5).
 */
function evaluateDestination(repo: RepoConfig, opts: CheckOptions): CheckDestination | null {
  if (opts.remoteUrl === undefined || opts.remoteUrl.trim() === "") return null;
  // The pre-push hook sees the real environment and git config of the push: an
  // ssh override (GIT_SSH_COMMAND, GIT_SSH, GIT_SSH_VARIANT, core.sshCommand)
  // makes a non-GitHub-looking ssh host unresolved (see `resolveRemoteUrl`).
  // Unlike the agent hook, this layer needs no "dotless unknown host" rule:
  // it sees the real environment.
  const target = resolveRemoteUrl(opts.remoteUrl, undefined, { sshOverride: detectSshOverride(repo.cwd) });
  if (target.kind === "non-github") return null;

  const ref = refLabel(opts);
  const loaded = loadRegistryForPush();
  const humanPresent = currentHumanPresent();
  const ruleH = ruleHStatus(loaded.state, loaded.registry ?? EMPTY_REGISTRY);

  // --- UNREGISTERED_OWNER_EGRESS (rule h) ----------------------------------
  if (!humanPresent) {
    const named = target.kind === "github" ? { org: target.org, repo: target.repo } : null;
    const candidate =
      named ??
      ({
        org: "*",
        repo: "*",
        unresolved: "opaque-url",
        ...(target.kind === "unresolved" && { unresolvedWhy: target.why }),
      } as const);
    let refused = false;
    if (registryUnreadable(loaded.state)) {
      refused = true; // no owner can be confirmed, so none is admitted (D4, revised); a hook cannot ask, so it refuses
    } else if (loaded.state === "loaded" && loaded.registry !== null) {
      const owners = registeredOwners(loaded.registry);
      refused = owners.size > 0 && !ownerAdmitted(candidate, { verb: "git-push" }, owners, loaded.registry);
    }
    if (refused) {
      const label = named !== null ? `${named.org}/${named.repo}` : "(unresolved)";
      auditRefusal("UNREGISTERED_OWNER_EGRESS", repo, label, ref);
      emitError(
        {
          code: "UNREGISTERED_OWNER_EGRESS",
          error: unregisteredOwnerReason({ verb: "git-push" }, candidate, loaded.state, loaded.registry ?? EMPTY_REGISTRY),
          // Only the destination, which the remote URL already carries: never
          // the registry's owners, engagements or upstreams (the redaction oracle).
          details: { destination: label, ref, ruleH },
        },
        opts,
      );
    }
    // D4: say when rule h did NOT judge, so nobody believes an owner check happened. (Encrypted has its own line below.)
    const skipNote = loaded.state === "encrypted" ? null : ruleHSkipNote(ruleH);
    if (skipNote !== null) process.stderr.write(`repo-aegis: ${skipNote}\n`);
  }
  // An encrypted registry is treated as none: say so once per run, with what that switched off and the way back.
  if (loaded.state === "encrypted") {
    process.stderr.write(
      "repo-aegis: registry is encrypted, so rule h was skipped and the cross-org check used only this repository's " +
        "remote; a person runs `repo-aegis registry decrypt --identity <key>`\n",
    );
  }

  if (target.kind === "unresolved") {
    // Nothing offline names the repository, so none of the destination checks
    // below can run. Rule h has already judged this (or a person is present,
    // or it was skipped); say so rather than pass in silence.
    process.stderr.write(
      `repo-aegis: the push URL does not resolve to a GitHub repository offline; destination checks skipped\n`,
    );
    return null;
  }
  const parsed = { host: "github.com", org: target.org, repo: target.repo };
  // The pushing repository's declaration describes the destination only when
  // the destination IS its origin. A push to any other URL (`git push
  // git@github.com:o/other.git main`) must be judged by `o/other`'s own
  // declaration, which this machine may hold in another checkout.
  recordWorkingTree(repo.cwd);
  const ownUrl = getRemoteUrl(repo.cwd);
  const own = ownUrl === null ? null : parseRemoteUrlResolved(ownUrl);
  const isOwn = own !== null && own.org === parsed.org && own.repo === parsed.repo;
  // The pushing repository's cached visibility describes the destination only
  // when the destination IS its origin. For any other URL it is "unknown"
  // until the destination's own checkout (the cache) or GitHub says otherwise
  // — reading this repo's value there is how a push to a foreign public
  // repository was once judged by a private repository's cache.
  // (`REPO_AEGIS_ASSUME_PUBLIC=1` still applies: `readCachedVisibility` honours it.)
  let visibility: RepoVisibility = readCachedVisibility(repo.cwd);
  if (!isOwn && visibility !== "public") visibility = "unknown";
  let cls = repo.class;
  let declaredBy: CheckDestination["declaredBy"] = isOwn ? "origin" : "none";
  let workingTree: string | undefined = isOwn ? repo.cwd : undefined;
  const registry = loaded.registry;
  if (!isOwn) {
    const cached = resolveCachedDestination(parsed.org, parsed.repo);
    if (cached !== null) {
      visibility = cached.visibility;
      cls = cached.class;
      declaredBy = "cache";
      if (cached.live) workingTree = cached.workingTree;
    }
  }
  // Issue #114: an unknown visibility is looked up once (and cached into the
  // destination's checkout when there is one). A lookup that fails leaves it
  // unknown, and unknown is treated as public below — the network is only
  // ever a way OUT of the refusal, never a condition for it.
  if (visibility === "unknown" && cls !== "public-eligible") {
    visibility = refreshUnknownVisibility(
      { org: parsed.org, repo: parsed.repo, ...(workingTree !== undefined && { workingTree }) },
      effectiveVisibilityLookup(opts.lookupVisibility),
    );
  }
  // The one rule shared with the `gh` shim and the agent hooks.
  const publicFacing = treatAsPublicDestination(cls, visibility);
  const assumedPublic = publicFacing && cls !== "public-eligible" && visibility === "unknown";
  // How the visibility is printed: the same words the egress policy uses.
  const visLabel = assumedPublic ? "visibility uncached, treated as public" : visibility;
  const dest: CheckDestination = {
    org: parsed.org,
    repo: parsed.repo,
    visibility,
    class: cls,
    publicFacing,
    declaredBy,
    ...(assumedPublic && { assumedPublic: true as const }),
  };

  // --- CROSS_ORG_PUSH ------------------------------------------------------
  if (registry !== null) {
    let boundaryOrgs: string[] | null = null;
    try {
      boundaryOrgs = [...computeTrustBoundary(repo.cwd, registry).orgs].sort();
    } catch {
      boundaryOrgs = null; // context unavailable -> fail open
    }
    // An empty org set is "no signal", not "no orgs allowed" — same rule as
    // `trustBoundariesOverlap`, which treats two empty sets as non-overlapping
    // rather than as a match.
    if (boundaryOrgs !== null && boundaryOrgs.length > 0 && !boundaryOrgs.includes(parsed.org)) {
      auditRefusal("CROSS_ORG_PUSH", repo, `${dest.org}/${dest.repo}`, ref);
      // The boundary's owners are NOT listed, in the text or in `details`: they
      // can be customer orgs, and a refusal can land in an agent transcript.
      // Only the destination owner, which the remote URL already carries.
      emitError(
        {
          code: "CROSS_ORG_PUSH",
          error: pushRefusal(
            "CROSS_ORG_PUSH",
            parsed,
            ref,
            `This repository's trust boundary does not include the owner "${parsed.org}", so a push there would ` +
              `carry its content across the boundary (the boundary comes from how this repository is classified, which a person set with \`repo-aegis classify\`)`,
            "No approval covers this: an approval cannot widen a trust boundary",
            [
              {
                by: "agent",
                command: "git push <a remote inside this repository's trust boundary> <branch>",
              },
              // Only "push inside the boundary" or "re-classify this repository".
              // Never `engagements add --github-org <destination owner>`: that
              // would teach the refused party to widen the boundary to fit.
              {
                by: "person",
                when: "If this repository was classified wrongly",
                command: "repo-aegis classify",
                note: "it re-classifies this repository so its boundary matches where it should publish; the new class applies to every later push too",
              },
            ],
          ),
          details: {
            destination: `${parsed.org}/${parsed.repo}`,
            ref,
          },
        },
        opts,
      );
    }
  }

  // --- PUBLIC_PUSH_NEEDS_HUMAN --------------------------------------------
  // `currentHumanPresent` tests stderr's TTY (and the process ancestry). stdin is git's ref list on this path
  // and is never the signal. A live approval minted at a terminal for this
  // destination (and ref, when scoped) stands in for the person.
  // A `*` approval covers only personalOrgs owners (D7); a push always has a
  // destination, and a registry that could not be loaded has no personal orgs,
  // so `*` then covers nothing (fail closed).
  const scope = approvalScopeOf(registry ?? {});
  const approval = dest.publicFacing && !humanPresent ? findApproval(parsed, opts.pushRef, scope) : null;
  if (approval !== null) {
    try {
      appendAuditRecord({
        action: "egress-approval-use",
        cwd: repo.cwd,
        repo: repo.cwd,
        details: { id: approval.id, layer: "git pre-push", destination: `${parsed.org}/${parsed.repo}`, ref },
      });
    } catch {
      /* audit must not block the push */
    }
    process.stderr.write(`repo-aegis: human approval ${approval.id} stands in for a person on this push\n`);
  }
  if (dest.publicFacing && !humanPresent && approval === null) {
    auditRefusal("PUBLIC_PUSH_NEEDS_HUMAN", repo, `${dest.org}/${dest.repo}`, ref);
    emitError(
      {
        code: "PUBLIC_PUSH_NEEDS_HUMAN",
        error: pushRefusal(
          "PUBLIC_PUSH_NEEDS_HUMAN",
          parsed,
          ref,
          `The destination ${parsed.org}/${parsed.repo} (${visLabel}, ${cls}) is public-facing, and no person is ` +
            `present` +
            (assumedPublic ? `.${UNKNOWN_VISIBILITY_HINT}` : ""),
          publicPushApprovalSentence(parsed, opts.pushRef, scope, registry ?? EMPTY_REGISTRY),
          [
            {
              by: "person",
              when: "To approve this push in advance",
              command: `repo-aegis approve ${parsed.org}/${parsed.repo}`,
            },
            {
              by: "person",
              note: `or set ${EGRESS_HUMAN_ENV}=1 for that one invocation; an agent never sets it`,
            },
          ],
        ),
        details: {
          destination: `${parsed.org}/${parsed.repo}`,
          ref,
          visibility,
          class: cls,
        },
      },
      opts,
    );
  }

  // --- AGENT_PUSH_NEEDS_APP (doc/plan-owner-identity.md §5.6, §12.1 A6) --------
  // After every destination check above, which are unchanged. With no person present (identity presence: no
  // environment variable counts, A1), an owner mapped to an agent identity is pushed to over HTTPS, where the
  // repo-aegis credential helper supplies the App token. Over SSH the push would go as whatever key the person
  // has: refused, with the HTTPS form. Over HTTPS the helper must be first in git's list, or git asks the
  // person's helper instead.
  if (registry !== null && registry.identityMap?.get(parsed.org)?.agent !== undefined) {
    const presence = identityPresence(checkTerminal());
    if (presence === "agent") {
      const transport = pushTransport(opts.remoteUrl);
      const safe = safeDestination(parsed.org, parsed.repo);
      if (transport === "ssh") {
        const httpsForm = safe === null ? null : `git push https://github.com/${safe.org}/${safe.repo}.git <branch>`;
        auditRefusal("AGENT_PUSH_NEEDS_APP", repo, `${dest.org}/${dest.repo}`, ref);
        emitError(
          {
            code: "AGENT_PUSH_NEEDS_APP",
            error: pushRefusal(
              "AGENT_PUSH_NEEDS_APP",
              parsed,
              ref,
              "This owner has a GitHub App identity for agents (a person mapped it; repo-aegis maps none by itself), and this push's remote is an SSH one, which goes out as the person's SSH key instead of the App; only an HTTPS push gets the App's narrowed token",
              "No approval covers this: an approval cannot make an SSH push use the App's token",
              httpsForm === null ? [] : [{ by: "agent", command: httpsForm }],
            ),
            details: { destination: `${parsed.org}/${parsed.repo}`, ref },
          },
          opts,
        );
      }
      const entries = readCredentialConfig(repo.cwd);
      const order = entries === null ? null : helperOrder(entries, helperCommand(currentEnforcementPin(), repoAegisHome()));
      if (order === null || order.kind !== "first") {
        auditRefusal("GIT_CREDENTIAL_HELPER_ORDER", repo, `${dest.org}/${dest.repo}`, ref);
        emitError(
          {
            code: "GIT_CREDENTIAL_HELPER_ORDER",
            error: pushRefusal(
              "GIT_CREDENTIAL_HELPER_ORDER",
              parsed,
              ref,
              "This owner has a GitHub App identity for agents, but the repo-aegis git credential helper is not the first helper git runs for https://github.com (or git's configuration cannot be read), so this push was authenticated with some other credential; repo-aegis puts its helper first only when `install git-credential` runs, so it was never installed or another helper was added ahead of it afterwards",
              "No approval covers this: an approval cannot change which helper git asks first",
              [
                {
                  by: "person",
                  when: "To fix the helper order",
                  command: "repo-aegis install git-credential",
                  note: "it adds only repo-aegis's own helper entry, so re-running it is safe; if another helper still comes first, `repo-aegis doctor` names it",
                },
              ],
            ),
            details: { destination: `${parsed.org}/${parsed.repo}`, ref },
          },
          opts,
        );
      }
    }
  }

  // --- the git-native receipt ---------------------------------------------
  // One line, on stderr, so it rides out with git's own output and lands in
  // the agent's tool result. A model skims twenty lines of git output; it does
  // not skim one line naming a repository it did not intend.
  process.stderr.write(
    `repo-aegis: pushing ${ref} → ${parsed.org}/${parsed.repo} (${visLabel})\n`,
  );

  return dest;
}

export function check(opts: CheckOptions): void {
  // Validate flags FIRST. Exactly one of --staged, --path, --range,
  // --push-ref, --history must be specified.
  const modes = [opts.staged, !!opts.path, !!opts.range, !!opts.pushRef, !!opts.history].filter(
    Boolean,
  ).length;
  if (modes !== 1) {
    emitError(
      {
        code: "USAGE",
        error:
          "specify exactly one of --staged, --path <path>, --range <revspec>, " +
          "--push-ref <ref>, or --history",
      },
      opts,
    );
  }

  const repo = readRepoConfig(opts.cwd);

  if (repo.isGitRepo && repo.class === "customer-coupled" && repo.engagements.length === 0) {
    const err = new CustomerCoupledNoEngagementError();
    emitError({ code: err.code, error: err.message }, opts);
  }

  // Destination first, content second. A push to the wrong repository is
  // wrong even when the bytes are clean — that is the whole point of §2 — and
  // deciding it before the scan means the refusal costs nothing and cannot be
  // masked by a scan failure.
  const destination = evaluateDestination(repo, opts);

  const denySet = computeDenySet(repo);
  // Fail-closed floor, before anything can report "clean" — including the
  // `no-deny-set` early return further down, which is exactly the outcome this
  // guards against being mistaken for a passing scan.
  enforceDenySetFloor(denySet.patterns.length, denySet.files.map(f => f.stem), opts);
  const redactAttribution = shouldRedactAttribution(opts.redactAttribution);
  const reveal = shouldRevealMatches(opts);
  const scanOpts = {
    revealMatches: reveal,
    maxFileBytes: opts.maxFileBytes ?? undefined,
    respectAllowComments: !opts.ignoreAllowlistComments,
  };

  // --push-ref resolves its diff base up front, before anything else looks at
  // the repo, for three reasons: the egress sweep below needs the same range
  // the marker scan will use; a git failure must exit 2 rather than fall
  // through to a confident "clean"; and the resolved value is then reused by
  // scanNewRef so `rev-list` runs once, not twice.
  const remote = opts.remote ?? "origin";
  let newRef: NewRefBase | undefined;
  if (opts.pushRef) {
    if (!repo.isGitRepo) {
      emitError({ code: "NOT_GIT_REPO", error: "not a git repo; --push-ref requires a git repo" }, opts);
    }
    try {
      newRef = resolveNewRefBase(repo, { ref: opts.pushRef, remote });
    } catch (err) {
      emitError({ code: "GIT_ERROR", error: (err as Error).message }, opts);
    }
  }

  // The effective range for the egress sweep: the user's own --range, or the
  // range --push-ref resolved to. `nothing-new` leaves it undefined — there is
  // no diff, so there are no files to read.
  const effectiveRange =
    opts.range ?? (newRef?.base !== undefined ? `${newRef.base}..${opts.pushRef}` : undefined);

  // Egress hygiene runs independently of the marker deny set: a private-registry
  // URL in a lockfile / .npmrc is not a customer marker, and must be caught even
  // when this repo has no deny set. It applies only to public-facing repos and
  // not in --history mode (egress is a present-state policy).
  const egress: RegistryFinding[] =
    !opts.history && isPublicFacing(repo)
      ? scanRegistryEgress(gatherEgressInputs(repo, opts, effectiveRange), loadEgressPolicy())
      : [];

  const hasDenySet = denySet.combinedRegex !== "";
  const mode: "staged" | "path" | "range" | "push-ref" | "history" = opts.path
    ? "path"
    : opts.range
      ? "range"
      : opts.pushRef
        ? "push-ref"
        : opts.history
          ? "history"
          : "staged";

  if (!hasDenySet && egress.length === 0) {
    if (opts.json) {
      emitJson({
        hits: [],
        skipped: [],
        egress: [],
        status: "no-deny-set",
        warnings: denySet.warnings,
        ...(destination !== null && { destination }),
      });
    } else {
      emitText("repo-aegis: no deny set (marker dir empty or all engagements allowed here)");
    }
    return;
  }

  let hits: ScanHit[] = [];
  let skipped: SkippedFile[] = [];
  let historyHits: HistoryHit[] = [];
  /** Set only when `--path` named a directory; drives the reporting below. */
  let dirScan: { filesScanned: number; skippedDirs: string[] } | undefined;

  if (hasDenySet) {
    if (opts.staged) {
      if (!repo.isGitRepo) {
        emitError({ code: "NOT_GIT_REPO", error: "not a git repo; --staged requires a git repo" }, opts);
      }
      // A scanner that reports "clean" because git failed is worse than one
      // that reports nothing: the operator reads the empty result as safety.
      // Every git-backed mode below therefore fails closed with exit 2.
      try {
        const r = scanStagedDiff(repo, denySet, scanOpts);
        hits = r.hits;
        skipped = r.skipped;
      } catch (err) {
        emitError({ code: "GIT_ERROR", error: (err as Error).message }, opts);
      }
    } else if (opts.path) {
      // #97.3: resolve a relative path against the repo under test, not the
      // process cwd. `--cwd <repo> --path <relative>` previously resolved
      // against wherever the process happened to be, missed, and reported the
      // miss as a skip inside an otherwise clean-looking result.
      const target = resolveScanTarget(opts.path, repo.cwd);
      const workingTree = repo.isGitRepo ? repo.cwd : undefined;
      if (isDirectory(target)) {
        // A directory used to reach `scanFile`, fail `readFileSync` with
        // EISDIR, and be reported as `unreadable` — fail-closed with the
        // wrong diagnosis, which sends the operator to check permissions on
        // something that was never a file. Walking it is what the operator
        // meant, and it costs nothing this command was not already doing
        // per file.
        // The refusal below sits OUTSIDE the try on purpose: `emitError`
        // exits, and under the test harness that exit is an exception — a
        // refusal raised inside the try would be caught by this very catch
        // and re-reported as an I/O failure.
        let walked: DirectoryScanResult | undefined;
        try {
          walked = scanDirectory(target, denySet, dirScanOpts(scanOpts, opts), workingTree);
        } catch (err) {
          emitError({ error: (err as Error).message }, opts);
        }
        const r = walked!;
        hits = r.hits;
        skipped = r.skipped;
        dirScan = { filesScanned: r.filesScanned, skippedDirs: r.skippedDirs };
        if (r.limitExceeded) {
          // An incomplete scan must never be reported as a result. Same rule
          // as every other fail-closed path here: say what did not happen,
          // exit 2, and let the operator narrow the scope.
          emitError(
            {
              code: "PATH_TOO_MANY_FILES",
              error:
                `nothing was reported: the directory --path holds more than ` +
                `${opts.maxFiles ?? DEFAULT_MAX_SCAN_FILES} file(s), and a truncated scan would read as a clean one`,
              details:
                `path: ${target}\n` +
                `  Scan a narrower path, or raise the cap with --max-files <n>.`,
            },
            opts,
          );
        }
      } else {
        try {
          const r = scanFile(target, denySet, scanOpts, workingTree);
          hits = r.hits;
          skipped = r.skipped;
        } catch (err) {
          emitError({ error: (err as Error).message }, opts);
        }
      }
      // The requested path IS the entire scope of --path mode, so if nothing
      // in it was scanned, nothing was scanned. Reporting that as `hits: []`
      // + exit 0 is the failure this tool exists to prevent: a leak check
      // that quietly did not run, indistinguishable from one that ran and
      // found nothing. Every other git-backed mode already fails closed with
      // exit 2; so does this. For a directory the test is "no file was read"
      // — a tree where some files were skipped for size or binary content
      // still scanned the rest, and those skips are reported below.
      const scannedNothing = dirScan !== undefined ? dirScan.filesScanned === 0 : skipped.length > 0;
      if (scannedNothing) {
        const why = [...new Set(skipped.map(s => s.reason))].join(", ");
        emitError(
          {
            code: "PATH_NOT_SCANNED",
            error:
              dirScan !== undefined
                ? `nothing was scanned: no file under the requested --path directory was read` +
                  (why === "" ? " (it holds none)" : ` (${why})`)
                : `nothing was scanned: the requested --path was skipped (${why})`,
            details: `path: ${target}`,
          },
          opts,
        );
      }
    } else if (opts.range) {
      if (!repo.isGitRepo) {
        emitError({ code: "NOT_GIT_REPO", error: "not a git repo; --range requires a git repo" }, opts);
      }
      try {
        const r = scanRange(repo, denySet, opts.range, scanOpts);
        hits = r.hits;
        skipped = r.skipped;
      } catch (err) {
        emitError({ code: "GIT_ERROR", error: (err as Error).message }, opts);
      }
    } else if (opts.pushRef) {
      // The base was resolved (and its failure handled) above; pass it in so
      // the scan does not re-run `rev-list`. scanNewRef can still throw from
      // the diff itself, which must fail closed like every other git-backed
      // mode.
      try {
        const r = scanNewRef(
          repo,
          denySet,
          { ref: opts.pushRef, remote },
          scanOpts,
          newRef,
        );
        hits = r.hits;
        skipped = r.skipped;
      } catch (err) {
        emitError({ code: "GIT_ERROR", error: (err as Error).message }, opts);
      }
    } else if (opts.history) {
      if (!repo.isGitRepo) {
        emitError({ code: "NOT_GIT_REPO", error: "not a git repo; --history requires a git repo" }, opts);
      }
      try {
        historyHits = scanHistory(repo, denySet, {
          ...scanOpts,
          ...(opts.since !== undefined && { since: opts.since }),
        });
      } catch (err) {
        emitError({ code: "GIT_ERROR", error: (err as Error).message }, opts);
      }
    }
  }

  const advisory = repo.class === "scratch";

  // ---- D: reviewed-benign waivers ---------------------------------------
  // Loaded unconditionally above the `--ignore-waivers` branch point so a
  // malformed `waivers:` block is always a hard error (see
  // loadWaiversOrExit). `now` is captured once, here at the CLI edge, and
  // threaded into the clock-free core predicates — core never calls
  // Date.now()/new Date() itself, so waiver-expiry behaviour stays
  // deterministic under test.
  const waivers = loadWaiversOrExit(repo, opts);
  const now = new Date();
  const expired = expiredWaivers(waivers, now);

  // CONTROL 3 (see waivers.ts / the plan's "D" section): a waiver that
  // hides silently is exactly the failure mode this feature exists to
  // avoid, so `waivedHits` is tracked and reported — as a text-mode count
  // and a full JSON list — on every run, including when it ends up empty.
  // Each entry pairs WHERE the finding was with WHICH waiver covered it and
  // WHY. Emitting the bare hit would drop `reason`/`approver`, which is the
  // whole audit value of a waiver — a reviewer reading JSON needs to see the
  // human justification, not just that something was suppressed.
  const waivedHits: (ScanHit & {
    reason: string;
    approver: string;
    expires?: string;
  })[] = [];
  if (!opts.ignoreWaivers && waivers.length > 0 && hits.length > 0) {
    const kept: ScanHit[] = [];
    for (const h of hits) {
      const probe = { patternId: h.patternId ?? "", blob: h.blob };
      // Single-waiver `isWaived` calls reuse core's matching AND expiry rules
      // verbatim, so this cannot drift from the filter decision below.
      const matched = waivers.find(w => isWaived(probe, [w], now));
      if (matched) {
        waivedHits.push({
          ...h,
          reason: matched.reason,
          approver: matched.approver,
          ...(matched.expires !== undefined && { expires: matched.expires }),
        });
      } else {
        kept.push(h);
      }
    }
    hits = kept;
  }

  // ---- C: "already public" → warn, not block ----------------------------
  // Only in scope for a genuine full-history scan (`--history`, or
  // `--push-ref`'s `full-history` fallback) on a public-facing repo — a
  // first-time addition of the same shape via `--staged`/`--range` must
  // still block. `newRef?.mode === "full-history"` is included per the
  // design even though today's `scanNewRef` delegates to `scanRange`
  // (producing `ScanHit`s with no commit attribution, not `HistoryHit`s) —
  // `historyHits` is in practice only ever populated by `--history`, so
  // this condition is inert for `--push-ref` today and costs nothing to
  // include; it means no further change is needed here if a future
  // `scanNewRef` gains commit-attributed hits for that mode.
  const historyDowngradeEligible =
    isPublicFacing(repo) && (opts.history === true || newRef?.mode === "full-history");

  let reachableCommits: Set<string> | undefined;
  if (historyDowngradeEligible && historyHits.length > 0) {
    // Computed ONCE for the whole run — see remote-reach.ts's header doc
    // for why this must not become a spawn per historical hit.
    reachableCommits = remoteReachableCommits(repo, remote);
  }

  const historyHitsJson = historyHits.map(h => {
    const alreadyPublic = reachableCommits !== undefined && reachableCommits.has(h.commitSha);
    return { ...h, alreadyPublic };
  });
  const blockingHistoryHits = historyHitsJson.filter(h => !h.alreadyPublic);
  const warnedHistoryHits = historyHitsJson.filter(h => h.alreadyPublic);

  const repoJson: RepoJson = {
    cwd: repo.cwd,
    isGitRepo: repo.isGitRepo,
    class: repo.class,
    classExplicit: repo.classExplicit,
    // A clean run leaks too: this array is emitted whether or not anything
    // matched, so redaction cannot be conditional on there being hits.
    engagements: redactAttribution ? [] : repo.engagements,
  };

  // Count before redacting — the aggregate is the one attribution signal that
  // survives, and it has to be computed from the un-redacted hits.
  const engagementsAffected = distinctEngagementCount([...hits, ...waivedHits]);

  const result = {
    mode,
    // Present only when `--remote-url` parsed. Omitted otherwise so the
    // envelope every existing consumer reads stays byte-identical.
    ...(destination !== null && { destination }),
    // Only --push-ref resolves a range mode; omitting the key elsewhere keeps
    // the envelope of the other four modes byte-identical to before.
    ...(newRef !== undefined && {
      rangeMode: newRef.mode,
      ...(newRef.base !== undefined && { base: newRef.base }),
    }),
    // Present only for a directory `--path`, so the envelope of every other
    // mode (and of the file form) stays byte-identical. `filesScanned` is the
    // number a reader needs to tell a clean tree from a tree nothing read.
    ...(dirScan !== undefined && {
      filesScanned: dirScan.filesScanned,
      skippedDirs: dirScan.skippedDirs,
    }),
    hits: redactAttribution ? redactHits(hits) : hits,
    // Not redacted: a HistoryHit carries no attribution. Its `pattern` field
    // is already run through the same `formatMatch` redaction as
    // `matchPreview`, and it has no engagement or patternId to strip.
    historyHits: historyHitsJson,
    skipped,
    egress,
    repo: repoJson,
    denySet: {
      // `files` is a list of marker-file stems, i.e. engagement ids — the same
      // disclosure as `engagements` above, one level down and easy to miss.
      files: redactAttribution
        ? redactStems(denySet.files.map(f => f.stem))
        : denySet.files.map(f => f.stem),
      patternCount: denySet.patterns.length,
    },
    // Only present when redacting: the aggregate that replaces per-hit
    // attribution. Omitted otherwise so un-redacted output keeps its shape.
    ...(redactAttribution && { engagementsAffected, attributionRedacted: true as const }),
    advisory,
    warnings: denySet.warnings,
    // CONTROL 3: always present, even when empty — never a silent filter.
    waived: redactAttribution ? redactHits(waivedHits) : waivedHits,
    // A waiver's `pattern` is a `<stem>/<digest>` id. `waive` only ever mints
    // `_always` waivers, so these are publishable by construction — but a
    // hand-edited `.repo-aegis.yml` could carry another stem, and this is
    // output, not input validation. Redact defensively.
    expiredWaivers: expired.map(w => ({
      ...(!redactAttribution || isPublishablePatternId(w.pattern) ? { pattern: w.pattern } : {}),
      blob: w.blob,
      expires: w.expires,
    })),
  };

  // Only blocking (non-downgraded) history hits count toward the exit
  // code; warnedHistoryHits are surfaced below but never block.
  const totalHits = hits.length + blockingHistoryHits.length;

  if (opts.json) {
    emitJson(result);
  } else {
    // CONTROL 3: whenever a waiver actually suppressed something, say so
    // before the clean/hit branches below — a waiver must never disappear
    // into a "clean" result with no trace that it applied. Zero is not
    // announced: this line lands in hook output on every commit, and a
    // permanent `waived: 0` is noise that trains people to skim past it
    // (and so past the case that matters). JSON always carries the list.
    if (waivedHits.length > 0) {
      emitText(`repo-aegis: waived: ${waivedHits.length} finding(s) via .repo-aegis.yml`);
    }
    if (expired.length > 0) {
      emitText(`  warning: ${expired.length} waiver(s) have expired and no longer apply`);
    }

    // Directory mode says how much it read, always — "clean" over a tree
    // means nothing without the count of files behind it.
    if (dirScan !== undefined) {
      const dirs =
        dirScan.skippedDirs.length > 0
          ? `; ${dirScan.skippedDirs.length} director${dirScan.skippedDirs.length === 1 ? "y" : "ies"} not walked`
          : "";
      emitText(`repo-aegis: scanned ${dirScan.filesScanned} file(s) under ${opts.path}${dirs}`);
    }

    if (newRef?.mode === "nothing-new" && totalHits === 0 && egress.length === 0) {
      // The release-tag case. Saying "clean (N patterns checked)" here would be
      // true but misleading — nothing was diffed, because there was nothing to
      // diff. Say so, so an operator can tell this apart from a real scan.
      emitText(`repo-aegis: nothing new to scan (ref already reachable from ${remote})`);
    } else if (totalHits === 0 && egress.length === 0) {
      emitText(`repo-aegis: clean (${denySet.patterns.length} patterns checked)`);
      if (skipped.length > 0) {
        emitText(`  skipped: ${skipped.length} file(s) (${skipped.map(s => s.reason).join(", ")})`);
      }
    } else {
      if (hits.length > 0) {
        emitText(`repo-aegis: ${hits.length} marker hit${hits.length === 1 ? "" : "s"}${advisory ? " (advisory)" : ""}`);
        for (const h of hits) {
          // Text output goes to a terminal locally and to a job log in CI, and
          // a job log on a public repo is world-readable — so the same
          // redaction applies here, not just to --json.
          const eng = h.engagement && !redactAttribution ? ` [${h.engagement}]` : "";
          emitText(`  ${h.path ?? "<staged>"}:${h.line}:${h.column}  ${h.matchPreview}${eng}`);
        }
        if (redactAttribution && engagementsAffected > 0) {
          emitText(`  (attribution redacted; ${engagementsAffected} engagement(s) affected)`);
        }
      }
      if (blockingHistoryHits.length > 0) {
        emitText(
          `repo-aegis: ${blockingHistoryHits.length} historical hit${blockingHistoryHits.length === 1 ? "" : "s"} across the git log`,
        );
        for (const h of blockingHistoryHits) {
          emitText(`  ${h.commitSha}  ${h.pattern}  ${h.commitSummary}`);
        }
      }
      if (egress.length > 0) {
        emitText(
          `repo-aegis: ${egress.length} private-registry reference${egress.length === 1 ? "" : "s"} in a public-facing repo`,
        );
        for (const e of egress) {
          emitText(`  ${e.file}${e.line ? `:${e.line}` : ""}  ${e.host}${e.pkg ? `  (${e.pkg})` : ""}`);
        }
      }
      if (skipped.length > 0) {
        emitText(`  skipped: ${skipped.length} file(s)`);
      }
      for (const w of denySet.warnings) emitText(`  warning: ${w}`);
    }

    // C: surfaced unconditionally (never folded into the "clean" branch
    // above), independent of whether anything else blocked this run — a
    // downgraded finding is a warning, not a thing that disappears.
    if (warnedHistoryHits.length > 0) {
      emitText(
        `repo-aegis: ${warnedHistoryHits.length} historical hit${warnedHistoryHits.length === 1 ? "" : "s"} already public (reachable from ${remote}); not blocking`,
      );
      for (const h of warnedHistoryHits) {
        emitText(`  ${h.commitSha}  ${h.pattern}  ${h.commitSummary}`);
      }
    }
  }

  if ((totalHits > 0 || egress.length > 0) && !advisory) process.exit(EXIT_HIT);
}
