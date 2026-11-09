// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// The one place that spawns `taaad mint` (doc/plan-owner-identity.md §13.3, A4, N6).
//
// A token from the pinned taaad is only as good as the check on what it says: a swapped App, a wider
// installation or a response for another repository must not reach a caller. So the JSON is validated
// here, and a caller gets either a token that is for exactly `<owner>/<repo>` at no more than the
// requested scope, or a `MintError`. Nothing in an error message carries taaad's stdout or stderr: both
// can hold a token or a customer name, and the caller prints these messages.
import { spawnSync } from "node:child_process";
import { homedir, userInfo } from "node:os";
import { isAbsolute } from "node:path";
import type { IdentityScope } from "@de-otio/repo-aegis-core";
import { readPinnedTaaad } from "./taaad-pin.js";

export interface MintParams {
  /** Absolute path of the pinned taaad launcher. */
  taaadPath: string;
  /** The App slug of the identity (registry-validated shape). */
  slug: string;
  owner: string;
  repo: string;
  scope: IdentityScope;
}

export interface MintedToken {
  token: string;
  /** As taaad printed it (ISO-8601 in practice); null when absent or unparseable. */
  expiresAt: string | null;
  installationAccount: string;
  installationId: unknown;
  appId: unknown;
  repositories: readonly string[];
  permissions: Readonly<Record<string, string>>;
}

/**
 * Why a mint was refused. `installation-mismatch` maps to GH_IDENTITY_INSTALLATION_MISMATCH, everything else
 * to GH_IDENTITY_UNAVAILABLE. The message is fixed text and never carries taaad's output.
 */
export class MintError extends Error {
  constructor(
    readonly kind: "unavailable" | "installation-mismatch",
    message: string,
    /** Which step failed, as a fixed word safe for the audit log. */
    readonly reason: MintFailureReason = "failed",
  ) {
    super(message);
    this.name = "MintError";
  }
}

export type MintFailureReason =
  | "timeout"
  | "not-runnable"
  | "tty"
  | "rate-limited"
  | "denied"
  | "screen-locked"
  | "signer"
  | "not-installed"
  | "repo-not-covered"
  | "permission-not-granted"
  | "installation-mismatch"
  | "bad-output"
  | "failed";

/**
 * Classify a failed `taaad mint` (non-zero exit) into a fixed reason and message. taaad's stderr is only
 * MATCHED here, never copied into the message: it can name an owner (a customer) and it is printed to agents.
 * Patterns follow taaad v0.6's `taaad mint` error texts; anything unrecognised is the generic failure.
 */
