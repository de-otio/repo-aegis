import {
  loadRegistry,
  resolveEngagement,
  readRepoConfig,
  addEngagements,
  isActive,
  RegistryNotFoundError,
  NotAGitRepoError,
  type Engagement,
  type RepoJson,
  type EngagementJson,
} from "@de-otio/repo-aegis-core";
import { emitJson, emitText, emitError, type OutputOptions } from "../format.js";

interface AllowResult {
  engagement: EngagementJson;
  added: boolean;
  reason?: string;
}

export function allow(queries: string[], opts: OutputOptions): void {
  if (queries.length === 0) {
    emitError({ error: "allow requires at least one engagement argument" }, opts);
  }

  let registry;
  try {
    registry = loadRegistry();
  } catch (err) {
    if (err instanceof RegistryNotFoundError) {
      emitError(
        {
          code: "REGISTRY_NOT_FOUND",
          error: "engagement registry not found",
          details: `expected at ${err.path}; create it before using repo-aegis allow`,
        },
        opts,
      );
    }
    emitError({ error: (err as Error).message }, opts);
  }

  const resolved: Engagement[] = [];
  for (const q of queries) {
    const { match, candidates } = resolveEngagement(registry, q);
    if (!match) {
      emitError(
        candidates.length > 1
          ? {
              code: "AMBIGUOUS_QUERY",
              error: `ambiguous engagement query "${q}"`,
              details: "run `repo-aegis engagements list` to see options",
            }
          : {
              code: "ENGAGEMENT_NOT_FOUND",
              error: `no engagement matches "${q}"`,
              details: "run `repo-aegis engagements list` to see options",
            },
        opts,
      );
    }
    resolved.push(match);
  }

  const repoBefore = readRepoConfig();
  if (!repoBefore.isGitRepo) {
    emitError({ code: "NOT_GIT_REPO", error: "not inside a git repository" }, opts);
  }

  const beforeSet = new Set(repoBefore.engagements);
  let addedIds: string[];
  try {
    addedIds = addEngagements(
      resolved.map(e => e.id),
      repoBefore.cwd,
    );
  } catch (err) {
    if (err instanceof NotAGitRepoError) emitError({ error: err.message }, opts);
    emitError({ error: (err as Error).message }, opts);
  }

  const addedSet = new Set(addedIds);
  const results: AllowResult[] = resolved.map(e => {
    const j: EngagementJson = { id: e.id, name: e.name, active: isActive(e) };
    return addedSet.has(e.id)
      ? { engagement: j, added: true }
      : { engagement: j, added: false, reason: beforeSet.has(e.id) ? "already-allowed" : "duplicate-in-args" };
  });

  const repoJson: RepoJson = {
    cwd: repoBefore.cwd,
    isGitRepo: repoBefore.isGitRepo,
    class: repoBefore.class,
    classExplicit: repoBefore.classExplicit,
    engagements: [...repoBefore.engagements, ...addedIds],
  };

  if (opts.json) {
    emitJson({ action: "allow", results, repo: repoJson });
    return;
  }

  for (const r of results) {
    if (r.added) {
      emitText(`repo-aegis: now allowing ${r.engagement.id} (${r.engagement.name})`);
    } else {
      emitText(`repo-aegis: ${r.engagement.id} (${r.engagement.name}) was already allowed`);
    }
  }
  emitText(`  class:   ${repoJson.class}`);
  emitText(`  allowed: ${repoJson.engagements.join(", ") || "(none)"}`);
}
