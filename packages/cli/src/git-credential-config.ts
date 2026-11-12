// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Reading git's credential configuration, for the credential helper (A5), `install git-credential` (A6),
// `doctor` and the pre-push hook (A6). Everything below the `git` call is pure.
//
// WHY NOT `git config --get-urlmatch`. It returns ONE value per key: for a multi-valued key such as
// `credential.helper` it keeps only the last entry, so it cannot show which helper runs FIRST. The ordered list
// comes from `git config --show-scope --get-regexp`, which prints every entry in the order git reads it
// (system, global, local, worktree, command), and the URL matching of credential.c is applied here.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

export interface ConfigEntry {
  /** `system`, `global`, `local`, `worktree` or `command`. */
  scope: string;
  /** As git prints it: section and variable lower-cased, the subsection (a URL pattern) as written. */
  key: string;
  /** `null` for a valueless key (`[http] sslVerify`), which git reads as true. */
  value: string | null;
}

/** What git is about to authenticate: always https://github.com. `path` is null when not known (a probe). */
export interface CredentialContext {
  /** The path as git sent it (case and `.git` kept): git's own pattern comparison is case-sensitive on exactly this. */
  path: string | null;
  /** The normalised form (lower-case, no `.git`); a pattern applying to either path counts, the cautious reading. */
  altPath?: string | null;
}

/**
 * Scopes the user's own agent cannot write: `system`, and `unknown`, which is how Apple's git reports the
 * gitconfig bundled with the Command Line Tools (it carries `credential.helper osxkeychain`).
 */
const isSystemScope = (scope: string): boolean => scope === "system" || scope === "unknown";

/** How a scope reads in a message. */
export const scopeLabel = (scope: string): string => (scope === "unknown" ? "system (the git build's bundled config)" : scope);

const CONFIG_KEYS =
  "^(credential\\.|http\\.|core\\.(hookspath|fsmonitor|sshcommand)$|url\\..*\\.(insteadof|pushinsteadof)$)";

/** Parse `git config --show-scope --get-regexp` output (`scope<TAB>key value`). */
export function parseShowScopeList(out: string): ConfigEntry[] {
  const entries: ConfigEntry[] = [];
  for (const line of out.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    const scope = line.slice(0, tab);
    const rest = line.slice(tab + 1);
    const space = rest.indexOf(" ");
    const key = space === -1 ? rest : rest.slice(0, space);
    if (key === "") continue;
    entries.push({ scope, key, value: space === -1 ? null : rest.slice(space + 1) });
  }
  return entries;
}

/** An absolute `git`: the one next to git's own helpers when git set `GIT_EXEC_PATH`, else /usr/bin/git, else by name. */
export function gitBinary(env: NodeJS.ProcessEnv): string {
  const exec = env["GIT_EXEC_PATH"];
  if (exec !== undefined && exec !== "" && existsSync(`${exec}/git`)) return `${exec}/git`;
  return existsSync("/usr/bin/git") ? "/usr/bin/git" : "git";
}

/**
 * The credential, http and core entries git would read from `cwd`, in order. Null when git could not
 * be asked (a broken config file exits 128): the caller refuses, it does not guess.
 */
export function readCredentialConfig(cwd: string, env: NodeJS.ProcessEnv = process.env): ConfigEntry[] | null {
  const childEnv: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!k.startsWith("GIT_TRACE") && v !== undefined) childEnv[k] = v;
  childEnv["GIT_TERMINAL_PROMPT"] = "0";
  try {
    const out = execFileSync(gitBinary(env), ["config", "--show-scope", "--get-regexp", CONFIG_KEYS], {
      cwd,
      env: childEnv,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    });
    return parseShowScopeList(out);
  } catch (err) {
    // `--get-regexp` exits 1 when nothing matches: an empty configuration, not a failure.
    if ((err as { status?: number }).status === 1) return [];
    return null;
  }
}

// ---------------------------------------------------------------------------
// URL matching (credential.c)
// ---------------------------------------------------------------------------

