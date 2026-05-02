// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import {
  loadRegistry,
  resolveEngagement,
  readRepoConfig,
  removeEngagement,
  isActive,
  RegistryNotFoundError,
  NotAGitRepoError,
  appendAuditRecord,
  type Engagement,
  type RepoJson,
  type EngagementJson,
} from "@de-otio/repo-aegis-core";
import { emitJson, emitText, emitError, type OutputOptions } from "../format.js";

interface DenyResult {
  engagement: EngagementJson;
  removed: boolean;
  wasAllowed: boolean;
}

export function deny(queries: string[], opts: OutputOptions): void {
  if (queries.length === 0) {
    emitError({ error: "deny requires at least one engagement argument" }, opts);
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
          details: `expected at ${err.path}`,
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
  const results: DenyResult[] = [];
  for (const e of resolved) {
    const wasAllowed = beforeSet.has(e.id);
    let removed = false;
    if (wasAllowed) {
      try {
        removed = removeEngagement(e.id, repoBefore.cwd);
      } catch (err) {
        if (err instanceof NotAGitRepoError) emitError({ error: err.message }, opts);
        emitError({ error: (err as Error).message }, opts);
      }
    }
    results.push({
      engagement: { id: e.id, name: e.name, active: isActive(e) },
      removed,
      wasAllowed,
    });
  }

  const remaining = repoBefore.engagements.filter(id => !results.some(r => r.removed && r.engagement.id === id));

  const repoJson: RepoJson = {
    cwd: repoBefore.cwd,
    isGitRepo: repoBefore.isGitRepo,
    class: repoBefore.class,
    classExplicit: repoBefore.classExplicit,
    engagements: remaining,
  };

  // Audit log (best-effort). Emit AFTER persistence; record the ids
  // actually removed (skip no-ops) so the trail reflects state change.
  const removedIds = results.filter(r => r.removed).map(r => r.engagement.id);
  if (removedIds.length > 0) {
    try {
      appendAuditRecord({
        action: "deny",
        cwd: repoBefore.cwd,
        repo: repoBefore.cwd,
        engagements: removedIds,
        details: { class: repoBefore.class },
      });
    } catch {
      /* audit log must not break user-facing ops */
    }
  }

  if (opts.json) {
    emitJson({ action: "deny", results, repo: repoJson });
    return;
  }

  for (const r of results) {
    if (r.removed) {
      emitText(`repo-aegis: stopped allowing ${r.engagement.id} (${r.engagement.name})`);
    } else {
      emitText(`repo-aegis: ${r.engagement.id} was not currently allowed`);
    }
  }
  emitText(`  allowed: ${repoJson.engagements.length === 0 ? "(none)" : repoJson.engagements.join(", ")}`);
}
