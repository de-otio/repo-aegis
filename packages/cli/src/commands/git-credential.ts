// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `repo-aegis git-credential --home <pinned home> <get|store|erase>`: a git credential helper that gives an
// agent's HTTPS push a GitHub App token narrowed to one repository (doc/plan-owner-identity.md §5.6, §13.4,
// §12.1 A5, A7, A17).
//
// THE CONTRACT with git, which reads stdout:
//   - printing NOTHING means "I have no answer": git asks the next helper, which is the person's own. That is
//     reserved for two cases: a person is present, and the owner is not mapped (or only a person identity
//     answers it: agents read as the person, N3).
//   - EVERY refusal prints exactly `quit=true`: git stops asking and does not prompt. The reason, with its
//     code, goes to stderr. Falling through on a refusal would hand the agent the person's credential.
//   - the exit status is always 0: a non-zero exit from a helper makes git warn and carry on.
//   - `store` and `erase` are ignored. (A later helper in the list still receives `store` from git; A5 makes
//     the helper refuse when any helper that could be agent-writable is in the list.)
//
// The decision is `chooseIdentity` (core), the same function the hook and `repo-aegis gh` use. This module only
// adds what is specific to git: the protocol, the parent chain that tells a push from a fetch (A7), and A5's
// configuration and environment checks. The token is written to stdout and nowhere else.
import { basename, isAbsolute, join } from "node:path";
import {
  appendAuditRecord,
  checkTerminal,
  chooseIdentity,
  identityPresence,
  loadRegistry,
  readProcessAncestry,
  refusal,
  registeredOwners,
  RegistryNotFoundError,
  type AncestorInfo,
  type AncestryChain,
  type IdentityPresence,
  type IdentityScope,
  type Registry,
} from "@de-otio/repo-aegis-core";
import {
  credentialConfigViolation,
  readCredentialConfig,
  type ConfigEntry,
} from "../git-credential-config.js";
import { mintAppToken, MintError, resolvePinnedTaaad, type MintParams, type MintedToken } from "./taaad-mint.js";

export const GIT_CREDENTIAL_ACTIONS = ["get", "store", "erase"] as const;
export type GitCredentialAction = (typeof GIT_CREDENTIAL_ACTIONS)[number];

export interface GitCredentialResult {
  /** Exactly what goes to stdout. */
  stdout: string;
  /** What goes to stderr: the refusal text with its code. Never a token. */
  stderr: string;
}

/** Everything the helper reads from outside, injectable so the decision is testable without a process tree. */
export interface GitCredentialDeps {
  env: NodeJS.ProcessEnv;
  cwd: string;
  presence: () => IdentityPresence;
  ancestry: () => AncestryChain | readonly AncestorInfo[] | null;
  readConfig: (cwd: string, env: NodeJS.ProcessEnv) => ConfigEntry[] | null;
  /** The registry in the pinned home: `"missing"` when there is none, null when it cannot be read. */
  loadRegistry: (home: string) => Registry | "missing" | null;
  resolveTaaad: (home: string) => string | null;
  mint: (params: MintParams) => MintedToken;
}

export function realGitCredentialDeps(): GitCredentialDeps {
  return {
    env: process.env,
    cwd: process.cwd(),
    presence: () => identityPresence(checkTerminal()),
    ancestry: () => readProcessAncestry(),
    readConfig: readCredentialConfig,
    loadRegistry: home => {
      try {
        // The pinned home only (D8): never REPO_AEGIS_REGISTRY, which the caller's environment could set.
        return loadRegistry(join(home, "engagements.yaml"));
      } catch (err) {
        return err instanceof RegistryNotFoundError ? "missing" : null;
      }
    },
    resolveTaaad: resolvePinnedTaaad,
    mint: mintAppToken,
  };
}

// ---------------------------------------------------------------------------
// The protocol
// ---------------------------------------------------------------------------

const MAX_INPUT_BYTES = 64 * 1024;

/** `key=value` lines up to the first blank line. Every value of a repeated key is kept. */
export function parseCredentialInput(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const line of text.slice(0, MAX_INPUT_BYTES).split("\n")) {
    if (line === "") break;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    const list = out.get(key);
    if (list === undefined) out.set(key, [line.slice(eq + 1)]);
    else list.push(line.slice(eq + 1));
  }
  return out;
}

