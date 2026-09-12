// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `repo-aegis scan-env` — discover this machine's private package-registry
// hosts from the developer's toolchain configs and offer them as markers.
//
// Companion to the egress check: `check`/`audit` catch a private host once it
// has reached a lockfile; this catches the configuration that puts it there.
// Explicitly invoked — never on the gate path — and **dry-run by default**, so
// it can never mutate the deny set as a side effect of being curious.
//
// Security posture:
//   - Hosts only. The parsers never read an auth token, and nothing here
//     persists a credential (see `core/env-scan.ts`).
//   - Nothing is written without an explicit `--accept <placement>`.
//
// `--self` scans the inverse direction. The default mode asks "what private
// infrastructure does this machine talk to?", which protects a public repo
// from our hosts. `--self` asks "what is this operator called?" — their orgs,
// their package names, the shape of an agent session link — which protects a
// *customer's* repo from our identity. Same discovery-then-offer discipline,
// same dry-run default, different reserved stem and the opposite class gate.

import { homedir } from "node:os";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  loadRegistry,
  defaultEnvSources,
  scanEnvSources,
  hostToMarkerPattern,
  addTopLevelPatterns,
  addMarkerPatterns,
  appendAuditRecord,
  MIN_ENV_HOST_LENGTH,
  SELF_IDENTITY_FILE_STEM,
  EngagementNotFoundError,
  PatternValidationError,
  type EnvHostFinding,
} from "@de-otio/repo-aegis-core";
import { emitJson, emitText, emitError, type OutputOptions } from "../format.js";

/**
 * Where an accepted host should be recorded.
 *
 * `private-infra` is the default recommendation: a machine's registry host is
 * usually not attributable to one engagement, and it is legitimate in private
 * repos — so blocking it everywhere (`always-block`) would fire constantly in
 * exactly the repos where it belongs.
 */
export type ScanEnvPlacement = "private-infra" | "always-block" | "engagement";

export interface ScanEnvOptions extends OutputOptions {
  /** Persist accepted hosts to this placement. Omit for a dry run. */
  accept?: string;
  /**
   * Offer the operator's own identity as `selfIdentity` candidates instead of
   * scanning toolchain configs for private-registry hosts. Accepts only
   * `--accept self-identity`.
   */
  self?: boolean;
  /** Engagement id — required when `--accept engagement`. */
  engagement?: string;
  /**
   * Override the home dir whose dotfiles are scanned. Deliberately NOT named
   * `home`: `--home` is a reserved global that repoints REPO_AEGIS_HOME, and
   * reusing it here silently redirected the registry.
   */
  scanHome?: string;
  /** Also scan project-level configs under this dir. Default: cwd. */
  from?: string;
  /** Override registry path; passed through to the mutators (tests). */
  registryPath?: string;
}

const PLACEMENTS: readonly ScanEnvPlacement[] = [
  "private-infra",
  "always-block",
  "engagement",
];

/** The only `--accept` value `--self` recognises. */
export const SELF_PLACEMENT = "self-identity";

interface Candidate {
  finding: EnvHostFinding;
  pattern: string;
}

