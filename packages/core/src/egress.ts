// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Public-repo egress hygiene: detect private package-registry references
// (e.g. an AWS CodeArtifact host) committed into a *public-facing* tree.
//
// This is NOT the customer-marker/deny-set threat model. A private-registry
// URL in a lockfile or `.npmrc` leaks the owner's account id and breaks
// `npm ci` for external clones — but only matters when the repo is, or can
// become, public. In a private repo the very same URL is correct and
// intended, so callers MUST gate enforcement on `isPublicFacing()`.
//
// All parsers are pure: text in, findings out. No filesystem or git access
// except the small `readCachedVisibility` helper (a single `git config` read).
import { execFileSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import type { RepoConfig } from "./repo.js";
import { loadRegistry, type Registry } from "./registry.js";

/** A reference to a non-allowed package registry found in a tracked file. */
export interface RegistryFinding {
  /** Repo-relative (or caller-supplied) path of the offending file. */
  file: string;
  /** The offending registry host (e.g. an account-scoped CodeArtifact host). */
  host: string;
  /** Which file shape produced the finding. */
  kind: "lockfile" | "npmrc" | "requirements";
  /** Lockfile package path / dependency name, when applicable. */
  pkg?: string;
  /** 1-based line number, for line-oriented findings. */
  line?: number;
  /** The full offending value (URL or config line), for actionable output. */
  value: string;
}

export interface EgressPolicy {
  /**
   * Registry hosts that are allowed in a public-facing tree, in ADDITION to
   * the always-allowed public hosts (npmjs, yarnpkg, and any `*.github.com`
   * — GitHub Packages / codeload). Use for a team's public mirror host.
   */
  readonly allowedHosts: readonly string[];
}

/**
 * Public hosts allowed everywhere. `*.github.com` (GitHub Packages,
 * codeload.github.com) is handled by suffix match in {@link isHostAllowed},
 * not listed here.
 */
export const DEFAULT_ALLOWED_REGISTRY_HOSTS: readonly string[] = [
  // npm / yarn / pnpm
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  // pip
  "pypi.org",
  "files.pythonhosted.org",
  // cargo (the default crates.io index lives on github.com, which is already
  // allowed by the `*.github.com` suffix rule below)
  "crates.io",
  "static.crates.io",
];

export function defaultEgressPolicy(): EgressPolicy {
  return { allowedHosts: [...DEFAULT_ALLOWED_REGISTRY_HOSTS] };
}

/**
 * Build a policy from a loaded registry's `publicRegistries` list. Pure.
 * `loadRegistry` already lower-cases the entries; we repeat it here so a
 * hand-built Registry literal (tests, callers constructing one directly)
 * behaves identically.
 */
export function egressPolicyFromRegistry(
  reg: Pick<Registry, "publicRegistries">,
): EgressPolicy {
  return {
    allowedHosts: [
      ...DEFAULT_ALLOWED_REGISTRY_HOSTS,
      ...(reg.publicRegistries ?? []).map(h => h.toLowerCase()),
    ],
  };
}

/**
 * Load the egress policy from the on-disk registry, falling back to the
 * built-in defaults when the registry is missing, encrypted, or malformed.
 *
 * Deliberately fail-soft, because this runs on the pre-commit / pre-push path:
 * egress hygiene is designed to work with *no* configuration at all (that is
 * the whole point — it catches a private host with zero markers), so a user
 * with no registry, or one encrypted at rest between work sessions, must still
 * get the check rather than a hard error.
 *
 * Failing soft here cannot weaken the check: the fallback is the *smallest*
 * allowlist, so a registry we cannot read yields more findings, never fewer.
 * The only loss is a legitimate mirror being flagged — visible and correctable,
 * unlike a silent miss.
 */
export function loadEgressPolicy(path?: string): EgressPolicy {
  try {
    return egressPolicyFromRegistry(path === undefined ? loadRegistry() : loadRegistry(path));
  } catch {
    return defaultEgressPolicy();
  }
}

/** True when `host` is a public/allowed registry under `policy`. */
export function isHostAllowed(host: string, policy: EgressPolicy): boolean {
  if (host === "") return true; // not a host we can reason about; don't flag
  if (DEFAULT_ALLOWED_REGISTRY_HOSTS.includes(host)) return true;
  if (policy.allowedHosts.includes(host)) return true;
  // GitHub Packages (npm.pkg.github.com) and codeload.github.com are public.
  if (host === "github.com" || host.endsWith(".github.com")) return true;
  return false;
}

/** Extract the host from a URL string; "" when not a parseable absolute URL. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// package-lock.json (npm) — lockfileVersion 3 (`packages`) and 1 (`dependencies`).
// ---------------------------------------------------------------------------

interface NpmLockV3 {
  packages?: Record<string, { resolved?: unknown }>;
}
interface NpmLockV1Dep {
  resolved?: unknown;
  dependencies?: Record<string, NpmLockV1Dep>;
}
interface NpmLockV1 {
  dependencies?: Record<string, NpmLockV1Dep>;
}

function scanNpmLock(
  file: string,
  text: string,
  policy: EgressPolicy,
): RegistryFinding[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return []; // malformed lock is a different audit concern; fail soft here
  }
  if (parsed === null || typeof parsed !== "object") return [];
  const findings: RegistryFinding[] = [];

  const consider = (pkg: string, resolved: unknown): void => {
    if (typeof resolved !== "string" || resolved === "") return;
    const host = hostOf(resolved);
    if (host === "") return; // file:/link:/git+ssh — not a registry host
    if (isHostAllowed(host, policy)) return;
    findings.push({ file, host, kind: "lockfile", pkg, value: resolved });
  };

  // v3 / v2: flat `packages` map keyed by install path.
  const v3 = parsed as NpmLockV3;
  if (v3.packages && typeof v3.packages === "object") {
    for (const [path, info] of Object.entries(v3.packages)) {
      consider(path || "(root)", info?.resolved);
    }
  }
  // v1: nested `dependencies` tree.
  const walk = (deps: Record<string, NpmLockV1Dep> | undefined, prefix: string): void => {
    if (!deps) return;
    for (const [name, info] of Object.entries(deps)) {
      const pkg = prefix ? `${prefix} > ${name}` : name;
      consider(pkg, info?.resolved);
      walk(info?.dependencies, pkg);
    }
  };
  walk((parsed as NpmLockV1).dependencies, "");

  return findings;
}

// ---------------------------------------------------------------------------
// yarn.lock (classic + berry) — `resolved "<url>#<hash>"` entries.
// ---------------------------------------------------------------------------

function scanYarnLock(
  file: string,
  text: string,
  policy: EgressPolicy,
): RegistryFinding[] {
  const findings: RegistryFinding[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s+resolution:?\s+"?([^"\s]+)"?/.exec(lines[i] ?? "")
      ?? /^\s+resolved\s+"?([^"\s]+)"?/.exec(lines[i] ?? "");
    if (!m) continue;
    const raw = (m[1] ?? "").replace(/#.*$/, "");
    // berry resolutions look like `@scope/pkg@npm:1.2.3` — only URL-shaped
    // values carry a host worth checking.
    const host = hostOf(raw);
    if (host === "" || isHostAllowed(host, policy)) continue;
    findings.push({ file, host, kind: "lockfile", line: i + 1, value: raw });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// pnpm-lock.yaml — best-effort: a top-level `registry` and any `tarball:` URL.
// (For ordinary deps pnpm records only integrity; the registry leak then lives
// in `.npmrc`, which `scanNpmrc` covers.)
// ---------------------------------------------------------------------------

function scanPnpmLock(
  file: string,
  text: string,
  policy: EgressPolicy,
): RegistryFinding[] {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch {
    return [];
  }
  if (doc === null || typeof doc !== "object") return [];
  const findings: RegistryFinding[] = [];
  const seen = new Set<string>();
  const add = (pkg: string, url: unknown): void => {
    if (typeof url !== "string") return;
    const host = hostOf(url);
    if (host === "" || isHostAllowed(host, policy)) return;
    const key = `${pkg}\u0000${url}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ file, host, kind: "lockfile", pkg, value: url });
  };
  // Top-level registry (pnpm < 9 settings).
  add("(registry)", (doc as { registry?: unknown }).registry);
  // Walk for `tarball` and `registry` fields anywhere in the tree.
  const stack: Array<{ node: unknown; path: string }> = [{ node: doc, path: "" }];
  while (stack.length > 0) {
    const { node, path } = stack.pop()!;
    if (node === null || typeof node !== "object") continue;
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if ((k === "tarball" || k === "registry") && typeof v === "string") {
        add(path || "(root)", v);
      } else if (v !== null && typeof v === "object") {
        stack.push({ node: v, path: path ? `${path}/${k}` : k });
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// .npmrc — `registry=`, `@scope:registry=`, and `//host/..:_authToken=` lines.
// This is the upstream cause: a private default registry here is what rewrites
// a lockfile's `resolved` URLs on the next install.
// ---------------------------------------------------------------------------

function scanNpmrc(
  file: string,
  text: string,
  policy: EgressPolicy,
): RegistryFinding[] {
  const findings: RegistryFinding[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;

    // `registry=` or `@scope:registry=` → value is a URL.
    const reg = /^(?:@[^:]+:)?registry\s*=\s*(\S+)/.exec(line);
    if (reg) {
      const host = hostOf(reg[1] ?? "");
      if (host !== "" && !isHostAllowed(host, policy)) {
        findings.push({ file, host, kind: "npmrc", line: i + 1, value: line });
      }
      continue;
    }
    // `//host/path:_authToken=` (or :_password / :_auth) → host is the prefix.
    const auth = /^\/\/([^/]+)\/[^:]*:_(?:authToken|password|auth)\s*=/.exec(line);
    if (auth) {
      const host = auth[1] ?? "";
      if (host !== "" && !isHostAllowed(host, policy)) {
        // Redact the credential value; the host is the signal.
        const redacted = line.replace(/(=).*/, "$1<redacted>");
        findings.push({ file, host, kind: "npmrc", line: i + 1, value: redacted });
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Shared helpers for the TOML-ish lockfiles (Cargo.lock, poetry.lock).
//
// These are parsed line-wise rather than with a real TOML parser. The fields we
// need (`source =`, `url =`) are always single-line quoted strings in these two
// formats, and `yarn.lock` already sets the "no full parse" precedent above.
// The deciding factor is dependency surface: repo-aegis exists to protect a
// supply chain, so it does not add a parser dependency to read two string keys.
// ---------------------------------------------------------------------------

