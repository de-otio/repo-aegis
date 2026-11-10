// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  computeDenySet,
  readRepoConfig,
  scanText,
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
  type RepoConfig,
  type DenySet,
  type ScanHit,
} from "@de-otio/repo-aegis-core";
import { emitError, emitJson, emitText, shouldRevealMatches, type OutputOptions } from "../format.js";
import { enforceDenySetFloor, type DenySetFloorOptions } from "../deny-set-floor.js";
import { currentEnforcementPin } from "../enforcement-pin.js";

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
  /**
   * The next six moved to `repo-aegis-scan audit` (network work does not belong
   * on the gate path). They stay on this type only so the flags still parse and
   * `audit` can answer them with the exact replacement command; see
   * {@link movedNetworkAuditCommand}. Nothing here acts on them.
   */
  org?: string;
  published?: string;
  /** `--no-secret-scan` (default true); only meaningful with `--published`. */
  secretScan?: boolean;
  token?: string;
  maxQueries?: number;
  acceptCrossBorder?: boolean;
  /**
   * Report findings that a `repo-aegis: allow` comment currently suppresses.
   * There is deliberately no `--ignore-waivers` counterpart: `audit` never
   * applies waivers in the first place, so it is already strict there.
   */
  ignoreAllowlistComments?: boolean;
  verbose?: boolean;
  /** Root-level flags (`withGlobals`); read only to rebuild the moved-flag replacement command. */
  home?: string;
  registryPath?: string;
}

const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

function shellWord(v: string): string {
  return SHELL_SAFE.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`;
}

/**
 * `audit --org` and `audit --published` moved to `repo-aegis-scan audit`. This is
 * the exact command to run instead: every flag the caller passed that the new
 * command understands, in the same spelling. Null when neither moved flag was used.
 *
 * Exported for tests and so the wording is pinned in one place. Remove with the
 * moved-flag shims (one release after the move).
 */
export function movedNetworkAuditCommand(opts: AuditOptions): string | null {
  if (!opts.org && !opts.published) return null;
  const args: string[] = ["audit"];
  if (opts.org) args.push("--org", shellWord(opts.org));
  if (opts.published) args.push("--published", shellWord(opts.published));
  if (opts.secretScan === false) args.push("--no-secret-scan");
  if (opts.token) args.push("--token", shellWord(opts.token));
  if (typeof opts.maxQueries === "number" && Number.isFinite(opts.maxQueries)) {
    args.push("--max-queries", String(opts.maxQueries));
  }
  if (opts.acceptCrossBorder) args.push("--accept-cross-border");
  if (typeof opts.minPatterns === "number" && Number.isFinite(opts.minPatterns)) {
    args.push("--min-patterns", String(opts.minPatterns));
  }
  if (opts.requireDenySet) args.push("--require-deny-set");
  if (opts.redactAttribution) args.push("--redact-attribution");
  if (opts.verbose) args.push("--verbose");
  if (opts.cwd) args.push("--cwd", shellWord(opts.cwd));
  if (opts.home) args.push("--home", shellWord(opts.home));
  if (opts.registryPath) args.push("--registry-path", shellWord(opts.registryPath));
  if (opts.json) args.push("--json");
  return `repo-aegis-scan ${args.join(" ")}`;
}

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

    // Stat and read through one descriptor, so the type/size checks describe
    // the same file that is read.
    let fd: number;
    try {
      fd = openSync(real, "r");
    } catch {
      return this.recordResult(queryPath, real, {
        kind: "unreadable",
        inFixtureDir: false,
      });
    }
    let buf: Buffer;
    try {
      const st = fstatSync(fd);
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
      buf = readFileSync(fd);
      this.readCount += 1;
    } catch {
      return this.recordResult(queryPath, real, {
        kind: "unreadable",
        inFixtureDir: false,
      });
    } finally {
      closeSync(fd);
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
  ignoreAllowlistComments = false,
): ScanHit[] {
  if (loaded.kind !== "ok" || loaded.text === undefined) return [];
  return scanText(loaded.text, denySet, loaded.realPath, {
    revealMatches: reveal,
    ignorePathExemptions: true,
    // `scanText` respects `repo-aegis: allow` comments by default, and so
    // does `audit` — the day-to-day gate has to, or people reach for
    // `--no-verify`. `--ignore-allowlist-comments` is what the scheduled
    // strict profile passes to see what those comments are currently hiding.
    //
    // Note the asymmetry with waivers: `audit` never applies waivers at all
    // (unlike `check`), so it is already strict in that dimension and there
    // is nothing to turn off.
    ...(ignoreAllowlistComments && { respectAllowComments: false }),
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
  ignoreAllowlistComments = false,
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
    const hits = scanLoadedFile(loaded, denySet, reveal, ignoreAllowlistComments);
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
  ignoreAllowlistComments = false,
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
      const hits = scanLoadedFile(loaded, denySet, reveal, ignoreAllowlistComments);
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
  const state = resolveHookState(cwd, currentEnforcementPin());
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
  // Refuse before doing any work: running the local checks and then failing on
  // the moved flag would look like a partial result, and a CI job that passed
  // `--org` expects the sweep, which this command no longer performs.
  const moved = movedNetworkAuditCommand(opts);
  if (moved !== null) {
    emitError(
      {
        code: "AUDIT_NETWORK_MOVED",
        error:
          `\`audit --org\` and \`audit --published\` moved to \`${moved}\` ` +
          `(install: \`npm install -g @de-otio/repo-aegis-scan\`). ` +
          `Run \`repo-aegis audit\` without those flags for the local checks.`,
      },
      opts,
    );
  }

  const cwd = opts.cwd ?? process.cwd();
  const repo = readRepoConfig(cwd);
  const denySet = computeDenySet(repo);
  // Fail-closed floor. `audit` is the verb the generated CI workflow runs, so
  // this is the surface where a registry that never arrived would otherwise
  // produce a green check over an empty deny set.
  enforceDenySetFloor(denySet.patterns.length, denySet.files.map(f => f.stem), opts);
  const redactAttribution = shouldRedactAttribution(opts.redactAttribution);
  const reveal = shouldRevealMatches(opts);

  const ignoreAllowlistComments = opts.ignoreAllowlistComments === true;
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
  if (runMarker)
    results.push(
      checkMarkerScan(cwd, repo, denySet, reveal, cache, exempt, ignoreAllowlistComments),
    );
  if (runHistory) results.push(checkHistory(cwd, repo, denySet));
  if (runLockfile) results.push(checkRegistryEgress(cwd, repo, cache));
  if (runRemote) results.push(checkVisibility(repo));
  if (runFixture)
    results.push(
      checkFixtures(cwd, repo, denySet, reveal, cache, exempt, ignoreAllowlistComments),
    );
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
      const hookState = resolveHookState(cwd, currentEnforcementPin());
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
