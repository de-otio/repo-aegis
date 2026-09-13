// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
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
  parseRemoteUrl,
  computeTrustBoundary,
  readCachedVisibility,
  recordWorkingTree,
  resolveCachedDestination,
  getRemoteUrl,
  findApproval,
  isHumanPresent,
  EGRESS_HUMAN_ENV,
  loadRegistry,
  appendAuditRecord,
  RegistryNotFoundError,
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
}

/** The ref or range this run is about, for reasons and the receipt line. */
function refLabel(opts: CheckOptions): string {
  return opts.pushRef ?? opts.range ?? "(no ref)";
}

/**
 * Load the registry for the trust-boundary comparison, best-effort.
 *
 * `null` means "skip the cross-org check": a guardrail must not block on its
 * own inability to determine context (the spurious `CROSS_ORG_WRITE` flake,
 * doc/bugs/repo-aegis-check-write-flake.md). A *missing* registry is the one
 * error that is not ambiguous — there is simply no registry on this machine —
 * so it degrades to an empty one, which still lets the remote-origin fallback
 * inside `computeTrustBoundary` supply the repo's own org.
 */
function registryForBoundary(): Registry | null {
  try {
    return loadRegistry();
  } catch (err) {
    if (err instanceof RegistryNotFoundError) return { engagements: [], alwaysBlock: [] };
    return null;
  }
}

/** Best-effort audit trail for a refusal. Never content, never the URL. */
function auditRefusal(code: string, repo: RepoConfig, dest: CheckDestination, ref: string): void {
  try {
    appendAuditRecord({
      action: "check-egress-refused",
      cwd: repo.cwd,
      repo: repo.cwd,
      details: { code, destination: `${dest.org}/${dest.repo}`, ref },
    });
  } catch {
    /* the audit log must never break the refusal itself */
  }
}

/**
 * Run the destination checks for `--remote-url` and return what `--json`
 * should report. Refusals exit through `emitError` (exit 2) and never return.
 *
 * Order matters: `CROSS_ORG_PUSH` is deterministic and offline, so it is
 * decided first and is unaffected by whether a human happens to be at the
 * keyboard. `PUBLIC_PUSH_NEEDS_HUMAN` is the softer gate underneath it.
 *
 * Fail-open by construction: a URL that does not parse (a non-GitHub host, a
 * local path, a bare directory) yields `null` and no checks at all. That is
 * the documented Phase-1 scope of `parseRemoteUrl`, and refusing what it
 * cannot read would make every non-GitHub remote unpushable.
 */
function evaluateDestination(repo: RepoConfig, opts: CheckOptions): CheckDestination | null {
  if (opts.remoteUrl === undefined || opts.remoteUrl.trim() === "") return null;
  const parsed = parseRemoteUrl(opts.remoteUrl);
  if (parsed === null) return null;

  const ref = refLabel(opts);
  // The pushing repository's declaration describes the destination only when
  // the destination IS its origin. A push to any other URL (`git push
  // git@github.com:o/other.git main`) must be judged by `o/other`'s own
  // declaration, which this machine may hold in another checkout.
  recordWorkingTree(repo.cwd);
  const ownUrl = getRemoteUrl(repo.cwd);
  const own = ownUrl === null ? null : parseRemoteUrl(ownUrl);
  const isOwn = own !== null && own.org === parsed.org && own.repo === parsed.repo;
  let visibility = readCachedVisibility(repo.cwd);
  let cls = repo.class;
  let publicFacing = isPublicFacing(repo, { visibility });
  let declaredBy: CheckDestination["declaredBy"] = isOwn ? "origin" : "none";
  const registry = registryForBoundary();
  if (!isOwn) {
    const cached = resolveCachedDestination(parsed.org, parsed.repo);
    if (cached !== null) {
      visibility = cached.visibility;
      cls = cached.class;
      publicFacing = cached.class === "public-eligible" || cached.visibility === "public";
      declaredBy = "cache";
    } else if ((registry?.personalOrgs ?? []).some(o => o.toLowerCase() === parsed.org)) {
      // Nothing describes it, but it is in the operator's own org — where the
      // public repositories live. Same rule as the egress policy: treated as
      // public-facing, so the human-presence gate below applies rather than
      // an unknown destination slipping through.
      visibility = "unknown";
      cls = "private-strict";
      publicFacing = true;
    }
  }
  const dest: CheckDestination = {
    org: parsed.org,
    repo: parsed.repo,
    visibility,
    class: cls,
    publicFacing,
    declaredBy,
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
      auditRefusal("CROSS_ORG_PUSH", repo, dest, ref);
      emitError(
        {
          code: "CROSS_ORG_PUSH",
          error:
            `refusing to push ${ref} to ${parsed.org}/${parsed.repo}: this repo's trust boundary ` +
            `is ${boundaryOrgs.join(", ")} and does not include ${parsed.org}. ` +
            `Push to a remote inside the boundary, or classify this repo so the boundary is right.`,
          details: {
            destination: `${parsed.org}/${parsed.repo}`,
            ref,
            boundaryOrgs,
          },
        },
        opts,
      );
    }
  }

  // --- PUBLIC_PUSH_NEEDS_HUMAN --------------------------------------------
  // `isHumanPresent` tests stderr's TTY. stdin is git's ref list on this path
  // and is never the signal. A live approval minted at a terminal for this
  // destination (and ref, when scoped) stands in for the person.
  const approval = dest.publicFacing && !isHumanPresent() ? findApproval(parsed, opts.pushRef) : null;
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
  if (dest.publicFacing && !isHumanPresent() && approval === null) {
    auditRefusal("PUBLIC_PUSH_NEEDS_HUMAN", repo, dest, ref);
    emitError(
      {
        code: "PUBLIC_PUSH_NEEDS_HUMAN",
        error:
          `refusing to push ${ref} to ${parsed.org}/${parsed.repo} ` +
          `(${visibility}, ${cls}) with no human present: ` +
          `run it from a terminal, mint an approval first (\`repo-aegis approve ${parsed.org}/${parsed.repo}\`), ` +
          `or a human sets ${EGRESS_HUMAN_ENV}=1 for this one invocation (an agent never sets it).`,
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

  // --- the git-native receipt ---------------------------------------------
  // One line, on stderr, so it rides out with git's own output and lands in
  // the agent's tool result. A model skims twenty lines of git output; it does
  // not skim one line naming a repository it did not intend.
  process.stderr.write(
    `repo-aegis: pushing ${ref} → ${parsed.org}/${parsed.repo} (${visibility})\n`,
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
