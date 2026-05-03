// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Prose extraction: walks a repo and produces a bounded text payload for an LLM.
// Phase 2 component; the LLM call is a separate task (P2-A-5).
//
// [SEC C-1] Root path is canonicalised via realpathSync before traversal.
//           Refused with RootContainmentError if the path resolves into
//           forbidden directories.
// [SEC C-2] Hard-exclusion list extends design §2.3 to cover secrets/key material.
//           Author-domain remote-egress guard suppresses domains when a non-loopback
//           endpoint is intended.
// [SEC H-4] Each file is re-resolved via realpathSync immediately before reading
//           to guard against TOCTOU symlink races.
// [SEC M-2] Resource caps: max depth 4, max files 200, max readdir entries 20 000.

import { realpathSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, extname, dirname } from "node:path";
import { spawnSync } from "node:child_process";

// ── Error types ───────────────────────────────────────────────────────────────

/**
 * Thrown when the canonicalised root resolves into a forbidden path.
 * [SEC C-1]
 */
export class RootContainmentError extends Error {
  readonly code = "ROOT_CONTAINMENT" as const;
  constructor(
    public readonly root: string,
    public readonly forbiddenPrefix: string,
  ) {
    super(
      `extractProse root "${root}" resolves to or under a forbidden path "${forbiddenPrefix}". ` +
        `Refusing to walk sensitive directory.`,
    );
    this.name = "RootContainmentError";
  }
}

// ── Exclusion list ────────────────────────────────────────────────────────────

/**
 * Hard-exclusion patterns. The list is exported as a const so tests can iterate it.
 *
 * [SEC C-2] Extends design §2.3 to cover key material and secret-adjacent files.
 *
 * Semantics (resolved by matchesExclusionPattern / matchesPathPattern):
 *  - Entries without "*" and without "/" → exact basename match (case-insensitive)
 *  - Entries with "*" but without "/"   → glob matched against basename only
 *  - Entries with "/"                   → glob matched against the full relative path
 */
export const HARD_EXCLUSIONS: readonly string[] = [
  // Lockfiles (design §2.3)
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.lock",
  "go.sum",
  // Generated / vendored directory names (checked as dir names during traversal)
  "node_modules",
  "dist",
  "build",
  "coverage",
  "target",
  ".next",
  // Git / hidden sensitive dirs
  ".git",
  ".ssh",
  ".aws",
  ".gnupg",
  // Exact-basename secrets [SEC C-2]
  ".npmrc",
  ".netrc",
  // Glob patterns – key material [SEC C-2]
  "*.key",
  "*.p12",
  "*.pfx",
  "*.age",
  "*.pem",
  // Name-contains patterns [SEC C-2]
  "*secret*",
  "*token*",
  "*credentials*",
  // Prefix-based [SEC C-2]
  "id_*",
  ".env*",
  // GitHub workflow YAML (may contain secrets / tokens) [SEC C-2]
  ".github/workflows/*.yml",
];

/**
 * Directory names that are always skipped (never recursed into).
 * Kept separate from HARD_EXCLUSIONS so traversal can short-circuit without
 * stat-ing subdirectory contents.
 */
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  "target",
  ".next",
  ".git",
  ".ssh",
  ".aws",
  ".gnupg",
  "vendor",
  "third_party",
  "third-party",
]);

/** Loopback hostnames/IPs used by the Ollama client. [SEC C-2]
 * Note: new URL("http://[::1]:11434").hostname returns "[::1]" (with brackets),
 * so both the bare and bracketed forms are included. */
const LOOPBACK_HOSTS = new Set([
  "127.0.0.1",
  "::1",
  "[::1]",
  "::ffff:127.0.0.1",
  "[::ffff:127.0.0.1]",
  "0.0.0.0",
  "localhost",
]);

// ── Public types ──────────────────────────────────────────────────────────────

export interface ProseFile {
  path: string;
  content: string;
  truncated: boolean;
}

export interface SkippedAfterResolveEntry {
  path: string;
  reason: string;
}

