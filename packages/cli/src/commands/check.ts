// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  readRepoConfig,
  computeDenySet,
  scanFile,
  scanStagedDiff,
  scanRange,
  scanHistory,
  scanRegistryEgress,
  isEgressRelevant,
  isPublicFacing,
  loadEgressPolicy,
  CustomerCoupledNoEngagementError,
  type ScanHit,
  type SkippedFile,
  type RepoJson,
  type HistoryHit,
  type RegistryFinding,
  type RepoConfig,
  EXIT_HIT,
} from "@de-otio/repo-aegis-core";
import { emitJson, emitText, emitError, shouldRevealMatches } from "../format.js";

interface CheckOptions {
  staged?: boolean;
  path?: string;
  range?: string;
  history?: boolean;
  /** With --history, only scan commits reachable from this revspec. */
  since?: string;
  maxFileBytes?: number;
  ignoreAllowlistComments?: boolean;
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

/** The "tip" ref of a diff range (`A..B` / `A...B` → `B`; bare ref → itself). */
function rangeTip(range: string): string {
  const parts = range.split(/\.{2,3}/);
  const tip = parts[parts.length - 1]?.trim();
  return tip && tip !== "" ? tip : range.trim();
}

/**
 * Gather the egress-relevant files (lockfiles / .npmrc) in scope for this run,
 * reading the bytes that will actually land:
 *   --staged → the staged blob (`git show :path`), not the working tree;
 *   --range  → the file at the range tip (`git show <tip>:path`);
 *   --path   → the working-tree file, when it is itself egress-relevant.
 * --history is out of scope (egress is a present-state policy).
 */
function gatherEgressInputs(
  repo: RepoConfig,
  opts: CheckOptions,
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

  if (opts.range) {
    const tip = rangeTip(opts.range);
    const names = git(repo.cwd, ["diff", "--name-only", "--diff-filter=ACMR", opts.range]);
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
  // --history must be specified.
  const modes = [opts.staged, !!opts.path, !!opts.range, !!opts.history].filter(Boolean).length;
  if (modes !== 1) {
    emitError(
      {
        code: "USAGE",
        error: "specify exactly one of --staged, --path <path>, --range <revspec>, or --history",
      },
      opts,
    );
  }

  const repo = readRepoConfig();

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

  // Egress hygiene runs independently of the marker deny set: a private-registry
  // URL in a lockfile / .npmrc is not a customer marker, and must be caught even
  // when this repo has no deny set. It applies only to public-facing repos and
  // not in --history mode (egress is a present-state policy).
  const egress: RegistryFinding[] =
    !opts.history && isPublicFacing(repo)
      ? scanRegistryEgress(gatherEgressInputs(repo, opts), loadEgressPolicy())
      : [];

  const hasDenySet = denySet.combinedRegex !== "";
  const mode: "staged" | "path" | "range" | "history" = opts.path
    ? "path"
    : opts.range
      ? "range"
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
      const r = scanStagedDiff(repo, denySet, scanOpts);
      hits = r.hits;
      skipped = r.skipped;
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
        emitError(
          { code: "GIT_ERROR", error: `git diff ${opts.range} failed: ${(err as Error).message}` },
          opts,
        );
      }
    } else if (opts.history) {
      if (!repo.isGitRepo) {
        emitError({ code: "NOT_GIT_REPO", error: "not a git repo; --history requires a git repo" }, opts);
      }
      historyHits = scanHistory(repo, denySet, {
        ...scanOpts,
        ...(opts.since !== undefined && { since: opts.since }),
      });
    }
  }

  const advisory = repo.class === "scratch";

  const repoJson: RepoJson = {
    cwd: repo.cwd,
    isGitRepo: repo.isGitRepo,
    class: repo.class,
    classExplicit: repo.classExplicit,
    engagements: repo.engagements,
  };

  const result = {
    mode,
    hits,
    historyHits,
    skipped,
    egress,
    repo: repoJson,
    denySet: { files: denySet.files.map(f => f.stem), patternCount: denySet.patterns.length },
    advisory,
    warnings: denySet.warnings,
  };

  const totalHits = hits.length + historyHits.length;

  if (opts.json) {
    emitJson(result);
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
    if (historyHits.length > 0) {
      emitText(`repo-aegis: ${historyHits.length} historical hit${historyHits.length === 1 ? "" : "s"} across the git log`);
      for (const h of historyHits) {
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

  if ((totalHits > 0 || egress.length > 0) && !advisory) process.exit(EXIT_HIT);
}
