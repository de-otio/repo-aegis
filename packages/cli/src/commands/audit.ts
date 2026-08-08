// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { execFileSync, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  computeDenySet,
  loadRegistry,
  readRepoConfig,
  scanFile,
  scanText,
  isActive,
  scanRegistryEgress,
  isEgressRelevant,
  isPublicFacing,
  loadEgressPolicy,
  readCachedVisibility,
  resolveHookState,
  appendAuditRecord,
  compileGlobs,
  matchesCompiled,
  ALWAYS_FILE_STEM,
  shouldRedactAttribution,
  redactStems,
  scanForSecrets,
  summariseHits,
  type RepoConfig,
  type DenySet,
  type ScanHit,
} from "@de-otio/repo-aegis-core";
import { emitJson, emitText, shouldRevealMatches, type OutputOptions } from "../format.js";
import { enforceDenySetFloor, type DenySetFloorOptions } from "../deny-set-floor.js";
import { runScan, makeOctokitClient } from "@de-otio/repo-aegis-scan";

interface AuditOptions extends OutputOptions, DenySetFloorOptions {
  cwd?: string;
  history?: boolean;
  /** Strip engagement attribution from output bound for a publication channel. */
  redactAttribution?: boolean;
  markerScan?: boolean;
  lockfileCheck?: boolean;
  fixtureCheck?: boolean;
  remoteCheck?: boolean;
  hooksCheck?: boolean;
  org?: string;
  published?: string;
  /** Scan `--published` archive contents for universal secret shapes. */
  secretScan?: boolean;
  token?: string;
  verbose?: boolean;
  maxQueries?: number;
  acceptCrossBorder?: boolean;
}

const DEFAULT_MAX_ORG_QUERIES = 30;

const ORG_CROSS_BORDER_CONSENT_ENV = "REPO_AEGIS_ACCEPT_ORG_SEED_TRANSFER";

interface Finding {
  message: string;
  detail?: unknown;
  /**
   * Reported but does not fail the check. Currently exactly one thing:
   * an `_always` (secret-shape) hit inside a path the deny set exempts.
   *
   * Why report it at all. `check` and the hooks skip the `_always` class
   * inside `test/`, `fixtures/`, `*.test.*` and friends — a keypair there is
   * a throwaway by construction, and firing on it is how a tool teaches
   * people to reach for `--no-verify`. But an exemption nobody can see is an
   * exemption nobody reviews. `audit` therefore runs the FULL pattern set and
   * shows these, without gating on them: visible somewhere beats invisible
   * everywhere.
   *
   * Engagement markers and `_private_infra` are never informational, at any
   * path. A customer name or an internal host in a test fixture is exactly as
   * much of a leak as one in `src/`.
   */
  informational?: boolean;
}

/** Findings that gate the check's `ok` — i.e. everything not informational. */
function blocking(findings: readonly Finding[]): Finding[] {
  return findings.filter(f => f.informational !== true);
}

interface CheckResult {
  name: string;
  ok: boolean;
  findings: Finding[];
  skipped?: boolean;
  skipReason?: string;
}

const DEFAULT_AUDIT_MAX_FILE_BYTES = 1024 * 1024; // mirror scanFile's default

type LoadedKind = "ok" | "binary" | "too-large" | "unreadable" | "outside";

interface LoadedFile {
  /** Original path as queried; possibly relative to cwd. */
  queryPath: string;
  /** Realpath when resolvable; otherwise the original path. */
  realPath: string;
  kind: LoadedKind;
  /** Populated when kind === "ok"; otherwise undefined. */
  text?: string;
  /** True when file lives inside a fixture directory (per FIXTURE_DIR_NAMES). */
  inFixtureDir: boolean;
}

/**
 * Loads files at most once per realpath and shares the result across
 * checks. Each check that needs file content (marker-scan,
 * fixture-check, lockfile-check) reuses the same buffer rather than
 * issuing its own read syscall. Binary / oversize / outside-tree
 * decisions are made at load time, not per-check.
 *
 * `readCount` is exposed for tests asserting that overlapping paths
 * across checks don't trigger duplicate reads.
 */
class FileCache {
  private byReal = new Map<string, LoadedFile>();
  private byQuery = new Map<string, LoadedFile>();
  /** Test instrumentation: incremented once per actual readFileSync issued by load(). */
  public readCount = 0;
  constructor(
    private workingTree: string,
    private maxBytes = DEFAULT_AUDIT_MAX_FILE_BYTES,
  ) {}

