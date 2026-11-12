// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `repo-aegis git-credential --home <pinned home> <get|store|erase>`: a git credential helper that gives an
// agent's HTTPS push a GitHub App token narrowed to one repository (doc/plan-owner-identity.md §5.6, §13.4,
// §12.1 A5, A7, A17).
//
// THE CONTRACT with git, which reads stdout:
//   - printing NOTHING means "I have no answer": git asks the next helper, which is the person's own. That is
//     reserved for these cases: a person is present, the owner is not mapped, the registry is missing or
//     encrypted (the note on stderr says which), or the request is a known read whose registry cannot be read.
//   - EVERY refusal prints exactly `quit=true`: git stops asking and does not prompt. The reason, with its
//     code, goes to stderr. Falling through on a refusal would hand the agent the person's credential.
//   - the exit status is always 0: a non-zero exit from a helper makes git warn and carry on.
//   - `store` and `erase` are ignored. (A later helper in the list still receives `store` from git; A5 makes
//     the helper refuse an App token when any helper that could be agent-writable is in the list.)
//
// THE HELPER ONLY CHOOSES THE ACCOUNT (EVALUATION §5.2). Which account a push uses is the registry's mapping:
// the owner's App when one is mapped (opt-in), else the mapped person login. Whether a push may GO is decided
// elsewhere: pre-push (rule g for a public destination, rule h cross-org) and the Bash hook. So the helper no
// longer asks "is it a push", "can the process list be read" or "is there an approval": every request that is not
// a known read is treated as a push, and the refusals that remain each name the honest mistake they stop (an
// owner whose registry cannot be read, a configuration that would trace or store the token, an unusable path).
//
// The account choice is `chooseIdentity` (core), the same function the hook and the gh wrapper use. This module
// only adds what is specific to git: the protocol, the parent chain that tells a read from a push (A7), and A5's
// configuration and environment checks. The token is written to stdout and nowhere else.
import { basename, isAbsolute, join } from "node:path";
import {
  appendAuditRecord,
  checkTerminal,
  chooseIdentity,
  destinationCachePath,
  getRemoteUrl,
  identityPresence,
  loadRegistry,
  parseRemoteUrlResolved,
  pausePath,
  readCachedVisibility,
  readProcessAncestry,
  readRepoConfig,
  refusal,
  registeredOwners,
  RegistryEncryptedError,
  RegistryNotFoundError,
  resolveCachedDestination,
  treatAsPublicDestination,
  type AncestorInfo,
  type AncestryChain,
  type RepoConfig,
  type IdentityPresence,
  type IdentityScope,
  type Registry,
  type RefusalFix,
  type DecisionInput,
  withLogTrailer,
} from "@de-otio/repo-aegis-core";
import { recordDecision } from "../decision.js";
import {
  credentialConfigViolation,
  credentialConfigWarnings,
  helperKind,
  laterStoringHelper,
  readCredentialConfig,
  type ConfigEntry,
} from "../git-credential-config.js";
import { pauseCoveringDestinations, recordPausedAllow } from "../pause-scope.js";
import { resolveTrustedGh } from "./doctor-owner-checks.js";
import { isOwnHooksPath } from "./gh-command.js";
import { fetchLoginToken } from "./gh-identity-token.js";
import { mintAppToken, MintError, resolvePinnedTaaad, type MintParams, type MintedToken } from "./taaad-mint.js";

export const GIT_CREDENTIAL_ACTIONS = ["get", "store", "erase"] as const;
export type GitCredentialAction = (typeof GIT_CREDENTIAL_ACTIONS)[number];

export interface GitCredentialResult {
  /** Exactly what goes to stdout. */
  stdout: string;
  /** What goes to stderr: the refusal text with its code. Never a token. */
  stderr: string;
  /**
   * What the decision log records for this run (P1-I): the outcome and the facts only this module knows. `runGitCredential`
   * writes it once and, for a refusal, ends `stderr` with the log trailer. Absent when the run is not a decision of this
   * helper (not a github.com `get`, or a pause that stood aside, which records itself).
   */
  log?: CredentialLog;
}