export function classifyMintFailure(
  status: number | null,
  stderr: string,
  /** Whether this process runs inside the agent's sandbox (Claude Code's sandbox runtime sets SANDBOX_RUNTIME). */
  inSandbox: boolean = process.env["SANDBOX_RUNTIME"] !== undefined,
): MintError {
  const e = (reason: MintFailureReason, message: string, kind: MintError["kind"] = "unavailable"): MintError =>
    new MintError(kind, message, reason);
  // Seen 2026-11-09: inside the default Claude Code sandbox taaad-signer fails BEFORE its presence prompt (no
  // Touch ID dialog appears), plausibly because the sandbox blocks the keychain or the helper's GitHub call. The
  // hint names the likely cause without claiming it; it is added only where a sandbox could explain the failure.
  const sandboxHint = inSandbox
    ? ". This command ran inside the agent's sandbox, which most likely stopped taaad-signer before its presence " +
      "prompt (keychain or network); an App token cannot be minted from inside it. Your human runs the command " +
      "from a terminal, or lets this one command run outside the sandbox"
    : "";
  const statusPart = status === null ? "" : ` (taaad exit status ${status})`;
  switch (status) {
    case 2:
      return e("tty", "taaad refused to print a token to a terminal");
    case 3:
      return e("rate-limited", "taaad's presence-prompt limit is reached; wait a few minutes and retry");
    case 4:
      return e("denied", "your human declined taaad's presence prompt; stop and ask them before retrying");
  }
  // taaad ≥ 0.7.0 prints, as the LAST stderr line of every failed `taaad mint`, `taaad: error=<code>` or
  // `taaad: error=<code> status=<n>` (n an HTTP status, 100–599). The code is copied verbatim only when it is in
  // the known vocabulary; an unknown code is treated as `internal` and NOT echoed (taaad's README: "treat an
  // unknown code like internal"). Nothing else from stderr is ever copied.
  const lastLine = stderr.replace(/\s+$/, "").split("\n").pop() ?? "";
  const coded = /^taaad: error=([a-z][a-z-]{0,31})(?: status=([1-5]\d\d))?$/.exec(lastLine);
  if (coded !== null) {
    const known = TAAAD_CODES.has(coded[1]!);
    const code = known ? coded[1]! : "internal";
    const detail = known && coded[2] !== undefined ? ` status=${coded[2]}` : "";
    const step = `taaad error=${code}${detail}`;
    switch (code) {
      case "presence-denied":
        return e("denied", `your human declined taaad's presence prompt (${step}); stop and ask them before retrying`);
      case "rate-limited":
        return e("rate-limited", `taaad's presence-prompt limit is reached (${step}); wait a few minutes and retry`);
      case "tty":
        return e("tty", `taaad refused to print a token to a terminal (${step})`);
      case "config":
        return e("not-installed", `taaad has no usable configuration for this App, e.g. no installation id yet (${step})`);
      case "owner-mismatch":
      case "app-mismatch":
        return e("installation-mismatch", `the App's installation belongs to a different account than the destination owner (${step})`, "installation-mismatch");
      case "not-granted":
        return e("permission-not-granted", `the App's installation does not grant the permission this operation needs (${step})`);
      case "bad-response":
        return e("bad-output", `GitHub's token response was unusable, so taaad minted nothing (${step})`);
    }
    const sandboxable = code === "keychain" || code === "github" || code === "protocol" || code === "missing" || code === "internal";
    return e("signer", `taaad failed at step ${step}, so no token was minted${sandboxable ? sandboxHint : ""}`);
  }
  if (/User interaction is not allowed/i.test(stderr)) {
    return e("screen-locked", "taaad-signer could not show its presence prompt (Touch ID), most likely because the screen is locked; retry when your human is at the machine");
  }
  if (/taaad-signer\b.*timed out/i.test(stderr)) {
    return e("timeout", "nobody answered taaad's presence prompt (Touch ID) in time; retry when your human is at the machine");
  }
  if (/taaad-signer/i.test(stderr)) {
    return e("signer", `taaad-signer failed${statusPart}, so no token was signed${sandboxHint || "; your human can run the same command from a terminal to see taaad's own message"}`);
  }
  if (/has no install_id/i.test(stderr)) {
    return e("not-installed", "the App has no installation yet (taaad has no installation id for it)");
  }
  if (/is not the installation account/i.test(stderr)) {
    return e("installation-mismatch", "the App's installation belongs to a different account than the destination owner", "installation-mismatch");
  }
  if (/contents:write is not granted|grants no permission/i.test(stderr)) {
    return e("permission-not-granted", "the App's installation does not grant the permission this operation needs (for a push: contents: write)");
  }
  if (/not accessible to the parent installation|\b(404|422)\b|not found/i.test(stderr)) {
    return e("repo-not-covered", "GitHub would not issue a token for this repository: the App's installation does not include it");
  }
  return e("failed", `taaad exited with a failure${statusPart} and minted nothing${sandboxHint || "; your human can run the same command from a terminal to see taaad's own message"}`);
}

/**
 * taaad ≥ 0.7.0's error vocabulary, used verbatim when taaad prints it: taaad-signer's `SignerError.code` values
 * plus the codes `taaad mint` raises itself (tty, usage, config, owner-mismatch, not-granted, bad-response).
 */
