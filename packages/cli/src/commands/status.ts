import {
  loadRegistry,
  readRepoConfig,
  computeDenySet,
  isActive,
  RegistryNotFoundError,
  type RepoJson,
  type EngagementJson,
} from "@de-otio/repo-aegis-core";
import { emitJson, emitText, emitError, type OutputOptions } from "../format.js";

export function status(opts: OutputOptions): void {
  const repo = readRepoConfig();

  let registryEngagements: { id: string; name: string; active: boolean }[] = [];
  let alwaysBlockCount = 0;
  try {
    const reg = loadRegistry();
    registryEngagements = reg.engagements.map(e => ({
      id: e.id,
      name: e.name,
      active: isActive(e),
    }));
    alwaysBlockCount = reg.alwaysBlock.length;
  } catch (err) {
    if (!(err instanceof RegistryNotFoundError)) {
      emitError({ error: (err as Error).message }, opts);
    }
  }

  const denySet = computeDenySet(repo);
  const allowed: EngagementJson[] = repo.engagements.map(id => {
    const meta = registryEngagements.find(e => e.id === id);
    return { id, name: meta?.name ?? id, active: meta?.active ?? false };
  });
  const denying = denySet.files.map(f => f.stem);

  const repoJson: RepoJson = {
    cwd: repo.cwd,
    isGitRepo: repo.isGitRepo,
    class: repo.class,
    classExplicit: repo.classExplicit,
    engagements: repo.engagements,
  };

  const result = {
    repo: repoJson,
    allowedEngagements: allowed,
    denySet: {
      files: denying,
      patternCount: denySet.patterns.length,
    },
    alwaysBlock: { patternCount: alwaysBlockCount },
    warnings: denySet.warnings,
    // leakContextMode: planned for v0.2 (context on/off command)
  };

  if (opts.json) {
    emitJson(result);
    return;
  }
  if (!repo.isGitRepo) {
    emitText("repo-aegis status: not inside a git repository");
    return;
  }
  emitText(`repo-aegis status: ${repo.cwd}`);
  emitText(`  class:    ${repo.class}${repo.classExplicit ? "" : " (default; not set)"}`);
  emitText(
    `  allowed:  ${
      allowed.length === 0
        ? "(none)"
        : allowed.map(a => `${a.id}${a.name !== a.id ? ` (${a.name})` : ""}`).join(", ")
    }`,
  );
  emitText(`  blocked:  ${denying.length === 0 ? "(none — marker dir empty)" : denying.join(", ")}`);
  emitText(`  patterns: ${denySet.patterns.length} active (+ ${alwaysBlockCount} always-block)`);
  for (const w of denySet.warnings) emitText(`  warning:  ${w}`);
}
