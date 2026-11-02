// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Pure parser for git remote URLs. Used by `classify` to derive the
// engagement (or personal-org) attribution from `git remote get-url
// origin`, and by the egress guard (rule h) to name the owner a push lands on.
//
// The parser is total: malformed input returns `null` rather than
// throwing. This is load-bearing — `parseRemoteUrl` runs in the JIT
// classify path, and a thrown exception there would surface to the
// agent as a tool-failure rather than the intended `skipped` status.
//
// Phase 1 scope: github.com only (including multi-account ssh aliases
// like `git@github.com-personal:`). Non-github hosts return `null`;
// extending to gitlab/bitbucket is a deliberate follow-up.
//
// Hardened for rule h (doc/plan-unregistered-owner-egress.md §3.3 item 6,
// §8.4 F4). A destination that parses to NOTHING used to mean "no
// destination", which skipped every context rule. So the parser now tells three
// things apart (`classifyRemoteUrl`):
//
//   github      cleanly `github.com/<owner>/<repo>`; owner and repo pass the
//               same charset as `safeDestination` (refusal.ts);
//   non-github  another host, or a local path: out of scope, not mis-attributed;
//   opaque      URL-shaped, but not cleanly anything (userinfo tricks, a port
//               that is not a number, percent-encoding, `..`, extra path
//               segments, a repo name outside the charset). A caller that must
//               not fail open treats this as UNRESOLVED.
//
// An ssh host that is not github.com may be an alias in the user's ssh config
// (`git@gh-work:o/r`). The pure parser cannot say; `classifyRemoteUrl` returns
// `alias` and `resolveRemoteUrl` consults `ssh-config.ts`.
import { safeDestination } from "./refusal.js";
import { lookupSshHost, type SshHostLookup } from "./ssh-config.js";

export interface ParsedRemote {
  /** Always `"github.com"` in v1; ssh-alias suffixes are stripped. */
  host: string;
  /** Lowercased GitHub org name. */
  org: string;
  /** Lowercased GitHub repo name (no `.git` suffix). */
  repo: string;
}

/** What a remote URL turned out to be. */
export type RemoteUrlClass =
  | { kind: "github"; org: string; repo: string }
  | { kind: "non-github" }
  | { kind: "opaque" }
  /**
   * An ssh host that is not github.com: it may be an ssh-config alias for
   * GitHub. `legacy` marks the `github.com-<alias>` convention, which this
   * parser has always read as GitHub.
   */
  | { kind: "alias"; host: string; path: string; legacy: boolean };

/** Hosts that ARE GitHub for an ssh URL. */
const GITHUB_SSH_HOSTS: ReadonlySet<string> = new Set(["github.com", "ssh.github.com", "www.github.com"]);
/** Hosts that ARE GitHub for an http(s) or git URL. */
const GITHUB_WEB_HOSTS: ReadonlySet<string> = new Set(["github.com", "www.github.com"]);
/** `HostName` values that make an ssh alias GitHub (plan §3.3 item 5). */
const GITHUB_HOSTNAMES: ReadonlySet<string> = new Set(["github.com", "ssh.github.com"]);

const LEGACY_ALIAS_RE = /^github\.com-[a-z0-9_-]+$/;
/** A host name an ssh alias lookup can be asked about. Anything else is opaque. */
const HOSTNAME_RE = /^[a-z0-9_]([a-z0-9._-]*[a-z0-9_])?$/;
/** Whitespace, control characters and backslashes make a URL's meaning depend on who parses it. */
// eslint-disable-next-line no-control-regex
const HOSTILE_CHARS_RE = /[\u0000- \u007f\\]/;

/**
 * `<owner>/<repo>[.git][/]` (a leading `/` already removed) → names, or null.
 * Both halves pass `safeDestination`'s charset; `.`, `..` and `*` are not repos.
 */
function parseOwnerRepoPath(path: string): { org: string; repo: string } | null {
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  const parts = trimmed.split("/");
  if (parts.length !== 2) return null;
  const owner = parts[0]!;
  let repo = parts[1]!;
  if (repo.endsWith(".git")) repo = repo.slice(0, -4);
  if (repo === "*") return null;
  return safeDestination(owner, repo);
}