export interface ProseBundle {
  files: ProseFile[];
  authorDomains: string[];
  /** Files skipped due to TOCTOU re-resolve failure. [SEC H-4] */
  skippedAfterResolve?: SkippedAfterResolveEntry[];
  /**
   * True when author domains were suppressed because `intendedRemoteEndpoint`
   * is non-loopback and `allowRemoteAuthorDomains` was not set. [SEC C-2]
   */
  remoteAuthorDomainWarning?: boolean;
}

export interface ProseExtractionOptions {
  /** Absolute path to the repository root. */
  root: string;
  /** Per-file byte cap (default 16 KiB). [SEC M-2] */
  fileSizeCapBytes?: number;
  /** Total payload byte cap (default 128 KiB). [SEC M-2] */
  totalCapBytes?: number;
  /** Whether to harvest author email domains from git log. */
  gitLogAuthors?: boolean;
  /**
   * When set and the hostname is non-loopback, author domains are suppressed
   * unless `allowRemoteAuthorDomains` is also true. [SEC C-2]
   */
  intendedRemoteEndpoint?: string;
  /** Override the remote-endpoint author-domain guard. [SEC C-2] */
  allowRemoteAuthorDomains?: boolean;
  /**
   * Skip git-working-tree check (for testing non-git fixture directories).
   * [SEC C-1]
   */
  allowNonGit?: boolean;
  /** Max distinct author domains to return (default 8). */
  maxAuthorDomains?: number;
}

// ── Resource cap constants ────────────────────────────────────────────────────

const DEFAULT_FILE_SIZE_CAP_BYTES = 16 * 1024;    // 16 KiB
const DEFAULT_TOTAL_CAP_BYTES = 128 * 1024;        // 128 KiB
/** [SEC M-2] */
const MAX_RECURSION_DEPTH = 4;
/** [SEC M-2] */
const MAX_FILES_CONSIDERED = 200;
/** [SEC M-2] */
const MAX_READDIR_ENTRIES = 20_000;
const DEFAULT_MAX_AUTHOR_DOMAINS = 8;
/** Max markdown files included (excludes README, CODEOWNERS, LICENSE, package.json). */
const MAX_MD_FILES = 10;

// ── Forbidden-root helpers ────────────────────────────────────────────────────

function getForbiddenRoots(): string[] {
  const home = homedir();
  const aegisHome =
    process.env["REPO_AEGIS_HOME"] ?? join(home, ".config", "repo-aegis");
  return [
    aegisHome,
    join(home, ".ssh"),
    join(home, ".aws"),
    join(home, ".gnupg"),
    join(home, ".config", "git"),
  ];
}

/**
 * Returns the forbidden prefix that `p` is under, or null if safe.
 * [SEC C-1] [SEC H-4]
 */
function forbiddenPrefixOf(p: string): string | null {
  for (const forbidden of getForbiddenRoots()) {
    let real: string;
    try {
      real = realpathSync(forbidden);
    } catch {
      real = forbidden;
    }
    if (p === real || p.startsWith(real + "/")) {
      return real;
    }
  }
  return null;
}

// ── Exclusion matchers ────────────────────────────────────────────────────────

/** Minimal glob that supports "*foo", "foo*", "*foo*", and exact. */
function matchGlob(value: string, pattern: string): boolean {
  const v = value.toLowerCase();
  const p = pattern.toLowerCase();

  if (!p.includes("*")) return v === p;

  const parts = p.split("*");

  if (parts.length === 2) {
    const prefix = parts[0] ?? "";
    const suffix = parts[1] ?? "";
    if (prefix === "" && suffix === "") return true; // "*"
    if (prefix === "") return v.endsWith(suffix);
    if (suffix === "") return v.startsWith(prefix);
    return (
      v.length >= prefix.length + suffix.length &&
      v.startsWith(prefix) &&
      v.endsWith(suffix)
    );
  }

  // "*foo*" → three parts ["", "foo", ""]
  if (parts.length === 3 && parts[0] === "" && parts[2] === "") {
    const mid = parts[1] ?? "";
    return v.includes(mid);
  }

  // General: sequential part matching
  let idx = 0;
  for (const part of parts) {
    if (part === "") continue;
    const found = v.indexOf(part, idx);
    if (found === -1) return false;
    idx = found + part.length;
  }
  return true;
}

