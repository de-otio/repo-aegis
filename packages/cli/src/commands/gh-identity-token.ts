// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Token sources and the environments they run in, for `repo-aegis gh` (doc/plan-owner-identity.md §13.3,
// D3, A2, A4, N5, N6, N7).
//
// THE TOKEN'S ONLY HOMES. A token is read from a child's stdout into one local variable, compared by SHA-256
// digest, and handed to the `gh` child through its ENVIRONMENT. It is never printed, logged, written, put in
// argv, or included in an error message: nothing in this module formats a token into a string other than the
// environment object itself. The children's stderr is discarded (`ignore`), never forwarded.
//
// ENVIRONMENTS ARE ALLOWLISTS, built here from the caller's environment by NAME. What the caller sets for
// anything else (a pager, an editor, a proxy, `BASH_ENV`, `GIT_CONFIG_*`, `XDG_CONFIG_HOME`, `GH_CONFIG_DIR`,
// `SSL_CERT_FILE`, `SHELLOPTS`) does not reach a child that holds a token.
import { spawnSync } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { userInfo } from "node:os";
import { delimiter, dirname } from "node:path";
import type { IdentityScope } from "@de-otio/repo-aegis-core";
import { untrustedDirReason } from "./doctor-owner-checks.js";
import { taaadTrustProblem, type TaaadPin } from "./taaad-pin.js";

const CHILD_TIMEOUT_MS = 20_000;
const CHILD_MAX_BUFFER = 1024 * 1024;

/** The pinned PATH of a minting taaad (A4): nothing the caller can add to. */
export const TAAAD_PATH = "/usr/bin:/bin";

/** The home directory of the ACCOUNT, from the passwd database; the caller's `HOME` only when there is no entry. */
function accountHome(env: NodeJS.ProcessEnv): string | undefined {
  try {
    const h = userInfo().homedir;
    if (h !== "") return h;
  } catch {
    /* no passwd entry */
  }
  return env["HOME"];
}

/** Copy `names` that are set (non-empty) in `from`. */
function pick(from: NodeJS.ProcessEnv, names: readonly string[]): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const n of names) {
    const v = from[n];
    if (v !== undefined && v !== "") out[n] = v;
  }
  return out;
}

/**
 * The environment taaad is minted with (A4, §13.3): exactly `HOME`, `PATH=/usr/bin:/bin`, `TERM` and `LANG`.
 * No `TAAAD_*` (it selects taaad's app registry), no `XDG_*`, nothing else. `HOME` is the account's, not the
 * caller's: taaad finds its configuration relative to it.
 */
export function taaadEnv(callerEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const home = accountHome(callerEnv);
  return { ...(home !== undefined && { HOME: home }), PATH: TAAAD_PATH, ...pick(callerEnv, ["TERM", "LANG"]) };
}

