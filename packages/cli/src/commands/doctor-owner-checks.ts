// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `doctor`'s registered-owner checks (doc/plan-unregistered-owner-egress.md
// §3.8, issue #151): is the registry usable for rule h, and do the GitHub
// accounts on this machine own things the registry does not know about?
//
// Two groups:
//
//   registryStateChecks  pure, offline: OWNERS_UNDECLARED, REGISTRY_UNREADABLE and REGISTRY_ENCRYPTED.
//   ghOwnerChecks        best-effort, network via `gh`: GH_LOGIN_UNREGISTERED,
//                        GH_MEMBER_ORG_UNREGISTERED, REGISTERED_ORG_NOT_MEMBER.
//
// REDACTION. Doctor output can land in an agent transcript, and a membership
// list can contain customer names. So org and owner names appear only in a
// check's `fix` and in `--json`, never in `detail` (the line that gets copied
// into tickets). The one thing `detail` does name is the gh ACCOUNT a finding
// applies to, because several accounts are checked and a finding that does not
// say which one is useless (§3.8, amendment of 2026-11-02).
//
// MULTIPLE ACCOUNTS. Other agent sessions switch the active `gh` account at
// will, so the active account at the moment doctor runs is arbitrary. Doctor
// therefore checks EVERY account logged in for github.com: it lists them,
// fetches each account's token with `gh auth token --user <login>`, and hands
// it to the child `gh` through the child's environment only. It NEVER runs
// `gh auth switch` (that would change the account under other sessions), and
// the token is never printed, logged, stored, put in an argument vector, or
// echoed into an error message. The only things read from a child are the
// token (held in one local variable), logins and org slugs.
//
// WHICH `gh`. Handing a token to a binary is only as safe as the binary. A `gh`
// placed earlier on PATH (in `~/bin`, say, which an agent can write to) would
// receive every account's token the moment a person ran doctor. So:
//
//   - the gh checks are skipped when another gh precedes the repo-aegis shim,
//     or when the gh we would spawn is not the one the shim would run;
//   - only absolute PATH entries count (an empty or relative entry resolves
//     against the cwd), and the resolved real path is what is spawned;
//   - the PATH entry's OWN directory and the resolved real path are each refused
//     under $HOME, the cwd or a temp directory, and when their directory is
//     group/world-writable or not owned by root (or by the user inside a
//     package-manager prefix such as /opt/homebrew). Vetting only the target is
//     not enough: `~/bin/gh -> /bin/sh` has a root-owned target, and `sh` then
//     runs `./auth` from the cwd as a script;
//   - the real path must itself BE a gh: named `gh`, and either a standard
//     install path or inside `<prefix>/Cellar/gh/` / `<prefix>/opt/gh/` of a
//     known Homebrew prefix. A symlink to any other program is refused;
//   - before any non-active token is read, a gh configured to redirect requests
//     (`http_unix_socket`, GH_CONFIG_DIR, GH_HOST, token variables in the
//     environment) is refused: it would hand every token to a socket or server
//     the person did not choose;
//   - the active account is checked without ever reading a token (`gh api`
//     runs as the active login); another account's token is read only after a
//     y/N on a stdin TTY that names the gh binary, and never without a TTY.
import { spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, sep } from "node:path";
import {
  classifyRemoteUrl,
  parseRemoteUrlResolved,
  registeredOwners,
  repoAegisHome,
  resolvePushUrls,
  safeDestination,
  type Registry,
  type RegistryLoad,
} from "@de-otio/repo-aegis-core";
import { PERSON_RUNS_THIS, type DoctorCheck } from "./doctor-checks.js";
import { checkShim } from "./install-shim.js";
import { readPinnedTaaad, taaadTrustProblem } from "./taaad-pin.js";
import { confirmOnTerminal, isHumanTerminal } from "../require-terminal.js";

const HOST = "github.com";
/** One `gh` call must not hang `doctor`: this runs on a developer's machine, interactively. */
const GH_TIMEOUT_MS = 20_000;
/** `gh api user/orgs --paginate` for an account in hundreds of orgs is still well under this. */
const GH_MAX_BUFFER = 8 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Registry state (D4)
// ---------------------------------------------------------------------------

/**
 * `REGISTRY_UNREADABLE` (a FAILURE, decision D4), `REGISTRY_ENCRYPTED` (a warning) and `OWNERS_UNDECLARED`.
 *
 * A registry that exists but cannot be read (it does not parse or validate, or a newer repo-aegis wrote it) makes
 * rule h ask or refuse every non-interactive egress that has a destination, so it is a failure and not a warning.
 * An encrypted-at-rest registry is read as no registry at all (encryption at rest is deprecated), so it is a
 * warning: nothing is refused, but rule h and the identity mapping are off. A missing registry is not a finding
 * here: rule h is skipped by design when no registry exists, and a machine that never set repo-aegis up has nothing
 * to fix.
 *
 * No message includes the loader's error text: zod and YAML messages can name orgs and engagement ids.
 */