  load(queryPath: string, opts: { mustBeUnderTree?: boolean } = {}): LoadedFile {
    const cachedByQuery = this.byQuery.get(queryPath);
    if (cachedByQuery) return cachedByQuery;

    if (!existsSync(queryPath)) {
      return this.recordResult(queryPath, queryPath, {
        kind: "unreadable",
        inFixtureDir: false,
      });
    }
    let real: string;
    try {
      real = realpathSync(queryPath);
    } catch {
      return this.recordResult(queryPath, queryPath, {
        kind: "unreadable",
        inFixtureDir: false,
      });
    }

    const cachedByReal = this.byReal.get(real);
    if (cachedByReal) {
      this.byQuery.set(queryPath, cachedByReal);
      return cachedByReal;
    }

    if (opts.mustBeUnderTree && this.workingTree) {
      let wtReal: string;
      try {
        wtReal = realpathSync(this.workingTree);
      } catch {
        wtReal = this.workingTree;
      }
      const rel = relative(wtReal, real);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        return this.recordResult(queryPath, real, {
          kind: "outside",
          inFixtureDir: false,
        });
      }
    }

    let st;
    try {
      st = statSync(real);
    } catch {
      return this.recordResult(queryPath, real, {
        kind: "unreadable",
        inFixtureDir: false,
      });
    }
    if (!st.isFile()) {
      return this.recordResult(queryPath, real, {
        kind: "unreadable",
        inFixtureDir: false,
      });
    }
    if (st.size > this.maxBytes) {
      return this.recordResult(queryPath, real, {
        kind: "too-large",
        inFixtureDir: false,
      });
    }
    let buf: Buffer;
    try {
      buf = readFileSync(real);
      this.readCount += 1;
    } catch {
      return this.recordResult(queryPath, real, {
        kind: "unreadable",
        inFixtureDir: false,
      });
    }
    if (looksBinary(buf)) {
      return this.recordResult(queryPath, real, {
        kind: "binary",
        inFixtureDir: false,
      });
    }
    return this.recordResult(queryPath, real, {
      kind: "ok",
      text: buf.toString("utf8"),
      inFixtureDir: false,
    });
  }

  private recordResult(
    queryPath: string,
    realPath: string,
    body: Omit<LoadedFile, "queryPath" | "realPath">,
  ): LoadedFile {
    const entry: LoadedFile = { queryPath, realPath, ...body };
    this.byQuery.set(queryPath, entry);
    this.byReal.set(realPath, entry);
    return entry;
  }
}

function looksBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 8192));
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) return true;
  }
  return false;
}

/**
 * Test-only: build a FileCache and run an arbitrary closure with it.
 * Lets the audit test assert that overlapping reads across checks
 * don't trigger duplicate readFileSync calls.
 *
 * @internal
 */
