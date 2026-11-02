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
// PRINCIPLE (doc/plan-unregistered-owner-egress.md §3.3 item 6, §8.4 F4).
// This is not a re-implementation of git's or ssh's URL handling, and it must
// not try to be. A push URL counts as "known non-GitHub" ONLY when the guard
// is positively sure it is somewhere else: a plain DNS host over http(s)/git,
// a `file://` URL, a local path, a remote name, or an ssh host that the ssh
// config positively maps to another plain host. EVERYTHING doubtful is
// UNRESOLVED, and rule h refuses an unresolved push when it is active and no
// person is present. A doubt costs a refusal, never a mis-attributed owner:
//
//   - URL-shaped but not cleanly `github.com/<owner>/<repo>` (userinfo tricks,
//     a port that is not a number, percent-encoding, backslashes, `..`, extra
//     path segments, a name outside `safeDestination`'s charset);
//   - an IP-literal host (v4, v6, or a numeric spelling of one), and any
//     `*.github.com` host other than github.com / ssh.github.com, whether named
//     directly or reached through an ssh `HostName`;
//   - a remote-helper address (`<helper>::<address>`) whose helper is not a
//     plain http(s)/ftp transport;
//   - an ssh host the ssh config cannot positively resolve (`ssh-config.ts`);
//   - a host that is not GitHub-looking while an ssh override is in effect
//     (`GIT_SSH_COMMAND`, `GIT_SSH`, `GIT_SSH_VARIANT`, `core.sshCommand`, or a
//     ProxyCommand/ProxyJump in the applying ssh config): see `resolveRemoteUrl`.
//
// Brackets: git strips `[` `]` from a host (`[github.com]:o/r`,
// `ssh://[github.com]/o/r`, `ssh://git@[github.com]/o/r`, `[github.com:22]:o/r`),
// so the inner host is classified; a real IP literal inside them is unresolved.
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

/** How the push travels. Only `ssh` is subject to an ssh override and to ssh config. */
export type RemoteTransport = "ssh" | "http";

/** What a remote URL turned out to be. */
export type RemoteUrlClass =
  | { kind: "github"; org: string; repo: string; transport: RemoteTransport }
  | { kind: "non-github" }
  /** URL-shaped, but not cleanly anything. `why` is a fixed, content-free phrase. */
  | { kind: "opaque"; why: string }
  /**
   * An ssh host that is not github.com: it may be an ssh-config alias for
   * GitHub. `legacy` marks the `github.com-<alias>` convention, which this
   * parser has always read as GitHub.
   */
  | { kind: "alias"; host: string; path: string; legacy: boolean };

/** `HostName` values (and literal ssh hosts) that ARE GitHub over ssh. */
const GITHUB_SSH_HOSTS: ReadonlySet<string> = new Set(["github.com", "ssh.github.com"]);
/** Hosts that ARE GitHub for an http(s) or git URL. */
const GITHUB_WEB_HOSTS: ReadonlySet<string> = new Set(["github.com", "www.github.com"]);

const LEGACY_ALIAS_RE = /^github\.com-[a-z0-9_-]+$/;
/** A host name an ssh alias lookup can be asked about. Anything else is opaque. */
const HOSTNAME_RE = /^[a-z0-9_]([a-z0-9._-]*[a-z0-9_])?$/;
/** Numeric spellings of an address: dotted quads, decimal/hex/octal integers, `0x7f.1`. */
const NUMERIC_HOST_RE = /^(0x[0-9a-f]+|\d+)(\.(0x[0-9a-f]+|\d+))*$/i;
/** Whitespace, control characters and backslashes make a URL's meaning depend on who parses it. */
// eslint-disable-next-line no-control-regex
const HOSTILE_CHARS_RE = /[\u0000-\u0020\u007f\\]/;
/** `<helper>::<address>`, git's remote-helper syntax. */
const HELPER_RE = /^([A-Za-z0-9+.-]+)::(.*)$/;
/** Helpers whose address is a plain URL for a transport this module classifies. */
const PLAIN_HELPERS: ReadonlySet<string> = new Set(["http", "https", "ftp", "ftps"]);

const OPAQUE = (why: string): RemoteUrlClass => ({ kind: "opaque", why });
const NOT_CLEAN = "the URL is not cleanly github.com/<owner>/<repo>";
const IP_HOST = "the host is an IP address, not a name";
const GITHUB_OTHER = "the host is a github.com subdomain other than ssh.github.com";

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