export function registryStateChecks(load: RegistryLoad): DoctorCheck[] {
  if (load.state === "unparseable" || load.state === "newer-schema") {
    return [
      {
        code: "REGISTRY_UNREADABLE",
        ok: false,
        detail:
          (load.state === "newer-schema"
            ? "the registry was written by a newer repo-aegis than this one"
            : "the registry exists but does not parse or validate") +
          ", so rule h asks (agent hook) or refuses (pre-push, the gh shim) every non-interactive egress that has a destination; " +
          "a person at a terminal can still publish",
        fix:
          load.state === "newer-schema"
            ? `upgrade repo-aegis (this one reads schemaVersion up to ${load.max}), then run \`repo-aegis install hooks\` and \`repo-aegis install claude-md\``
            : "repair or restore the registry file (run `repo-aegis status` for the parse error), then re-run doctor",
      },
    ];
  }
  if (load.state === "encrypted") {
    return [
      {
        code: "REGISTRY_ENCRYPTED",
        ok: false,
        severity: "warn",
        detail:
          "the registry is encrypted at rest, so repo-aegis runs as if there were none: rule h and the GitHub identity mapping are off; " +
          "marker scanning (`_always` and engagement files) is unaffected. Encryption at rest is removed in 0.15.0",
        fix: `repo-aegis registry decrypt --identity <your age identity file>   (${PERSON_RUNS_THIS})`,
      },
    ];
  }
  if (load.state === "loaded" && registeredOwners(load.registry).size === 0) {
    return [
      {
        code: "OWNERS_UNDECLARED",
        ok: false,
        detail:
          "the registry loads but declares no owners (no personalOrgs and no engagement githubOrgs), " +
          "so rule h is inert: it refuses nothing, whoever the destination is",
        fix: `repo-aegis engagements add --personal-org <your GitHub login>   (${PERSON_RUNS_THIS})`,
      },
    ];
  }
  return [];
}

/**
 * `OWNER_IDENTITY_UNMAPPED`: ONE finding for all registered owners that have no identity entry (no `person`
 * and no `agent`). A warning, because an unmapped owner keeps passing through unchanged (N11); a FAILURE when
 * the registry sets `requireIdentity`, because then an agent write to one is refused. The owners are named in
 * `names` only (`--json`), never in `detail` or `fix` (owners can be customer names). One finding rather than
 * one per owner: with the owners kept out of the text, per-owner lines read as the same line repeated.
 */
export function ownerIdentityChecks(registry: Registry): DoctorCheck[] {
  // P3-C: with no identity defined in the registry at all, "unmapped" is every owner and says nothing: the
  // person has not opted in to identities. The finding only means something once an identity exists.
  if ((registry.identities?.size ?? 0) === 0) return [];
  const mapped = registry.identityMap ?? new Map();
  const required = registry.requireIdentity === true;
  const unmapped = [...registeredOwners(registry)].filter(owner => !mapped.has(owner)).sort();
  if (unmapped.length === 0) return [];
  const n = `${unmapped.length} registered owner(s)`;
  return [
    {
      code: "OWNER_IDENTITY_UNMAPPED" as const,
      ok: false,
      ...(required ? {} : { severity: "warn" as const }),
      names: unmapped,
      detail: required
        ? `${n} are still unmapped (listed in --json), and requireIdentity is set, so an agent write to one with no identity entry is refused`
        : `${n} have no identity entry (listed in --json), so no GitHub identity is recorded for them`,
      fix:
        "map each owner to an identity: repo-aegis identity add <name> --gh-login <login>, then " +
        `repo-aegis engagements set-identity (<engagement-id> | --personal-org <org>) --person <name>   (${PERSON_RUNS_THIS})`,
    },
  ];
}

/**
 * `AGENT_REMOTE_IS_SSH` (warn), per repository (doc/plan-landscape-recommendations.md U3): the owner's AGENT
 * identity is a GitHub App, and `origin`'s push URL is SSH. An agent's SSH push goes out as the person's key,
 * not the App, so `git push origin` is refused (`AGENT_PUSH_NEEDS_APP`); only an HTTPS push gets the App's
 * narrowed token. The fix is one person-run line that moves ONLY the push URL, so a person's fetches and own
 * pushes keep their SSH remote:
 * `git remote set-url --push origin https://github.com/<org>/<repo>.git`.
 *
 * Null (nothing to say) when the owner has no App agent identity, when `origin` has no push URL, or when every
 * push URL is already HTTPS. The owner and repository are named in `fix` only, like every owner name here
 * (`detail` is the line that gets copied out of a terminal). Never throws; `resolve` is a seam for the push URLs.
 */
export function agentRemoteSshCheck(
  wt: string,
  org: string,
  registry: Registry,
  resolve: (cwd: string, remote: string) => string[] | null = resolvePushUrls,
): DoctorCheck | null {
  try {
    if (registry.identityMap?.get(org.toLowerCase())?.agent?.kind !== "github-app") return null;
    const urls = resolve(wt, "origin");
    const ssh = urls?.find(u => {
      const c = classifyRemoteUrl(u);
      return c.kind === "github" ? c.transport === "ssh" : c.kind === "alias";
    });
    if (ssh === undefined) return null;
    const parsed = parseRemoteUrlResolved(ssh);
    const safe = parsed === null ? null : safeDestination(parsed.org, parsed.repo);
    const target = safe === null ? `${org.toLowerCase()}/<repo>` : `${safe.org}/${safe.repo}`;
    return {
      code: "AGENT_REMOTE_IS_SSH",
      ok: false,
      severity: "warn",
      detail:
        "this owner has a GitHub App identity for agents, and origin's push URL is SSH, which goes out as the person's SSH key instead of the App, " +
        "so an agent's `git push origin` is refused; only an HTTPS push gets the App's narrowed token. A person runs the fix: " +
        "it changes the push URL only, so fetches and the person's own pushes are unaffected",
      fix: `git remote set-url --push origin https://github.com/${target}.git`,
    };
  } catch {
    return null;
  }
}