export function __testCreateFileCache(workingTree: string): FileCache {
  return new FileCache(workingTree);
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

/**
 * Scan a cached file with the FULL pattern set — path exemptions off.
 *
 * `audit` is the surface that has to stay honest about what the everyday gate
 * skips, so it never lets the deny set narrow itself by path. The exempt-path
 * hits it finds are demoted to informational by {@link ExemptPathClassifier}
 * instead, which keeps them on the page while keeping `audit`'s exit status in
 * agreement with `check`.
 */
function scanLoadedFile(
  loaded: LoadedFile,
  denySet: DenySet,
  reveal: boolean,
): ScanHit[] {
  if (loaded.kind !== "ok" || loaded.text === undefined) return [];
  return scanText(loaded.text, denySet, loaded.realPath, {
    revealMatches: reveal,
    ignorePathExemptions: true,
  });
}

/**
 * Decides whether a hit falls inside a deny-set path exemption, so `audit`
 * can demote it to informational.
 *
 * Compiles the glob list once per run. A `GlobTooBroadError` cannot surface
 * here: `computeDenySet` already validated the same list and would have
 * thrown before `audit` got a DenySet at all.
 */
class ExemptPathClassifier {
  private readonly compiled: readonly RegExp[];
  constructor(denySet: DenySet) {
    this.compiled = compileGlobs(denySet.exemptPaths ?? []);
  }

  /**
   * True when `relPath` (repo-relative, POSIX) is exempt AND the hit came
   * from the exemptible class. The class test is the load-bearing half: a
   * hit with no attribution, or one attributed to an engagement or to
   * `_private_infra`, is never demoted.
   */
  isInformational(hit: ScanHit, relPath: string): boolean {
    if (hit.engagement !== ALWAYS_FILE_STEM) return false;
    if (this.compiled.length === 0) return false;
    return matchesCompiled(relPath.split(sep).join("/"), this.compiled);
  }
}

function checkMarkerScan(
  cwd: string,
  repo: RepoConfig,
  denySet: DenySet,
  reveal: boolean,
  cache: FileCache,
  exempt: ExemptPathClassifier,
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
    const loaded = cache.load(abs, { mustBeUnderTree: true });
    if (loaded.kind !== "ok") continue;
    const hits = scanLoadedFile(loaded, denySet, reveal);
    for (const h of hits) {
      // `f` comes from `git ls-files`, so it is already repo-relative POSIX.
      const informational = exempt.isInformational(h, f);
      findings.push({
        message: `${f}:${h.line}:${h.column}`,
        detail: {
          path: f,
          line: h.line,
          column: h.column,
          matchPreview: h.matchPreview,
          ...(informational && { exemptPath: true }),
        },
        ...(informational && { informational: true }),
      });
    }
  }
  // Same demotion rule as the fixture check below, and for the same reason:
  // if `audit` hard-failed on a hit that `check` deliberately skips, the two
  // gates would contradict each other and the exemption would be useless to
  // anyone running `audit` in CI.
  return { name: "marker-scan", ok: blocking(findings).length === 0, findings };
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

// Egress hygiene: a private-registry URL (e.g. an account-scoped CodeArtifact
// host) in a lockfile or .npmrc leaks the owner's account id and breaks
// `npm ci` for external clones — but ONLY matters when the repo is, or can
// become, public. In a private repo the same URL is correct and intended, so
// this check is skipped unless the repo is public-facing. Detection lives in
// core (`scanRegistryEgress`) and spans package-lock.json / yarn.lock /
// pnpm-lock.yaml / .npmrc; we feed it every tracked file of those shapes.
function checkRegistryEgress(
  cwd: string,
  repo: RepoConfig,
  cache: FileCache,
): CheckResult {
  if (!repo.isGitRepo) {
    return { name: "registry-egress", ok: true, findings: [], skipped: true, skipReason: "not a git repo" };
  }
  if (!isPublicFacing(repo)) {
    return {
      name: "registry-egress",
      ok: true,
      findings: [],
      skipped: true,
      skipReason: "repo is not public-facing (private-registry URLs are intended here)",
    };
  }
  const inputs: { path: string; text: string }[] = [];
  for (const f of listTrackedFiles(cwd)) {
    if (!isEgressRelevant(f)) continue;
    const loaded = cache.load(join(cwd, f), { mustBeUnderTree: true });
    if (loaded.kind !== "ok" || loaded.text === undefined) continue;
    inputs.push({ path: f, text: loaded.text });
  }
  const findings: Finding[] = scanRegistryEgress(inputs, loadEgressPolicy()).map(rf => ({
    message:
      `${rf.file}${rf.line ? `:${rf.line}` : ""} references non-public registry ${rf.host}` +
      `${rf.pkg ? ` (${rf.pkg})` : ""}`,
    detail: { file: rf.file, host: rf.host, kind: rf.kind, pkg: rf.pkg, line: rf.line, value: rf.value },
  }));
  return { name: "registry-egress", ok: findings.length === 0, findings };
}

// Reconcile the declared repo class against the cached GitHub visibility. A
// repo left at the `private-strict` default but actually public on GitHub (or
// a `public-eligible` repo that is in fact private) is a misconfiguration the
// fleet should correct — and it's exactly what would let an egress leak slip
// past a class-only gate. Offline: reads the cache `classify`/`status` write.
function checkVisibility(repo: RepoConfig): CheckResult {
  if (!repo.isGitRepo) {
    return { name: "visibility", ok: true, findings: [], skipped: true, skipReason: "not a git repo" };
  }
  const vis = readCachedVisibility(repo.cwd);
  if (vis === "unknown") {
    return {
      name: "visibility",
      ok: true,
      findings: [],
      skipped: true,
      skipReason: "GitHub visibility not cached (run `repo-aegis classify` or `status`)",
    };
  }
  const findings: Finding[] = [];
  if (vis === "public" && repo.class !== "public-eligible") {
    findings.push({
      message: `repo is GitHub-public but class=${repo.class}; set class=public-eligible`,
      detail: { visibility: vis, class: repo.class },
    });
  } else if (vis === "private" && repo.class === "public-eligible") {
    findings.push({
      message: `repo is GitHub-private but class=public-eligible; reclassify`,
      detail: { visibility: vis, class: repo.class },
    });
  }
  return { name: "visibility", ok: findings.length === 0, findings };
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

// The fixture check exists to scan exactly the directories the deny set's
// path exemptions cover, which makes it the one place an exemption is visible.
// It therefore runs the full pattern set (see scanLoadedFile) and demotes only
// the exemptible class: `_always` hits inside an exempt path are reported but
// do not fail the check, while engagement and `_private_infra` hits in a
// fixture stay hard failures.
function checkFixtures(
  cwd: string,
  repo: RepoConfig,
  denySet: DenySet,
  reveal: boolean,
  cache: FileCache,
  exempt: ExemptPathClassifier,
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
      const loaded = cache.load(full, { mustBeUnderTree: repo.isGitRepo });
      if (loaded.kind !== "ok") continue;
      const hits = scanLoadedFile(loaded, denySet, reveal);
      for (const h of hits) {
        const rel = relative(cwd, full);
        const informational = exempt.isInformational(h, rel);
        findings.push({
          message: `${rel}:${h.line}:${h.column}`,
          detail: {
            path: rel,
            line: h.line,
            column: h.column,
            matchPreview: h.matchPreview,
            ...(informational && { exemptPath: true }),
          },
          ...(informational && { informational: true }),
        });
      }
    }
  }
  for (const d of dirs) recurse(d);
  return { name: "fixtures", ok: blocking(findings).length === 0, findings };
}