function githubOrOpaque(path: string, transport: RemoteTransport): RemoteUrlClass {
  const parsed = parseOwnerRepoPath(path);
  return parsed === null ? OPAQUE(NOT_CLEAN) : { kind: "github", ...parsed, transport };
}

/** A host name, lower-cased with one trailing dot removed. */
function normaliseHost(host: string): string {
  const h = host.toLowerCase();
  return h.endsWith(".") ? h.slice(0, -1) : h;
}

function isIpHost(host: string): boolean {
  return host.includes(":") || NUMERIC_HOST_RE.test(host);
}

/**
 * A host as written in a URL: `host`, `host:port` (URL form only), or a
 * bracketed `[host]`, `[host:port]`. git strips the brackets and uses the inner
 * host, so that is what is classified. Returns null for anything malformed.
 */
function parseHost(text: string, allowPort: boolean): { host: string; ip: boolean } | null {
  if (text.startsWith("[")) {
    const close = text.indexOf("]");
    if (close === -1) return null;
    const inner = text.slice(1, close);
    const after = text.slice(close + 1);
    if (after !== "") {
      if (!allowPort || !/^:\d{1,5}$/.test(after)) return null;
    }
    // `[host:port]` or `[host]`; two or more colons is an IPv6 literal.
    const colons = inner.split(":").length - 1;
    let host = inner;
    if (colons === 1) {
      const [h, port] = inner.split(":") as [string, string];
      if (!/^\d{1,5}$/.test(port)) return null;
      host = h;
    }
    host = normaliseHost(host);
    if (host === "") return null;
    return { host, ip: colons >= 2 || isIpHost(host) };
  }
  let host = text;
  const colon = text.lastIndexOf(":");
  if (colon !== -1) {
    if (!allowPort || !/^\d{1,5}$/.test(text.slice(colon + 1))) return null;
    host = text.slice(0, colon);
  }
  host = normaliseHost(host);
  if (host === "") return null;
  return { host, ip: isIpHost(host) };
}

/** Is `host` github.com itself under another name (`api.github.com`, `x.github.com`)? */
function isOtherGithubHost(host: string): boolean {
  return host !== "github.com" && host.endsWith(".github.com") && !GITHUB_SSH_HOSTS.has(host);
}

/**
 * Does the value look like a URL (rather than a remote name or a local path)?
 * `scheme://…`, a remote helper, or scp-like `host:path` with the first colon
 * before any slash. One-letter hosts count (`a:o/r` is ssh to host `a`); only a
 * Windows drive letter (`C:\…`), on Windows, is a local path.
 */
export function looksLikeRemoteUrl(value: string): boolean {
  if (value.includes("://")) return true;
  if (process.platform === "win32" && /^[A-Za-z]:[\\/]/.test(value)) return false;
  if (HELPER_RE.test(value)) return true;
  const colon = value.indexOf(":");
  const slash = value.indexOf("/");
  return colon >= 1 && (slash === -1 || colon < slash);
}

/** An ssh-transport host and path: github.com (and ssh.github.com), an alias, or a doubt. */
function sshTarget(host: string, ip: boolean, path: string): RemoteUrlClass {
  if (ip) return OPAQUE(IP_HOST);
  if (GITHUB_SSH_HOSTS.has(host)) return githubOrOpaque(path, "ssh");
  if (host === "www.github.com" || isOtherGithubHost(host)) return OPAQUE(GITHUB_OTHER);
  if (!HOSTNAME_RE.test(host)) return OPAQUE("the ssh host is not a plain host name");
  return { kind: "alias", host, path, legacy: LEGACY_ALIAS_RE.test(host) };
}

