import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  computeDenySet,
  readRepoConfig,
  scanFile,
  type RepoConfig,
  type DenySet,
} from "@de-otio/repo-aegis-core";
import { emitJson, emitText, shouldRevealMatches, type OutputOptions } from "../format.js";

interface AuditOptions extends OutputOptions {
  cwd?: string;
  history?: boolean;
  markerScan?: boolean;
  lockfileCheck?: boolean;
  fixtureCheck?: boolean;
  remoteCheck?: boolean;
  verbose?: boolean;
}

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

function git(cwd: string, args: string[]): { ok: boolean; stdout: string } {
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
  const r = git(cwd, ["ls-files"]);
  if (!r.ok) return [];
  return r.stdout.split("\n").filter(Boolean);
}

function checkMarkerScan(
  cwd: string,
  repo: RepoConfig,
  denySet: DenySet,
  reveal: boolean,
): CheckResult {
  if (!repo.isGitRepo) {
    return { name: "marker-scan", ok: true, findings: [], skipped: true, skipReason: "not a git repo" };
  }
  if (denySet.combinedRegex === "") {
    return { name: "marker-scan", ok: true, findings: [], skipped: true, skipReason: "empty deny set" };
  }
  const findings: Finding[] = [];
  const files = listTrackedFiles(cwd);
  for (const f of files) {
    const abs = join(cwd, f);
    if (!existsSync(abs)) continue;
    const r = scanFile(abs, denySet, { revealMatches: reveal }, cwd);
    for (const h of r.hits) {
      findings.push({
        message: `${f}:${h.line}:${h.column}`,
        detail: { path: f, line: h.line, column: h.column, matchPreview: h.matchPreview },
      });
    }
  }
  return { name: "marker-scan", ok: findings.length === 0, findings };
}

function checkHistory(cwd: string, repo: RepoConfig, denySet: DenySet): CheckResult {
  if (!repo.isGitRepo) {
    return { name: "history", ok: true, findings: [], skipped: true, skipReason: "not a git repo" };
  }
  if (denySet.patterns.length === 0) {
    return { name: "history", ok: true, findings: [], skipped: true, skipReason: "empty deny set" };
  }
  const findings: Finding[] = [];
  for (const p of denySet.patterns) {
    let stdout = "";
    try {
      stdout = execFileSync("git", ["log", "-G", p, "--oneline", "--no-decorate"], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      continue;
    }
    const lines = stdout.split("\n").filter(Boolean);
    for (const line of lines) {
      const sha = line.split(" ")[0] ?? "";
      findings.push({
        message: `pattern matched in commit ${sha}`,
        detail: { sha, summary: line.slice(sha.length + 1) },
      });
    }
  }
  return { name: "history", ok: findings.length === 0, findings };
}

function checkLockfile(cwd: string): CheckResult {
  const lockPath = join(cwd, "package-lock.json");
  if (!existsSync(lockPath)) {
    return { name: "lockfile", ok: true, findings: [], skipped: true, skipReason: "no package-lock.json" };
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
        /* skip non-URL entries (e.g. file: paths) silently */
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

function checkFixtures(
  cwd: string,
  repo: RepoConfig,
  denySet: DenySet,
  reveal: boolean,
): CheckResult {
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
    return { name: "fixtures", ok: true, findings: [], skipped: true, skipReason: "no fixture directories found" };
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
      const r = scanFile(full, denySet, { revealMatches: reveal }, repo.isGitRepo ? cwd : undefined);
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
    return { name: "remote", ok: true, findings: [], skipped: true, skipReason: "not a git repo" };
  }
  const r = git(cwd, ["remote", "get-url", "origin"]);
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
    const anyEngagementInRemote = repo.engagements.some(e =>
      lower.includes(e.toLowerCase()),
    );
    if (!anyEngagementInRemote) {
      findings.push({
        message: `class=customer-coupled but no engagement id appears in the remote URL`,
        detail: {
          remote,
          engagements: repo.engagements,
          hint:
            "verify the engagement tag matches the repo's owner/name; rename the engagement or correct the remote",
        },
      });
    }
    return { name: "remote", ok: findings.length === 0, findings };
  }

  return { name: "remote", ok: true, findings: [] };
}

export function audit(opts: AuditOptions): void {
  const cwd = opts.cwd ?? process.cwd();
  const repo = readRepoConfig(cwd);
  const denySet = computeDenySet(repo);
  const reveal = shouldRevealMatches(opts);

  const runMarker = opts.markerScan !== false;
  const runLockfile = opts.lockfileCheck !== false;
  const runFixture = opts.fixtureCheck !== false;
  const runRemote = opts.remoteCheck !== false;
  const runHistory = !!opts.history;

  const results: CheckResult[] = [];
  if (runMarker) results.push(checkMarkerScan(cwd, repo, denySet, reveal));
  if (runHistory) results.push(checkHistory(cwd, repo, denySet));
  if (runLockfile) results.push(checkLockfile(cwd));
  if (runFixture) results.push(checkFixtures(cwd, repo, denySet, reveal));
  if (runRemote) results.push(checkRemote(cwd, repo));

  const failedChecks = results.filter(c => !c.ok);
  const totalFindings = results.reduce((sum, c) => sum + c.findings.length, 0);

  if (opts.json) {
    emitJson({
      action: "audit",
      cwd,
      class: repo.class,
      engagements: repo.engagements,
      checks: results,
      summary: {
        run: results.length,
        failed: failedChecks.length,
        totalFindings,
      },
      warnings: denySet.warnings,
    });
  } else {
    emitText(`audit: ${results.length} check(s) run, ${failedChecks.length} failed, ${totalFindings} finding(s)`);
    for (const c of results) {
      if (c.skipped) {
        emitText(`  ${c.name}: skipped (${c.skipReason})`);
        continue;
      }
      const status = c.ok ? "ok" : "fail";
      emitText(`  ${c.name}: ${status} (${c.findings.length} finding(s))`);
      for (const f of c.findings) {
        emitText(`    - ${f.message}`);
      }
    }
    for (const w of denySet.warnings) emitText(`  warning: ${w}`);
  }

  if (failedChecks.length > 0) {
    process.exit(1);
  }
}