// Extract literal "seeds" from a regex pattern that GitHub code-search
// can use as substring matches. Splits on regex metacharacters and
// keeps continuous runs of length >= 4. Best-effort; patterns that
// produce no usable seed are silently skipped.
function literalSeeds(pattern: string): string[] {
  const runs = pattern.split(/[\\^$()\[\]{}?+*|.]+/);
  return runs.filter(r => r.length >= 4);
}

async function checkOrg(
  org: string,
  reg: { engagements: import("@de-otio/repo-aegis-core").Engagement[]; alwaysBlock: string[] },
  token: string,
  maxQueries: number,
): Promise<CheckResult> {
  const seedSet = new Set<string>();
  for (const e of reg.engagements) {
    if (!isActive(e)) continue;
    for (const p of e.markers) for (const s of literalSeeds(p)) seedSet.add(s);
  }
  for (const p of reg.alwaysBlock) for (const s of literalSeeds(p)) seedSet.add(s);

  // Sort alphabetically so the truncation, when it happens, is deterministic
  // across runs and across machines. Stable order also makes the "skipped"
  // finding actionable: the operator sees the same prefix every time.
  const allSeeds = Array.from(seedSet).sort();
  if (allSeeds.length === 0) {
    return {
      name: "org-scan",
      ok: true,
      findings: [],
      skipped: true,
      skipReason: "no usable literal seeds extracted from registry patterns",
    };
  }

  const cap = Math.max(1, maxQueries);
  const seeds = allSeeds.slice(0, cap);
  const skippedCount = allSeeds.length - seeds.length;

  const truncationFinding: Finding | null =
    skippedCount > 0
      ? {
          message: `${skippedCount} seed(s) skipped due to --max-queries budget (cap=${cap}, total=${allSeeds.length})`,
          detail: {
            code: "ORG_SCAN_TRUNCATED",
            cap,
            totalSeeds: allSeeds.length,
            skippedCount,
          },
        }
      : null;

  const queries = seeds.map((s, i) => ({
    name: `audit-seed-${i}`,
    query: `"${s}" org:${org}`,
  }));

  const client = makeOctokitClient({ token });
  const result = await runScan({
    queries,
    state: { seen: {} },
    client,
    interRequestSleepMs: 1500,
    maxPagesPerQuery: 2,
    capResultsPerQuery: 50,
  });

  const findings: Finding[] = [];
  if (truncationFinding) findings.push(truncationFinding);
  for (const h of result.hits) {
    findings.push({
      message: `${h.repo}:${h.path}${h.line !== null ? `:${h.line}` : ""}`,
      detail: { repo: h.repo, path: h.path, line: h.line, url: h.url, query: h.query },
    });
  }

  const allFailed = result.summary.queries.length > 0 && result.summary.queries.every(q => !q.ok);
  if (allFailed) {
    return {
      name: "org-scan",
      ok: false,
      findings: [
        ...(truncationFinding ? [truncationFinding] : []),
        { message: "all org-scan queries failed", detail: { queries: result.summary.queries } },
      ],
    };
  }

  // The result is "ok" only when no real hits and no truncation. A truncated
  // run is strictly worse than a clean clean run because some seeds were not
  // queried at all — surface as a failure so the operator sees it.
  const hitCount = result.hits.length;
  return {
    name: "org-scan",
    ok: hitCount === 0 && skippedCount === 0,
    findings,
  };
}