/** A PATH for the `gh` child that no caller can extend: gh's own directory, then the standard system ones. */
export function ghChildPath(ghPath: string, policy: "default" | "permissive", callerEnv: NodeJS.ProcessEnv): string {
  const dirs = [dirname(ghPath), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
  const out: string[] = [];
  for (const d of dirs) {
    if (out.includes(d) || !existsSync(d)) continue;
    // /usr/bin and /bin are root's; a package-manager directory must pass the same vetting as gh's own.
    const system = d === "/usr/bin" || d === "/bin";
    if (!system && policy === "default" && untrustedDirReason(d, callerEnv) !== null) continue;
    out.push(d);
  }
  if (!out.includes("/usr/bin")) out.push("/usr/bin");
  if (!out.includes("/bin")) out.push("/bin");
  return out.join(delimiter);
}

/**
 * `GIT_CONFIG_COUNT` overrides for the `git` children gh spawns (A2): they read the agent-writable
 * `.git/config` (`core.fsmonitor`, `credential.helper`, filters), which would run an agent's program with the
 * token in its environment. Command-line style config outranks every file.
 */
const GIT_OVERRIDES: ReadonlyArray<readonly [string, string]> = [
  ["core.fsmonitor", "false"],
  ["core.hooksPath", "/dev/null"],
  ["credential.helper", ""],
  ["core.sshCommand", "ssh"],
];

/**
 * The environment of an INJECTED `gh` call (A2): `HOME`, a PATH the caller cannot extend, `TERM`, `LANG` / `LC_*`,
 * `TMPDIR`, `GH_REPO` when the caller set it (the target was judged with it), the token, and fixed values that
 * turn off pagers, prompts and update notifiers. Everything else is dropped.
 *
 * `token` is `undefined` for the children that must act as nobody (`gh config get`, `gh auth token`).
 */
export function ghChildEnv(
  callerEnv: NodeJS.ProcessEnv,
  ghPath: string,
  policy: "default" | "permissive",
  token?: string,
): NodeJS.ProcessEnv {
  const home = accountHome(callerEnv);
  const lc = Object.keys(callerEnv).filter(k => k.startsWith("LC_"));
  const env: NodeJS.ProcessEnv = {
    ...(home !== undefined && { HOME: home }),
    PATH: ghChildPath(ghPath, policy, callerEnv),
    ...pick(callerEnv, ["TERM", "LANG", "TMPDIR", "GH_REPO", ...lc]),
    GH_PAGER: "",
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: String(GIT_OVERRIDES.length),
  };
  GIT_OVERRIDES.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  if (token !== undefined) env["GH_TOKEN"] = token;
  return env;
}

// ---------------------------------------------------------------------------
// gh-login
// ---------------------------------------------------------------------------

/** Run the trusted `gh` as nobody (no token variable) and return its stdout, or null on any failure. */
export function runGhAsNobody(
  ghPath: string,
  args: readonly string[],
  callerEnv: NodeJS.ProcessEnv,
  policy: "default" | "permissive",
): string | null {
  const res = spawnSync(ghPath, [...args], {
    env: ghChildEnv(callerEnv, ghPath, policy),
    encoding: "utf8",
    timeout: CHILD_TIMEOUT_MS,
    maxBuffer: CHILD_MAX_BUFFER,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return res.error === undefined && res.status === 0 && typeof res.stdout === "string" ? res.stdout : null;
}

/** A token must be one printable word: no whitespace, no control characters. */
const TOKEN_SHAPE = /^[\x21-\x7e]{8,}$/;

/** `gh auth token --hostname github.com --user <login>` through the trusted gh, with every token and redirect variable absent. */
export function fetchLoginToken(
  ghPath: string,
  login: string,
  callerEnv: NodeJS.ProcessEnv,
  policy: "default" | "permissive",
): string | null {
  const out = runGhAsNobody(ghPath, ["auth", "token", "--hostname", "github.com", "--user", login], callerEnv, policy);
  if (out === null) return null;
  const token = out.trim();
  return TOKEN_SHAPE.test(token) ? token : null;
}

// ---------------------------------------------------------------------------
// github-app (taaad mint)
// ---------------------------------------------------------------------------

export type MintFailure =
  /** No taaad is pinned, or no trusted one. */
  | { code: "GH_BINARY_UNTRUSTED"; why: string }
  | { code: "TAAAD_AGENT_WRITABLE"; why: string }
  | { code: "GH_IDENTITY_INSTALLATION_MISMATCH"; why: string }
  | { code: "GH_IDENTITY_UNAVAILABLE"; why: string };

export type MintResult = { ok: true; token: string } | { ok: false; failure: MintFailure };

const LEVELS: Readonly<Record<string, number>> = { read: 1, write: 2, admin: 3 };

/** The permission keys N5 allows an App token for each scope, and the widest level of each. `*`: any key. */
const SCOPE_LIMITS: Readonly<Record<IdentityScope, Readonly<Record<string, number>>>> = {
  read: { metadata: 1, contents: 1, pull_requests: 1, issues: 1 },
  "contents-write": { metadata: 1, contents: 2 },
  write: {},
};

/** True when every permission is within what `scope` allows (a write scope: any key, but never `admin`). */
export function permissionsWithin(scope: IdentityScope, perms: unknown): boolean {
  if (typeof perms !== "object" || perms === null || Array.isArray(perms)) return false;
  const limits = SCOPE_LIMITS[scope];
  for (const [key, level] of Object.entries(perms as Record<string, unknown>)) {
    if (typeof level !== "string") return false;
    const rank = LEVELS[level];
    if (rank === undefined) return false;
    if (scope === "write") {
      if (rank > 2) return false;
    } else {
      const max = limits[key];
      if (max === undefined || rank > max) return false;
    }
  }
  return true;
}

/**
 * Check `taaad mint ... --json` output against the call it was minted for. The token is returned only when
 * ALL of these hold; the failure text never contains a value taken from the output.
 *   - `installationAccount` equals the destination owner, case-insensitively (N6): else INSTALLATION_MISMATCH;
 *   - `repositories` is exactly the destination repository (N5);
 *   - `permissions` are no wider than the scope (N5).
 */
export function validateMint(stdout: string, target: { owner: string; repo: string }, scope: IdentityScope): MintResult {
  const unavailable = (why: string): MintResult => ({ ok: false, failure: { code: "GH_IDENTITY_UNAVAILABLE", why } });
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return unavailable("taaad printed something that is not JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return unavailable("taaad's answer is not an object");
  const o = parsed as Record<string, unknown>;
  const token = o["token"];
  if (typeof token !== "string" || !TOKEN_SHAPE.test(token)) return unavailable("taaad returned no usable token");
  const account = o["installationAccount"];
  if (typeof account !== "string") return unavailable("taaad did not say which account the installation belongs to");
  if (account.toLowerCase() !== target.owner.toLowerCase()) {
    return {
      ok: false,
      failure: {
        code: "GH_IDENTITY_INSTALLATION_MISMATCH",
        why: "the App's installation belongs to a different account than this call's owner, so the token was discarded",
      },
    };
  }
  const repos = o["repositories"];
  const want = target.repo.toLowerCase();
  const named = (r: unknown): boolean =>
    typeof r === "string" && (r.toLowerCase() === want || r.toLowerCase() === `${target.owner.toLowerCase()}/${want}`);
  if (!Array.isArray(repos) || repos.length !== 1 || !named(repos[0])) {
    return unavailable("taaad's token is not narrowed to exactly this repository, so it was discarded");
  }
  if (!permissionsWithin(scope, o["permissions"])) {
    return unavailable("taaad's token carries wider permissions than this call needs, so it was discarded");
  }
  return { ok: true, token };
}

export interface MintInput {
  pin: TaaadPin | null;
  slug: string;
  owner: string;
  repo: string | null;
  scope: IdentityScope;
  callerEnv: NodeJS.ProcessEnv;
  /** Test seam: `"permissive"` skips the root-ownership test (stubs are not root-owned). Not reachable from the CLI. */
  trust?: "default" | "permissive";
}

/** `<pinned taaad> mint --app <slug> --repo <owner>/<repo> --permissions <scope> --json`, validated (N4, N5, N6, A4). */
export function mintAppToken(input: MintInput): MintResult {
  const fail = (failure: MintFailure): MintResult => ({ ok: false, failure });
  if (input.repo === null) {
    return fail({ code: "GH_IDENTITY_UNAVAILABLE", why: "an App token is minted for one repository, and this call names only an owner" });
  }
  if (input.pin === null) {
    return fail({
      code: "GH_BINARY_UNTRUSTED",
      why: "no taaad is pinned: install taaad into a root-owned prefix, then re-run `repo-aegis install shim`",
    });
  }
  if ((input.trust ?? "default") === "default") {
    const problem = taaadTrustProblem(input.pin);
    if (problem !== null) return fail({ code: "TAAAD_AGENT_WRITABLE", why: `${problem}, so an App token it mints could be captured` });
  }
  const res = spawnSync(
    input.pin.launcher,
    ["mint", "--app", input.slug, "--repo", `${input.owner}/${input.repo}`, "--permissions", input.scope, "--json"],
    {
      env: taaadEnv(input.callerEnv),
      encoding: "utf8",
      timeout: CHILD_TIMEOUT_MS,
      maxBuffer: CHILD_MAX_BUFFER,
      // stderr is discarded: nothing a minting child says is forwarded.
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  if (res.error !== undefined || res.status !== 0 || typeof res.stdout !== "string" || res.stdout.trim() === "") {
    return fail({ code: "GH_IDENTITY_UNAVAILABLE", why: "taaad could not mint a token for this App and repository" });
  }
  return validateMint(res.stdout, { owner: input.owner, repo: input.repo }, input.scope);
}

// ---------------------------------------------------------------------------
// N7 / D6
// ---------------------------------------------------------------------------

const digest = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();

/** True when `supplied` is exactly `expected`: SHA-256 digests compared with `timingSafeEqual`. */
export function tokensEqual(supplied: string, expected: string): boolean {
  return timingSafeEqual(digest(supplied), digest(expected));
}
