// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  readRepoConfig,
  computeDenySet,
  scanFile,
  scanStagedDiff,
  scanRange,
  scanNewRef,
  resolveNewRefBase,
  scanHistory,
  scanRegistryEgress,
  isEgressRelevant,
  isPublicFacing,
  loadEgressPolicy,
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
  type ScanHit,
  type SkippedFile,
  type RepoJson,
  type HistoryHit,
  type RegistryFinding,
  type RepoConfig,
  type NewRefBase,
  type Waiver,
  EXIT_HIT,
} from "@de-otio/repo-aegis-core";
import { emitJson, emitText, emitError, shouldRevealMatches } from "../format.js";

interface CheckOptions {
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
    if (!isEgressRelevant(opts.path)) return out;
    const abs = isAbsolute(opts.path) ? opts.path : join(repo.cwd, opts.path);
    if (!existsSync(abs)) return out;
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

  const denySet = computeDenySet(repo);
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
      emitJson({ hits: [], skipped: [], egress: [], status: "no-deny-set", warnings: denySet.warnings });
    } else {
      emitText("repo-aegis: no deny set (marker dir empty or all engagements allowed here)");
    }
    return;
  }

  let hits: ScanHit[] = [];
  let skipped: SkippedFile[] = [];
  let historyHits: HistoryHit[] = [];

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
      try {
        const r = scanFile(opts.path, denySet, scanOpts, repo.isGitRepo ? repo.cwd : undefined);
        hits = r.hits;
        skipped = r.skipped;
      } catch (err) {
        emitError({ error: (err as Error).message }, opts);
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
    engagements: repo.engagements,
  };

  const result = {
    mode,
    // Only --push-ref resolves a range mode; omitting the key elsewhere keeps
    // the envelope of the other four modes byte-identical to before.
    ...(newRef !== undefined && {
      rangeMode: newRef.mode,
      ...(newRef.base !== undefined && { base: newRef.base }),
    }),
    hits,
    historyHits: historyHitsJson,
    skipped,
    egress,
    repo: repoJson,
    denySet: { files: denySet.files.map(f => f.stem), patternCount: denySet.patterns.length },
    advisory,
    warnings: denySet.warnings,
    // CONTROL 3: always present, even when empty — never a silent filter.
    waived: waivedHits,
    expiredWaivers: expired.map(w => ({ pattern: w.pattern, blob: w.blob, expires: w.expires })),
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
          const eng = h.engagement ? ` [${h.engagement}]` : "";
          emitText(`  ${h.path ?? "<staged>"}:${h.line}:${h.column}  ${h.matchPreview}${eng}`);
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