export function scanEnv(opts: ScanEnvOptions): void {
  if (opts.self === true) {
    scanSelfIdentity(opts);
    return;
  }
  const placement = opts.accept as ScanEnvPlacement | undefined;
  if (placement !== undefined && !PLACEMENTS.includes(placement)) {
    emitError(
      {
        code: "USAGE",
        error: `--accept must be one of: ${PLACEMENTS.join(", ")}`,
      },
      opts,
    );
  }
  if (placement === "engagement" && !opts.engagement) {
    emitError(
      { code: "USAGE", error: "--accept engagement requires --engagement <id>" },
      opts,
    );
  }

  const home = opts.scanHome ?? homedir();
  const cwd = opts.from ?? process.cwd();
  const { hosts, scanned, publicHostCount } = scanEnvSources(
    defaultEnvSources(home, cwd),
  );

  // Hosts too short to be safe as substring literals are dropped, not offered.
  const candidates: Candidate[] = [];
  const tooShort: string[] = [];
  for (const finding of hosts) {
    const pattern = hostToMarkerPattern(finding.host);
    if (pattern === null) {
      tooShort.push(finding.host);
      continue;
    }
    candidates.push({ finding, pattern });
  }

  if (candidates.length === 0) {
    if (opts.json) {
      emitJson({
        action: "scan-env",
        scanned,
        candidates: [],
        accepted: [],
        publicHostsFiltered: publicHostCount,
        tooShort,
      });
      return;
    }
    emitText(
      scanned.length === 0
        ? "scan-env: no toolchain config files found"
        : `scan-env: no private-registry hosts found in ${scanned.length} config file(s)`,
    );
    return;
  }

  // Dry run (the default): show what WOULD be added, persist nothing.
  if (placement === undefined) {
    if (opts.json) {
      emitJson({
        action: "scan-env",
        dryRun: true,
        scanned,
        publicHostsFiltered: publicHostCount,
        tooShort,
        candidates: candidates.map(c => ({
          host: c.finding.host,
          source: c.finding.source,
          kind: c.finding.kind,
          field: c.finding.field,
          pattern: c.pattern,
        })),
      });
      return;
    }
    emitText(
      `scan-env: ${candidates.length} private-registry host(s) in ${scanned.length} config file(s)`,
    );
    for (const c of candidates) {
      emitText(`  ${c.finding.host}`);
      emitText(`    from ${c.finding.source} (${c.finding.field})`);
    }
    emitText("");
    emitText("nothing written (dry run). To record these, re-run with one of:");
    emitText("  --accept private-infra              blocked in public-facing repos only (recommended)");
    emitText("  --accept always-block               blocked everywhere");
    emitText("  --accept engagement --engagement <id>   scoped to one engagement");
    if (tooShort.length > 0) {
      emitText("");
      emitText(
        `note: ${tooShort.length} host(s) skipped as too short (< ${MIN_ENV_HOST_LENGTH} chars) to match safely`,
      );
    }
    return;
  }

  // Persist.
  const patterns = candidates.map(c => c.pattern);
  let result;
  try {
    result =
      placement === "engagement"
        ? addMarkerPatterns(opts.engagement!, patterns, {
            ...(opts.registryPath !== undefined && { registryPath: opts.registryPath }),
            source: "scan-env",
          })
        : addTopLevelPatterns(
            placement === "always-block" ? "always_block" : "privateInfra",
            patterns,
            {
              ...(opts.registryPath !== undefined && { registryPath: opts.registryPath }),
              source: "scan-env",
            },
          );
  } catch (err) {
    if (err instanceof EngagementNotFoundError) {
      emitError({ code: err.code, error: err.message }, opts);
    }
    if (err instanceof PatternValidationError) {
      emitError(
        { code: err.code, error: "synthesised host patterns failed validation" },
        opts,
      );
    }
    emitError({ code: "WRITE_FAILED", error: (err as Error).message }, opts);
  }

  // Audit: counts and placement only — the patterns are private hostnames.
  try {
    appendAuditRecord({
      action: "scan-env-run",
      engagement: placement === "engagement" ? opts.engagement! : placement,
      details: {
        sourcesScanned: scanned.length,
        candidateCount: candidates.length,
        addedCount: result.added.length,
        skippedCount: result.skipped.length,
      },
    });
  } catch {
    /* audit log must not break user-facing ops */
  }

  if (opts.json) {
    emitJson({
      action: "scan-env",
      placement,
      scanned,
      added: result.added,
      skippedDuplicates: result.skipped,
      rendered: result.rendered,
      publicHostsFiltered: publicHostCount,
      tooShort,
    });
    return;
  }
  emitText(
    `scan-env: recorded ${result.added.length} host pattern(s) under ${placement}` +
      (result.skipped.length > 0 ? ` (${result.skipped.length} already present)` : ""),
  );
}

// ---------------------------------------------------------------------------
// `--self`: offer the operator's own identity as `selfIdentity` candidates.
// ---------------------------------------------------------------------------