/** The part of a key after `credential.` / `http.` split into subsection (URL pattern) and variable. */
function splitKey(key: string, section: string): { sub: string | null; name: string } | null {
  if (!key.startsWith(`${section}.`)) return null;
  const rest = key.slice(section.length + 1);
  const dot = rest.lastIndexOf(".");
  if (dot === -1) return { sub: null, name: rest };
  return { sub: rest.slice(0, dot), name: rest.slice(dot + 1) };
}

/**
 * Does the URL pattern of `credential.<pattern>.<var>` / `http.<pattern>.<var>` apply to https://github.com[/path]?
 * Scheme, host and port must match (a host-only pattern matches any scheme; port 443 is https' default; no
 * wildcards: `*.github.com` is not github.com). A path pattern needs a known path with the pattern as a prefix
 * on a segment boundary; with no known path (a probe) it is assumed to apply, which is the cautious reading.
 * A pattern with a user matches only a request that names that user, and a probe names none.
 */
export function patternApplies(pattern: string, ctx: CredentialContext): boolean {
  const m = /^(?:([A-Za-z][A-Za-z0-9+.-]*):\/\/)?(?:([^@/]*)@)?([^/:]+)(?::(\d+))?(\/.*)?$/.exec(pattern);
  if (m === null) return false;
  const [, scheme, user, host, port, path] = m;
  if (scheme !== undefined && scheme.toLowerCase() !== "https") return false;
  if (host!.toLowerCase() !== "github.com") return false;
  if (port !== undefined && port !== "443") return false;
  if (user !== undefined) return false;
  if (path !== undefined && path !== "/") {
    if (ctx.path === null) return true;
    const want = path.replace(/\/+$/, "").replace(/^\//, "");
    const applies = (candidate: string): boolean => {
      const have = candidate.replace(/^\//, "");
      return have === want || have.startsWith(`${want}/`);
    };
    // Raw first (git's rule), then the normalised form, and the pattern's own normalised form against it.
    const norm = (t: string): string => t.toLowerCase().replace(/\.git$/, "");
    const alt = ctx.altPath ?? null;
    if (applies(ctx.path)) return true;
    if (alt !== null && applies(alt)) return true;
    const wantNorm = norm(want);
    return [ctx.path, alt].some(c => c !== null && (norm(c.replace(/^\//, "")) === wantNorm || norm(c.replace(/^\//, "")).startsWith(`${wantNorm}/`)));
  }
  return true;
}

/** Entries of `section` whose URL pattern (when it has one) applies, with the variable name lower-cased. */
export function applicableEntries(
  entries: readonly ConfigEntry[],
  section: string,
  ctx: CredentialContext,
): { entry: ConfigEntry; name: string }[] {
  const out: { entry: ConfigEntry; name: string }[] = [];
  for (const entry of entries) {
    const parts = splitKey(entry.key, section);
    if (parts === null) continue;
    if (parts.sub !== null && !patternApplies(parts.sub, ctx)) continue;
    out.push({ entry, name: parts.name });
  }
  return out;
}

/** The helpers git would run for https://github.com, in order, after the last empty (reset) entry. */
export function effectiveHelpers(entries: readonly ConfigEntry[], ctx: CredentialContext): ConfigEntry[] {
  let list: ConfigEntry[] = [];
  for (const { entry, name } of applicableEntries(entries, "credential", ctx)) {
    if (name !== "helper") continue;
    if (entry.value === null) continue; // git rejects a valueless helper; it runs nothing
    if (entry.value === "") list = [];
    else list.push(entry);
  }
  return list;
}

// ---------------------------------------------------------------------------
// Order (A6)
// ---------------------------------------------------------------------------

export type OrderVerdict =
  | { kind: "first" }
  /** Our helper is configured, but another one answers before it. */
  | { kind: "behind"; precededBy: { scope: string; value: string } }
  /** The exact helper is not in the effective list; `stale` when a repo-aegis helper with a different command is. */
  | { kind: "missing"; stale: boolean };

/** Is `ours` the first helper git runs for https://github.com? */
export function helperOrder(entries: readonly ConfigEntry[], ours: string, ctx: CredentialContext = { path: null }): OrderVerdict {
  const list = effectiveHelpers(entries, ctx);
  const at = list.findIndex(e => e.value === ours);
  if (at === 0) return { kind: "first" };
  if (at > 0) return { kind: "behind", precededBy: { scope: list[0]!.scope, value: list[0]!.value ?? "" } };
  return { kind: "missing", stale: list.some(e => isRepoAegisHelperValue(e.value ?? "")) };
}

/** A configured helper that is some repo-aegis `git-credential` helper (this install's or an older one). */
export function isRepoAegisHelperValue(value: string): boolean {
  return /\bgit-credential --home /.test(value) && value.startsWith("!");
}

/** The config key repo-aegis writes its helper under. */
export const HELPER_KEY = "credential.https://github.com.helper";
export const USE_HTTP_PATH_KEY = "credential.https://github.com.useHttpPath";

/**
 * The entry list as it will read once `ours` is installed at global scope: after the last global empty entry
 * of {@link HELPER_KEY}, else before its first global entry, else after every system and global entry.
 */
export function withHelperInstalled(entries: readonly ConfigEntry[], ours: string): ConfigEntry[] {
  const mine: ConfigEntry = { scope: "global", key: HELPER_KEY, value: ours };
  const isKey = (e: ConfigEntry): boolean => e.scope === "global" && e.key === HELPER_KEY;
  const out = [...entries];
  let lastReset = -1;
  let first = -1;
  out.forEach((e, i) => {
    if (!isKey(e)) return;
    if (first === -1) first = i;
    if (e.value === "") lastReset = i;
  });
  let at: number;
  if (lastReset !== -1) at = lastReset + 1;
  else if (first !== -1) at = first;
  else {
    at = 0;
    out.forEach((e, i) => {
      if (isSystemScope(e.scope) || e.scope === "global") at = i + 1;
    });
  }
  out.splice(at, 0, mine);
  return out;
}

/**
 * The entry list as it will read once, at global scope, an empty reset entry, `ours` and then `readded` are written
 * (in that order) to a global `credential.https://github.com.helper` list that was empty.
 */
export function withResetAndHelperInstalled(entries: readonly ConfigEntry[], ours: string, readded: readonly string[]): ConfigEntry[] {
  const withReset = withHelperInstalled(entries, "");
  const out = withHelperInstalled(withReset, ours);
  const at = out.findIndex(e => e.scope === "global" && e.key === HELPER_KEY && e.value === ours);
  out.splice(
    at + 1,
    0,
    ...readded.map((value): ConfigEntry => ({ scope: "global", key: HELPER_KEY, value })),
  );
  return out;
}

/**
 * The helpers a reset entry written at global scope would hide, as values to write back after ours: the system and
 * global helpers that apply to https://github.com, in order, without repo-aegis's own and without duplicates.
 * `foreign` is true when one of them is set under another URL pattern (`credential.https://github.com/<path>.helper`
 * and the like): writing its value back under {@link HELPER_KEY} would change where it applies, so the caller must
 * not re-add anything.
 */
export function helpersHiddenByReset(entries: readonly ConfigEntry[], ctx: CredentialContext = { path: null }): { values: string[]; foreign: boolean } {
  const values: string[] = [];
  let foreign = false;
  for (const e of effectiveHelpers(entries, ctx)) {
    if (!isSystemScope(e.scope) && e.scope !== "global") continue;
    const v = e.value ?? "";
    if (isRepoAegisHelperValue(v)) continue;
    if (e.key !== "credential.helper" && e.key !== HELPER_KEY) {
      foreign = true;
      continue;
    }
    if (v.includes("\n")) {
      foreign = true;
      continue;
    }
    if (!values.includes(v)) values.push(v);
  }
  return { values, foreign };
}

// ---------------------------------------------------------------------------
// A5: configuration that can redirect or capture the token
// ---------------------------------------------------------------------------

const FALSY = /^(false|no|off|0|)$/i;

/**
 * A fixed phrase naming why the token must not be handed over, or null. Checked only for a push the helper would
 * answer. Covers the honest mistakes that would leak a token into a trace or a helper that stores it: a helper
 * from local, worktree or command scope (it would be handed the token by `store`); the environment variables
 * that trace the HTTP exchange (`GIT_TRACE_CURL`, `GIT_CURL_VERBOSE`, `GIT_TRACE_PACKET`) or turn the redaction
 * of those traces off (`GIT_TRACE_REDACT`).
 *
 * Deliberately NOT judged (P1-A): `http.proxy` and the proxy variables (the default Claude Code sandbox sets one
 * on every command, and a CONNECT proxy cannot read TLS), a CA bundle (`sslCAInfo`, `sslCAPath`, `sslBackend`:
 * planting one is an attack, not an accident), `extraHeader`, and `sslVerify=false`, which only warns
 * ({@link credentialConfigWarnings}).
 */
export function credentialConfigViolation(
  entries: readonly ConfigEntry[],
  ctx: CredentialContext,
  env: NodeJS.ProcessEnv,
): string | null {
  for (const e of effectiveHelpers(entries, ctx)) {
    if (isSystemScope(e.scope) || e.scope === "global") continue;
    // repo-aegis's own helper and `gh auth git-credential` never persist what `store` hands them, so their scope
    // does not matter: a tool that nulls the global config and re-applies the person's credential.* entries with
    // `-c` / GIT_CONFIG_COUNT moves exactly these into command scope. A helper that stores is judged by
    // laterStoringHelper, whatever its scope.
    const v = e.value ?? "";
    if (isRepoAegisHelperValue(v) || isGhHelperValue(v)) continue;
    return `a credential helper is configured in ${e.scope} scope`;
  }
  return environmentViolation(env);
}

/**
 * Notes, not refusals: `http.sslVerify` off in a non-system scope, and `GIT_SSL_NO_VERIFY` in the environment.
 * Turning verification off is a common honest mistake (a corporate proxy); it is the person's setting, so the
 * helper says so on stderr and goes on. Fixed phrases.
 */
export function credentialConfigWarnings(entries: readonly ConfigEntry[], ctx: CredentialContext, env: NodeJS.ProcessEnv): string[] {
  const phrases: string[] = [];
  for (const { entry, name } of applicableEntries(entries, "http", ctx)) {
    if (isSystemScope(entry.scope) || name !== "sslverify") continue;
    // A valueless key reads as true, so only an explicit falsy value counts.
    if (entry.value !== null && FALSY.test(entry.value)) {
      const phrase = `http.sslVerify is off in ${entry.scope} scope`;
      if (!phrases.includes(phrase)) phrases.push(phrase);
    }
  }
  const noVerify = env["GIT_SSL_NO_VERIFY"];
  if (noVerify !== undefined && noVerify !== "") phrases.push("GIT_SSL_NO_VERIFY is set in the environment");
  return phrases.map(
    phrase =>
      `repo-aegis: warning: ${phrase}, so TLS certificates are not checked for this push; the token was given anyway. \`git config --list --show-origin\` names the file to remove it from.\n`,
  );
}

/** The environment half of A5. Null when clean. */
export function environmentViolation(env: NodeJS.ProcessEnv): string | null {
  const set = (name: string): boolean => {
    const v = env[name];
    return v !== undefined && v !== "";
  };
  for (const name of ["GIT_TRACE_CURL", "GIT_CURL_VERBOSE", "GIT_TRACE_PACKET"]) {
    if (set(name)) return `${name} is set in the environment`;
  }
  const redact = env["GIT_TRACE_REDACT"];
  if (redact !== undefined && FALSY.test(redact) && redact !== "") return "GIT_TRACE_REDACT is off in the environment";
  return null;
}

// ---------------------------------------------------------------------------
// Helpers after ours: who would be handed the token by `store`
// ---------------------------------------------------------------------------

/** A configured helper value that is `gh auth git-credential` (any path to gh): it never persists what it is handed. */
export function isGhHelperValue(value: string): boolean {
  return /^!?\s*(?:'[^']*gh'|"[^"]*gh"|\S*\/gh|gh)\s+auth\s+git-credential\s*$/.test(value);
}

/** What kind of helper a value is, for a message: its program name without `git-credential-`, or "an unrecognised helper". */
export function helperKind(value: string): string {
  const word = /^!?\s*(?:'([^']*)'|"([^"]*)"|(\S+))/.exec(value);
  const prog = word?.[1] ?? word?.[2] ?? word?.[3];
  if (prog === undefined) return "an unrecognised helper";
  const base = prog.split("/").pop() ?? prog;
  const name = base.replace(/^git-credential-/, "");
  return /^(osxkeychain|store|cache|manager|manager-core|git-credential-manager|libsecret|wincred)$/.test(name) ? name : "an unrecognised helper";
}

/**
 * After a push, git sends `store` to EVERY helper in the list. The first later helper that is neither repo-aegis's
 * nor `gh auth git-credential` could persist the App token (osxkeychain, store, cache, a credential manager,
 * libsecret, wincred, or anything unrecognised). Returns that helper's kind, or null. Only helpers after the first
 * repo-aegis helper count.
 */
export function laterStoringHelper(entries: readonly ConfigEntry[], ctx: CredentialContext): string | null {
  const list = effectiveHelpers(entries, ctx);
  const at = list.findIndex(e => isRepoAegisHelperValue(e.value ?? ""));
  if (at === -1) return null;
  for (const e of list.slice(at + 1)) {
    const v = e.value ?? "";
    if (isRepoAegisHelperValue(v) || isGhHelperValue(v)) continue;
    return helperKind(v);
  }
  return null;
}

// ---------------------------------------------------------------------------
// gh's git children (doc/plan-owner-identity.md A2, H1)
// ---------------------------------------------------------------------------

/**
 * A fixed phrase naming why a `gh` verb that runs `git` in this directory must not carry a token, or null.
 * The environment overrides `repo-aegis gh` gives gh's git children cover most of this, but git reads them
 * BEFORE a command-line `-c`, and a repository can hold what a clone or checkout then runs or follows, so the
 * effective configuration is judged as well: `core.hooksPath`, `core.fsmonitor` (anything but off) and
 * `core.sshCommand` from local, worktree or command scope; `url.<base>.insteadOf` / `pushInsteadOf` from those
 * scopes (it re-points the remote the token is sent to); and everything {@link credentialConfigViolation} judges
 * (`credential.helper` outside system and global scope, the trace variables). `env` is the CHILD's environment,
 * which the gh wrapper allowlists, so it is `{}` there.
 */
export function gitSpawnViolation(entries: readonly ConfigEntry[], ctx: CredentialContext, env: NodeJS.ProcessEnv): string | null {
  for (const e of entries) {
    if (isSystemScope(e.scope) || e.scope === "global") continue;
    const v = e.value;
    if (e.key === "core.hookspath" && v !== null && v !== "") return `core.hooksPath is set in ${e.scope} scope`;
    if (e.key === "core.fsmonitor" && v !== null && !FALSY.test(v)) return `core.fsmonitor is set in ${e.scope} scope`;
    if (e.key === "core.sshcommand" && v !== null && v !== "") return `core.sshCommand is set in ${e.scope} scope`;
    if (/^url\..*\.(insteadof|pushinsteadof)$/.test(e.key)) return `a url.<base>.insteadOf rewrite is set in ${e.scope} scope`;
  }
  return credentialConfigViolation(entries, ctx, env);
}