/** Returns true if the basename should be excluded. */
function basenameIsExcluded(name: string): boolean {
  for (const pattern of HARD_EXCLUSIONS) {
    if (pattern.includes("/")) continue; // path patterns handled separately
    if (matchGlob(name, pattern)) return true;
  }
  return false;
}

/** Returns true if the relative path matches a path-scoped exclusion. */
function relPathIsExcluded(relPath: string): boolean {
  for (const pattern of HARD_EXCLUSIONS) {
    if (!pattern.includes("/")) continue;
    if (matchGlob(relPath, pattern)) return true;
  }
  return false;
}

// ── Truncation ────────────────────────────────────────────────────────────────

function truncateToBytes(
  content: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const buf = Buffer.from(content, "utf8");
  if (buf.length <= maxBytes) return { text: content, truncated: false };

  // Slice to maxBytes and remove a potentially torn multi-byte sequence at the end
  const sliced = buf.subarray(0, maxBytes).toString("utf8").replace(/�.*$/, "");
  const lastNl = sliced.lastIndexOf("\n");
  const truncated = lastNl > 0 ? sliced.slice(0, lastNl) : sliced;
  return { text: truncated + "\n... [truncated]", truncated: true };
}

// ── package.json field filter ─────────────────────────────────────────────────

const PACKAGE_JSON_KEEP = new Set([
  "name",
  "description",
  "repository",
  "author",
  "homepage",
]);

function filterPackageJson(raw: string): string {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of PACKAGE_JSON_KEEP) {
      if (key in obj) out[key] = obj[key];
    }
    return JSON.stringify(out, null, 2);
  } catch {
    return raw;
  }
}

// ── LICENSE author line extraction ───────────────────────────────────────────

function extractLicenseAuthorLines(content: string): string {
  return content
    .split("\n")
    .filter((l) => /copyright|author|©|\(c\)/i.test(l))
    .join("\n");
}

// ── git helpers ───────────────────────────────────────────────────────────────

function isInsideGitWorkTree(cwd: string): boolean {
  const r = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd,
    encoding: "utf8",
    timeout: 5_000,
  });
  return r.status === 0 && r.stdout.trim() === "true";
}

function harvestAuthorDomains(cwd: string, maxDomains: number): string[] {
  const r = spawnSync("git", ["log", "--format=%ae", "--", "."], {
    cwd,
    encoding: "utf8",
    timeout: 10_000,
  });
  if (r.status !== 0 || !r.stdout) return [];

  const domains = new Set<string>();
  for (const email of r.stdout.split("\n")) {
    const at = email.indexOf("@");
    if (at !== -1) {
      const domain = email.slice(at + 1).toLowerCase().trim();
      if (domain) domains.add(domain);
    }
    if (domains.size >= maxDomains) break;
  }
  return Array.from(domains).slice(0, maxDomains);
}

// ── Loopback check ────────────────────────────────────────────────────────────