// After extraction, walk the tree and verify every entry's realpath is
// rooted under the extraction root. Catches zip-slip / tar-slip entries
// (e.g. `../../escape.txt`) and symlinks pointing outside the archive.
// Returns null if the tree is clean, or a string describing the offending
// entry if any escape is detected.
function findArchiveEscape(extractDir: string): string | null {
  let extractReal: string;
  try {
    extractReal = realpathSync(extractDir);
  } catch {
    return `cannot resolve realpath of extraction dir ${extractDir}`;
  }
  const stack: string[] = [extractDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = join(dir, name);
      let real: string;
      try {
        real = realpathSync(full);
      } catch {
        // Broken / dangling symlink: treat as escape rather than ignore.
        // Anything we can't realpath cleanly inside the extraction root
        // is suspicious.
        return `entry ${full} has unresolvable realpath`;
      }
      const rel = relative(extractReal, real);
      if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
        // entry is rooted under extractReal; recurse if it's a directory
        // (use lstat so we don't follow symlinks again — realpath already
        // resolved the link's target safely above).
        let st;
        try {
          st = statSync(real);
        } catch {
          continue;
        }
        if (st.isDirectory()) stack.push(full);
        continue;
      }
      return `entry ${full} resolves outside extraction root (-> ${real})`;
    }
  }
  return null;
}