function githubOrOpaque(path: string): RemoteUrlClass {
  const parsed = parseOwnerRepoPath(path);
  return parsed === null ? { kind: "opaque" } : { kind: "github", ...parsed };
}

/**
 * Split `[userinfo@]host[:port]`; null when it is not cleanly one host and one
 * numeric port, `"ip-literal"` for `[::1]`-style hosts (never github.com).
 */
function splitAuthority(authority: string): { host: string } | "ip-literal" | null {
  if (authority.includes("%")) return null; // percent-encoding hides the real host
  const at = authority.split("@");
  if (at.length > 2) return null; // `a@b@host`: ssh and URL parsers disagree on the host
  const hostport = at[at.length - 1]!;
  if (hostport.startsWith("[")) return "ip-literal";
  let host = hostport;
  const colon = hostport.lastIndexOf(":");
  if (colon !== -1) {
    host = hostport.slice(0, colon);
    if (!/^\d{1,5}$/.test(hostport.slice(colon + 1))) return null;
  }
  host = host.toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host === "") return null;
  return { host };
}

/**
 * Does the value look like a URL (rather than a remote name or a local path)?
 * `scheme://…`, or scp-like `host:path` with the first colon before any slash.
 */
export function looksLikeRemoteUrl(value: string): boolean {
  if (value.includes("://")) return true;
  const colon = value.indexOf(":");
  const slash = value.indexOf("/");
  return colon > 1 && (slash === -1 || colon < slash);
}

/** Classify a remote URL. Pure and total. */
export function classifyRemoteUrl(raw: unknown): RemoteUrlClass {
  if (typeof raw !== "string") return { kind: "non-github" };
  const url = raw.trim();
  if (url.length === 0) return { kind: "non-github" };
  if (!looksLikeRemoteUrl(url)) return { kind: "non-github" }; // a name or a local path
  if (HOSTILE_CHARS_RE.test(url)) return { kind: "opaque" };

  const schemeMatch = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(.*)$/.exec(url);
  if (schemeMatch === null && url.includes("://")) return { kind: "opaque" };
  if (schemeMatch !== null) {
    const scheme = schemeMatch[1]!.toLowerCase();
    const rest = schemeMatch[2]!;
    if (scheme === "file") return { kind: "non-github" };
    const slash = rest.indexOf("/");
    const authority = slash === -1 ? rest : rest.slice(0, slash);
    const path = slash === -1 ? "" : rest.slice(slash + 1);
    const split = splitAuthority(authority);
    const web = scheme === "http" || scheme === "https" || scheme === "git";
    const ssh = scheme === "ssh" || scheme === "git+ssh" || scheme === "ssh+git";
    if (!web && !ssh) {
      // A remote-helper scheme (`foo://`) runs `git-remote-foo`. Not a host
      // this parser understands; opaque if it names a GitHub-looking host.
      return /github/i.test(authority) ? { kind: "opaque" } : { kind: "non-github" };
    }
    if (split === "ip-literal") return { kind: "non-github" };
    if (split === null) return { kind: "opaque" };
    const { host } = split;
    if (web) return GITHUB_WEB_HOSTS.has(host) ? githubOrOpaque(path) : { kind: "non-github" };
    if (GITHUB_SSH_HOSTS.has(host)) return githubOrOpaque(path);
    if (!HOSTNAME_RE.test(host)) return { kind: "opaque" };
    return { kind: "alias", host, path, legacy: LEGACY_ALIAS_RE.test(host) };
  }

  // scp-like: [user@]host:path, the first colon before any slash.
  const colon = url.indexOf(":");
  const left = url.slice(0, colon);
  const path = url.slice(colon + 1).replace(/^\//, "");
  if (left.includes("%")) return { kind: "opaque" };
  const at = left.split("@");
  if (at.length > 2) return { kind: "opaque" };
  let host = at[at.length - 1]!.toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host === "") return { kind: "opaque" };
  if (host.startsWith("[")) return { kind: "non-github" };
  if (GITHUB_SSH_HOSTS.has(host)) return githubOrOpaque(path);
  if (!HOSTNAME_RE.test(host)) return { kind: "opaque" };
  return { kind: "alias", host, path, legacy: LEGACY_ALIAS_RE.test(host) };
}