function isLoopback(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

// ── File classification ───────────────────────────────────────────────────────

type FileKind = "readme" | "md" | "codeowners" | "package-json" | "license";

function classifyFile(name: string, relPath: string): FileKind | null {
  const lower = name.toLowerCase();
  const ext = extname(lower);
  const dirPart = dirname(relPath);
  const isTopLevel = dirPart === "." || dirPart === "";

  if (/^readme/i.test(name)) return "readme";
  if (lower === "codeowners") return "codeowners";
  if (/^license/i.test(name)) return "license";
  if (lower === "package.json" && isTopLevel) return "package-json";
  if (ext === ".md") {
    if (isTopLevel || /^docs$/i.test(dirPart)) return "md";
  }
  return null;
}

// ── Internal traversal types ──────────────────────────────────────────────────

interface CandidateFile {
  absPath: string;
  relPath: string;
  kind: FileKind;
}

interface TraversalState {
  realRoot: string;
  candidates: CandidateFile[];
  filesConsidered: number;
  readdirEntries: number;
  mdFileCount: number;
  // Cap-hit flags (for single-emit warnings)
  depthCapHit: boolean;
  filesCapHit: boolean;
  readdirCapHit: boolean;
}

// ── Tree walk ─────────────────────────────────────────────────────────────────

function walk(state: TraversalState, dir: string, depth: number): void {
  // [SEC M-2] Depth cap
  if (depth > MAX_RECURSION_DEPTH) {
    if (!state.depthCapHit) {
      state.depthCapHit = true;
      process.stderr.write(
        `[repo-aegis prose-extraction] [SEC M-2] max recursion depth ` +
          `${MAX_RECURSION_DEPTH} reached at "${dir}"; halting descent.\n`,
      );
    }
    return;
  }

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  state.readdirEntries += entries.length;
  // [SEC M-2] Readdir cap
  if (state.readdirEntries >= MAX_READDIR_ENTRIES) {
    if (!state.readdirCapHit) {
      state.readdirCapHit = true;
      process.stderr.write(
        `[repo-aegis prose-extraction] [SEC M-2] max readdir entries ` +
          `${MAX_READDIR_ENTRIES} reached; halting traversal.\n`,
      );
    }
    return;
  }

  const relDir = relative(state.realRoot, dir);
  const subdirs: string[] = [];

  for (const entry of entries) {
    // [SEC M-2] Files-considered cap
    if (state.filesConsidered >= MAX_FILES_CONSIDERED) {
      if (!state.filesCapHit) {
        state.filesCapHit = true;
        process.stderr.write(
          `[repo-aegis prose-extraction] [SEC M-2] max files considered ` +
            `${MAX_FILES_CONSIDERED} reached; halting traversal.\n`,
        );
      }
      return;
    }

    const absPath = join(dir, entry);
    const relPath = relDir ? `${relDir}/${entry}` : entry;

    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(absPath);
    } catch {
      continue;
    }

    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(entry) && !basenameIsExcluded(entry)) {
        subdirs.push(absPath);
      }
      continue;
    }

    if (!st.isFile()) continue;

    state.filesConsidered++;

    // Apply exclusions
    if (basenameIsExcluded(entry) || relPathIsExcluded(relPath)) continue;

    // Classify
    const kind = classifyFile(entry, relPath);
    if (kind === null) continue;

    // Cap markdown files
    if (kind === "md" && state.mdFileCount >= MAX_MD_FILES) continue;
    if (kind === "md") state.mdFileCount++;

    state.candidates.push({ absPath, relPath, kind });
  }

  // Recurse into non-excluded subdirectories
  for (const sub of subdirs) {
    if (state.readdirCapHit || state.filesCapHit || state.depthCapHit) break;
    walk(state, sub, depth + 1);
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Walk a repository and produce a bounded text payload for an LLM.
 *
 * Pure with respect to network — no http/https imports are touched.
 *
 * @throws {RootContainmentError} [SEC C-1] if `root` resolves under a forbidden path.
 * @throws {Error} if root is not inside a git working tree and `allowNonGit` is not set.
 */
export async function extractProse(
  opts: ProseExtractionOptions,
): Promise<ProseBundle> {
  const {
    root,
    fileSizeCapBytes = DEFAULT_FILE_SIZE_CAP_BYTES,
    totalCapBytes = DEFAULT_TOTAL_CAP_BYTES,
    gitLogAuthors = false,
    intendedRemoteEndpoint,
    allowRemoteAuthorDomains = false,
    allowNonGit = false,
    maxAuthorDomains = DEFAULT_MAX_AUTHOR_DOMAINS,
  } = opts;

  // ── [SEC C-1] Canonicalise root ───────────────────────────────────────────
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch (err) {
    throw new Error(
      `extractProse: cannot resolve root path "${root}": ${(err as Error).message}`,
    );
  }

  // [SEC C-1] Check containment in forbidden roots
  const forbidden = forbiddenPrefixOf(realRoot);
  if (forbidden !== null) {
    throw new RootContainmentError(realRoot, forbidden);
  }

  // [SEC C-1] Git working-tree check
  if (!allowNonGit && !isInsideGitWorkTree(realRoot)) {
    throw new Error(
      `extractProse: "${realRoot}" is not inside a git working tree. ` +
        `Pass allowNonGit: true to override.`,
    );
  }

  // ── Tree walk ──────────────────────────────────────────────────────────────
  const state: TraversalState = {
    realRoot,
    candidates: [],
    filesConsidered: 0,
    readdirEntries: 0,
    mdFileCount: 0,
    depthCapHit: false,
    filesCapHit: false,
    readdirCapHit: false,
  };

  walk(state, realRoot, 0);

  // ── Second pass: TOCTOU-guarded file reads ────────────────────────────────
  const resultFiles: ProseFile[] = [];
  const skippedAfterResolve: SkippedAfterResolveEntry[] = [];
  let totalBytesUsed = 0;
  let totalCapHit = false;

  for (const candidate of state.candidates) {
    if (totalCapHit) break;

    // [SEC H-4] Re-resolve before reading
    let realFile: string;
    try {
      realFile = realpathSync(candidate.absPath);
    } catch {
      const reason = "path unresolvable after collection";
      skippedAfterResolve.push({ path: candidate.relPath, reason });
      process.stderr.write(
        `[repo-aegis prose-extraction] [SEC H-4] cannot re-resolve ` +
          `"${candidate.relPath}"; skipping. Reason: ${reason}\n`,
      );
      continue;
    }

    // [SEC H-4] Forbidden-root check on re-resolved path
    const forbiddenAfter = forbiddenPrefixOf(realFile);
    if (forbiddenAfter !== null) {
      const reason =
        `re-resolved path "${realFile}" falls under forbidden root "${forbiddenAfter}"`;
      skippedAfterResolve.push({ path: candidate.relPath, reason });
      process.stderr.write(
        `[repo-aegis prose-extraction] [SEC H-4] ${reason}; skipping.\n`,
      );
      continue;
    }

    // Read
    let raw: string;
    try {
      raw = readFileSync(realFile, "utf8");
    } catch {
      skippedAfterResolve.push({ path: candidate.relPath, reason: "unreadable" });
      continue;
    }

    // Content transform by kind
    if (candidate.kind === "package-json") {
      raw = filterPackageJson(raw);
    } else if (candidate.kind === "license") {
      raw = extractLicenseAuthorLines(raw);
      if (!raw.trim()) continue;
    }

    // Per-file size cap
    const { text: fileCapped, truncated: fileTruncated } = truncateToBytes(
      raw,
      fileSizeCapBytes,
    );

    // Total cap
    const fileBytes = Buffer.byteLength(fileCapped, "utf8");
    if (totalBytesUsed + fileBytes > totalCapBytes) {
      const remaining = totalCapBytes - totalBytesUsed;
      if (remaining > 0) {
        const { text: totalCapped, truncated: totalTruncated } = truncateToBytes(
          fileCapped,
          remaining,
        );
        if (totalCapped.trim()) {
          resultFiles.push({
            path: candidate.relPath,
            content: totalCapped,
            truncated: fileTruncated || totalTruncated,
          });
          totalBytesUsed += Buffer.byteLength(totalCapped, "utf8");
        }
      }
      process.stderr.write(
        `[repo-aegis prose-extraction] [SEC M-2] total payload cap ` +
          `${totalCapBytes} bytes reached; stopping.\n`,
      );
      totalCapHit = true;
      break;
    }

    totalBytesUsed += fileBytes;
    if (fileCapped.trim()) {
      resultFiles.push({
        path: candidate.relPath,
        content: fileCapped,
        truncated: fileTruncated,
      });
    }
  }

  // ── [SEC C-2] Author domain harvesting with remote-egress guard ──────────
  let authorDomains: string[] = [];
  let remoteAuthorDomainWarning: boolean | undefined;

  if (gitLogAuthors) {
    const isRemote =
      intendedRemoteEndpoint !== undefined &&
      !isLoopback(intendedRemoteEndpoint);

    if (isRemote && !allowRemoteAuthorDomains) {
      // [SEC C-2] Non-loopback endpoint without explicit override → suppress domains
      authorDomains = [];
      remoteAuthorDomainWarning = true;
    } else {
      authorDomains = harvestAuthorDomains(realRoot, maxAuthorDomains);
    }
  }

  // ── Assemble bundle ───────────────────────────────────────────────────────
  const bundle: ProseBundle = {
    files: resultFiles,
    authorDomains,
  };

  if (skippedAfterResolve.length > 0) {
    bundle.skippedAfterResolve = skippedAfterResolve;
  }
  if (remoteAuthorDomainWarning === true) {
    bundle.remoteAuthorDomainWarning = true;
  }

  return bundle;
}