/** True when some owner's agent identity is a GitHub App, i.e. an agent call for it needs a minted App token. */
export function hasAppAgentIdentity(registry: Registry): boolean {
  for (const entry of registry.identityMap?.values() ?? []) if (entry.agent?.kind === "github-app") return true;
  return false;
}

/**
 * `TAAAD_AGENT_WRITABLE` (doc/plan-owner-identity.md A4, as amended by §2.1 / Q5): the taaad that
 * the `gh` shim mints App tokens through must be pinned by `install shim` (a FAILURE when an owner's AGENT
 * identity is a github-app and nothing is pinned: no token can be minted, so calls for that owner are refused).
 * Whether it is root-owned is a WARNING only. The pin is always reported (paths of tools, never owners).
 *
 * Reported ONLY when some owner actually maps an App in its `agent` column (X-9). taaad mints the agent's App
 * token; a registry with no App agent identity has no use for it, so there is nothing to pin, nothing refused
 * and nothing to warn about, whether or not a taaad happens to be installed or pinned.
 */
export function taaadChecks(registry: Registry, home: string = repoAegisHome()): DoctorCheck[] {
  if (!hasAppAgentIdentity(registry)) return [];
  const pin = readPinnedTaaad(home);
  const fix = "install taaad v0.6.0 or later, then re-run `repo-aegis install shim`";
  const hardenFix =
    "optional: install taaad into a root-owned prefix (for example `sudo pipx install --global taaad`), remove any " +
    "user-level copy, then re-run `repo-aegis install shim`";
  if (pin === null) {
    return [
      {
        code: "TAAAD_AGENT_WRITABLE",
        ok: false,
        detail: "a github-app identity is mapped but no taaad is pinned by the `gh` shim, so no App token can be minted and calls for that owner are refused",
        fix,
      },
    ];
  }
  const problem = taaadTrustProblem(pin);
  const where = `launcher ${pin.launcher}, interpreter ${pin.interpreter}, package directory ${pin.packageDir}`;
  if (problem === null) {
    return [{ code: "TAAAD_AGENT_WRITABLE", ok: true, detail: `taaad is pinned and root-owned (${where})` }];
  }
  // Always a warning, never a refusal (owner decision 2026-11-08, plan §2.1 / Q5): App identities keep working;
  // the weakness only matters against an agent that deliberately edits taaad's code.
  return [
    {
      code: "TAAAD_AGENT_WRITABLE",
      ok: false,
      severity: "warn",
      detail:
        `taaad is pinned (${where}) but is not root-only-writable: ${problem}. ` +
        "App identities still work; an agent that edits taaad's code could capture the tokens it mints",
      fix: hardenFix,
    },
  ];
}

// ---------------------------------------------------------------------------
// Locating and running `gh`
// ---------------------------------------------------------------------------

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * The `gh` the repo-aegis shim would run: the first executable `gh` on an
 * ABSOLUTE PATH entry that is not the shim's own directory. Null when there is
 * none.
 *
 * Empty and relative entries are skipped, never resolved: `""` means the cwd to
 * a shell, and a relative entry means whatever directory doctor was started in.
 * Both are places an agent can put a file. Doctor spawns the path returned here
 * (by absolute path), so nothing is re-resolved through PATH at spawn time, and
 * in particular the shim cannot be reached by accident.
 */
export function findRealGh(env: NodeJS.ProcessEnv): string | null {
  const pathValue = env["PATH"];
  if (pathValue === undefined || pathValue === "") return null;
  const shimDir = canonical(join(env["REPO_AEGIS_HOME"] ?? repoAegisHome(), "bin"));
  for (const entry of pathValue.split(delimiter)) {
    if (entry === "" || !isAbsolute(entry)) continue;
    const candidate = join(entry, "gh");
    try {
      const st = statSync(candidate);
      if (!st.isFile() || (st.mode & 0o111) === 0) continue;
    } catch {
      continue;
    }
    if (canonical(dirname(candidate)) === shimDir) continue;
    return candidate;
  }
  return null;
}

/** Where a package manager installs `gh`, in order of preference. */
export const FIXED_GH_PATHS: readonly string[] = [
  "/opt/homebrew/bin/gh",
  "/usr/local/bin/gh",
  "/usr/bin/gh",
  "/home/linuxbrew/.linuxbrew/bin/gh",
];

/** Prefixes whose directories a package manager owns as the user rather than as root. */
const PACKAGE_PREFIXES: readonly string[] = ["/opt/homebrew", "/usr/local", "/home/linuxbrew/.linuxbrew", "/opt/local"];

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** Homebrew prefixes whose `Cellar/gh/` and `opt/gh/` hold a real gh. */
const BREW_PREFIXES: readonly string[] = ["/opt/homebrew", "/usr/local", "/home/linuxbrew/.linuxbrew"];