const TAAAD_CODES: ReadonlySet<string> = new Set([
  "tty",
  "usage",
  "config",
  "owner-mismatch",
  "not-granted",
  "bad-response",
  "internal",
  "missing",
  "protocol",
  "not-found",
  "presence-denied",
  "rate-limited",
  "github",
  "widened",
  "keychain",
  "exists",
  "bad-key",
  "app-mismatch",
]);

/**
 * Longer than taaad's own wait: taaad-signer gives a person 240 s to answer its presence prompt (Touch ID),
 * then taaad makes a few GitHub calls of up to 10 s each. Killing taaad sooner turns a slow fingerprint into
 * a failed mint that looks like a broken install.
 */
export const SPAWN_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
/** What a GitHub installation token looks like, loosely: no whitespace, no line breaks (the credential protocol is line based). */
const TOKEN_SHAPE = /^[A-Za-z0-9_.=-]{8,1024}$/;

/** The home directory of the ACCOUNT (passwd), not the caller's `HOME`: taaad finds its configuration relative to it. */
export function accountHome(env: NodeJS.ProcessEnv = process.env): string | undefined {
  try {
    const h = userInfo().homedir;
    if (h !== "") return h;
  } catch {
    /* no passwd entry */
  }
  const e = env["HOME"];
  return e !== undefined && e !== "" ? e : homedir();
}

/** The environment of the taaad spawn: exactly these four names (A4). No `TAAAD_*`, no `XDG_*`, nothing the caller set. */
export function taaadEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return {
    HOME: accountHome(env) ?? homedir(),
    PATH: "/usr/bin:/bin",
    TERM: env["TERM"] !== undefined && env["TERM"] !== "" ? env["TERM"] : "dumb",
    LANG: env["LANG"] !== undefined && env["LANG"] !== "" ? env["LANG"] : "C",
  };
}

/**
 * Permissions no wider than `scope` (taaad README: read class / contents:write + metadata:read / the installation's own).
 *
 * `read` is checked by LEVEL, not by key (taaad plan 0004): taaad ≥ 0.7.0 derives the read class from what the
 * installation grants (every granted permission at `read`), so an App granted e.g. `security_events: read` can serve
 * a read. taaad 0.6.0's fixed four keys (metadata, contents, pull_requests, issues) still pass. What a read token must
 * never carry is a `write` or `admin` level; which keys it reads is the App's grant, already chosen by its owner.
 */
function permissionsWithin(scope: IdentityScope, perms: Record<string, string>): boolean {
  const entries = Object.entries(perms);
  if (entries.length === 0) return false;
  switch (scope) {
    case "read":
      return entries.every(([, v]) => v === "read");
    case "contents-write":
      return entries.every(([k, v]) => (k === "contents" && v === "write") || (k === "metadata" && v === "read"));
    case "write":
      // The installation's own grants: no key list to compare to, but never `admin`.
      return entries.every(([, v]) => v === "read" || v === "write");
  }
}

function repositoryName(entry: unknown, owner: string): string | null {
  let text: string | null = null;
  if (typeof entry === "string") text = entry;
  else if (typeof entry === "object" && entry !== null) {
    const o = entry as Record<string, unknown>;
    if (typeof o["full_name"] === "string") text = o["full_name"];
    else if (typeof o["name"] === "string") text = o["name"];
  }
  if (text === null) return null;
  const slash = text.indexOf("/");
  if (slash === -1) return text;
  return text.slice(0, slash).toLowerCase() === owner.toLowerCase() ? text.slice(slash + 1) : null;
}