interface Request {
  /** True when any host in the request is github.com (or github.com:443) over https. */
  forGithub: boolean;
  /** Distinct normalised `owner/repo` paths in the request (lower-cased, no `.git`). Empty when none. */
  paths: string[];
  /** The path as the request spelled it, for the mint (case kept). */
  firstPath: string | null;
  /** More than one protocol or host in one request. */
  mixed: boolean;
}

function normaliseHost(host: string): string {
  return host.toLowerCase().replace(/:443$/, "");
}

function ownerRepoOf(path: string): { owner: string; repo: string } | null {
  const trimmed = path.replace(/^\/+/, "").replace(/\/+$/, "");
  const m = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})$/.exec(trimmed);
  if (m === null) return null;
  const repo = m[2]!.replace(/\.git$/i, "");
  if (repo === "" || repo === "." || repo === "..") return null;
  return { owner: m[1]!, repo };
}

function readRequest(input: Map<string, string[]>): Request {
  const protocols = new Set<string>();
  const hosts = new Set<string>();
  const rawPaths: string[] = [];
  for (const p of input.get("protocol") ?? []) protocols.add(p.toLowerCase());
  for (const h of input.get("host") ?? []) hosts.add(normaliseHost(h));
  for (const p of input.get("path") ?? []) if (p !== "") rawPaths.push(p);
  for (const u of input.get("url") ?? []) {
    const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(?:[^@/]*@)?([^/]+)(\/.*)?$/.exec(u);
    if (m === null) continue;
    protocols.add(m[1]!.toLowerCase());
    hosts.add(normaliseHost(m[2]!));
    if (m[3] !== undefined && m[3] !== "/") rawPaths.push(m[3]);
  }
  const forGithub = protocols.has("https") && hosts.has("github.com");
  const normalised = new Set<string>();
  for (const p of rawPaths) {
    const or = ownerRepoOf(p);
    normalised.add(or === null ? `?${p}` : `${or.owner}/${or.repo}`.toLowerCase());
  }
  return {
    forGithub,
    paths: [...normalised],
    firstPath: rawPaths[0] ?? null,
    mixed: protocols.size > 1 || hosts.size > 1,
  };
}

// ---------------------------------------------------------------------------
// Push or fetch (A7)
// ---------------------------------------------------------------------------

function subcommandOf(argv: readonly string[]): string | null {
  // `git [-C <dir>] [-c <k=v>] [--opt[=v]] <subcommand> …`, within the six words the process list keeps.
  for (let i = 1; i < argv.length; i++) {
    const w = argv[i]!;
    if (w === "-C" || w === "-c" || w === "--git-dir" || w === "--work-tree" || w === "--namespace" || w === "--exec-path") {
      i++;
      continue;
    }
    if (w.startsWith("-")) continue;
    return w;
  }
  return null;
}

/** What the parent chain says about who asked: a push, another remote operation, no remote helper at all, or unreadable. */
export type Parent = "push" | "remote" | "direct" | "unreadable";

/**
 * A7. The helper answers only a request that comes from `git-remote-https`, which git spawns for push, fetch,
 * pull, clone and ls-remote. Anything else asking (`git credential fill` run by hand, `git credential-<x> get`, a
 * direct invocation) is `direct`: it would hand a token to whoever typed the command. Above the remote helper, the
 * nearest `git`'s subcommand decides: `push` and `send-pack` are writes; any other subcommand, or one that cannot
 * be read from the few argv words kept (an alias), is a read, which only mints the narrower token.
 * `unreadable` when no chain could be read at all, or the remote helper has no readable `git` above it.
 */