/**
 * Strip a URL's userinfo so a credential embedded in an index URL
 * (`https://user:token@host/simple`) is never echoed in a finding. The host is
 * the signal; the secret is not ours to print. Mirrors the `.npmrc` auth-line
 * redaction above.
 */
function redactUrlCredentials(url: string): string {
  // Unanchored and global on purpose: callers pass whole config *lines*
  // (`--index-url https://user:tok@host/…`), not bare URLs, so an anchored
  // match would silently fail to redact and echo the credential.
  return url.replace(/([a-z0-9+.-]+:\/\/)[^/@\s]*@/gi, "$1<redacted>@");
}

/** `name = "foo"` → `foo`; null when the line is not a name assignment. */
function tomlName(line: string): string | null {
  return /^\s*name\s*=\s*"([^"]*)"/.exec(line)?.[1] ?? null;
}

/**
 * Scan a TOML-ish lockfile line-wise for a given key, tracking the most recent
 * `name = "..."` so findings can name the offending package.
 *
 * `transform` normalises the raw value before host extraction (cargo prefixes
 * its sources with `registry+` / `sparse+` / `git+`).
 */
function scanTomlish(
  file: string,
  text: string,
  policy: EgressPolicy,
  key: "source" | "url",
  transform: (raw: string) => string,
): RegistryFinding[] {
  const findings: RegistryFinding[] = [];
  const lines = text.split(/\r?\n/);
  const keyRe = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`);
  let pkg = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const name = tomlName(line);
    if (name !== null) {
      pkg = name;
      continue;
    }
    const m = keyRe.exec(line);
    if (!m) continue;
    const raw = transform(m[1] ?? "");
    const host = hostOf(raw);
    if (host === "" || isHostAllowed(host, policy)) continue;
    findings.push({
      file,
      host,
      kind: "lockfile",
      line: i + 1,
      value: redactUrlCredentials(raw),
      ...(pkg !== "" && { pkg }),
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Cargo.lock — `source = "registry+https://…"` / `"sparse+https://…"`.
// The default crates.io index is a github.com URL, so it passes the suffix
// rule; a private or vendored registry shows up as any other host.
// ---------------------------------------------------------------------------

function scanCargoLock(
  file: string,
  text: string,
  policy: EgressPolicy,
): RegistryFinding[] {
  return scanTomlish(file, text, policy, "source", raw =>
    raw.replace(/^(?:registry|sparse|git)\+/, ""),
  );
}

// ---------------------------------------------------------------------------
// poetry.lock — `[package.source] url = "https://…"` for packages resolved
// from a non-PyPI index.
// ---------------------------------------------------------------------------

function scanPoetryLock(
  file: string,
  text: string,
  policy: EgressPolicy,
): RegistryFinding[] {
  return scanTomlish(file, text, policy, "url", raw => raw);
}

// ---------------------------------------------------------------------------
// Pipfile.lock (JSON) — `_meta.sources[].url` carries the configured indexes.
// ---------------------------------------------------------------------------

interface PipfileLock {
  _meta?: { sources?: Array<{ name?: unknown; url?: unknown }> };
}

function scanPipfileLock(
  file: string,
  text: string,
  policy: EgressPolicy,
): RegistryFinding[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return []; // malformed lock is a different audit concern; fail soft
  }
  if (parsed === null || typeof parsed !== "object") return [];
  const sources = (parsed as PipfileLock)._meta?.sources;
  if (!Array.isArray(sources)) return [];
  const findings: RegistryFinding[] = [];
  for (const src of sources) {
    if (src === null || typeof src !== "object") continue;
    const url = src.url;
    if (typeof url !== "string") continue;
    const host = hostOf(url);
    if (host === "" || isHostAllowed(host, policy)) continue;
    findings.push({
      file,
      host,
      kind: "lockfile",
      value: redactUrlCredentials(url),
      ...(typeof src.name === "string" && src.name !== "" && { pkg: src.name }),
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// requirements*.txt — the pip analogue of `.npmrc`: an `--index-url` /
// `--extra-index-url` / `-i` / `--find-links` pointing at a private index.
// Ordinary pinned requirement lines carry no host, so nothing else to check.
// ---------------------------------------------------------------------------

function scanRequirementsTxt(
  file: string,
  text: string,
  policy: EgressPolicy,
): RegistryFinding[] {
  const findings: RegistryFinding[] = [];
  const lines = text.split(/\r?\n/);
  const flagRe = /(?:^|\s)(?:--index-url|--extra-index-url|--find-links|-i|-f)[\s=]+(\S+)/;
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = flagRe.exec(line);
    if (!m) continue;
    const host = hostOf(m[1] ?? "");
    if (host === "" || isHostAllowed(host, policy)) continue;
    findings.push({
      file,
      host,
      kind: "requirements",
      line: i + 1,
      value: redactUrlCredentials(line),
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Dispatch.
// ---------------------------------------------------------------------------

export interface EgressInputFile {
  /** Repo-relative path; its basename selects the parser. */
  path: string;
  /** File contents. */
  text: string;
}

/** Select a parser by file basename; null when the file is not relevant. */
export function egressParserFor(
  path: string,
): ((file: string, text: string, policy: EgressPolicy) => RegistryFinding[]) | null {
  const base = path.split("/").pop() ?? path;
  if (base === "package-lock.json" || base === "npm-shrinkwrap.json") return scanNpmLock;
  if (base === "yarn.lock") return scanYarnLock;
  if (base === "pnpm-lock.yaml") return scanPnpmLock;
  if (base === ".npmrc") return scanNpmrc;
  if (base === "Cargo.lock") return scanCargoLock;
  if (base === "poetry.lock") return scanPoetryLock;
  if (base === "Pipfile.lock") return scanPipfileLock;
  // Deliberately narrow: `requirements.txt` / `requirements-dev.txt` by name,
  // plus any `*.txt` inside a `requirements/` directory (a common split-deps
  // layout). NOT every `*.txt` — that would drag unrelated prose files through
  // a URL scanner for no benefit.
  if (
    /^requirements[\w.-]*\.txt$/i.test(base) ||
    (/\.txt$/i.test(base) && /(?:^|\/)requirements\//i.test(path))
  ) {
    return scanRequirementsTxt;
  }
  // `go.sum` is deliberately absent: Go's proxy is configured via GOPROXY in
  // the environment, not recorded in the file, so there is no host to check.
  return null;
}

/** True when `path` is a file shape this module knows how to scan. */
export function isEgressRelevant(path: string): boolean {
  return egressParserFor(path) !== null;
}

/** Scan a set of in-memory files for non-allowed registry references. */
export function scanRegistryEgress(
  files: readonly EgressInputFile[],
  policy: EgressPolicy = defaultEgressPolicy(),
): RegistryFinding[] {
  const out: RegistryFinding[] = [];
  for (const f of files) {
    const parser = egressParserFor(f.path);
    if (!parser) continue;
    out.push(...parser(f.path, f.text, policy));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Visibility gate.
// ---------------------------------------------------------------------------

export type RepoVisibility = "public" | "private" | "unknown";

/**
 * Read the cached GitHub visibility for the repo from git config
 * (`repo-aegis.visibility`). Populated by `classify` / `status`; absent →
 * "unknown". A single, fast, offline read so hooks never block on the network.
 */
export function readCachedVisibility(cwd: string, env: NodeJS.ProcessEnv = process.env): RepoVisibility {
  // A CI runner checks out a fresh clone, so the git-config cache below is
  // always absent there — while the workflow knows the answer authoritatively
  // (`github.event.repository.private`, or the `public` event firing at the
  // exact moment a repo flips). REPO_AEGIS_ASSUME_PUBLIC is how that knowledge
  // gets in.
  //
  // It is deliberately ONE-DIRECTIONAL: it can assert "public", which turns
  // egress enforcement ON, and there is no env var that asserts "private". A
  // symmetric override would be a suppression primitive — an environment
  // variable that switches findings off is indistinguishable from a waiver
  // nobody reviewed, and it would be reachable from a shell profile, a
  // Makefile, or a workflow edit, none of which leave the audit trail
  // `repo-aegis waive` insists on. One-directional also needs no
  // anti-spoofing story: nobody gains anything by asserting the stricter
  // value.
  if (env.REPO_AEGIS_ASSUME_PUBLIC === "1") return "public";
  try {
    const out = execFileSync("git", ["config", "--get", "repo-aegis.visibility"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (out === "public" || out === "private") return out;
    return "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Whether egress enforcement applies to this repo. True when the repo is
 * declared `public-eligible`, OR its cached GitHub visibility is `public`
 * (the misclassification safety net: a repo left at the `private-strict`
 * default but actually public on GitHub is still protected). Private repos
 * — where a private-registry URL is intended — return false.
 */
export function isPublicFacing(
  repo: Pick<RepoConfig, "class" | "cwd">,
  opts: { visibility?: RepoVisibility } = {},
): boolean {
  if (repo.class === "public-eligible") return true;
  const vis = opts.visibility ?? readCachedVisibility(repo.cwd);
  return vis === "public";
}