/** Validate taaad's JSON against the request. Throws {@link MintError}. Exported for tests. */
export function validateMintOutput(raw: string, p: Pick<MintParams, "owner" | "repo" | "scope">): MintedToken {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new MintError("unavailable", "taaad printed something that is not JSON");
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new MintError("unavailable", "taaad's output is not a JSON object");
  }
  const o = json as Record<string, unknown>;
  const token = o["token"];
  if (typeof token !== "string" || !TOKEN_SHAPE.test(token)) {
    throw new MintError("unavailable", "taaad returned no usable token");
  }
  const account = o["installationAccount"];
  if (typeof account !== "string" || account.toLowerCase() !== p.owner.toLowerCase()) {
    throw new MintError("installation-mismatch", "the App's installation belongs to a different account than the destination owner");
  }
  const repos = o["repositories"];
  if (!Array.isArray(repos) || repos.length !== 1) {
    throw new MintError("unavailable", "the token does not name exactly one repository");
  }
  const named = repositoryName(repos[0], p.owner);
  if (named === null || named.toLowerCase() !== p.repo.toLowerCase()) {
    throw new MintError("unavailable", "the token is for a different repository than the one requested");
  }
  const perms = o["permissions"];
  if (typeof perms !== "object" || perms === null || Array.isArray(perms)) {
    throw new MintError("unavailable", "the token does not state its permissions");
  }
  const permissions: Record<string, string> = {};
  for (const [k, v] of Object.entries(perms as Record<string, unknown>)) {
    if (typeof v !== "string") throw new MintError("unavailable", "the token's permissions are malformed");
    permissions[k] = v;
  }
  if (!permissionsWithin(p.scope, permissions)) {
    throw new MintError("unavailable", `the token's permissions are wider than the requested scope (${p.scope})`);
  }
  const exp = o["expiresAt"];
  const expiresAt = typeof exp === "string" && Number.isFinite(Date.parse(exp)) ? exp : null;
  return {
    token,
    expiresAt,
    installationAccount: account,
    installationId: o["installationId"],
    appId: o["appId"],
    repositories: [named],
    permissions,
  };
}

/** A spawn that did not finish: killed at the timeout, or never started. Exported for tests. */
export function spawnFailure(error: Error): MintError {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ETIMEDOUT") {
    return new MintError(
      "unavailable",
      `taaad did not finish within ${SPAWN_TIMEOUT_MS / 1000} s (its presence prompt, Touch ID, was probably not answered); retry when your human is at the machine`,
      "timeout",
    );
  }
  return new MintError("unavailable", "the pinned taaad could not be started; your human re-runs `repo-aegis install shim`", "not-runnable");
}

/**
 * Mint an installation token narrowed to one repository and one scope, from the pinned taaad.
 * Synchronous (a credential helper has nothing else to do). The token is returned, never printed or logged.
 */
export function mintAppToken(p: MintParams): MintedToken {
  if (!isAbsolute(p.taaadPath)) throw new MintError("unavailable", "the pinned taaad path is not absolute");
  const r = spawnSync(
    p.taaadPath,
    ["mint", "--app", p.slug, "--repo", `${p.owner}/${p.repo}`, "--permissions", p.scope, "--json"],
    {
      env: taaadEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      timeout: SPAWN_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
    },
  );
  if (r.error !== undefined) throw spawnFailure(r.error);
  // taaad's documented exit codes: 2 = stdout is a terminal, 3 = the prompt budget is spent, 4 = the person
  // cancelled or denied the prompt, 1 = anything else (told apart by its stderr, never copied).
  if (r.status !== 0) throw classifyMintFailure(r.status, typeof r.stderr === "string" ? r.stderr : "");
  if (typeof r.stdout !== "string" || r.stdout.trim() === "") throw new MintError("unavailable", "taaad printed nothing", "bad-output");
  return validateMintOutput(r.stdout, p);
}

/**
 * The launcher of the taaad that `install shim` pinned, or null when none is known: the pin is read from the
 * shim (`readPinnedTaaad`). Whether taaad is root-owned is a `doctor` warning (TAAAD_AGENT_WRITABLE), not a
 * condition here (doc/plan-owner-identity.md §2.1, Q5). `trust` is kept for call-site compatibility and ignored.
 */
export function resolvePinnedTaaad(home: string, _trust: "default" | "permissive" = "default"): string | null {
  const pin = readPinnedTaaad(home);
  if (pin === null || !isAbsolute(pin.launcher)) return null;
  return pin.launcher;
}