/** The part of a decision record the credential helper decides; the layer, host, version and clock are filled by the writer. */
export type CredentialLog = Pick<DecisionInput, "outcome" | "code" | "destination" | "identityColumn" | "verb">;

/** Everything the helper reads from outside, injectable so the decision is testable without a process tree. */
export interface GitCredentialDeps {
  env: NodeJS.ProcessEnv;
  cwd: string;
  presence: () => IdentityPresence;
  ancestry: () => AncestryChain | readonly AncestorInfo[] | null;
  readConfig: (cwd: string, env: NodeJS.ProcessEnv) => ConfigEntry[] | null;
  /**
   * The registry in the pinned home, four ways (a local type: the core one belongs to P1-D). `"missing"`: there is
   * none. `"encrypted"`: only the `.age` ciphertext exists. `"unreadable"`: it exists but does not parse, or a
   * newer repo-aegis wrote it. Anything else that throws is `"unreadable"` too, never `"missing"`.
   */
  loadRegistry: (home: string) => Registry | "missing" | "encrypted" | "unreadable";
  /**
   * Is the push's destination possibly public, judged offline from the caches pre-push reads (the repository's
   * `repo-aegis.visibility` and `.class`, or the machine-wide destination cache for another repository)? The same
   * rule as pre-push, `treatAsPublicDestination`: only a recorded `private` is false. Fails closed (true).
   */
  destinationPublic: (cwd: string, owner: string, repo: string, env: NodeJS.ProcessEnv, home: string) => boolean;
  resolveTaaad: (home: string) => string | null;
  mint: (params: MintParams) => MintedToken;
  /**
   * The token of the GitHub account `login`, the person account an owner is mapped to. Asked of the
   * pinned/trusted `gh` (the one `repo-aegis gh` hands tokens to), never of whichever account is active: `untrusted`
   * when no gh may be handed the request, `unavailable` when gh has no usable token for that login.
   */
  loginToken: (login: string, env: NodeJS.ProcessEnv, home: string) => LoginTokenResult;
  /** The clock for the emergency pause's expiry. Default: now. */
  now?: () => Date;
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

function realDestinationPublic(cwd: string, owner: string, repo: string, env: NodeJS.ProcessEnv, home: string): boolean {
  try {
    const url = getRemoteUrl(cwd);
    const own = url === null ? null : parseRemoteUrlResolved(url);
    const isOwn = own !== null && own.org.toLowerCase() === owner.toLowerCase() && own.repo.toLowerCase() === repo.toLowerCase();
    // As pre-push judges it: this repository's cache describes the destination only when it IS the origin.
    let visibility = readCachedVisibility(cwd, env);
    if (!isOwn && visibility !== "public") visibility = "unknown";
    let cls: RepoConfig["class"] = isOwn ? readRepoConfig(cwd).class : "private-strict";
    if (!isOwn) {
      const cached = resolveCachedDestination(owner, repo, destinationCachePath(home));
      if (cached !== null) {
        visibility = cached.visibility;
        cls = cached.class;
      }
    }
    return treatAsPublicDestination(cls, visibility);
  } catch {
    return true;
  }
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
        if (err instanceof RegistryNotFoundError) return "missing";
        if (err instanceof RegistryEncryptedError) return "encrypted";
        return "unreadable";
      }
    },
    destinationPublic: realDestinationPublic,
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

/** The approval sentence of every refusal here: none covers any of them. */
const NO_APPROVAL_HERE = "No approval covers this.";

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
  return {
    stdout: QUIT,
    stderr: `repo-aegis git-credential: ${reason}\n`,
    log: { outcome: "refuse", code, ...(dest !== undefined && { destination: { org: dest.owner, repo: dest.repo } }) },
  };
}

/** Nothing on stdout, so git asks its next helper: a recorded step-aside, with the fixed reason as its code. */
function stepAside(code: string, stderr = "", dest?: { owner: string; repo: string }): GitCredentialResult {
  return { stdout: "", stderr, log: { outcome: "step-aside", code, ...(dest !== undefined && { destination: { org: dest.owner, repo: dest.repo } }) } };
}

