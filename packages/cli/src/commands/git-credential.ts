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
  approvalsPath,
  checkTerminal,
  chooseIdentity,
  findAccountBoundApproval,
  findLoginApproval,
  identityPresence,
  loadRegistry,
  personLoginOf,
  readProcessAncestry,
  refusal,
  registeredOwners,
  RegistryNotFoundError,
  type AncestorInfo,
  type AncestryChain,
  type EgressApproval,
  type IdentityChoice,
  type IdentityPresence,
  type IdentityScope,
  type Registry,
  type RefusalFix,
} from "@de-otio/repo-aegis-core";
import {
  credentialConfigViolation,
  laterStoringHelper,
  readCredentialConfig,
  type ConfigEntry,
} from "../git-credential-config.js";
import { resolveTrustedGh } from "./doctor-owner-checks.js";
import { fetchLoginToken } from "./gh-identity-token.js";
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
  /**
   * The token of the GitHub account `login`, for a push an approval bound to that login covers. Asked of the
   * pinned/trusted `gh` (the one `repo-aegis gh` hands tokens to), never of whichever account is active: `untrusted`
   * when no gh may be handed the request, `unavailable` when gh has no usable token for that login.
   */
  loginToken: (login: string, env: NodeJS.ProcessEnv, home: string) => LoginTokenResult;
}

export type LoginTokenResult =
  | { kind: "token"; token: string }
  | { kind: "untrusted"; reason: string }
  | { kind: "unavailable" };