// Probe a binary's presence on PATH by running `<bin> --version`. We use
// the binary itself (not `which`) so the result reflects exactly what
// `spawnSync(bin, ...)` will see later — this guards against shim/PATH
// mismatches where `which` succeeds but spawn fails or vice versa.
// Returns a finding describing the missing binary, or null if the binary
// runs cleanly. Mirrors the AgeNotFoundError pattern from age.ts.
function checkBinaryAvailable(bin: string, code: string): Finding | null {
  const probe = spawnSync(bin, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (probe.error) {
    const errCode = (probe.error as NodeJS.ErrnoException).code;
    if (errCode === "ENOENT") {
      return {
        message: `\`${bin}\` not found on PATH; install it and retry`,
        detail: { code, binary: bin, reason: "ENOENT" },
      };
    }
    return {
      message: `\`${bin} --version\` probe failed: ${probe.error.message}`,
      detail: { code, binary: bin, reason: probe.error.message },
    };
  }
  // Some tools exit non-zero on `--version` (rare). Treat any spawnable
  // result as "present"; we only care that the binary is on PATH.
  return null;
}

function checkPublished(
  input: string,
  cwd: string,
  denySet: DenySet,
  reveal: boolean,
  secretScan: boolean,
): CheckResult {
  const findings: Finding[] = [];

  // An empty deny set is LEGITIMATE here and must not fail the check: the
  // engagement registry is machine-local by design (it holds customer
  // markers, which is precisely what must never reach a public CI runner),
  // so a publish workflow scanning its own tarball will always have zero
  // engagement patterns. But "scanned against nothing" and "scanned clean"
  // must not render identically — that is the exact confusion the
  // deny-set floor exists to prevent, and a gate that reports `ok: true`
  // after matching no patterns is the shape of a green check nobody can
  // trust. Report it, visibly, without gating on it.
  if (denySet.patterns.length === 0) {
    findings.push({
      message:
        "marker scan was inert: the deny set has 0 patterns, so archive contents were not matched against any engagement marker",
      detail: { code: "PUBLISHED_EMPTY_DENY_SET", patternCount: 0, secretScan },
      informational: true,
    });
  }
  const tmp = mkdtempSync(join(tmpdir(), "repo-aegis-published-"));
  let extractDir = tmp;

  try {
    if (input.endsWith(".tgz") || input.endsWith(".tar.gz")) {
      if (!existsSync(input)) {
        return {
          name: "published",
          ok: false,
          findings: [{ message: `tarball not found: ${input}` }],
        };
      }
      const missing = checkBinaryAvailable("tar", "TAR_NOT_FOUND");
      if (missing) {
        return { name: "published", ok: false, findings: [missing] };
      }
      const r = spawnSync("tar", ["-xzf", input, "-C", tmp], { encoding: "utf8" });
      if (r.status !== 0) {
        return {
          name: "published",
          ok: false,
          findings: [{ message: `tar extract failed: ${r.stderr}` }],
        };
      }
    } else if (input.endsWith(".vsix")) {
      if (!existsSync(input)) {
        return {
          name: "published",
          ok: false,
          findings: [{ message: `vsix not found: ${input}` }],
        };
      }
      const missing = checkBinaryAvailable("unzip", "UNZIP_NOT_FOUND");
      if (missing) {
        return { name: "published", ok: false, findings: [missing] };
      }
      const r = spawnSync("unzip", ["-q", input, "-d", tmp], { encoding: "utf8" });
      if (r.status !== 0) {
        return {
          name: "published",
          ok: false,
          findings: [{ message: `unzip failed: ${r.stderr}` }],
        };
      }
    } else {
      // Treat as npm package name; pack first.
      const missingNpm = checkBinaryAvailable("npm", "NPM_NOT_FOUND");
      if (missingNpm) {
        return { name: "published", ok: false, findings: [missingNpm] };
      }
      const missingTar = checkBinaryAvailable("tar", "TAR_NOT_FOUND");
      if (missingTar) {
        return { name: "published", ok: false, findings: [missingTar] };
      }
      const packResult = spawnSync("npm", ["pack", "--silent", input], {
        cwd: tmp,
        encoding: "utf8",
      });
      if (packResult.status !== 0) {
        return {
          name: "published",
          ok: false,
          findings: [{ message: `npm pack failed for ${input}: ${packResult.stderr}` }],
        };
      }
      const tgzs = readdirSync(tmp).filter(f => f.endsWith(".tgz"));
      if (tgzs.length === 0) {
        return {
          name: "published",
          ok: false,
          findings: [{ message: `npm pack produced no .tgz for ${input}` }],
        };
      }
      const tgz = tgzs[0]!;
      const xr = spawnSync("tar", ["-xzf", join(tmp, tgz), "-C", tmp], { encoding: "utf8" });
      if (xr.status !== 0) {
        return {
          name: "published",
          ok: false,
          findings: [{ message: `tar extract failed: ${xr.stderr}` }],
        };
      }
    }

    // Zip-slip / tar-slip defence: after extraction, verify every entry
    // (including symlink targets) resolves within the extraction root.
    // BSD `tar` (default on macOS) and `unzip` do not reliably reject
    // `../../escape.txt` entries on their own.
    const escape = findArchiveEscape(extractDir);
    if (escape !== null) {
      return {
        name: "published",
        ok: false,
        findings: [
          {
            message: "extracted archive contains an entry that escapes the extraction root",
            detail: { code: "PUBLISHED_ARCHIVE_ESCAPE", reason: escape },
          },
        ],
      };
    }

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
        // Pass extractDir as the workingTree so scanFile rejects any
        // symlink whose realpath points outside the archive (e.g. a
        // symlink to /etc/passwd that survived the escape check above
        // — it can't, but defence-in-depth).
        let r;
        try {
          // Full pattern set, no path exemptions and no demotion: a
          // published tarball is the last artefact anyone can inspect, and
          // "it was in a fixture directory" is not a reason to let a secret
          // shape ship to a registry.
          r = scanFile(
            full,
            denySet,
            { revealMatches: reveal, ignorePathExemptions: true },
            extractDir,
          );
        } catch {
          // OutsideWorkingTreeError or similar: skip this entry; the
          // archive-escape check above is the authoritative gate.
          continue;
        }
        for (const h of r.hits) {
          const rel = relative(extractDir, full);
          findings.push({
            message: `${rel}:${h.line}:${h.column}`,
            detail: { path: rel, line: h.line, column: h.column, matchPreview: h.matchPreview },
          });
        }

        // Universal secret shapes, independent of the deny set. This is the
        // only part of the published check that still works when the deny
        // set is empty — which, per the note at the top of this function, is
        // the normal case in CI. It covers the threat that actually applies
        // to a registry tarball: a private key, JWT, or forge token that
        // reached the archive via build output or `files` drift rather than
        // via a tracked source file the hooks already cover.
        //
        // `scanForSecrets` returns kind/offset/length and never the matched
        // bytes, so these findings are safe to print in a public job log
        // without the attribution-redaction machinery.
        if (secretScan) {
          // Read through a file DESCRIPTOR, not the path a second time.
          // `statSync` above already resolved this path; re-resolving it for
          // the read is a TOCTOU (CodeQL `js/file-system-race`) — between the
          // two calls the entry can be replaced, including by a symlink out
          // of the extraction root that the escape check already cleared.
          // Opening once and reading from the fd removes the window rather
          // than narrowing it, and `fstatSync` re-checks the regular-file
          // property against the SAME object we will read.
          let text: string;
          let fd: number;
          try {
            fd = openSync(full, "r");
          } catch {
            continue;
          }
          try {
            if (!fstatSync(fd).isFile()) continue;
            text = readFileSync(fd, "utf8");
          } catch {
            continue;
          } finally {
            try {
              closeSync(fd);
            } catch {
              /* best-effort close */
            }
          }
          const secretHits = scanForSecrets(text);
          if (secretHits.length > 0) {
            const rel = relative(extractDir, full);
            const summary = summariseHits(secretHits);
            findings.push({
              message: `${rel}: ${summary.count} secret-shaped match(es) [${summary.kinds.join(", ")}]`,
              detail: {
                code: "PUBLISHED_SECRET_SHAPE",
                path: rel,
                kinds: summary.kinds,
                count: summary.count,
              },
            });
          }
        }
      }
    }

    recurse(extractDir);
    void cwd;
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }

  return { name: "published", ok: blocking(findings).length === 0, findings };
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

