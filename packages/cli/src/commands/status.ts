// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import {
  loadRegistry,
  readRepoConfig,
  computeDenySet,
  isActive,
  getRegexBackend,
  isPublicFacing,
  resolveHookState,
  appendAuditRecord,
  RegistryNotFoundError,
  type RepoJson,
  type EngagementJson,
  type HookState,
  type HookName,
  type HookScriptState,
} from "@de-otio/repo-aegis-core";
import { emitJson, emitText, emitError, type OutputOptions } from "../format.js";
import { resolveVisibility } from "../visibility.js";

// Same 10-char label field the other `  key:    value` lines below use
// (2-space indent + label + colon padded to column 10), so continuation
// lines for a multi-line hooks failure line up under the value column.
const HOOKS_LABEL = "  hooks:    ";
const HOOKS_CONT = "            ";

function scriptNames(hooks: HookState, pred: (s: HookScriptState) => boolean): string[] {
  return (Object.keys(hooks.scripts) as HookName[]).filter(n => pred(hooks.scripts[n]));
}

/**
 * Builds the text-mode lines for the `hooks:` status line. Returns a
 * ready-to-emit array (one `emitText` call per entry) rather than a
 * single string with embedded newlines, matching how the rest of this
 * command emits multi-line output.
 *
 * A hook that never runs cannot report itself — that's the whole
 * reason this exists (see hooks-state.ts) — so this line has to read
 * as a failure, not a warning, whenever `code !== HOOKS_OK`.
 */
function hooksStatusLines(hooks: HookState): string[] {
  if (hooks.code === "HOOKS_OK") {
    const lines = [`${HOOKS_LABEL}OK — pre-commit/pre-push active (${hooks.origin} core.hooksPath)`];
    // Only the hooks we do not chain are actually lost; a displaced
    // pre-commit/pre-push still runs via the chain in the generated script.
    if (hooks.bypassedRepoHooks.length > 0) {
      lines.push(
        `  warning:  ${hooks.bypassedRepoHooks.length} repo-local hook script(s) will never run ` +
          `(shadowed by core.hooksPath): ${hooks.bypassedRepoHooks.join(", ")}`,
      );
    }
    return lines;
  }

  const expected = `expected ${hooks.expectedPath}`;
  switch (hooks.code) {
    case "HOOKS_PATH_UNSET":
      return [
        `${HOOKS_LABEL}FAIL — core.hooksPath is unset; hooks were never installed,`,
        `${HOOKS_CONT}${expected}.`,
        `${HOOKS_CONT}fix: ${hooks.fix}`,
      ];
    case "HOOKS_PATH_FOREIGN":
      return [
        `${HOOKS_LABEL}FAIL — core.hooksPath is ${hooks.effectivePath} (foreign path),`,
        `${HOOKS_CONT}${expected}.`,
        `${HOOKS_CONT}fix: ${hooks.fix}`,
      ];
    case "HOOKS_PATH_LOCAL_OVERRIDE":
      return [
        `${HOOKS_LABEL}FAIL — core.hooksPath is ${hooks.effectivePath} (local override),`,
        `${HOOKS_CONT}${expected}, which is correctly set globally but shadowed here.`,
        `${HOOKS_CONT}fix: ${hooks.fix}`,
      ];
    case "HOOKS_SCRIPT_MISSING":
      return [
        `${HOOKS_LABEL}FAIL — missing hook script(s) at ${hooks.effectivePath}: ` +
          `${scriptNames(hooks, s => !s.present).join(", ")}.`,
        `${HOOKS_CONT}fix: ${hooks.fix}`,
      ];
    case "HOOKS_SCRIPT_NOT_EXECUTABLE":
      return [
        `${HOOKS_LABEL}FAIL — non-executable hook script(s) at ${hooks.effectivePath}: ` +
          `${scriptNames(hooks, s => !s.executable).join(", ")}.`,
        `${HOOKS_CONT}fix: ${hooks.fix}`,
      ];
    case "HOOKS_SCRIPT_STALE":
      return [
        `${HOOKS_LABEL}FAIL — stale hook script(s) (older than the installed version) at ` +
          `${hooks.effectivePath}: ${scriptNames(hooks, s => !s.current).join(", ")}.`,
        `${HOOKS_CONT}fix: ${hooks.fix}`,
      ];
    default:
      // Exhaustiveness guard: HookStateCode is a closed union: if a new
      // code is added upstream without updating this switch, fail loud
      // in text mode rather than silently printing nothing.
      return [`${HOOKS_LABEL}FAIL — unrecognised hook state code ${hooks.code as string}`];
  }
}