/**
 * The scope word ("local" or "worktree") when the repository's own configuration sets `core.hooksPath` to a
 * directory that is not `<home>/hooks`, else null. With that setting git runs only that directory, so repo-aegis's
 * global pre-push does not run (a hooks manager such as husky does this). git reads the last value; a global or
 * system value is the person's own and is not judged here. A relative value cannot be compared and counts as foreign.
 * Command scope (`-c core.hooksPath=/dev/null`, GIT_CONFIG_COUNT) is not judged either: it is the invoking tool's
 * deliberate choice for that one call, as `--no-verify` is, not a setting left behind in the repository. In the
 * sandbox a fetch cannot be told from a push, so judging it refused hardened fetches.
 */
function localHooksOverride(entries: readonly ConfigEntry[], home: string, env: NodeJS.ProcessEnv): string | null {
  let last: ConfigEntry | null = null;
  for (const e of entries) if (e.key === "core.hookspath" && e.value !== null && e.value !== "") last = e;
  if (last === null || (last.scope !== "local" && last.scope !== "worktree")) return null;
  return isOwnHooksPath({ ...last, scope: "local" }, home, env) ? null : last.scope;
}

function refuseText(code: string, reason: string): GitCredentialResult {
  return {
    stdout: QUIT,
    stderr: `repo-aegis git-credential: ${reason.includes(code) ? reason : `${reason} [${code}]`}\n`,
    log: { outcome: "refuse", code },
  };
}

/**
 * Stderr when the registry is encrypted: no account was chosen, so git's next helper answers. A note, not a
 * refusal (the person's own helper is the honest fallback, and an encrypted registry is a state a person chose).
 * Only validated, lower-cased names are interpolated.
 */
