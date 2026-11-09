// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `repo-aegis-scan audit --org <org> | --published <pkg-or-tarball>`.
//
// These two checks used to be flags of `repo-aegis audit`. They moved here so
// the CLI's gate path never imports an HTTP client or shells out to `npm pack`.
// What did NOT move: the local checks (marker scan, lockfile, fixtures, remote
// consistency, hooks). A run that wants both is now two commands, and
// `repo-aegis audit --org|--published` says so.
//
// Written as a function that RETURNS what to print and how to exit, rather
// than writing and exiting itself: the bin wrapper does the I/O, and the tests
// need neither a stdout patch nor a `process.exit` stub.
import {
  computeDenySet,
  denySetFloorShortfall,
  loadRegistry,
  readRepoConfig,
  redactStems,
  shouldRedactAttribution,
} from "@de-otio/repo-aegis-core";
import {
  checkOrg,
  checkPublished,
  DEFAULT_MAX_ORG_QUERIES,
  ORG_CROSS_BORDER_CONSENT_ENV,
  type CheckOrgDeps,
  type CheckResult,
} from "./audit-checks.js";

export interface AuditOptions {
  cwd?: string;
  json?: boolean;
  org?: string;
  published?: string;
  /** Scan `--published` archive contents for universal secret shapes (default true). */
  secretScan?: boolean;
  /** Env var holding the GitHub token for `--org` (default GH_TOKEN). */
  token?: string;
  maxQueries?: number;
  acceptCrossBorder?: boolean;
  minPatterns?: number;
  requireDenySet?: boolean;
  redactAttribution?: boolean;
  verbose?: boolean;
}

export interface AuditRun {
  /** 0 clean, 1 a check failed, 2 the audit could not run. */
  exitCode: 0 | 1 | 2;
  stdout: string;
  stderr: string;
}

export interface AuditDeps extends CheckOrgDeps {
  env?: NodeJS.ProcessEnv;
}

function fail(error: string, opts: AuditOptions, code?: string, details?: unknown): AuditRun {
  const payload = { ...(code ? { code } : {}), error, ...(details !== undefined ? { details } : {}) };
  if (opts.json) {
    return { exitCode: 2, stdout: "", stderr: JSON.stringify(payload) + "\n" };
  }
  const d =
    details === undefined ? "" : `  ${typeof details === "string" ? details : JSON.stringify(details)}\n`;
  return { exitCode: 2, stdout: "", stderr: `repo-aegis-scan: ${error}\n${d}` };
}