export function status(opts: OutputOptions & { cwd?: string }): void {
  // `--cwd` is documented as applying to every subcommand uniformly (design
  // README, "Universal CLI flags"). This previously ignored it and reported
  // the process cwd's repo instead.
  const repo = readRepoConfig(opts.cwd);

  let registryEngagements: {
    id: string;
    name: string;
    active: boolean;
    markerCount: number;
  }[] = [];
  let alwaysBlockCount = 0;
  try {
    const reg = loadRegistry();
    registryEngagements = reg.engagements.map(e => ({
      id: e.id,
      name: e.name,
      active: isActive(e),
      markerCount: e.markers.length,
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

  // [SEC H-5] follow-up: surface engagements that have zero markers so
  // the user knows to run suggest-markers (or hand-add markers).
  // Active-only — ended engagements with retained markers don't count.
  const zeroMarkerEngagements = registryEngagements
    .filter(e => e.active && e.markerCount === 0)
    .map(e => e.id);

  // GitHub visibility drives the egress-hygiene gate. Refresh the cache
  // best-effort (a `gh` probe; no-op when gh/remote absent) so audit's
  // reconciliation check and the egress gate read a current value.
  const visibility = repo.isGitRepo ? resolveVisibility(repo.cwd) : "unknown";
  const publicFacing = isPublicFacing(repo, { visibility });

  // H1/H2: a repo-local core.hooksPath pointing at an empty (or foreign)
  // directory silently disables scanning, and a hook that never runs
  // can't report itself — so `status` reads it directly instead of
  // relying on hook output. `resolveHookState` already returns a
  // well-formed (isGitRepo: false) placeholder outside a git repo, so
  // it's safe to call unconditionally and include verbatim in JSON.
  const hooks = resolveHookState(repo.cwd);

  // H6: best-effort audit-log record of the observed hook state so a
  // regression gets a timestamp when audit-log is enabled. Off by
  // default; never breaks a user-facing command. Structural metadata
  // only (code + ok) — no marker content, no paths beyond what's
  // already in `hooks`.
  try {
    appendAuditRecord({
      action: "observe-hooks",
      cwd: repo.cwd,
      repo: repo.cwd,
      details: { code: hooks.code, ok: hooks.ok },
    });
  } catch {
    /* audit log must not break user-facing ops */
  }

  const repoJson: RepoJson = {
    cwd: repo.cwd,
    isGitRepo: repo.isGitRepo,
    class: repo.class,
    classExplicit: repo.classExplicit,
    engagements: repo.engagements,
  };

  const result = {
    repo: repoJson,
    visibility,
    publicFacing,
    allowedEngagements: allowed,
    denySet: {
      files: denying,
      patternCount: denySet.patterns.length,
    },
    alwaysBlock: { patternCount: alwaysBlockCount },
    regexBackend: getRegexBackend(),
    zeroMarkerEngagements,
    warnings: denySet.warnings,
    hooks,
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
    `  github:   ${visibility}${publicFacing ? " — egress-hygiene enforced" : ""}` +
      `${visibility === "public" && repo.class !== "public-eligible" ? " (consider class=public-eligible)" : ""}`,
  );
  emitText(
    `  allowed:  ${
      allowed.length === 0
        ? "(none)"
        : allowed.map(a => `${a.id}${a.name !== a.id ? ` (${a.name})` : ""}`).join(", ")
    }`,
  );
  emitText(`  blocked:  ${denying.length === 0 ? "(none — marker dir empty)" : denying.join(", ")}`);
  emitText(`  patterns: ${denySet.patterns.length} active (+ ${alwaysBlockCount} always-block)`);
  emitText(`  regex:    ${getRegexBackend()}`);
  for (const line of hooksStatusLines(hooks)) emitText(line);
  if (zeroMarkerEngagements.length > 0) {
    emitText(
      `  warning:  ${zeroMarkerEngagements.length} engagement(s) with 0 markers: ${zeroMarkerEngagements.join(", ")}`,
    );
    emitText(
      `            run \`repo-aegis suggest-markers --engagement <id> --from <repo>\` to populate`,
    );
  }
  for (const w of denySet.warnings) emitText(`  warning:  ${w}`);
}