/**
 * The agent session-link shape. Offered as a fixed candidate because it is the
 * one identity string that is not discoverable from any config on the machine
 * and is pasted by reflex: a session URL in a PR body or a commit message
 * published to a customer's repository names the operator's tooling account
 * and is retrievable by anyone who reads it.
 *
 * Already a regex (the dot is escaped), so it is offered verbatim rather than
 * through {@link hostToMarkerPattern}, which would escape the backslash.
 */
export const AGENT_SESSION_LINK_PATTERN = "claude\\.ai/code/session_";

/** Directory names the package-name walk never descends into. */
const SELF_SCAN_SKIP_DIRS = new Set(["node_modules", ".git"]);

/** How deep below `--from` the walk looks for a `package.json`. */
const SELF_SCAN_DEPTH_BUDGET = 4;

interface SelfCandidate {
  /** The identity string the pattern was derived from. */
  value: string;
  /** Where it came from, for the operator to judge it by. */
  source: string;
  /** The marker pattern that would be recorded. */
  pattern: string;
}

/**
 * Every `name` declared by a `package.json` at or under `root`.
 *
 * A scoped name yields two entries — `@scope/pkg` gives `scope` and `pkg` —
 * because both halves travel independently: the scope is the operator's npm
 * org and appears in a registry URL or an import path, the bare name appears
 * in a stack trace, a lockfile entry and a README. Recording only the joined
 * form would match neither.
 *
 * `node_modules` is skipped, and not as an optimisation: a dependency's name
 * is somebody else's identity, and recording it would block the world.
 */
export function findPackageNames(
  root: string,
): Array<{ name: string; source: string }> {
  const out: Array<{ name: string; source: string }> = [];
  const seen = new Set<string>();
  const stack: Array<{ dir: string; depth: number; label: string }> = [
    { dir: root, depth: 0, label: "." },
  ];
  while (stack.length > 0) {
    const { dir, depth, label } = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    if (entries.includes("package.json")) {
      const source = `${label}/package.json`;
      try {
        const parsed: unknown = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
        const name =
          parsed !== null && typeof parsed === "object"
            ? (parsed as { name?: unknown }).name
            : undefined;
        if (typeof name === "string" && name.trim() !== "") {
          const trimmed = name.trim();
          const scoped = /^@([^/]+)\/(.+)$/.exec(trimmed);
          const parts = scoped ? [scoped[1]!, scoped[2]!] : [trimmed];
          for (const part of parts) {
            if (seen.has(part)) continue;
            seen.add(part);
            out.push({ name: part, source });
          }
        }
      } catch {
        /* an unreadable or malformed package.json is not an error here */
      }
    }
    if (depth >= SELF_SCAN_DEPTH_BUDGET) continue;
    for (const e of entries) {
      if (SELF_SCAN_SKIP_DIRS.has(e) || e.startsWith(".")) continue;
      const sub = join(dir, e);
      try {
        if (!statSync(sub).isDirectory()) continue;
      } catch {
        continue;
      }
      stack.push({ dir: sub, depth: depth + 1, label: `${label}/${e}` });
    }
  }
  return out;
}

/**
 * Collect the identity candidates. Pure apart from the two reads it is named
 * for (the registry, the tree under `from`), and neither is fatal: a machine
 * with no registry yet still gets package names and the session-link shape.
 */
