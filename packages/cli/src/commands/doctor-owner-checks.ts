// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `doctor`'s registered-owner checks (doc/plan-unregistered-owner-egress.md
// §3.8, issue #151): is the registry usable for rule h, and do the GitHub
// accounts on this machine own things the registry does not know about?
//
// Two groups:
//
//   registryStateChecks  pure, offline: OWNERS_UNDECLARED and REGISTRY_UNREADABLE.
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
import { spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { registeredOwners, repoAegisHome, type Registry } from "@de-otio/repo-aegis-core";
import { PERSON_RUNS_THIS, type DoctorCheck } from "./doctor-checks.js";

const HOST = "github.com";
/** One `gh` call must not hang `doctor`: this runs on a developer's machine, interactively. */
const GH_TIMEOUT_MS = 20_000;
/** `gh api user/orgs --paginate` for an account in hundreds of orgs is still well under this. */
const GH_MAX_BUFFER = 8 * 1024 * 1024;

/** How the registry file looked when doctor tried to load it. */
export type DoctorRegistryState = "loaded" | "missing" | "unreadable";

// ---------------------------------------------------------------------------
// Registry state (D4)
// ---------------------------------------------------------------------------

/**
 * `REGISTRY_UNREADABLE` (a FAILURE, decision D4) and `OWNERS_UNDECLARED`.
 *
 * An unreadable registry (encrypted at rest, or a file that does not parse)
 * makes rule h refuse every non-interactive egress that has a destination, so
 * it is a failure and not a warning. A missing registry is not a finding here:
 * rule h is skipped by design when no registry exists, and a machine that never
 * set repo-aegis up has nothing to fix.
 *
 * Neither message includes the loader's error text: zod and YAML messages can
 * name orgs and engagement ids.
 */
export function registryStateChecks(
  state: DoctorRegistryState,
  registry: Registry | null,
  encrypted: boolean,
): DoctorCheck[] {
  if (state === "unreadable") {
    return [
      {
        code: "REGISTRY_UNREADABLE",
        ok: false,
        detail:
          "the registry exists but cannot be read (encrypted at rest, or it does not parse or validate), " +
          "so rule h refuses every non-interactive egress that has a destination; a person at a terminal can still publish",
        fix: encrypted
          ? `repo-aegis registry decrypt --identity <your age identity file>   (${PERSON_RUNS_THIS})`
          : "repair or restore the registry file (run `repo-aegis status` for the parse error), then re-run doctor",
      },
    ];
  }
  if (state === "loaded" && registry !== null && registeredOwners(registry).size === 0) {
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
 * The real `gh`: the first executable `gh` on PATH that is not the repo-aegis
 * shim's directory. Doctor must not call its own shim; the shim runs
 * `egress-check`, writes audit records, and is the thing being diagnosed.
 * Null when there is no other `gh`.
 */
export function findRealGh(env: NodeJS.ProcessEnv): string | null {
  const pathValue = env["PATH"];
  if (pathValue === undefined || pathValue === "") return null;
  const shimDir = canonical(join(env["REPO_AEGIS_HOME"] ?? repoAegisHome(), "bin"));
  for (const entry of pathValue.split(delimiter)) {
    const dir = entry === "" ? "." : entry;
    const candidate = join(dir, "gh");
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

/** Variables that would make a child `gh` act as an account other than the one we mean. */
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
 * Best-effort: gh absent, or no usable login, is `skipped`, never a failure. A
 * guardrail must not report something it could not substantiate.
 */
export function ghOwnerChecks(registry: Registry, env: NodeJS.ProcessEnv = process.env): DoctorCheck[] {
  const gh = findRealGh(env);
  if (gh === null) return skippedAll("`gh` is not installed (or only the repo-aegis shim is on PATH)");

  const listing = listAccounts(gh, env);
  let facts: AccountFacts[];
  let fallbackNote = "";
  if (listing.kind === "accounts") {
    facts = listing.accounts.map(a => queryAccount(gh, env, a));
  } else {
    // Listing failed, or gh says nobody is logged in for a stored login. Fall
    // back to whatever account `gh` itself would use (environment token or the
    // active login) and SAY SO: the result is then about one arbitrary account.
    const active = queryWithToken(gh, env, "active account", "inherit");
    if (!active.reachable) {
      return skippedAll(
        listing.kind === "none"
          ? "`gh` is not authenticated for github.com"
          : "`gh` could not list its accounts and the active account could not be queried",
      );
    }
    facts = [active];
    fallbackNote = " (gh could not list the logged-in accounts, so only the active account was checked)";
  }

  const owners = registeredOwners(registry);
  const checks: DoctorCheck[] = [];

  for (const f of facts) {
    const who = fallbackNote === "" ? `gh account ${f.login}` : `the active gh account (${f.apiLogin ?? f.login})`;
    const account = f.apiLogin ?? f.login;

    if (!f.reachable) {
      const detail = `skipped: ${who} is logged in but its token is invalid or could not be read, so it was not checked`;
      checks.push({ code: "GH_LOGIN_UNREGISTERED", ok: true, skipped: true, account, detail });
      checks.push({ code: "GH_MEMBER_ORG_UNREGISTERED", ok: true, skipped: true, account, detail });
      continue;
    }

    const login = f.apiLogin!;
    const loginRegistered = owners.has(login);
    checks.push({
      code: "GH_LOGIN_UNREGISTERED",
      ok: loginRegistered,
      account,
      detail:
        (loginRegistered
          ? `${who}: its login is a registered owner`
          : `${who}: its login is not a registered owner, so rule h refuses non-interactive egress to repositories under that login`) +
        fallbackNote,
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
      account,
      detail:
        (unregistered.length === 0
          ? `${who}: every organisation it belongs to is a registered owner`
          : `${who}: belongs to ${unregistered.length} organisation(s) that are not registered owners, so rule h refuses non-interactive egress to them`) +
        fallbackNote,
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
    fix: `none required; not matched: ${missing.join(", ")}`,
  };
}