/**
 * Why `real` (already symlink-resolved) is not a gh we know how to recognise, or
 * null. It must be named `gh` AND be a standard install path or sit inside a
 * Homebrew `Cellar/gh/` or `opt/gh/`. This is what stops `~/bin/gh -> /bin/sh`
 * (or `/usr/bin/env`, or a Homebrew interpreter): their targets are root-owned,
 * so a permissions test alone passes them.
 */
export function ghLocationReason(real: string): string | null {
  if (!isAbsolute(real)) return "its path is relative";
  if (basename(real) !== "gh") return "the file it resolves to is not named gh (a link to another program)";
  if (FIXED_GH_PATHS.includes(real) || FIXED_GH_PATHS.map(canonical).includes(real)) return null;
  for (const prefix of BREW_PREFIXES) {
    if (real.startsWith(`${prefix}/Cellar/gh/`) || real.startsWith(`${prefix}/opt/gh/`)) return null;
  }
  return "it is not a standard gh install path or a Homebrew gh";
}

/**
 * Why files in directory `dir` (already symlink-resolved) must not be trusted
 * with a token, or null: under `$HOME`, the cwd or a temp directory; or
 * group/world-writable; or owned by neither root nor (inside a package-manager
 * prefix) the user.
 */
export function untrustedDirReason(
  dir: string,
  env: NodeJS.ProcessEnv,
  /**
   * `skipLocationRoots` is a test seam: skip the home/cwd/temp roots so the
   * permission and ownership branches can be exercised from a temp dir.
   * `afterRoots` lets {@link untrustedGhReason} slot the file's own check in
   * between the location test and the directory's mode and owner.
   */
  opts: { skipLocationRoots?: boolean; afterRoots?: () => string | null } = {},
): string | null {
  if (!isAbsolute(dir)) return "its path is relative";

  const roots: Array<[string, string]> = [];
  const add = (dir: string | undefined, label: string): void => {
    if (dir === undefined || dir === "" || dir === sep) return;
    roots.push([canonical(dir), label]);
  };
  add(env["HOME"], "your home directory");
  try {
    add(userInfo().homedir, "your home directory");
  } catch {
    /* no passwd entry */
  }
  add(process.cwd(), "the current directory");
  add(env["TMPDIR"], "a temporary directory");
  add(tmpdir(), "a temporary directory");
  for (const t of ["/tmp", "/var/tmp", "/private/tmp", "/private/var/tmp"]) add(t, "a temporary directory");
  for (const [root, label] of opts.skipLocationRoots === true ? [] : roots) {
    if (within(dir, root)) return `it is under ${label}, which an agent can write to`;
  }
  const between = opts.afterRoots?.() ?? null;
  if (between !== null) return between;

  try {
    const st = statSync(dir);
    if ((st.mode & 0o022) !== 0) return "its directory is writable by group or others";
    const uid = typeof process.getuid === "function" ? process.getuid() : -1;
    const packageManaged = PACKAGE_PREFIXES.some(prefix => within(dir, prefix));
    if (st.uid !== 0 && !(packageManaged && st.uid === uid)) {
      return "its directory is not owned by root or a package manager";
    }
  } catch {
    return "its location could not be inspected";
  }
  return null;
}

/**
 * Why `realPath` must not be handed a token, or null when it may be: its
 * directory fails {@link untrustedDirReason}, or the file itself is writable by
 * group or others. `realPath` is already symlink-resolved. This does not say
 * the file IS a gh: see {@link ghLocationReason}.
 */
export function untrustedGhReason(
  realPath: string,
  env: NodeJS.ProcessEnv,
  opts: { skipLocationRoots?: boolean } = {},
): string | null {
  if (!isAbsolute(realPath)) return "its path is relative";
  return untrustedDirReason(dirname(realPath), env, {
    ...opts,
    afterRoots: () => {
      try {
        return (statSync(realPath).mode & 0o022) !== 0 ? "the file is writable by group or others" : null;
      } catch {
        return "its location could not be inspected";
      }
    },
  });
}

export interface GhCheckOptions {
  /**
   * Test seam. `"permissive"` skips the binary-location policy, because fake
   * `gh` stubs live in temp directories, which the default policy refuses. There
   * is deliberately no environment variable for this: an agent controls the
   * environment, not this call.
   */
  policy?: "default" | "permissive";
  /**
   * Test seam. Under the default policy, skip the directory tests (home / cwd /
   * temp, mode, owner) but keep the "is this file a gh" test, so a case can prove
   * that test is wired in on its own, from a temp directory that the directory
   * tests would refuse first.
   */
  skipDirectoryChecks?: boolean;
  /**
   * Asked before any NON-active account's token is read. Default: a y/N on a
   * stdin TTY that names the gh binary; false without one.
   */
  confirm?: (ghPath: string, logins: string[]) => boolean;
}

function defaultConfirm(ghPath: string, logins: string[]): boolean {
  // A bare "stdin and stderr are TTYs" is a speed bump, not proof of a person:
  // a pty wrapper gives an agent both. `isHumanTerminal()` adds the
  // agent-ancestry and positive-root checks (issue #151, PR 2b).
  if (!process.stdin.isTTY || !isHumanTerminal()) return false;
  return confirmOnTerminal(
    `doctor will read the stored token of ${logins.length} other logged-in gh account(s) (${logins.join(", ")}) ` +
      `and hand each to this binary:\n  ${ghPath}\nOnly answer y if that is the gh you installed.`,
    "Read those tokens?",
  );
}

