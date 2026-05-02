import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { z } from "zod";
import {
  computeDenySet,
  readRepoConfig,
  scanFile,
  type DenySet,
  type RepoConfig,
  type ScanOptions,
} from "@de-otio/repo-aegis-core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { jsonResult } from "./_util.js";

/**
 * Hard-coded redaction policy: see check.ts. Audit findings include the
 * `matchPreview` field from scanFile, which is already redacted when
 * `revealMatches` is false. Setting it explicitly here keeps the policy
 * auditable from this file alone.
 */
const SCAN_OPTS: ScanOptions = { revealMatches: false };

interface Finding {
  message: string;
  detail?: unknown;
}

interface CheckResult {
  name: string;
  ok: boolean;
  findings: Finding[];
  skipped?: boolean;
  skipReason?: string;
}

function gitCmd(cwd: string, args: string[]): { ok: boolean; stdout: string } {
  try {
    const stdout = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { ok: true, stdout: stdout.trim() };
  } catch {
    return { ok: false, stdout: "" };
  }
}

function listTrackedFiles(cwd: string): string[] {
  const r = gitCmd(cwd, ["ls-files"]);
  if (!r.ok) return [];
  return r.stdout.split("\n").filter(Boolean);
}

function checkMarkerScan(cwd: string, repo: RepoConfig, denySet: DenySet): CheckResult {
  if (!repo.isGitRepo) {
    return {
      name: "marker-scan",
      ok: true,
      findings: [],
      skipped: true,
      skipReason: "not a git repo",
    };
  }
  if (denySet.combinedRegex === "") {
    return {
      name: "marker-scan",
      ok: true,
      findings: [],
      skipped: true,
      skipReason: "empty deny set",
    };
  }
  const findings: Finding[] = [];
  for (const f of listTrackedFiles(cwd)) {
    const abs = join(cwd, f);
    if (!existsSync(abs)) continue;
    const r = scanFile(abs, denySet, SCAN_OPTS, cwd);
    for (const h of r.hits) {
      findings.push({
        message: `${f}:${h.line}:${h.column}`,
        detail: { path: f, line: h.line, column: h.column, matchPreview: h.matchPreview },
      });
    }
  }
  return { name: "marker-scan", ok: findings.length === 0, findings };
}

function checkLockfile(cwd: string): CheckResult {
  const lockPath = join(cwd, "package-lock.json");
  if (!existsSync(lockPath)) {
    return {
      name: "lockfile",
      ok: true,
      findings: [],
      skipped: true,
      skipReason: "no package-lock.json",
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch {
    return {
      name: "lockfile",
      ok: false,
      findings: [{ message: "package-lock.json is not valid JSON" }],
    };
  }
  const findings: Finding[] = [];
  const root = parsed as { packages?: Record<string, { resolved?: string }> };
  if (root.packages) {
    for (const [pkgPath, info] of Object.entries(root.packages)) {
      const resolved = info?.resolved;
      if (!resolved) continue;
      try {
        const u = new URL(resolved);
        if (
          u.host !== "registry.npmjs.org" &&
          u.host !== "registry.yarnpkg.com" &&
          !u.host.endsWith(".github.com") &&
          u.host !== "codeload.github.com"
        ) {
          findings.push({
            message: `${pkgPath || "(root)"} resolved from non-public registry: ${u.host}`,
            detail: { pkg: pkgPath, host: u.host, resolved },
          });
        }
      } catch {
        /* skip non-URL entries */
      }
    }
  }
  return { name: "lockfile", ok: findings.length === 0, findings };
}

const FIXTURE_DIR_NAMES = new Set([
  "__fixtures__",
  "fixtures",
  "fixture",
  "test-fixtures",
  "testdata",
]);

function findFixtureDirs(cwd: string): string[] {
  const out: string[] = [];
  function recurse(dir: string, depth: number): void {
    if (depth > 4) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === ".git" || name === "node_modules") continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      if (FIXTURE_DIR_NAMES.has(name)) {
        out.push(full);
      } else {
        recurse(full, depth + 1);
      }
    }
  }
  recurse(cwd, 0);
  return out;
}