// H2: a repo-local core.hooksPath pointing at an empty (or foreign)
// directory silently disables every hook, and a hook that never runs
// cannot report itself (see hooks-state.ts). `audit` is the gate, so
// unlike `status` (which just reports), this check's failure is what
// makes `audit` exit non-zero. `resolveHookState` collapses to a
// single active problem code at a time, so there is at most one
// finding here — its `detail.code` is the stable machine-readable
// signal; `message` is the human-readable summary.
function checkHooks(cwd: string, repo: RepoConfig): CheckResult {
  if (!repo.isGitRepo) {
    return { name: "hooks", ok: true, findings: [], skipped: true, skipReason: "not a git repo" };
  }
  const state = resolveHookState(cwd);
  if (state.code === "HOOKS_OK") {
    return { name: "hooks", ok: true, findings: [] };
  }
  return {
    name: "hooks",
    ok: false,
    findings: [
      {
        message:
          `git hooks are not active (${state.code}): effective path ` +
          `${state.effectivePath ?? "<git-dir>/hooks"} (expected ${state.expectedPath}); ` +
          `fix: ${state.fix}`,
        detail: {
          code: state.code,
          fix: state.fix,
          origin: state.origin,
          effectivePath: state.effectivePath,
          expectedPath: state.expectedPath,
        },
      },
    ],
  };
}

/**
 * Strip engagement attribution from one check's findings.
 *
 * Marker-scan, fixture, and published findings never carried attribution —
 * their details are path/line/column/preview. The one that does is the remote
 * consistency check, which embeds `repo.engagements` to explain *which* ids it
 * looked for in the remote URL. That detail is the customer list in plaintext,
 * and it appears on a check that FAILS (so it lands in exactly the report a
 * workflow is most likely to publish).
 *
 * Written as a targeted rewrite rather than a recursive key sweep on purpose:
 * a sweep silently covers a key it has never seen, which reads as safety but
 * means a new attribution-bearing field ships unnoticed. This version breaks
 * loudly in review instead — and the oracle test in `ci-output.test.ts` scans
 * the whole serialised payload for real engagement ids, which is what actually
 * guarantees coverage.
 */
function redactCheckResult(check: CheckResult): CheckResult {
  return {
    ...check,
    findings: check.findings.map(f => {
      const d = f.detail;
      if (d === null || typeof d !== "object" || !("engagements" in d)) return f;
      const { engagements, ...restDetail } = d as Record<string, unknown>;
      return {
        ...f,
        detail: {
          ...restDetail,
          engagementCount: Array.isArray(engagements) ? engagements.length : 0,
        },
      };
    }),
  };
}

