import {
  readRepoConfig,
  computeDenySet,
  scanFile,
  scanStagedDiff,
  scanRange,
  scanHistory,
  CustomerCoupledNoEngagementError,
  type ScanHit,
  type SkippedFile,
  type RepoJson,
  type HistoryHit,
  EXIT_HIT,
} from "@de-otio/repo-aegis-core";
import { emitJson, emitText, emitError, shouldRevealMatches } from "../format.js";

interface CheckOptions {
  staged?: boolean;
  path?: string;
  range?: string;
  history?: boolean;
  maxFileBytes?: number;
  ignoreAllowlistComments?: boolean;
  json?: boolean;
  verbose?: boolean;
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

  if (denySet.combinedRegex === "") {
    if (opts.json) emitJson({ hits: [], skipped: [], status: "no-deny-set", warnings: denySet.warnings });
    else emitText("repo-aegis: no deny set (marker dir empty or all engagements allowed here)");
    return;
  }

  let hits: ScanHit[] = [];
  let skipped: SkippedFile[] = [];
  let historyHits: HistoryHit[] = [];
  let mode: "staged" | "path" | "range" | "history" = "staged";

  if (opts.staged) {
    mode = "staged";
    if (!repo.isGitRepo) {
      emitError({ code: "NOT_GIT_REPO", error: "not a git repo; --staged requires a git repo" }, opts);
    }
    const r = scanStagedDiff(repo, denySet, scanOpts);
    hits = r.hits;
    skipped = r.skipped;
  } else if (opts.path) {
    mode = "path";
    try {
      const r = scanFile(opts.path, denySet, scanOpts, repo.isGitRepo ? repo.cwd : undefined);
      hits = r.hits;
      skipped = r.skipped;
    } catch (err) {
      emitError({ error: (err as Error).message }, opts);
    }
  } else if (opts.range) {
    mode = "range";
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
    mode = "history";
    if (!repo.isGitRepo) {
      emitError({ code: "NOT_GIT_REPO", error: "not a git repo; --history requires a git repo" }, opts);
    }
    historyHits = scanHistory(repo, denySet, scanOpts);
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
    repo: repoJson,
    denySet: { files: denySet.files.map(f => f.stem), patternCount: denySet.patterns.length },
    advisory,
    warnings: denySet.warnings,
  };

  const totalHits = hits.length + historyHits.length;

  if (opts.json) {
    emitJson(result);
  } else if (totalHits === 0) {
    emitText(`repo-aegis: clean (${denySet.patterns.length} patterns checked)`);
    if (skipped.length > 0) {
      emitText(`  skipped: ${skipped.length} file(s) (${skipped.map(s => s.reason).join(", ")})`);
    }
  } else {
    if (hits.length > 0) {
      emitText(`repo-aegis: ${hits.length} marker hit${hits.length === 1 ? "" : "s"}${advisory ? " (advisory)" : ""}`);
      for (const h of hits) {
        emitText(`  ${h.path ?? "<staged>"}:${h.line}:${h.column}  ${h.matchPreview}`);
      }
    }
    if (historyHits.length > 0) {
      emitText(`repo-aegis: ${historyHits.length} historical hit${historyHits.length === 1 ? "" : "s"} across the git log`);
      for (const h of historyHits) {
        emitText(`  ${h.commitSha}  ${h.pattern}  ${h.commitSummary}`);
      }
    }
    if (skipped.length > 0) {
      emitText(`  skipped: ${skipped.length} file(s)`);
    }
    for (const w of denySet.warnings) emitText(`  warning: ${w}`);
  }

  if (totalHits > 0 && !advisory) process.exit(EXIT_HIT);
}