type GhResolution =
  | { kind: "ok"; path: string; extra: DoctorCheck[] }
  | { kind: "skip"; reason: string; extra: DoctorCheck[] };

function untrusted(detail: string): DoctorCheck {
  return {
    code: "GH_BINARY_UNTRUSTED",
    ok: false,
    severity: "warn",
    detail,
    fix: "install gh from your package manager into a root-owned or package-manager directory, and keep user-writable directories out of PATH ahead of it",
  };
}

/** Choose the gh doctor may talk to, or say why none. */
function resolveGh(
  env: NodeJS.ProcessEnv,
  policy: "default" | "permissive",
  skipDirectoryChecks = false,
  requireShimFirst = true,
): GhResolution {
  // (a) Another gh ahead of the shim: whatever agents run is not what we would spawn. (`repo-aegis gh` is
  // already running BEHIND the shim, so it does not ask: it only needs a gh it may hand a token.)
  if (requireShimFirst && checkShim(env).some(c => c.code === "SHIM_NOT_FIRST" && !c.ok)) {
    return { kind: "skip", reason: "another `gh` precedes the repo-aegis shim on PATH, so doctor cannot tell which gh would run", extra: [] };
  }
  const onPath = findRealGh(env);
  if (onPath === null) {
    return { kind: "skip", reason: "`gh` is not installed (or only the repo-aegis shim is on PATH)", extra: [] };
  }
  const real = canonical(onPath);
  if (policy === "permissive") return { kind: "ok", path: real, extra: [] };

  const extra: DoctorCheck[] = [];
  // Three independent questions, any one of which refuses: is the directory it
  // was found in safe (`~/bin`), is the resolved file in a safe place, and is the
  // resolved file actually a gh (not `/bin/sh` behind a link named gh).
  const bad =
    (skipDirectoryChecks ? null : untrustedDirReason(canonical(dirname(onPath)), env)) ??
    (skipDirectoryChecks ? null : untrustedGhReason(real, env)) ??
    ghLocationReason(real);
  const standard = FIXED_GH_PATHS.map(canonical).find(p => {
    try {
      return statSync(p).isFile() && untrustedGhReason(p, env) === null && ghLocationReason(p) === null;
    } catch {
      return false;
    }
  });
  if (bad !== null) {
    extra.push(
      untrusted(
        `the gh first on PATH (${onPath}) is not trusted: ${bad}` +
          (standard !== undefined ? `; a standard install exists at ${standard} but is not the gh that agents would run` : ""),
      ),
    );
    return {
      kind: "skip",
      reason: "the gh first on PATH is not in a trusted location, so no account token is handed to it",
      extra,
    };
  }
  if (standard !== undefined && standard !== real) {
    extra.push(untrusted(`the gh first on PATH (${onPath}) is not the standard install (${standard})`));
  }
  return { kind: "ok", path: real, extra };
}

/**
 * The `gh` that `repo-aegis gh` may hand a token (doc/plan-owner-identity.md D3): the same vetting as `doctor`
 * (absolute PATH entries only, a directory neither under HOME, the cwd nor a temp directory nor writable by
 * others, a file that is really a gh), without the "is the shim first on PATH" question. `policy: "permissive"`
 * is a test seam (stubs live in temp directories); there is no environment variable for it.
 */
export function resolveTrustedGh(
  env: NodeJS.ProcessEnv,
  policy: "default" | "permissive" = "default",
): { kind: "ok"; path: string } | { kind: "skip"; reason: string } {
  const res = resolveGh(env, policy, false, false);
  return res.kind === "ok" ? { kind: "ok", path: res.path } : { kind: "skip", reason: res.reason };
}

/** Variables that would make a child `gh` act as an account other than the one we mean. */
/**
 * Environment variables that make gh talk to a server or account the person did
 * not pick at the terminal. Names only are ever reported, never values.
 */
export const GH_REDIRECT_ENV = [
  "GH_CONFIG_DIR",
  "GH_HOST",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
];

/**
 * Why gh is configured so that another account's token must not be read with
 * it, or null. A trusted gh binary is still steerable: `http_unix_socket` in its
 * config sends every request, token included, to a local socket; `GH_CONFIG_DIR`
 * points it at a different config (and so a different socket and host list); and
 * `GH_HOST` or a token variable changes which server or account it means.
 */
function redirectReason(gh: string, env: NodeJS.ProcessEnv): string | null {
  const set = GH_REDIRECT_ENV.filter(k => (env[k] ?? "") !== "");
  if (set.length > 0) return `these environment variables redirect or override gh's config: ${set.join(", ")}`;
  const sock = runGh(gh, ["config", "get", "http_unix_socket"], env, undefined);
  if (!sock.ok) return "gh's http_unix_socket setting could not be read";
  if (sock.stdout.trim() !== "") return "gh's config sets http_unix_socket, which sends every request, token included, to a local socket";
  return null;
}

const GH_IDENTITY_ENV = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_REPO", "GH_HOST"];

interface GhRun {
  ok: boolean;
  stdout: string;
  /** Only populated when asked for (`auth status` text parsing); never printed. */
  stderr: string;
}