export async function audit(opts: AuditOptions): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const repo = readRepoConfig(cwd);
  const denySet = computeDenySet(repo);
  // Fail-closed floor. `audit` is the verb the generated CI workflow runs, so
  // this is the surface where a registry that never arrived would otherwise
  // produce a green check over an empty deny set.
  enforceDenySetFloor(denySet.patterns.length, denySet.files.map(f => f.stem), opts);
  const redactAttribution = shouldRedactAttribution(opts.redactAttribution);
  const reveal = shouldRevealMatches(opts);

  const runMarker = opts.markerScan !== false;
  const runLockfile = opts.lockfileCheck !== false;
  const runFixture = opts.fixtureCheck !== false;
  const runRemote = opts.remoteCheck !== false;
  const runHooks = opts.hooksCheck !== false;
  const runHistory = !!opts.history;

  // Single shared cache: if marker-scan, lockfile, and fixture-check
  // each touch the same path (a tracked package-lock.json, or a tracked
  // file inside __fixtures__/), we read it once and re-scan from the
  // cached buffer. The cache also short-circuits binary / oversize
  // decisions across checks.
  const cache = new FileCache(cwd);
  const exempt = new ExemptPathClassifier(denySet);

  const results: CheckResult[] = [];
  if (runMarker) results.push(checkMarkerScan(cwd, repo, denySet, reveal, cache, exempt));
  if (runHistory) results.push(checkHistory(cwd, repo, denySet));
  if (runLockfile) results.push(checkRegistryEgress(cwd, repo, cache));
  if (runRemote) results.push(checkVisibility(repo));
  if (runFixture) results.push(checkFixtures(cwd, repo, denySet, reveal, cache, exempt));
  if (runRemote) results.push(checkRemote(cwd, repo));
  if (runHooks) results.push(checkHooks(cwd, repo));

  // H6: best-effort audit-log record of the observed hook state, so a
  // regression gets a timestamp (the forensic gap that motivated this
  // check in the first place). Independent of `--no-hooks-check` — that
  // flag only controls whether a bad state fails the `audit` gate, not
  // whether it gets observed. Off by default (audit-log itself); never
  // breaks a user-facing command.
  if (repo.isGitRepo) {
    try {
      const hookState = resolveHookState(cwd);
      appendAuditRecord({
        action: "observe-hooks",
        cwd,
        repo: cwd,
        details: { code: hookState.code, ok: hookState.ok },
      });
    } catch {
      /* audit log must not break user-facing ops */
    }
  }

  if (opts.org) {
    // Compliance gate: --org sends literal seeds derived from registry
    // patterns (which can carry customer-derived strings) to GitHub.com,
    // typically a cross-border data transfer. Require explicit consent
    // before any network call. The check runs before the token check so
    // the operator sees the cross-border message even when they haven't
    // set GH_TOKEN yet.
    const consentEnv = process.env[ORG_CROSS_BORDER_CONSENT_ENV];
    const hasConsent = consentEnv === "1" || opts.acceptCrossBorder === true;
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
      const token = process.env[tokenVar];
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
          results.push(await checkOrg(opts.org, reg, token, maxQueries));
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
    results.push(checkPublished(opts.published, cwd, denySet, reveal, opts.secretScan !== false));
  }

  const failedChecks = results.filter(c => !c.ok);
  const totalFindings = results.reduce((sum, c) => sum + c.findings.length, 0);
  // Counted separately so "3 findings, exit 0" is self-explaining rather than
  // looking like a bug in the exit-status logic.
  const informationalFindings = results.reduce(
    (sum, c) => sum + c.findings.filter(f => f.informational === true).length,
    0,
  );

  if (opts.json) {
    emitJson({
      action: "audit",
      cwd,
      class: repo.class,
      // Emitted on every run, hits or not — so a CLEAN audit published as a PR
      // comment would still disclose the full engagement list. That is why
      // redaction here is unconditional rather than keyed on findings.
      engagements: redactAttribution ? [] : repo.engagements,
      checks: redactAttribution ? results.map(redactCheckResult) : results,
      // New in 0.8.0: the number the fail-closed floor is enforced against.
      // Without it, a consumer could not tell "audit passed" from "audit had
      // nothing to scan" by reading the output — which is the whole failure
      // mode `--min-patterns` exists to remove.
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
    });
  } else {
    emitText(
      `audit: ${results.length} check(s) run, ${failedChecks.length} failed, ` +
        `${totalFindings} finding(s)` +
        (informationalFindings > 0 ? `, ${informationalFindings} informational` : ""),
    );
    for (const c of results) {
      if (c.skipped) {
        emitText(`  ${c.name}: skipped (${c.skipReason})`);
        continue;
      }
      const status = c.ok ? "ok" : "fail";
      emitText(`  ${c.name}: ${status} (${c.findings.length} finding(s))`);
      for (const f of c.findings) {
        // Marked inline: an unlabelled finding under an "ok" check reads as
        // an inconsistency, and the label is what makes the exemption
        // reviewable rather than merely present.
        emitText(`    - ${f.message}${f.informational ? " [informational: exempt path]" : ""}`);
      }
    }
    for (const w of denySet.warnings) emitText(`  warning: ${w}`);
  }

  if (failedChecks.length > 0) {
    process.exit(1);
  }
}