function realLoginToken(login: string, env: NodeJS.ProcessEnv, home: string): LoginTokenResult {
  const trusted = resolveTrustedGh({ ...env, REPO_AEGIS_HOME: home }, "default");
  if (trusted.kind === "skip") return { kind: "untrusted", reason: trusted.reason };
  const token = fetchLoginToken(trusted.path, login, env, "default");
  return token === null ? { kind: "unavailable" } : { kind: "token", token };
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
    loginToken: realLoginToken,
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

/** What the parent chain says about who asked. `sub` is the nearest `git`'s subcommand when it could be read. */
export type Parent =
  | { kind: "push"; sub: string }
  | { kind: "remote"; sub: string | null }
  | { kind: "direct" }
  | { kind: "unreadable" };

/** Subcommands that only read: the only ones for which an agent may fall through to the person's own credential. */
export const KNOWN_READ_SUBCOMMANDS: ReadonlySet<string> = new Set(["fetch", "pull", "clone", "ls-remote", "archive", "remote", "submodule"]);

const SHELLS = new Set(["sh", "bash", "dash", "zsh", "ksh"]);

/** `owner/repo` of a path or URL path, lower-cased, without `.git`; null when it is not that shape. */
function normalisedPath(path: string): string | null {
  const or = ownerRepoOf(path);
  return or === null ? null : `${or.owner}/${or.repo}`.toLowerCase();
}

/** `git remote-https <remote> <url>` whose `<remote> <url>` are the remote helper's own arguments. */
function isDispatcherOf(dispatcher: readonly string[], remote: readonly string[]): boolean {
  const at = dispatcher.findIndex(w => w === "remote-https" || w === "remote-http");
  if (at === -1) return false;
  const rest = dispatcher.slice(at + 1);
  const own = remote.slice(1);
  return rest.length === own.length && rest.every((w, k) => w === own[k]);
}

/**
 * A7, hardened. The helper answers only a request that git's HTTPS remote helper made, and "the chain contains a
 * process called git-remote-https" is forgeable (`cp /bin/sh /tmp/git-remote-https`), so the shape is checked:
 *
 *   helper <- [one shell, if git did not exec the helper directly] <- git-remote-https <- git <push|fetch|…>
 *
 * The remote helper must be the helper's parent or grandparent, with nothing but a plain shell between; its
 * argv must be `[git-remote-https, <remote>, https://github.com/<path>]` with that path equal to the request's
 * (case and `.git` aside); and no process between the helper and that git may be a `git credential…` command.
 * Anything else is `direct`. Above the remote helper, the nearest `git`'s subcommand decides: `push` and
 * `send-pack` are writes, any other subcommand, or one that cannot be read from the few argv words kept (an
 * alias), is a read. `unreadable` when no chain could be read, or no `git` can be found above the remote helper.
 *
 * Still a heuristic: a same-user process can set its own name and argv, and the process list is not a security
 * boundary (doc/configuration.md).
 */
export function parentFromAncestry(chain: AncestryChain | readonly AncestorInfo[] | null, requestPath: string | null): Parent {
  if (chain === null) return { kind: "unreadable" };
  const ancestors: readonly AncestorInfo[] = Array.isArray(chain) ? chain : (chain as AncestryChain).ancestors;
  if (ancestors.length === 0) return { kind: "unreadable" };
  const isRemote = (a: AncestorInfo): boolean => {
    const n = basename(a.comm);
    return n === "git-remote-https" || n === "git-remote-http" || (a.argv[0] !== undefined && /^git-remote-https?$/.test(basename(a.argv[0])));
  };
  const at = ancestors.findIndex(isRemote);
  if (at === -1 || at > 1) return { kind: "direct" };
  for (const between of ancestors.slice(0, at)) {
    if (!SHELLS.has(basename(between.comm)) || (between.argv[0] !== undefined && !SHELLS.has(basename(between.argv[0]).replace(/^-/, "")))) {
      return { kind: "direct" };
    }
  }
  const remote = ancestors[at]!;
  if (remote.argv.length < 3) return { kind: "direct" };
  const url = /^https:\/\/github\.com(?::443)?(\/.+)$/i.exec(remote.argv[2]!);
  if (url === null) return { kind: "direct" };
  const urlPath = normalisedPath(url[1]!);
  if (urlPath === null) return { kind: "direct" };
  // A request path that is not owner/repo is refused later, as a configuration problem; only a real one is compared.
  const requested = requestPath === null ? null : normalisedPath(requestPath);
  if (requested !== null && requested !== urlPath) return { kind: "direct" };
  for (const [i, a] of ancestors.slice(at + 1).entries()) {
    const name = basename(a.comm);
    const arg0 = a.argv[0] !== undefined ? basename(a.argv[0]) : "";
    if (name === "git" || arg0 === "git") {
      const sub = subcommandOf(a.argv);
      // git starts the remote helper as `git remote-https <remote> <url>` and waits; that process runs
      // `git-remote-https` as its child. Skip that dispatcher (directly above, same arguments) and let the git
      // that asked for the transport decide, or every push is read as a fetch.
      if (i === 0 && (sub === "remote-https" || sub === "remote-http") && isDispatcherOf(a.argv, remote.argv)) continue;
      if (sub === "credential" || (sub !== null && sub.startsWith("credential-"))) return { kind: "direct" };
      return sub === "push" || sub === "send-pack" ? { kind: "push", sub } : { kind: "remote", sub };
    }
  }
  return { kind: "unreadable" };
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

const QUIT = "quit=true\n";
const NOTHING: GitCredentialResult = { stdout: "", stderr: "" };

/**
 * The approval sentence of every refusal here but AGENT_PUSH_CHAIN_UNREADABLE (U7): the one condition an approval
 * covers is named, so an agent that reads "no approval" does not conclude none of them can be.
 */
const NO_APPROVAL_HERE =
  "No approval covers this; only an unreadable process list (AGENT_PUSH_CHAIN_UNREADABLE) is covered, by an account-bound `repo-aegis approve <owner>/<repo>`; a push as the owner's person account (GH_IDENTITY_WRITE_NEEDS_HUMAN) is covered by that same approval.";

const DOCTOR_FIX: RefusalFix = { by: "person", command: "repo-aegis doctor", note: "it reports why; then re-run the command from a terminal" };

/** What a person does about a configuration or environment hit named by `credentialConfigViolation`. */
function configFix(violation: string): RefusalFix {
  if (violation.endsWith("in the environment")) {
    return { by: "person", step: "unsets that environment variable in the shell the push runs from, or runs the push from a shell without it" };
  }
  return {
    by: "person",
    command: "git config --list --show-origin",
    note: "it names the file that sets it; remove the setting there (it only stops applying to the pushes it was meant for, so read its value first)",
  };
}

function refuse(
  code: string,
  why: string,
  dest?: { owner: string; repo: string },
  fix: RefusalFix = DOCTOR_FIX,
  approval: string = NO_APPROVAL_HERE,
): GitCredentialResult {
  const reason = refusal({
    code,
    ...(dest !== undefined && { destination: { verb: "git push", org: dest.owner, repo: dest.repo } }),
    what: "a git credential request for github.com",
    why,
    approval,
    fixes: [fix],
  });
  return { stdout: QUIT, stderr: `repo-aegis git-credential: ${reason}\n` };
}

/**
 * `AGENT_PUSH_CHAIN_UNREADABLE` with no approval to cover it (doc/plan-landscape-recommendations.md, U2). The usual
 * cause is a sandbox that blocks the process list (the default Claude Code sandbox does), so the text says so and
 * names the three ways out, every one of them a person's step: an agent must not take the third by itself, because
 * leaving a sandbox is a decision for whoever owns it. The approval remedy is only offered when the path named a
 * usable `<owner>/<repo>`; the command is built from the validated names only.
 */
function refuseChainUnreadable(dest: { owner: string; repo: string } | null): GitCredentialResult {
  const target = dest === null ? null : `${dest.owner.toLowerCase()}/${dest.repo}`;
  const reason = refusal({
    code: "AGENT_PUSH_CHAIN_UNREADABLE",
    ...(dest !== null && { destination: { verb: "git push", org: dest.owner, repo: dest.repo } }),
    what: "a git credential request for github.com",
    why: "repo-aegis could not read the process list to confirm that git's HTTPS remote helper asked, so no credential is given; a sandbox that blocks the process list (the default Claude Code sandbox does) is the likely cause",
    approval:
      target === null
        ? "No approval covers this."
        : `An approval for ${target} from a person covers this when the owner has a person identity mapped.`,
    fixes: [
      { by: "person", step: "runs the push from a terminal" },
      ...(target === null
        ? []
        : [{ by: "person" as const, command: `repo-aegis approve ${target}`, note: "agents may then push to it for the approval's lifetime" }]),
      { by: "person", step: "lets the agent's command run outside the sandbox" },
    ],
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

/**
 * Append the helper's audit record to the PINNED home's log (D8), as `repo-aegis gh` does: the audit log's reader
 * defaults to REPO_AEGIS_HOME, which here is the caller's environment, not the home git's config pinned. The
 * variable is set only for this one call and restored, so no other reader is affected.
 */
function auditBestEffort(details: Record<string, unknown>, home: string): void {
  const saved = process.env["REPO_AEGIS_HOME"];
  try {
    process.env["REPO_AEGIS_HOME"] = home;
    appendAuditRecord({ action: "git-credential", details });
  } catch {
    /* the audit log must never break a push, and it never holds a token */
  } finally {
    if (saved === undefined) delete process.env["REPO_AEGIS_HOME"];
    else process.env["REPO_AEGIS_HOME"] = saved;
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
    return refuse(
      "GH_IDENTITY_UNAVAILABLE",
      "the helper line in git's configuration has no absolute --home (repo-aegis writes that line itself in `install git-credential`, so it is stale or was edited by hand)",
      undefined,
      { by: "person", command: "repo-aegis install git-credential", note: "it rewrites only repo-aegis's own helper entry, so re-running it is safe" },
    );
  }
  // A7: only git-remote-https may be answered. Checked for every github.com request from a non-person, mapped or not.
  let parent: Parent;
  try {
    parent = parentFromAncestry(deps.ancestry(), request.firstPath);
  } catch {
    parent = { kind: "unreadable" };
  }
  if (parent.kind === "direct") {
    return refuse("AGENT_CREDENTIAL_DIRECT_FILL", "the request does not come from git's HTTPS remote helper (for example `git credential fill` was run directly), so no credential is given; the command itself is the cause, and no repo-aegis setting created it", undefined, {
      by: "person",
      step: "runs the original `git push` from a terminal; a token is only given to git's own HTTPS remote helper",
    });
  }
  // The registry is read once, from the pinned home, and only past the checks above (a person present never
  // reaches here: no registry read for them).
  let registryRead: { value: Registry | "missing" | null } | undefined;
  const readRegistry = (): Registry | "missing" | null => (registryRead ??= { value: deps.loadRegistry(home) }).value;
  // U5: a person's approval for `<owner>/<repo>` (or `<owner>/*`), bound to the account the owner's person identity
  // names NOW and unexpired, also covers "the process list cannot be read", so an agent can push from inside a
  // sandbox. It covers only "cannot tell": a chain that WAS read and shows another caller is `direct`, refused
  // above whatever is approved. An approval minted for an account the owner is no longer mapped to covers nothing,
  // and neither does one for an owner with no person login (or no readable registry): there is no account to
  // bind to. The store is read from the pinned home, as the registry is, never from the caller's environment.
  // Everything below still applies (one path, the identity choice, A5 configuration, the mint).
  let covered: EgressApproval | null = null;
  if (parent.kind === "unreadable") {
    const approvalTarget = request.mixed || request.paths.length > 1 || request.firstPath === null ? null : ownerRepoOf(request.firstPath);
    if (approvalTarget !== null) {
      const reg = readRegistry();
      const bound = reg === "missing" || reg === null ? null : personLoginOf(reg, approvalTarget.owner);
      covered =
        bound === null
          ? null
          : findAccountBoundApproval({ org: approvalTarget.owner, repo: approvalTarget.repo }, bound, approvalsPath(home));
    }
    if (covered === null) return refuseChainUnreadable(approvalTarget);
  }
  // An unreadable chain cannot tell a push from a fetch: it is treated as a push (the wider scope), which is what
  // the approval authorises.
  const chain = parent.kind === "push" || covered !== null;
  if (request.mixed) {
    return refuse("AGENT_PUSH_CREDENTIAL_PATH", "the request names more than one protocol or host, so repo-aegis cannot tell where the credential would go (git sent it that way; no repo-aegis setting created this)", undefined, {
      by: "person",
      step: "runs the push on its own, from a terminal",
    });
  }
  // A17: one path per invocation. A renamed repository makes git ask again with the new path.
  if (request.paths.length > 1) {
    return refuse("AGENT_PUSH_CREDENTIAL_PATH", "the request names more than one repository path, so repo-aegis cannot tell which one the credential is for (git sent it that way; no repo-aegis setting created this)", undefined, {
      by: "person",
      step: "runs the push for one repository at a time, from a terminal",
    });
  }
  const target = request.firstPath === null ? null : ownerRepoOf(request.firstPath);
  if (target === null) {
    // No usable path (credential.useHttpPath off, or a path that is not owner/repo): the owner is unknown, and
    // falling through would answer an agent with the person's credential.
    return refuse(
      "AGENT_PUSH_CREDENTIAL_CONFIG",
      "git did not pass an owner/repo path (credential.useHttpPath must be true for github.com; `repo-aegis install git-credential` sets it, so it was never installed or the setting was turned off afterwards)",
      undefined,
      { by: "person", command: "repo-aegis install git-credential", note: "it sets credential.useHttpPath for github.com and touches nothing else, so re-running it is safe" },
    );
  }
  const dest = { owner: target.owner.toLowerCase(), repo: target.repo };

  const registry = readRegistry();
  // No registry: the next helper answers, but only for a request known to come from git. A covered request is the
  // unreadable-chain case, which is not known, so it keeps its refusal.
  if (registry === "missing") return covered === null ? NOTHING : refuseChainUnreadable(dest);
  if (registry === null) {
    return refuse("GH_IDENTITY_UNAVAILABLE", "the registry in the pinned home could not be read (it is encrypted or damaged; repo-aegis did not change it), so repo-aegis cannot tell whether this owner has a GitHub identity", dest);
  }

  const owners = registeredOwners(registry);
  // The same approvals `repo-aegis gh` reads: the pinned home's, for a login-bound write as a person's account (A11).
  const decide = (isWrite: boolean): IdentityChoice =>
    chooseIdentity({
      args: [],
      isWrite,
      targets: [{ owner: dest.owner, repo: dest.repo, source: "literal" }],
      registry,
      presence,
      approvalFor: (owner, repo, login) => findLoginApproval({ org: owner, repo: repo ?? "*" }, login, approvalsPath(home))?.id ?? null,
      suppliedToken: false,
      redirect: null,
      registeredOwner: o => owners.has(o.toLowerCase()),
    });
  let choice = decide(chain);

  if (choice.kind === "none") {
    // An unmapped owner falls through to the person's own helper, but only for a request known to come from git;
    // an unreadable chain is not known, so the covered case keeps its refusal.
    return covered === null ? NOTHING : refuseChainUnreadable(dest);
  }
  // A person's account and a write with no login-bound approval: say what covers it at this layer (the core
  // refusal's text is written for `repo-aegis gh`).
  const needsHuman = (): GitCredentialResult =>
    refuse(
      "GH_IDENTITY_WRITE_NEEDS_HUMAN",
      "this would run as a person's GitHub account, and the git subcommand is not one known to only read (an alias, or one that cannot be read from the process list), so it may be a push; the person-only mapping is a registry choice, repo-aegis created no setting for it",
      dest,
      {
        by: "person",
        command: `repo-aegis approve ${dest.owner}/${dest.repo}`,
        note: "login-bound: it records the owner's person account, and agents may then push as that account for the approval's lifetime; or the person runs the push from a terminal",
      },
      `A login-bound \`repo-aegis approve ${dest.owner}/${dest.repo}\` (or \`${dest.owner}/*\`) run by a person from a terminal covers this, for the account the owner's person identity names; a \`*\` approval, one with no recorded account and one for another account do not.`,
    );
  if (choice.kind === "refuse") return choice.code === "GH_IDENTITY_WRITE_NEEDS_HUMAN" ? needsHuman() : refuseText(choice.code, choice.reason);
  // The id of the login-bound approval under which this push runs as the person's account, when it does.
  let personApproval: string | null = null;
  // An agent that may only read as the person (N3), on a subcommand known to read: answered with the MAPPED login's
  // token, no approval (a read is not egress). Falling through to the next helper instead would answer with
  // whichever account that helper holds (gh's active account, the keychain's), which is the wrong account whenever
  // the person has more than one: the fetch then fails with "Repository not found". An alias or an unreadable
  // subcommand could be a push, and a push as the person needs a login-bound approval, looked up as for any write.
  let personRead = false;
  if (choice.column === "person") {
    if (parent.kind === "remote" && parent.sub !== null && KNOWN_READ_SUBCOMMANDS.has(parent.sub)) {
      personRead = true;
    } else {
      const asWrite = chain ? choice : decide(true);
      if (asWrite.kind !== "inject" || asWrite.column !== "person" || asWrite.approvalId === undefined) return needsHuman();
      choice = asWrite;
      personApproval = asWrite.approvalId;
    }
  }

  if (personApproval === null && !personRead && choice.identity.kind !== "github-app") {
    return refuse(
      "GH_IDENTITY_UNAVAILABLE",
      "the agent identity of this owner is not a GitHub App (the registry maps a GitHub login there; a person set that, repo-aegis did not)",
      dest,
      { by: "person", command: "repo-aegis engagements set-identity <id> --agent <app-name>", note: "`repo-aegis status` shows the current mapping; changing it affects only this owner's agent pushes" },
    );
  }
  // git compares URL patterns against the path as sent (case and .git kept); the normalised form counts too.
  const matchCtx = { path: (request.firstPath ?? "").replace(/^\/+/, ""), altPath: `${dest.owner}/${dest.repo}`.toLowerCase() };
  // A5: configuration and environment that could redirect or capture the token. Checked before any mint.
  const entries = deps.readConfig(deps.cwd, deps.env);
  if (entries === null) {
    return refuse("AGENT_PUSH_CREDENTIAL_CONFIG", "git's configuration could not be read (git failed to start, or a config file is unreadable; repo-aegis did not cause it)", dest, {
      by: "person",
      command: "git config --list --show-origin",
      note: "it shows which file fails to read; repair or remove that file",
    });
  }
  const violation = credentialConfigViolation(entries, matchCtx, deps.env);
  if (violation !== null) {
    return refuse("AGENT_PUSH_CREDENTIAL_CONFIG", `${violation}, which could redirect or capture the token; repo-aegis did not set it`, dest, configFix(violation));
  }

  // `store` goes to every helper in the list: one that persists would save the App token.
  const storing = laterStoringHelper(entries, matchCtx);
  if (storing !== null) {
    return refuse(
      "AGENT_PUSH_CREDENTIAL_STORE",
      `the ${personApproval === null ? "App" : "account's"} token would be saved by a later credential helper (${storing}), because git sends \`store\` to every helper; scope that helper away from https://github.com (credential.https://github.com.helper with a reset entry) or reorder, then re-run \`repo-aegis install git-credential\`; repo-aegis did not add that helper`,
      dest,
      { by: "person", command: "git config --list --show-origin", note: "it lists the helpers in order and names the files that set them; scope the later one away from https://github.com or move it before repo-aegis's, then re-run `repo-aegis install git-credential`" },
    );
  }

  if (personApproval !== null || personRead) {
    // A person's account, for a known read or under a login-bound approval: the token is THAT login's, from the
    // trusted gh, never the active gh account's. Every check above applied to it exactly as to an App token.
    const identity = choice.identity;
    if (identity.kind !== "gh-login") {
      // approvalFor is only consulted for a gh-login, so this is unreachable; fail closed rather than guess.
      return refuse("GH_IDENTITY_UNAVAILABLE", "the person identity of this owner is not a GitHub login", dest);
    }
    // The audit record names the approval (an id, never the login) and never a token.
    const record =
      personApproval === null
        ? { identity: identity.name, kind: "gh-login", column: "person", owner: dest.owner, repo: dest.repo, scope: "read", verb: "fetch" }
        : {
            identity: identity.name,
            kind: "gh-login",
            column: "person",
            owner: dest.owner,
            repo: dest.repo,
            scope: "write",
            verb: "push",
            approval: personApproval,
            covers: "GH_IDENTITY_WRITE_NEEDS_HUMAN",
            ...(covered !== null && { chainApproval: covered.id }),
          };
    const got = deps.loginToken(identity.login, deps.env, home);
    if (got.kind !== "token") {
      const untrusted = got.kind === "untrusted";
      const code = untrusted ? "GH_BINARY_UNTRUSTED" : "GH_IDENTITY_UNAVAILABLE";
      auditBestEffort({ ...record, outcome: "refused", code, reason: got.kind }, home);
      return untrusted
        ? refuse(code, `there is no gh repo-aegis may ask for the mapped account's token (${got.reason}); repo-aegis did not put that gh there, it only refuses to trust it`, dest, {
            by: "person",
            command: "repo-aegis doctor",
            note: "it names which gh is first on PATH and why it is untrusted; then put a package-manager gh (for example Homebrew's) first, or run the push from a terminal",
          })
        : refuse(code, "the mapped GitHub account has no usable token on this machine (gh could not give one for it; repo-aegis did not cause that)", dest, {
            by: "person",
            command: "repo-aegis doctor",
            note: "it reports why the mapped account cannot be used; then re-run the push",
          });
    }
    auditBestEffort(record, home);
    // A read prints nothing: it needs no approval, and a line on every fetch would be noise.
    if (personApproval === null) return { stdout: `username=x-access-token\npassword=${got.token}\n`, stderr: "" };
    return {
      stdout: `username=x-access-token\npassword=${got.token}\n`,
      // One line naming the approval, so a person reading the push output sees why an agent could push as them.
      stderr:
        `repo-aegis: approval ${personApproval} lets this push run as the GitHub account mapped to ${dest.owner}\n` +
        (covered === null ? "" : `repo-aegis: approval ${covered.id} covers an unreadable process list for ${dest.owner}/${dest.repo}\n`),
    };
  }

  const appIdentity = choice.identity;
  if (appIdentity.kind !== "github-app") {
    // Refused above (a login in the agent column); here only to narrow the type, and fail closed.
    return refuse("GH_IDENTITY_UNAVAILABLE", "the agent identity of this owner is not a GitHub App", dest);
  }
  const taaadPath = deps.resolveTaaad(home);
  if (taaadPath === null) {
    return refuse("GH_BINARY_UNTRUSTED", "no pinned taaad is known to use (repo-aegis pins taaad only when `repo-aegis install shim` runs, so none is pinned yet or the pin was removed)", dest, {
      by: "person",
      command: "repo-aegis install shim",
      note: "it needs taaad v0.6.0 or later installed first; re-running it is safe",
    });
  }
  const scope: IdentityScope = chain ? "contents-write" : "read";
  // The audit record names the approval that let an unreadable process list through (the id, never its login).
  const coveredBy = covered === null ? {} : { approval: covered.id, covers: "AGENT_PUSH_CHAIN_UNREADABLE" };
  let minted: MintedToken;
  try {
    minted = deps.mint({ taaadPath, slug: appIdentity.app, owner: dest.owner, repo: dest.repo, scope });
  } catch (err) {
    const mismatch = err instanceof MintError && err.kind === "installation-mismatch";
    const code = mismatch ? "GH_IDENTITY_INSTALLATION_MISMATCH" : "GH_IDENTITY_UNAVAILABLE";
    // A failed mint is recorded too (the reason is a fixed word, never taaad's output), so a refused push
    // can be diagnosed after the fact.
    auditBestEffort({
      identity: choice.identity.name,
      kind: "github-app",
      owner: dest.owner,
      repo: dest.repo,
      scope,
      verb: chain ? "push" : "fetch",
      outcome: "refused",
      code,
      reason: err instanceof MintError ? err.reason : "failed",
      ...coveredBy,
    }, home);
    return refuse(code, err instanceof MintError ? err.message : "the token could not be minted (taaad failed; repo-aegis did not cause it)", dest);
  }
  auditBestEffort({
    identity: choice.identity.name,
    kind: "github-app",
    owner: dest.owner,
    repo: dest.repo,
    scope,
    verb: chain ? "push" : "fetch",
    ...coveredBy,
  }, home);
  return {
    stdout: `username=x-access-token\npassword=${minted.token}\n${expiryLine(minted.expiresAt)}`,
    // One line, so a person reading the push output can see why an unreadable process list did not stop it.
    stderr: covered === null ? "" : `repo-aegis: approval ${covered.id} covers an unreadable process list for ${dest.owner}/${dest.repo}\n`,
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
        return refuse("GH_IDENTITY_UNAVAILABLE", "the credential helper hit an internal error (not a setting you made, and not one repo-aegis wrote)");
      }
    } catch {
      return refuse("GH_IDENTITY_UNAVAILABLE", "the credential helper hit an internal error (not a setting you made, and not one repo-aegis wrote)");
    }
    return NOTHING;
  }
}