export function parentFromAncestry(chain: AncestryChain | readonly AncestorInfo[] | null): Parent {
  if (chain === null) return "unreadable";
  const ancestors: readonly AncestorInfo[] = Array.isArray(chain) ? chain : (chain as AncestryChain).ancestors;
  const isRemote = (a: AncestorInfo): boolean => {
    const n = basename(a.comm);
    return n === "git-remote-https" || n === "git-remote-http" || (a.argv[0] !== undefined && /^git-remote-https?$/.test(basename(a.argv[0])));
  };
  const at = ancestors.findIndex(isRemote);
  if (at === -1) return ancestors.length === 0 ? "unreadable" : "direct";
  for (const a of ancestors.slice(at + 1)) {
    const name = basename(a.comm);
    const arg0 = a.argv[0] !== undefined ? basename(a.argv[0]) : "";
    if (name === "git" || arg0 === "git") {
      const sub = subcommandOf(a.argv);
      return sub === "push" || sub === "send-pack" ? "push" : "remote";
    }
  }
  return "unreadable";
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

const QUIT = "quit=true\n";
const NOTHING: GitCredentialResult = { stdout: "", stderr: "" };

function refuse(code: string, why: string, dest?: { owner: string; repo: string }): GitCredentialResult {
  const reason = refusal({
    code,
    ...(dest !== undefined && { destination: { verb: "git push", org: dest.owner, repo: dest.repo } }),
    what: "a git credential request for github.com",
    why,
    approval: "No approval covers this.",
    fixes: [{ by: "person", step: "checks `repo-aegis doctor` and re-runs the command from a terminal" }],
  });
  return { stdout: QUIT, stderr: `repo-aegis git-credential: ${reason}\n` };
}

function refuseText(code: string, reason: string): GitCredentialResult {
  return { stdout: QUIT, stderr: `repo-aegis git-credential: ${reason.includes(code) ? reason : `${reason} [${code}]`}\n` };
}

function expiryLine(expiresAt: string | null): string {
  if (expiresAt === null) return "";
  const seconds = Math.floor(Date.parse(expiresAt) / 1000);
  return Number.isSafeInteger(seconds) && seconds > 0 ? `password_expiry_utc=${seconds}\n` : "";
}

function auditBestEffort(details: Record<string, unknown>): void {
  try {
    appendAuditRecord({ action: "git-credential", details });
  } catch {
    /* the audit log must never break a push, and it never holds a token */
  }
}

/** `get`. Pure given `deps`: returns what to print, never prints or exits. */
export function gitCredentialGet(stdin: string, home: string, deps: GitCredentialDeps): GitCredentialResult {
  const request = readRequest(parseCredentialInput(stdin));
  if (!request.forGithub) return NOTHING;

  // A person present: the next helper answers, exactly as without repo-aegis. No registry read, no mint.
  const presence = deps.presence();
  if (presence === "person") return NOTHING;

  if (!isAbsolute(home)) {
    return refuse("GH_IDENTITY_UNAVAILABLE", "the helper was configured without an absolute --home");
  }
  // A7: only git-remote-https may be answered. Checked for every github.com request from a non-person, mapped or not.
  let parent: Parent;
  try {
    parent = parentFromAncestry(deps.ancestry());
  } catch {
    parent = "unreadable";
  }
  if (parent === "direct") {
    return refuse("AGENT_CREDENTIAL_DIRECT_FILL", "the request does not come from git's HTTPS remote helper (for example `git credential fill` was run directly), so no credential is given");
  }
  if (parent === "unreadable") {
    return refuse("AGENT_PUSH_CHAIN_UNREADABLE", "repo-aegis could not read the process list to confirm that git's HTTPS remote helper asked, so no credential is given");
  }
  const chain = parent === "push";
  if (request.mixed) {
    return refuse("AGENT_PUSH_CREDENTIAL_PATH", "the request names more than one protocol or host, so repo-aegis cannot tell where the credential would go");
  }
  // A17: one path per invocation. A renamed repository makes git ask again with the new path.
  if (request.paths.length > 1) {
    return refuse("AGENT_PUSH_CREDENTIAL_PATH", "the request names more than one repository path, so repo-aegis cannot tell which one the credential is for");
  }
  const target = request.firstPath === null ? null : ownerRepoOf(request.firstPath);
  if (target === null) {
    // No usable path (credential.useHttpPath off, or a path that is not owner/repo): the owner is unknown, and
    // falling through would answer an agent with the person's credential.
    return refuse(
      "AGENT_PUSH_CREDENTIAL_CONFIG",
      "git did not pass an owner/repo path (credential.useHttpPath must be true for github.com; `repo-aegis install git-credential` sets it)",
    );
  }
  const dest = { owner: target.owner.toLowerCase(), repo: target.repo };

  const registry = deps.loadRegistry(home);
  if (registry === "missing") return NOTHING;
  if (registry === null) {
    return refuse("GH_IDENTITY_UNAVAILABLE", "the registry in the pinned home could not be read, so repo-aegis cannot tell whether this owner has a GitHub identity", dest);
  }

  const owners = registeredOwners(registry);
  const choice = chooseIdentity({
    args: [],
    isWrite: chain,
    targets: [{ owner: dest.owner, repo: dest.repo, source: "literal" }],
    registry,
    presence,
    approvalFor: () => null,
    suppliedToken: false,
    redirect: null,
    registeredOwner: o => owners.has(o.toLowerCase()),
  });

  if (choice.kind === "none") return NOTHING;
  if (choice.kind === "refuse") return refuseText(choice.code, choice.reason);
  // An agent that may only read as the person (N3): the next helper answers.
  if (choice.column === "person") return NOTHING;

  if (choice.identity.kind !== "github-app") {
    return refuse("GH_IDENTITY_UNAVAILABLE", "the agent identity of this owner is not a GitHub App", dest);
  }
  // A5: configuration and environment that could redirect or capture the token. Checked before any mint.
  const entries = deps.readConfig(deps.cwd, deps.env);
  if (entries === null) {
    return refuse("AGENT_PUSH_CREDENTIAL_CONFIG", "git's configuration could not be read", dest);
  }
  const violation = credentialConfigViolation(entries, { path: `${dest.owner}/${dest.repo}` }, deps.env);
  if (violation !== null) {
    return refuse("AGENT_PUSH_CREDENTIAL_CONFIG", `${violation}, which could redirect or capture the token`, dest);
  }

  const taaadPath = deps.resolveTaaad(home);
  if (taaadPath === null) {
    return refuse("GH_BINARY_UNTRUSTED", "no pinned taaad is known to use (run `repo-aegis install shim`)", dest);
  }
  const scope: IdentityScope = chain ? "contents-write" : "read";
  let minted: MintedToken;
  try {
    minted = deps.mint({ taaadPath, slug: choice.identity.app, owner: dest.owner, repo: dest.repo, scope });
  } catch (err) {
    if (err instanceof MintError && err.kind === "installation-mismatch") {
      return refuse("GH_IDENTITY_INSTALLATION_MISMATCH", err.message, dest);
    }
    const why = err instanceof MintError ? err.message : "the token could not be minted";
    return refuse("GH_IDENTITY_UNAVAILABLE", `${why} (the App may not be installed on this repository)`, dest);
  }
  auditBestEffort({ identity: choice.identity.name, kind: "github-app", owner: dest.owner, repo: dest.repo, scope, verb: chain ? "push" : "fetch" });
  return {
    stdout: `username=x-access-token\npassword=${minted.token}\n${expiryLine(minted.expiresAt)}`,
    stderr: "",
  };
}

/** The helper as `repo-aegis git-credential` runs it. Total: a fault on a github.com `get` is a refusal. */
export function runGitCredential(
  action: string,
  stdin: string,
  home: string,
  deps: GitCredentialDeps = realGitCredentialDeps(),
): GitCredentialResult {
  if (action !== "get") return NOTHING; // store, erase, and any verb a later git adds
  try {
    return gitCredentialGet(stdin, home, deps);
  } catch {
    // Only reached for a github.com request that faulted after presence said "agent"; others return above
    // before anything can throw. Guard the rest the same way.
    try {
      if (readRequest(parseCredentialInput(stdin)).forGithub && deps.presence() !== "person") {
        return refuse("GH_IDENTITY_UNAVAILABLE", "the credential helper faulted");
      }
    } catch {
      return refuse("GH_IDENTITY_UNAVAILABLE", "the credential helper faulted");
    }
    return NOTHING;
  }
}