function collectSelfCandidates(
  from: string,
  registryPathOverride?: string,
): { candidates: SelfCandidate[]; tooShort: string[]; registryRead: boolean } {
  const candidates: SelfCandidate[] = [];
  const tooShort: string[] = [];
  const seenPatterns = new Set<string>();

  const offer = (value: string, source: string): void => {
    const pattern = hostToMarkerPattern(value);
    if (pattern === null) {
      if (!tooShort.includes(value)) tooShort.push(value);
      return;
    }
    if (seenPatterns.has(pattern)) return;
    seenPatterns.add(pattern);
    candidates.push({ value, source, pattern });
  };

  // (a) the orgs the operator has already declared as their own.
  let registryRead = false;
  try {
    const reg =
      registryPathOverride !== undefined
        ? loadRegistry(registryPathOverride)
        : loadRegistry();
    registryRead = true;
    for (const org of reg.personalOrgs ?? []) offer(org, "registry personalOrgs");
  } catch {
    /* best-effort: no registry yet is the normal state on a fresh machine */
  }

  // (b) the names this operator ships under.
  for (const { name, source } of findPackageNames(from)) offer(name, source);

  // (c) the fixed shape.
  if (!seenPatterns.has(AGENT_SESSION_LINK_PATTERN)) {
    seenPatterns.add(AGENT_SESSION_LINK_PATTERN);
    candidates.push({
      value: AGENT_SESSION_LINK_PATTERN,
      source: "built-in (agent session link)",
      pattern: AGENT_SESSION_LINK_PATTERN,
    });
  }

  return { candidates, tooShort, registryRead };
}

function scanSelfIdentity(opts: ScanEnvOptions): void {
  if (opts.accept !== undefined && opts.accept !== SELF_PLACEMENT) {
    emitError(
      {
        code: "USAGE",
        error:
          `--self only accepts \`--accept ${SELF_PLACEMENT}\`; ` +
          `\`--accept ${opts.accept}\` records hosts, not identity`,
      },
      opts,
    );
  }
  const from = opts.from ?? process.cwd();
  const { candidates, tooShort, registryRead } = collectSelfCandidates(
    from,
    opts.registryPath,
  );

  // Dry run (the default): show what WOULD be added, persist nothing.
  if (opts.accept === undefined) {
    if (opts.json) {
      emitJson({
        action: "scan-env-self",
        dryRun: true,
        from,
        registryRead,
        candidates,
        tooShort,
      });
      return;
    }
    emitText(`scan-env --self: ${candidates.length} identity candidate(s)`);
    for (const c of candidates) {
      emitText(`  ${c.value}`);
      emitText(`    from ${c.source}`);
    }
    emitText("");
    emitText("nothing written (dry run). To record these, re-run with:");
    emitText(
      `  --accept ${SELF_PLACEMENT}            blocked in customer-coupled repos only`,
    );
    if (!registryRead) {
      emitText("");
      emitText("note: no registry could be read, so no personalOrgs were offered");
    }
    if (tooShort.length > 0) {
      emitText("");
      emitText(
        `note: ${tooShort.length} name(s) skipped as too short (< ${MIN_ENV_HOST_LENGTH} chars) to match safely`,
      );
    }
    return;
  }

  // Persist.
  let result;
  try {
    result = addTopLevelPatterns(
      "selfIdentity",
      candidates.map(c => c.pattern),
      {
        ...(opts.registryPath !== undefined && { registryPath: opts.registryPath }),
        source: "scan-env",
      },
    );
  } catch (err) {
    if (err instanceof PatternValidationError) {
      emitError(
        { code: err.code, error: "synthesised identity patterns failed validation" },
        opts,
      );
    }
    emitError({ code: "WRITE_FAILED", error: (err as Error).message }, opts);
  }

  // Audit: counts only — the patterns name the operator, and the audit log is
  // read back into agent context.
  try {
    appendAuditRecord({
      action: "scan-env-self-run",
      engagement: SELF_IDENTITY_FILE_STEM,
      details: {
        candidateCount: candidates.length,
        addedCount: result.added.length,
        skippedCount: result.skipped.length,
      },
    });
  } catch {
    /* audit log must not break user-facing ops */
  }

  if (opts.json) {
    emitJson({
      action: "scan-env-self",
      placement: SELF_PLACEMENT,
      from,
      registryRead,
      added: result.added,
      skippedDuplicates: result.skipped,
      rendered: result.rendered,
      tooShort,
    });
    return;
  }
  emitText(
    `scan-env --self: recorded ${result.added.length} identity pattern(s) under ${SELF_PLACEMENT}` +
      (result.skipped.length > 0 ? ` (${result.skipped.length} already present)` : ""),
  );
}