export async function runAudit(opts: AuditOptions, deps: AuditDeps = {}): Promise<AuditRun> {
  const env = deps.env ?? process.env;
  if (!opts.org && !opts.published) {
    return fail(
      "audit needs --org <org> and/or --published <pkg-or-tarball>; the local checks are `repo-aegis audit`",
      opts,
      "USAGE",
    );
  }

  const cwd = opts.cwd ?? process.cwd();
  const repo = readRepoConfig(cwd);
  const denySet = computeDenySet(repo);
  // Fail-closed floor, enforced exactly as `repo-aegis audit` did: a registry
  // that never arrived must not produce a green check over an empty deny set.
  const shortfall = denySetFloorShortfall(
    denySet.patterns.length,
    denySet.files.length,
    opts,
    env,
  );
  if (shortfall !== null) {
    return fail(shortfall.error, opts, shortfall.code, shortfall.details);
  }
  const redactAttribution = shouldRedactAttribution(opts.redactAttribution);
  const reveal = !!opts.verbose;

  const results: CheckResult[] = [];

  if (opts.org) {
    // Compliance gate: --org sends literal seeds derived from registry
    // patterns (which can carry customer-derived strings) to GitHub.com,
    // typically a cross-border data transfer. Require explicit consent
    // before any network call. The check runs before the token check so
    // the operator sees the cross-border message even when they haven't
    // set GH_TOKEN yet.
    const hasConsent = env[ORG_CROSS_BORDER_CONSENT_ENV] === "1" || opts.acceptCrossBorder === true;
    if (!hasConsent) {
      results.push({
        name: "org-scan",
        ok: false,
        findings: [
          {
            message:
              "--org sends literal seed substrings (potentially customer-derived) to github.com, " +
              "which is a cross-border data transfer; explicit consent required. " +
              `Set ${ORG_CROSS_BORDER_CONSENT_ENV}=1 or pass --accept-cross-border to proceed.`,
            detail: {
              code: "ORG_SCAN_CONSENT_REQUIRED",
              consentEnv: ORG_CROSS_BORDER_CONSENT_ENV,
              consentFlag: "--accept-cross-border",
            },
          },
        ],
      });
    } else {
      const tokenVar = opts.token ?? "GH_TOKEN";
      const token = env[tokenVar];
      if (!token) {
        results.push({
          name: "org-scan",
          ok: false,
          findings: [{ message: `${tokenVar} env var is not set; cannot run --org sweep` }],
        });
      } else {
        try {
          const reg = loadRegistry();
          const maxQueries = opts.maxQueries ?? DEFAULT_MAX_ORG_QUERIES;
          results.push(await checkOrg(opts.org, reg, token, maxQueries, deps));
        } catch (err) {
          results.push({
            name: "org-scan",
            ok: false,
            findings: [{ message: `org-scan setup failed: ${(err as Error).message}` }],
          });
        }
      }
    }
  }

  if (opts.published) {
    results.push(checkPublished(opts.published, denySet, reveal, opts.secretScan !== false));
  }

  const failedChecks = results.filter(c => !c.ok);
  const totalFindings = results.reduce((sum, c) => sum + c.findings.length, 0);
  // Counted separately so "3 findings, exit 0" is self-explaining.
  const informationalFindings = results.reduce(
    (sum, c) => sum + c.findings.filter(f => f.informational === true).length,
    0,
  );
  const exitCode = failedChecks.length > 0 ? 1 : 0;

  if (opts.json) {
    const payload = {
      action: "audit",
      cwd,
      class: repo.class,
      // Emitted on every run, hits or not — so a CLEAN audit published as a PR
      // comment would still disclose the full engagement list. That is why
      // redaction here is unconditional rather than keyed on findings.
      engagements: redactAttribution ? [] : repo.engagements,
      checks: results,
      // The number the fail-closed floor is enforced against. Without it, a
      // consumer could not tell "audit passed" from "audit had nothing to scan".
      denySet: {
        files: redactAttribution
          ? redactStems(denySet.files.map(f => f.stem))
          : denySet.files.map(f => f.stem),
        patternCount: denySet.patterns.length,
      },
      ...(redactAttribution && { attributionRedacted: true as const }),
      summary: {
        run: results.length,
        failed: failedChecks.length,
        totalFindings,
        informationalFindings,
      },
      warnings: denySet.warnings,
    };
    return { exitCode, stdout: JSON.stringify(payload, null, 2) + "\n", stderr: "" };
  }

  const lines: string[] = [
    `audit: ${results.length} check(s) run, ${failedChecks.length} failed, ` +
      `${totalFindings} finding(s)` +
      (informationalFindings > 0 ? `, ${informationalFindings} informational` : ""),
  ];
  for (const c of results) {
    if (c.skipped) {
      lines.push(`  ${c.name}: skipped (${c.skipReason})`);
      continue;
    }
    lines.push(`  ${c.name}: ${c.ok ? "ok" : "fail"} (${c.findings.length} finding(s))`);
    for (const f of c.findings) {
      lines.push(`    - ${f.message}${f.informational ? " [informational: exempt path]" : ""}`);
    }
  }
  for (const w of denySet.warnings) lines.push(`  warning: ${w}`);
  return { exitCode, stdout: lines.join("\n") + "\n", stderr: "" };
}