/**
 * Run `gh` with a controlled environment.
 *
 *   `token: undefined`  strip every identity variable (list accounts, fetch a token);
 *   `token: string`     as above, then `GH_TOKEN=<token>` (act as exactly that account);
 *   `token: "inherit"`  leave the caller's environment alone (the active-account fallback).
 *
 * The token travels only in the child's environment. stderr is captured only
 * when `wantStderr` is set, and is only ever pattern-matched, never emitted.
 */
function runGh(
  gh: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  token: string | "inherit" | undefined,
  wantStderr = false,
): GhRun {
  const childEnv: NodeJS.ProcessEnv = { ...env };
  if (token !== "inherit") {
    for (const k of GH_IDENTITY_ENV) delete childEnv[k];
    if (token !== undefined) childEnv["GH_TOKEN"] = token;
  }
  childEnv["GH_PROMPT_DISABLED"] = "1";
  childEnv["GH_NO_UPDATE_NOTIFIER"] = "1";
  childEnv["NO_COLOR"] = "1";
  const res = spawnSync(gh, args, {
    env: childEnv,
    encoding: "utf8",
    timeout: GH_TIMEOUT_MS,
    maxBuffer: GH_MAX_BUFFER,
    stdio: ["ignore", "pipe", wantStderr ? "pipe" : "ignore"],
  });
  const ok = res.error === undefined && res.status === 0;
  return {
    ok,
    stdout: typeof res.stdout === "string" ? res.stdout : "",
    stderr: typeof res.stderr === "string" ? res.stderr : "",
  };
}

// ---------------------------------------------------------------------------
// Listing the accounts logged in for github.com
// ---------------------------------------------------------------------------

export interface GhAccount {
  login: string;
  /** gh's own verdict on the stored token, when it gave one. */
  tokenValid: boolean;
}

type AccountListing =
  | { kind: "accounts"; accounts: GhAccount[] }
  /** gh ran and says nobody is logged in. */
  | { kind: "none" }
  /** Neither the JSON nor the text form could be read. */
  | { kind: "failed" };

/** A GitHub login: letters, digits and single hyphens, at most 39 characters. Anything else is not trusted. */
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** `gh auth status --json hosts`: `{ hosts: { "github.com": [ { login, state, active, ... } ] } }`. */
function parseAuthStatusJson(text: string): GhAccount[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const hosts = (parsed as { hosts?: unknown }).hosts;
  if (typeof hosts !== "object" || hosts === null) return null;
  const entries = (hosts as Record<string, unknown>)[HOST];
  if (entries === undefined) return [];
  if (!Array.isArray(entries)) return null;
  const out: GhAccount[] = [];
  for (const e of entries) {
    if (typeof e !== "object" || e === null) continue;
    const { login, state } = e as { login?: unknown; state?: unknown };
    if (typeof login !== "string" || !LOGIN_RE.test(login)) continue;
    out.push({ login, tokenValid: state === "success" });
  }
  return out;
}

/**
 * `gh auth status` text, for a gh that predates `--json`. Recognised lines:
 *
 *   `✓ Logged in to github.com account <login> (keyring)`     (gh >= 2.40)
 *   `✓ Logged in to github.com as <login> (keyring)`          (older)
 *   `X Failed to log in to github.com account <login> (...)`  (token rejected)
 *
 * Only logins are read from it. Token lines (`- Token: ...`) are never looked at.
 */
export function parseAuthStatusText(text: string): GhAccount[] {
  const out: GhAccount[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /(Logged in to|Failed to log in to)\s+github\.com\s+(?:account|as)\s+([A-Za-z0-9-]+)/.exec(line);
    if (m === null) continue;
    const login = m[2]!;
    if (!LOGIN_RE.test(login) || seen.has(login.toLowerCase())) continue;
    seen.add(login.toLowerCase());
    out.push({ login, tokenValid: m[1] === "Logged in to" });
  }
  return out;
}

function listAccounts(gh: string, env: NodeJS.ProcessEnv): AccountListing {
  // Preferred: structured output. `--json` exits 0 whatever the auth state, so
  // a non-zero exit means this gh does not know the flag (or hit a fatal error).
  const asJson = runGh(gh, ["auth", "status", "--hostname", HOST, "--json", "hosts"], env, undefined);
  if (asJson.ok) {
    const accounts = parseAuthStatusJson(asJson.stdout);
    if (accounts !== null) return accounts.length > 0 ? { kind: "accounts", accounts } : { kind: "none" };
  }
  // Fallback: parse the text. It exits 1 when any account has a problem, so the
  // exit code is not consulted; gh writes it to stdout or stderr by version.
  const asText = runGh(gh, ["auth", "status", "--hostname", HOST], env, undefined, true);
  const accounts = parseAuthStatusText(`${asText.stdout}\n${asText.stderr}`);
  if (accounts.length > 0) return { kind: "accounts", accounts };
  if (/not logged in/i.test(`${asText.stdout}\n${asText.stderr}`)) return { kind: "none" };
  return { kind: "failed" };
}

// ---------------------------------------------------------------------------
// Per-account facts
// ---------------------------------------------------------------------------