/**
 * Parse a git remote URL into `{ host, org, repo }`. Returns `null`
 * for malformed input, non-github hosts, URL-shaped values that are not
 * cleanly `github.com/<owner>/<repo>`, and ssh hosts that would need the
 * ssh config to resolve (except the `github.com-<alias>` convention). Never throws.
 *
 * Org and repo are lowercased in the output. The original casing is
 * not preserved — callers that need the casing-as-typed must read
 * the raw remote themselves.
 *
 * `null` means "not attributable", NOT "no destination": a caller that must
 * not fail open uses {@link resolveRemoteUrl}, which says which it is.
 */
export function parseRemoteUrl(raw: unknown): ParsedRemote | null {
  const c = classifyRemoteUrl(raw);
  if (c.kind === "github") return { host: "github.com", org: c.org, repo: c.repo };
  if (c.kind === "alias" && c.legacy) {
    const g = githubOrOpaque(c.path);
    if (g.kind === "github") return { host: "github.com", org: g.org, repo: g.repo };
  }
  return null;
}

/** Where a push URL goes, for rule h. */
export type RemoteTarget =
  | { kind: "github"; org: string; repo: string }
  /** Another host or a local path: out of scope, as before. */
  | { kind: "non-github" }
  /** URL-shaped, but nothing offline can say which repository. Fail closed. */
  | { kind: "unresolved"; why: string };

/**
 * Resolve a remote URL, consulting the user's ssh config for aliases, to a
 * GitHub repository, a non-GitHub host, or UNRESOLVED. Total: never throws.
 *
 * - An alias whose `HostName` is `github.com` or `ssh.github.com` is GitHub.
 * - An alias whose `HostName` is anything else is not GitHub.
 * - An alias the pure ssh-config parser cannot resolve (a `Match` block that
 *   sets HostName, an unreadable config) is unresolved, except for the
 *   `github.com-<alias>` convention, which stays GitHub (the safe direction:
 *   the owner is then checked).
 * - An alias the config does not mention is its own host, so not GitHub
 *   (unless it is the `github.com-<alias>` convention).
 */
export function resolveRemoteUrl(
  raw: unknown,
  lookup: (host: string) => SshHostLookup = lookupSshHost,
): RemoteTarget {
  try {
    const c = classifyRemoteUrl(raw);
    switch (c.kind) {
      case "github":
        return { kind: "github", org: c.org, repo: c.repo };
      case "non-github":
        return { kind: "non-github" };
      case "opaque":
        return { kind: "unresolved", why: "the URL is not cleanly github.com/<owner>/<repo>" };
      case "alias": {
        const found = lookup(c.host);
        const asGithub = (): RemoteTarget => {
          const g = githubOrOpaque(c.path);
          return g.kind === "github"
            ? { kind: "github", org: g.org, repo: g.repo }
            : { kind: "unresolved", why: "the URL is not cleanly github.com/<owner>/<repo>" };
        };
        if (found.kind === "hostname") return GITHUB_HOSTNAMES.has(found.hostName) ? asGithub() : { kind: "non-github" };
        if (found.kind === "none") return c.legacy ? asGithub() : { kind: "non-github" };
        return c.legacy ? asGithub() : { kind: "unresolved", why: found.why };
      }
    }
  } catch {
    return { kind: "unresolved", why: "the URL could not be evaluated" };
  }
}

/** {@link parseRemoteUrl}, but resolving ssh-config aliases. `null` for anything that is not provably one GitHub repo. */
export function parseRemoteUrlResolved(raw: unknown): ParsedRemote | null {
  const t = resolveRemoteUrl(raw);
  return t.kind === "github" ? { host: "github.com", org: t.org, repo: t.repo } : null;
}