/** Classify a remote URL. Pure and total. */
export function classifyRemoteUrl(raw: unknown): RemoteUrlClass {
  if (typeof raw !== "string") return { kind: "non-github" };
  const url = raw.trim();
  if (url.length === 0) return { kind: "non-github" };

  // `<helper>::<address>`: git runs `git-remote-<helper>`. Only the plain
  // http(s)/ftp transports are understood; any other helper can send the bytes
  // anywhere (`ext::` runs a command), so it is unresolved.
  const helper = HELPER_RE.exec(url);
  if (helper !== null) {
    if (!PLAIN_HELPERS.has(helper[1]!.toLowerCase())) return OPAQUE("the URL uses a remote helper");
    const inner = helper[2]!;
    return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(inner) ? classifyRemoteUrl(inner) : OPAQUE("the URL uses a remote helper");
  }

  if (!looksLikeRemoteUrl(url)) return { kind: "non-github" }; // a name or a local path
  if (HOSTILE_CHARS_RE.test(url)) return OPAQUE(NOT_CLEAN);

  const schemeMatch = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(.*)$/.exec(url);
  if (schemeMatch === null && url.includes("://")) return OPAQUE(NOT_CLEAN);
  if (schemeMatch !== null) {
    const scheme = schemeMatch[1]!.toLowerCase();
    const rest = schemeMatch[2]!;
    if (scheme === "file") return { kind: "non-github" };
    const slash = rest.indexOf("/");
    const authority = slash === -1 ? rest : rest.slice(0, slash);
    const path = slash === -1 ? "" : rest.slice(slash + 1);
    const web = scheme === "http" || scheme === "https" || scheme === "git";
    const ssh = scheme === "ssh" || scheme === "git+ssh" || scheme === "ssh+git";
    if (!web && !ssh) {
      // A remote-helper scheme (`foo://`) runs `git-remote-foo`. Not a host
      // this parser understands: never positively non-GitHub.
      return OPAQUE("the URL uses a remote helper");
    }
    if (authority.includes("%")) return OPAQUE(NOT_CLEAN); // percent-encoding hides the real host
    const at = authority.split("@");
    if (at.length > 2) return OPAQUE(NOT_CLEAN); // `a@b@host`: ssh and URL parsers disagree on the host
    const parsed = parseHost(at[at.length - 1]!, true);
    if (parsed === null) return OPAQUE(NOT_CLEAN);
    const { host, ip } = parsed;
    if (web) {
      if (ip) return OPAQUE(IP_HOST);
      if (GITHUB_WEB_HOSTS.has(host)) return githubOrOpaque(path, "http");
      if (isOtherGithubHost(host)) return OPAQUE(GITHUB_OTHER);
      return { kind: "non-github" };
    }
    return sshTarget(host, ip, path);
  }

  // scp-like: [user@]host:path, or [user@][host]:path / [user@][host:port]:path.
  let hostText: string;
  let path: string;
  const bracketForm = /^(?:[^@[\]/:]+@)?\[/.exec(url);
  if (bracketForm !== null) {
    const bracket = bracketForm[0].length - 1;
    const close = url.indexOf("]", bracket);
    if (close === -1 || url[close + 1] !== ":") return OPAQUE(NOT_CLEAN);
    hostText = url.slice(bracket, close + 1);
    path = url.slice(close + 2).replace(/^\//, "");
  } else {
    const colon = url.indexOf(":");
    const left = url.slice(0, colon);
    path = url.slice(colon + 1).replace(/^\//, "");
    if (left.includes("%")) return OPAQUE(NOT_CLEAN);
    const at = left.split("@");
    if (at.length > 2) return OPAQUE(NOT_CLEAN);
    hostText = at[at.length - 1]!;
  }
  const parsed = parseHost(hostText, false);
  if (parsed === null) return OPAQUE(NOT_CLEAN);
  return sshTarget(parsed.host, parsed.ip, path);
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
    const g = githubOrOpaque(c.path, "ssh");
    if (g.kind === "github") return { host: "github.com", org: g.org, repo: g.repo };
  }
  return null;
}

/**
 * The ssh override in effect where a push runs (`detectSshOverride`, push-urls.ts):
 * `none`; `preserving` (only moves the connection, git still sends the path in
 * the URL); `other` (a program that can send a DIFFERENT path than the URL names).
 */
export type SshOverrideKind = "none" | "preserving" | "other";

/** Where a push URL goes, for rule h. */
export type RemoteTarget =
  | { kind: "github"; org: string; repo: string }
  /** Another host or a local path, positively: out of scope, as before. */
  | { kind: "non-github" }
  /** URL-shaped, but nothing offline can say which repository. Fail closed. `why` is a fixed phrase. */
  | { kind: "unresolved"; why: string };

/** Fixed, content-free phrase for an alias a lookup could not place. */
function aliasUnresolved(why: string): RemoteTarget {
  return { kind: "unresolved", why: `ssh host alias: ${why}` };
}

/**
 * Resolve a remote URL, consulting the user's ssh config for aliases, to a
 * GitHub repository, a non-GitHub host, or UNRESOLVED. Total: never throws.
 *
 * KEY RULE. An ssh redirect (an override, a proxy) changes which SERVER gets
 * the push, never the repository path sent to `git-receive-pack`. So:
 *
 * - A host that resolves to GitHub (literal github.com / ssh.github.com, or an
 *   alias whose ssh-config `HostName` is one of those) is GitHub: the owner in
 *   the path is judged, under a `preserving` override or none. If the override
 *   really sends the bytes to another server, they leave GitHub, which is
 *   outside the guard's model.
 * - Under an `other` override (a program git runs instead of plain ssh, which
 *   can rewrite the repository path in `git-receive-pack '<path>'`), EVERY ssh
 *   URL is unresolved, literal github.com included.
 * - Any OTHER ssh host (a plain non-GitHub name, an alias the config does not
 *   mention, an alias mapped to another host) is "not GitHub" only when no
 *   override is present. Under an override `ctx.sshOverride`, or a proxy in the
 *   applying ssh config, it is UNRESOLVED: that is exactly what a redirect to
 *   GitHub looks like. With no override at all, behaviour is unchanged.
 * - An alias whose `HostName` is an IP address or a github.com subdomain, or
 *   that the ssh-config parser cannot place (a `Match` block that sets
 *   HostName, an unreadable config), is unresolved.
 * - The `github.com-<alias>` convention stays GitHub when the config says
 *   nothing about it.
 * - `ctx.unknownDotlessUnresolved` (the agent hook sets it): a dotless host the
 *   ssh config does not map (`zz`) is unresolved whatever the override
 *   flag says. The hook process may not see the environment the agent's
 *   command runs in (Claude Code's sandbox sets `GIT_SSH_COMMAND` on every
 *   agent command, and the hook may run outside it), so it cannot know
 *   there is no override. A dotted non-GitHub host (gitlab.com) stays
 *   non-GitHub there; pre-push, which sees the real environment, catches that
 *   override case.
 */
export function resolveRemoteUrl(
  raw: unknown,
  lookup: (host: string) => SshHostLookup = lookupSshHost,
  ctx: { sshOverride?: SshOverrideKind; unknownDotlessUnresolved?: boolean } = {},
): RemoteTarget {
  try {
    const c = classifyRemoteUrl(raw);
    const override = ctx.sshOverride ?? "none";
    const programOverride = (): RemoteTarget => ({
      kind: "unresolved",
      why: "an ssh override program (GIT_SSH, or a GIT_SSH_COMMAND or core.sshCommand that is not plain ssh) can send a different repository path than the URL names",
    });
    switch (c.kind) {
      case "github":
        if (c.transport === "ssh" && override === "other") return programOverride();
        return { kind: "github", org: c.org, repo: c.repo };
      case "non-github":
        return { kind: "non-github" };
      case "opaque":
        return { kind: "unresolved", why: c.why };
      case "alias": {
        if (override === "other") return programOverride();
        const found = lookup(c.host);
        const asGithub = (): RemoteTarget => {
          const g = githubOrOpaque(c.path, "ssh");
          return g.kind === "github"
            ? { kind: "github", org: g.org, repo: g.repo }
            : { kind: "unresolved", why: NOT_CLEAN };
        };
        if (found.kind === "unresolved") return aliasUnresolved(found.why);
        const redirected = override !== "none" || found.proxied === true;
        const notGithub = (): RemoteTarget =>
          redirected
            ? aliasUnresolved("an ssh override or proxy is in effect, and a host that does not look like GitHub is what a redirect to GitHub looks like")
            : { kind: "non-github" };
        if (found.kind === "hostname") {
          const h = found.hostName;
          if (GITHUB_SSH_HOSTS.has(h)) return asGithub();
          if (isIpHost(h)) return aliasUnresolved(IP_HOST);
          if (h === "www.github.com" || isOtherGithubHost(h)) return aliasUnresolved(GITHUB_OTHER);
          return notGithub();
        }
        if (c.legacy) return asGithub();
        if (ctx.unknownDotlessUnresolved === true && !c.host.includes(".")) {
          return aliasUnresolved("a host name the ssh config does not map, and this process cannot see the environment ssh runs in");
        }
        return notGithub();
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
