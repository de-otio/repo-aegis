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
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { IdentityScope } from "@de-otio/repo-aegis-core";

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
  ) {
    super(message);
    this.name = "MintError";
  }
}

const SPAWN_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
/** What a GitHub installation token looks like, loosely: no whitespace, no line breaks (the credential protocol is line based). */
const TOKEN_SHAPE = /^[A-Za-z0-9_.=-]{8,1024}$/;

/** The environment of the taaad spawn: exactly these four names (A4). No `TAAAD_*`, no `XDG_*`, nothing the caller set. */
export function taaadEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const home = env["HOME"];
  return {
    HOME: home !== undefined && home !== "" ? home : homedir(),
    PATH: "/usr/bin:/bin",
    TERM: env["TERM"] !== undefined && env["TERM"] !== "" ? env["TERM"] : "dumb",
    LANG: env["LANG"] !== undefined && env["LANG"] !== "" ? env["LANG"] : "C",
  };
}

const READ_KEYS = new Set(["metadata", "contents", "pull_requests", "issues"]);

/** Permissions no wider than `scope` (taaad README: read set / contents:write + metadata:read / the installation's own). */
function permissionsWithin(scope: IdentityScope, perms: Record<string, string>): boolean {
  const entries = Object.entries(perms);
  if (entries.length === 0) return false;
  switch (scope) {
    case "read":
      return entries.every(([k, v]) => READ_KEYS.has(k) && v === "read");
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
  if (r.error !== undefined) throw new MintError("unavailable", "taaad could not be run");
  if (r.status !== 0) throw new MintError("unavailable", "taaad exited with a failure and minted nothing");
  if (typeof r.stdout !== "string" || r.stdout.trim() === "") throw new MintError("unavailable", "taaad printed nothing");
  return validateMintOutput(r.stdout, p);
}

/**
 * The taaad that `install shim` pinned, or null when none is known.
 *
 * PLACEHOLDER: the real pin (the realpaths of launcher, interpreter and package directory, root-owned,
 * §13.3) is written by `install shim` on another branch and will replace this body. Until then it reads a
 * minimal `<home>/state/taaad-pin.json` of the form `{"launcher": "/absolute/path"}`. Anything else (no file,
 * bad JSON, a relative or missing path) is null, which a caller treats as "no trusted taaad".
 */
export function resolvePinnedTaaad(home: string): string | null {
  try {
    const file = join(home, "state", "taaad-pin.json");
    if (!existsSync(file)) return null;
    const json = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (typeof json !== "object" || json === null) return null;
    const launcher = (json as Record<string, unknown>)["launcher"];
    if (typeof launcher !== "string" || !isAbsolute(launcher)) return null;
    return statSync(launcher).isFile() ? launcher : null;
  } catch {
    return null;
  }
}