export function encryptedNote(dest: { owner: string; repo: string }): string {
  return `repo-aegis: the registry is encrypted, so no GitHub account was chosen for ${dest.owner.toLowerCase()}/${dest.repo.toLowerCase()}; git's next credential helper answers. A person runs \`repo-aegis registry decrypt --identity <key>\`.\n`;
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

/**
 * `get`. Pure given `deps`: returns what to print, never prints or exits.
 *
 * P1-E: a person's emergency pause (read from the pinned home) changes ONE thing: a REFUSAL (`quit=true`) for a request
 * in scope becomes nothing at all, so git asks its next helper as if repo-aegis were not installed. The identity choice
 * is made as always, and an answer (an App's token for an App-mapped owner, the mapped login's token) is given as
 * always: a pause never hands out a token the helper would not have handed out, and never withholds one it would. The
 * request's scope is the one repository path it names; a request that names none or several is out of a scoped pause.
 */
export function gitCredentialGet(stdin: string, home: string, deps: GitCredentialDeps): GitCredentialResult {
  const request = readRequest(parseCredentialInput(stdin));
  if (!request.forGithub) return NOTHING;
  const result = gitCredentialDecide(request, home, deps);
  if (result.stdout !== QUIT) return result;
  const named = request.paths.length === 1 && request.firstPath !== null ? ownerRepoOf(request.firstPath) : null;
  const dest = named === null ? null : { org: named.owner, repo: named.repo };
  // A relative home is stale or hand-edited (refused by the decision) and is never trusted to hold a pause.
  const paused = !isAbsolute(home)
    ? null
    : pauseCoveringDestinations([dest], { path: pausePath(home), ...(deps.now !== undefined && { now: deps.now() }) });
  if (paused === null) return result;
  recordPausedAllow("credential-helper", { verb: "credential", destination: dest, home, pause: paused });
  return NOTHING;
}

function gitCredentialDecide(request: Request, home: string, deps: GitCredentialDeps): GitCredentialResult {

  // A person present: the next helper answers, exactly as without repo-aegis. No registry read, no mint.
  const presence = deps.presence();
  if (presence === "person") return stepAside("CREDENTIAL_PERSON_PRESENT");

  if (!isAbsolute(home)) {
    return refuse(
      "GH_IDENTITY_UNAVAILABLE",
      "the helper line in git's configuration has no absolute --home (repo-aegis writes that line itself in `install git-credential`, so it is stale or was edited by hand)",
      undefined,
      { by: "person", command: "repo-aegis install git-credential", note: "it rewrites only repo-aegis's own helper entry, so re-running it is safe" },
    );
  }
  // A7: what the parent chain says. Only a KNOWN read (a fetch, pull, clone, ls-remote, ...) is told apart from a
  // push: everything else, including a chain that cannot be read (the default Claude Code sandbox blocks `ps`)
  // and a request that did not come from git's remote helper, counts as a push, the wider scope. Nothing here
  // refuses: the process list is not a security boundary, and refusing on it stopped every sandboxed push.
  let parent: Parent;
  try {
    parent = parentFromAncestry(deps.ancestry(), request.firstPath);
  } catch {
    parent = { kind: "unreadable" };
  }
  const knownRead = parent.kind === "remote" && parent.sub !== null && KNOWN_READ_SUBCOMMANDS.has(parent.sub);
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

  // The registry, from the pinned home only (a person present never reaches here: no registry read for them).
  const registry = deps.loadRegistry(home);
  // No registry: nothing maps this owner, so the next helper answers, exactly as without repo-aegis.
  if (registry === "missing") return stepAside("CREDENTIAL_NO_REGISTRY", "", dest);
  // Encrypted: the same, but the person is told why no account was chosen.
  if (registry === "encrypted") return stepAside("CREDENTIAL_REGISTRY_ENCRYPTED", encryptedNote(dest), dest);
  if (registry === "unreadable") {
    // A known read publishes nothing, so the person's own helper may answer it; a push must not: git's next helper
    // would answer with whatever account it holds, which may be the wrong one for this owner.
    if (knownRead) return stepAside("CREDENTIAL_READ_REGISTRY_UNREADABLE", "", dest);
    return refuse(
      "GH_IDENTITY_UNAVAILABLE",
      "the registry in the pinned home exists but cannot be read (it does not parse, or a newer repo-aegis wrote it), so repo-aegis cannot tell which account this push must use, and git's next helper would answer with the person's own; repo-aegis did not change the file",
      dest,
      { by: "person", command: "repo-aegis doctor", note: "it says whether to repair the file or upgrade repo-aegis" },
    );
  }

  const owners = registeredOwners(registry);
  // This call is the ACCOUNT CHOICE only (EVALUATION §5.2): `isWrite: false` and no approvals, so a person-only
  // owner maps to its person login (D1: the default) and an owner with an App maps to the App. Whether the push
  // may go is decided by pre-push (rules g and h) and the Bash hook, not here.
  const choice = chooseIdentity({
    args: [],
    isWrite: false,
    targets: [{ owner: dest.owner, repo: dest.repo, source: "literal" }],
    registry,
    presence,
    approvalFor: () => null,
    suppliedToken: false,
    redirect: null,
    registeredOwner: o => owners.has(o.toLowerCase()),
  });
  // An unmapped owner falls through to the person's own helper.
  if (choice.kind === "none") return stepAside("CREDENTIAL_OWNER_UNMAPPED", "", dest);
  if (choice.kind === "refuse") return refuseText(choice.code, choice.reason);

  const column = choice.column;
  const identity = choice.identity;
  if (column === "agent" && identity.kind !== "github-app") {
    return refuse(
      "GH_IDENTITY_UNAVAILABLE",
      "the agent identity of this owner is not a GitHub App (the registry maps a GitHub login there; a person set that, repo-aegis did not)",
      dest,
      { by: "person", command: "repo-aegis engagements set-identity <id> --agent <app-name>", note: "`repo-aegis status` shows the current mapping; changing it affects only this owner's agent pushes" },
    );
  }
  // git compares URL patterns against the path as sent (case and .git kept); the normalised form counts too.
  const matchCtx = { path: (request.firstPath ?? "").replace(/^\/+/, ""), altPath: `${dest.owner}/${dest.repo}`.toLowerCase() };
  // A5: configuration and environment that could capture the token. Checked before any token is fetched.
  const entries = deps.readConfig(deps.cwd, deps.env);
  if (entries === null) {
    return refuse("AGENT_PUSH_CREDENTIAL_CONFIG", "git's configuration could not be read (git failed to start, or a config file is unreadable; repo-aegis did not cause it)", dest, {
      by: "person",
      command: "git config --list --show-origin",
      note: "it shows which file fails to read; repair or remove that file",
    });
  }
  // A known read of the person's account publishes nothing and prints nothing: the trace and helper-scope checks
  // (which guard where a push's token could be captured) and the TLS note do not apply to it. The plaintext-store
  // guard below still does. (0.13.1: reads answer as the mapped account, so a fetch is not stopped by a setting that
  // only matters for a push.)
  const personRead = column === "person" && knownRead;
  const violation = personRead ? null : credentialConfigViolation(entries, matchCtx, deps.env);
  if (violation !== null) {
    return refuse("AGENT_PUSH_CREDENTIAL_CONFIG", `${violation}, which could redirect or capture the token; repo-aegis did not set it`, dest, configFix(violation));
  }
  const warnings = personRead ? "" : credentialConfigWarnings(entries, matchCtx, deps.env).join("");

  // `store` goes to every helper in the list. An App token that a later helper saved would make the person's own
  // later pushes run as the App, so ANY later storing helper refuses it. A person's own login token saved in the
  // person's own OS store (osxkeychain, libsecret, wincred, a credential manager, the in-memory cache) changes
  // nothing about which account later pushes use, so those pass; `store` writes it in plaintext to
  // ~/.git-credentials, and an unrecognised helper may, so those refuse for the person column too, reads included (A5).
  const storing = laterStoringHelper(entries, matchCtx);
  if (storing !== null) {
    const plaintextRisk = storing === "store" || storing === "an unrecognised helper";
    if (column === "agent" || plaintextRisk) {
      const what =
        column === "agent"
          ? "the App token would be saved"
          : storing === "store"
            ? "the person's token would be written in plaintext to ~/.git-credentials"
            : "the person's token might be written in plaintext";
      return refuse(
        "AGENT_PUSH_CREDENTIAL_STORE",
        `${what} by a later credential helper (${storing}), because git sends \`store\` to every helper; scope that helper away from https://github.com (credential.https://github.com.helper with a reset entry) or reorder, then re-run \`repo-aegis install git-credential\`; repo-aegis did not add that helper`,
        dest,
        { by: "person", command: "git config --list --show-origin", note: "it lists the helpers in order and names the files that set them; scope the later one away from https://github.com or move it before repo-aegis's, then re-run `repo-aegis install git-credential`" },
      );
    }
  }

  // A push as the person's own account needs the pre-push guard to be running, because the helper no longer judges
  // whether the push may go. A repository whose own configuration points core.hooksPath at another directory (husky)
  // runs only that directory, so a script-run push (`npm run release`) to a possibly-public repository would carry the
  // person's token with nothing checking it. Refused only then: the destination is not known private, offline.
  // Residual: `git push --no-verify` skips the hook whatever this says.
  if (column === "person" && !knownRead) {
    const override = localHooksOverride(entries, home, deps.env);
    if (override !== null && deps.destinationPublic(deps.cwd, dest.owner, dest.repo, deps.env, home)) {
      return refuse(
        "AGENT_PUSH_GUARD_NOT_RUNNING",
        `the pre-push guard does not run in this repository (core.hooksPath is set in ${override} scope to a directory that is not repo-aegis's, as a hooks manager such as husky does), and the destination is not known to be private, so a push as the person's account to a possibly-public repository is refused; repo-aegis did not set it`,
        dest,
        {
          by: "person",
          step: "pushes from a terminal, or chains repo-aegis's pre-push hook from the repository's own hooks directory (doc/configuration.md, \"Git pushes by an agent\"); a recorded private visibility (`repo-aegis classify`) also lets this push through",
        },
      );
    }
  }

  if (column === "person") {
    // The mapped person account (D1, the default): the token is THAT login's, from the trusted gh, never the
    // active gh account's.
    if (identity.kind !== "gh-login") {
      // The person column holds a login; anything else fails closed rather than guess.
      return refuse("GH_IDENTITY_UNAVAILABLE", "the person identity of this owner is not a GitHub login", dest);
    }
    // The audit record names the identity (never the login) and never a token.
    const record = {
      identity: identity.name,
      kind: "gh-login",
      column: "person",
      owner: dest.owner,
      repo: dest.repo,
      scope: knownRead ? "read" : "write",
      verb: knownRead ? "fetch" : "push",
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
    return {
      log: { outcome: "allow", verb: knownRead ? "git fetch" : "git push", destination: { org: dest.owner, repo: dest.repo }, identityColumn: "person" },
      stdout: `username=x-access-token\npassword=${got.token}\n`,
      // One line on a push, so a person reading the push output sees which account it ran as. A read prints
      // nothing: a line on every fetch would be noise.
      stderr: knownRead ? "" : `repo-aegis: this push runs as the GitHub account mapped to ${dest.owner} (its person identity)\n${warnings}`,
    };
  }

  // The agent column: a GitHub App (opt-in), minted narrowed to this repository.
  if (identity.kind !== "github-app") {
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
  const scope: IdentityScope = knownRead ? "read" : "contents-write";
  let minted: MintedToken;
  try {
    minted = deps.mint({ taaadPath, slug: identity.app, owner: dest.owner, repo: dest.repo, scope });
  } catch (err) {
    const mismatch = err instanceof MintError && err.kind === "installation-mismatch";
    const code = mismatch ? "GH_IDENTITY_INSTALLATION_MISMATCH" : "GH_IDENTITY_UNAVAILABLE";
    // A failed mint is recorded too (the reason is a fixed word, never taaad's output), so a refused push
    // can be diagnosed after the fact.
    auditBestEffort({
      identity: identity.name,
      kind: "github-app",
      owner: dest.owner,
      repo: dest.repo,
      scope,
      verb: knownRead ? "fetch" : "push",
      outcome: "refused",
      code,
      reason: err instanceof MintError ? err.reason : "failed",
    }, home);
    return refuse(code, err instanceof MintError ? err.message : "the token could not be minted (taaad failed; repo-aegis did not cause it)", dest);
  }
  auditBestEffort({
    identity: identity.name,
    kind: "github-app",
    owner: dest.owner,
    repo: dest.repo,
    scope,
    verb: knownRead ? "fetch" : "push",
  }, home);
  return {
    log: { outcome: "allow", verb: knownRead ? "git fetch" : "git push", destination: { org: dest.owner, repo: dest.repo }, identityColumn: "agent" },
    stdout: `username=x-access-token\npassword=${minted.token}\n${expiryLine(minted.expiresAt)}`,
    stderr: warnings,
  };
}

/**
 * The helper as `repo-aegis git-credential` runs it. Total: a fault on a github.com `get` is a refusal.
 *
 * P1-I: one decision record per github.com `get`, written here (the pinned home, not the caller's), and a refusal's text
 * ends with the trailer for what the write did. The write never changes the answer: it is made first.
 */
export function runGitCredential(
  action: string,
  stdin: string,
  home: string,
  deps: GitCredentialDeps = realGitCredentialDeps(),
): GitCredentialResult {
  if (action !== "get") return NOTHING; // store, erase, and any verb a later git adds
  return withDecisionLog(runGitCredentialGet(stdin, home, deps), home);
}

function withDecisionLog(result: GitCredentialResult, home: string): GitCredentialResult {
  const log = result.log;
  if (log === undefined) return result;
  const { log: _done, ...rest } = result;
  const written = recordDecision({ layer: "credential-helper", host: "git", home, ...log }).written;
  if (log.outcome !== "refuse") return rest;
  return { ...rest, stderr: rest.stderr.replace(/\n$/, "") === "" ? rest.stderr : `${withLogTrailer(rest.stderr.replace(/\n$/, ""), written)}\n` };
}

function runGitCredentialGet(stdin: string, home: string, deps: GitCredentialDeps): GitCredentialResult {
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