function checkFixtures(cwd: string, repo: RepoConfig, denySet: DenySet): CheckResult {
  if (denySet.combinedRegex === "") {
    return {
      name: "fixtures",
      ok: true,
      findings: [],
      skipped: true,
      skipReason: "empty deny set",
    };
  }
  const dirs = findFixtureDirs(cwd);
  if (dirs.length === 0) {
    return {
      name: "fixtures",
      ok: true,
      findings: [],
      skipped: true,
      skipReason: "no fixture directories found",
    };
  }
  const findings: Finding[] = [];
  function recurse(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        recurse(full);
        continue;
      }
      if (!st.isFile()) continue;
      const r = scanFile(full, denySet, SCAN_OPTS, repo.isGitRepo ? cwd : undefined);
      for (const h of r.hits) {
        const rel = relative(cwd, full);
        findings.push({
          message: `${rel}:${h.line}:${h.column}`,
          detail: { path: rel, line: h.line, column: h.column, matchPreview: h.matchPreview },
        });
      }
    }
  }
  for (const d of dirs) recurse(d);
  return { name: "fixtures", ok: findings.length === 0, findings };
}

function checkRemote(cwd: string, repo: RepoConfig): CheckResult {
  if (!repo.isGitRepo) {
    return {
      name: "remote",
      ok: true,
      findings: [],
      skipped: true,
      skipReason: "not a git repo",
    };
  }
  const r = gitCmd(cwd, ["remote", "get-url", "origin"]);
  const remote = r.ok ? r.stdout : "";
  const findings: Finding[] = [];
  if (repo.class === "scratch") {
    if (remote !== "") {
      findings.push({
        message: `class=scratch but origin remote is set: ${remote}`,
        detail: { remote },
      });
    }
    return { name: "remote", ok: findings.length === 0, findings };
  }
  if (repo.class === "customer-coupled") {
    if (remote === "") {
      findings.push({ message: "class=customer-coupled but no origin remote is set" });
      return { name: "remote", ok: false, findings };
    }
    const lower = remote.toLowerCase();
    const anyEngagementInRemote = repo.engagements.some(e => lower.includes(e.toLowerCase()));
    if (!anyEngagementInRemote) {
      findings.push({
        message: "class=customer-coupled but no engagement id appears in the remote URL",
        detail: { remote, engagements: repo.engagements },
      });
    }
    return { name: "remote", ok: findings.length === 0, findings };
  }
  return { name: "remote", ok: true, findings: [] };
}

const auditInput = {
  cwd: z
    .string()
    .optional()
    .describe("Working directory to audit (defaults to server cwd)."),
};

/**
 * `repo_aegis_audit` — composite repo health check.
 *
 * Runs the same default checks as `repo-aegis audit --json` minus the
 * network-dependent / archive-extracting flags (`--org`, `--published`,
 * `--history`). Those are intentionally omitted from the MCP surface:
 *
 *   - `--org` is a cross-border data transfer and requires explicit
 *     human consent (`--accept-cross-border` or the matching env var).
 *     The agent must never opt the user in to that.
 *   - `--published` extracts archives to a temp dir; that's a CLI
 *     workflow, not an interactive-agent one.
 *   - `--history` is slow (full git-log sweep per pattern). If the user
 *     wants it, they run the CLI directly.
 *
 * Hits are returned with `matchPreview` already redacted by core.
 */
export function registerAuditTool(server: McpServer): void {
  server.registerTool(
    "repo_aegis_audit",
    {
      description:
        "Composite repo health check: marker scan over tracked files, " +
        "package-lock.json non-public-registry check, fixture-directory scan, " +
        "remote-vs-class consistency. Equivalent to `repo-aegis audit --json` " +
        "with default flags. Network sweeps (--org), archive scans " +
        "(--published), and full-history sweeps (--history) are deliberately " +
        "NOT exposed here — those require explicit human consent or run " +
        "long; use the CLI for them.",
      inputSchema: auditInput,
    },
    async ({ cwd }) => {
      const wd = cwd ?? process.cwd();
      const repo = readRepoConfig(wd);
      const denySet = computeDenySet(repo);

      const results: CheckResult[] = [
        checkMarkerScan(wd, repo, denySet),
        checkLockfile(wd),
        checkFixtures(wd, repo, denySet),
        checkRemote(wd, repo),
      ];
      const failed = results.filter(c => !c.ok);
      const totalFindings = results.reduce((sum, c) => sum + c.findings.length, 0);

      return jsonResult({
        action: "audit",
        cwd: wd,
        class: repo.class,
        engagements: repo.engagements,
        checks: results,
        summary: {
          run: results.length,
          failed: failed.length,
          totalFindings,
        },
        warnings: denySet.warnings,
      });
    },
  );
}