interface AccountFacts {
  /** The label findings use for this account. */
  login: string;
  /** False when nothing could be learned (token invalid or unobtainable). */
  reachable: boolean;
  /** `gh api user` login, lower-cased; null when unreachable. */
  apiLogin: string | null;
  /** `gh api user/orgs` slugs, lower-cased; null when the call failed. */
  orgs: string[] | null;
  /** Why an unreachable account was not checked, when it is not simply an invalid token. */
  skipNote?: string;
}

function lines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l !== "");
}

/** Fetch what doctor needs from ONE account, acting as it through `GH_TOKEN` in the child's env only. */
function queryAccount(gh: string, env: NodeJS.ProcessEnv, account: GhAccount): AccountFacts {
  const unreachable: AccountFacts = { login: account.login, reachable: false, apiLogin: null, orgs: null };
  if (!account.tokenValid) return unreachable;

  const tokenRun = runGh(gh, ["auth", "token", "--hostname", HOST, "--user", account.login], env, undefined);
  const token = tokenRun.ok ? tokenRun.stdout.trim() : "";
  if (token === "") return unreachable;

  return queryWithToken(gh, env, account.login, token);
}

function queryWithToken(gh: string, env: NodeJS.ProcessEnv, label: string, token: string | "inherit"): AccountFacts {
  const user = runGh(gh, ["api", "--hostname", HOST, "user", "--jq", ".login"], env, token);
  const userLogin = user.ok ? lines(user.stdout)[0] : undefined;
  if (userLogin === undefined || !LOGIN_RE.test(userLogin)) {
    return { login: label, reachable: false, apiLogin: null, orgs: null };
  }
  const orgsRun = runGh(gh, ["api", "--hostname", HOST, "user/orgs", "--paginate", "--jq", ".[].login"], env, token);
  const orgs = orgsRun.ok
    ? lines(orgsRun.stdout)
        .filter(o => LOGIN_RE.test(o))
        .map(o => o.toLowerCase())
    : null;
  return { login: label, reachable: true, apiLogin: userLogin.toLowerCase(), orgs };
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

const GH_CODES = ["GH_LOGIN_UNREGISTERED", "GH_MEMBER_ORG_UNREGISTERED", "REGISTERED_ORG_NOT_MEMBER"] as const;

function skippedAll(reason: string): DoctorCheck[] {
  return GH_CODES.map(code => ({
    code,
    ok: true,
    skipped: true,
    detail: `skipped: ${reason}`,
  }));
}

/**
 * The three gh-backed checks. `registry` must be a loaded registry; the caller
 * does not call this for a missing or unreadable one (there is nothing to
 * compare against, and no reason to spend network calls on it).
 *
 * Best-effort: gh absent or untrusted, or no usable login, is `skipped`, never a
 * failure. A guardrail must not report something it could not substantiate.
 *
 * The ACTIVE account is queried first and without reading any token (`gh api`
 * acts as it). Every other account needs its token read, which happens only
 * after `opts.confirm` says yes, naming the gh binary; with no terminal that is
 * a no, and those accounts are reported as not checked.
 */
export function ghOwnerChecks(
  registry: Registry,
  env: NodeJS.ProcessEnv = process.env,
  opts: GhCheckOptions = {},
): DoctorCheck[] {
  const res = resolveGh(env, opts.policy ?? "default", opts.skipDirectoryChecks === true);
  if (res.kind === "skip") return [...skippedAll(res.reason), ...res.extra];
  const gh = res.path;

  const listing = listAccounts(gh, env);
  const active = queryWithToken(gh, env, "active account", "inherit");
  const facts: AccountFacts[] = [];
  let note = "";

  if (listing.kind === "accounts") {
    if (active.reachable) facts.push(active);
    const others = listing.accounts.filter(a => a.login.toLowerCase() !== active.apiLogin);
    const fetchable = others.filter(a => a.tokenValid);
    // A redirected gh is refused BEFORE anyone is asked: there is nothing safe to confirm.
    const redirect = fetchable.length > 0 ? redirectReason(gh, env) : null;
    if (redirect !== null) {
      res.extra.push({
        code: "GH_CONFIG_REDIRECT",
        ok: false,
        severity: "warn",
        detail: `other accounts' tokens were not read: ${redirect}`,
        fix: "unset the variable(s), or remove http_unix_socket from gh's config (`gh config set http_unix_socket ''`), then re-run doctor",
      });
    }
    const confirmed =
      fetchable.length > 0 && redirect === null && (opts.confirm ?? defaultConfirm)(gh, fetchable.map(a => a.login));
    for (const a of others) {
      if (!a.tokenValid || confirmed) facts.push(queryAccount(gh, env, a));
      else {
        facts.push({
          login: a.login,
          reachable: false,
          apiLogin: null,
          orgs: null,
          skipNote:
            redirect !== null
              ? "was not checked: gh is configured to redirect requests (see GH_CONFIG_REDIRECT)"
              : "was not checked: reading another account's token needs a y/N confirmation at a terminal, and there was none (or it was declined)",
        });
      }
    }
    if (fetchable.length > 0 && !confirmed) {
      note =
        redirect !== null
          ? " (only the active account was checked: gh is configured to redirect requests)"
          : " (only the active account was checked: reading another account's token needs a y/N at a terminal)";
    }
  } else {
    // Listing failed, or gh says nobody is logged in for a stored login. Fall
    // back to whatever account `gh` itself would use (environment token or the
    // active login) and SAY SO: the result is then about one arbitrary account.
    if (!active.reachable) {
      return skippedAll(
        listing.kind === "none"
          ? "`gh` is not authenticated for github.com"
          : "`gh` could not list its accounts and the active account could not be queried",
      );
    }
    facts.push(active);
    note =
      listing.kind === "none"
        ? " (gh lists no logged-in account, so only the account gh itself would use was checked)"
        : " (gh could not list the logged-in accounts, so only the active account was checked)";
  }
  if (facts.length === 0) return skippedAll("no gh account could be queried");

  const owners = registeredOwners(registry);
  const checks: DoctorCheck[] = [...res.extra];

  for (const f of facts) {
    const account = f.apiLogin ?? f.login;
    const who = `gh account ${account}`;

    if (!f.reachable) {
      const detail =
        f.skipNote !== undefined
          ? `skipped: ${who} ${f.skipNote}`
          : `skipped: ${who} is logged in but its token is invalid or could not be read, so it was not checked`;
      checks.push({ code: "GH_LOGIN_UNREGISTERED", ok: true, skipped: true, account, detail });
      checks.push({ code: "GH_MEMBER_ORG_UNREGISTERED", ok: true, skipped: true, account, detail });
      continue;
    }

    const login = f.apiLogin!;
    const loginRegistered = owners.has(login);
    checks.push({
      code: "GH_LOGIN_UNREGISTERED",
      ok: loginRegistered,
      // WARN (P3-C): rule h refusing egress to an unregistered owner is its designed outcome; registering is the person's call.
      ...(loginRegistered ? {} : { severity: "warn" as const }),
      account,
      detail:
        (loginRegistered
          ? `${who}: its login is a registered owner`
          : `${who}: its login is not a registered owner, so rule h refuses non-interactive egress to repositories under that login`) +
        note,
      ...(loginRegistered
        ? {}
        : { fix: `repo-aegis engagements add --personal-org ${login}   (${PERSON_RUNS_THIS})` }),
    });

    if (f.orgs === null) {
      checks.push({
        code: "GH_MEMBER_ORG_UNREGISTERED",
        ok: true,
        skipped: true,
        account,
        detail: `skipped: ${who}: its organisation memberships could not be listed`,
      });
      continue;
    }
    const unregistered = f.orgs.filter(o => !owners.has(o));
    checks.push({
      code: "GH_MEMBER_ORG_UNREGISTERED",
      ok: unregistered.length === 0,
      // INFO (X-9): the fix itself says "or leave it". Not registering an organisation you belong to is a
      // choice (rule h then refuses egress to it, as intended), so it is a count, not a failure.
      ...(unregistered.length === 0 ? {} : { severity: "info" as const, names: unregistered }),
      account,
      detail:
        (unregistered.length === 0
          ? `${who}: every organisation it belongs to is a registered owner`
          : `${who}: belongs to ${unregistered.length} organisation(s) that are not registered owners (listed in --json); rule h refuses non-interactive egress to them until you register them, which is optional`) +
        note,
      ...(unregistered.length === 0
        ? {}
        : {
            fix:
              `for each of [${unregistered.join(", ")}]: repo-aegis engagements add --personal-org <org>` +
              `   (or --github-org <org> on the engagement that owns it), or leave it and let rule h refuse it` +
              `   (${PERSON_RUNS_THIS})`,
          }),
    });
  }

  checks.push(registeredNotMember(owners, facts));
  return checks;
}

/**
 * `REGISTERED_ORG_NOT_MEMBER` (info): a registered owner that is neither the
 * login of any checked account nor an org any of them belongs to. Archived
 * engagements make this normal, hence info and "none required". Uses the UNION
 * over all accounts: the registry is per machine, not per account.
 */
function registeredNotMember(owners: ReadonlySet<string>, facts: readonly AccountFacts[]): DoctorCheck {
  const reachable = facts.filter(f => f.reachable && f.orgs !== null);
  if (reachable.length === 0) {
    return {
      code: "REGISTERED_ORG_NOT_MEMBER",
      ok: true,
      skipped: true,
      detail: "skipped: no gh account's memberships could be read",
    };
  }
  const known = new Set<string>();
  for (const f of reachable) {
    known.add(f.apiLogin!);
    for (const o of f.orgs!) known.add(o);
  }
  const missing = [...owners].filter(o => !known.has(o)).sort();
  const incomplete = reachable.length < facts.length;
  const note = incomplete ? " (some logged-in accounts could not be read, so this list may be incomplete)" : "";
  if (missing.length === 0) {
    return {
      code: "REGISTERED_ORG_NOT_MEMBER",
      ok: true,
      detail: `every registered owner is a login or organisation of one of the ${reachable.length} gh account(s) checked${note}`,
    };
  }
  return {
    code: "REGISTERED_ORG_NOT_MEMBER",
    ok: false,
    severity: "info",
    detail:
      `${missing.length} registered owner(s) match no login or organisation of the ${reachable.length} gh account(s) checked ` +
      `(normal for an archived engagement)${note}`,
    // Registry owners can be customer names, and doctor output can land in an
    // agent transcript: the list is in --json only, never in a text line.
    fix: "none required; the unmatched owners are listed in --json",
    names: missing,
  };
}
