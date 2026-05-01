import {
  readRepoConfig,
  computeDenySet,
  scanFile,
  scanStagedDiff,
  CustomerCoupledNoEngagementError,
  type ScanHit,
  type SkippedFile,
  type RepoJson,
  EXIT_HIT,
  EXIT_USAGE,
} from "@de-otio/repo-aegis-core";
import { emitJson, emitText, emitError, shouldRevealMatches } from "../format.js";

interface CheckOptions {
  staged?: boolean;
  path?: string;
  maxFileBytes?: number;
  json?: boolean;
  verbose?: boolean;
}

export function check(opts: CheckOptions): void {
  // Validate flags FIRST, before any other state inspection. Design contract
  // (v2 § Locked decisions): "Errors with exit 2. Exactly one of --staged,
  // --path, --range, --history must be specified."
  const modes = [opts.staged, !!opts.path].filter(Boolean).length;
  if (modes !== 1) {
    emitError(
      { code: "USAGE", error: "specify exactly one of --staged or --path <path>" },
      opts,
    );
  }

  const repo = readRepoConfig();

  // Class enforcement: customer-coupled requires engagement to be set.
  // Hard error, not silent skip — defending the multi-customer scoping
  // pattern from misconfiguration.
  if (repo.isGitRepo && repo.class === "customer-coupled" && repo.engagements.length === 0) {
    const err = new CustomerCoupledNoEngagementError();
    emitError({ code: err.code, error: err.message }, opts);
  }

  const denySet = computeDenySet(repo);
  const reveal = shouldRevealMatches(opts);
  const scanOpts = { revealMatches: reveal, maxFileBytes: opts.maxFileBytes ?? undefined };

  if (denySet.combinedRegex === "") {
    if (opts.json) emitJson({ hits: [], skipped: [], status: "no-deny-set", warnings: denySet.warnings });
    else emitText("repo-aegis: no deny set (marker dir empty or all engagements allowed here)");
    return;
  }

  let hits: ScanHit[] = [];
  let skipped: SkippedFile[] = [];

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
    hits,
    skipped,
    repo: repoJson,
    denySet: { files: denySet.files.map(f => f.stem), patternCount: denySet.patterns.length },
    advisory,
    warnings: denySet.warnings,
  };

  if (opts.json) {
    emitJson(result);
  } else if (hits.length === 0) {
    emitText(`repo-aegis: clean (${denySet.patterns.length} patterns checked)`);
    if (skipped.length > 0) {
      emitText(`  skipped: ${skipped.length} file(s) (${skipped.map(s => s.reason).join(", ")})`);
    }
  } else {
    emitText(`repo-aegis: ${hits.length} marker hit${hits.length === 1 ? "" : "s"}${advisory ? " (advisory)" : ""}`);
    for (const h of hits) {
      emitText(`  ${h.path ?? "<staged>"}:${h.line}:${h.column}  ${h.matchPreview}`);
    }
    if (skipped.length > 0) {
      emitText(`  skipped: ${skipped.length} file(s)`);
    }
    for (const w of denySet.warnings) emitText(`  warning: ${w}`);
  }

  if (hits.length > 0 && !advisory) process.exit(EXIT_HIT);
}
