// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Egress approvals: a human's time-limited, destination-scoped declaration
// that a publish may proceed from a shell with nobody at the keyboard
// (doc/design/egress-guard.md §4a).
//
// Rule g needs a person. The test for one is a TTY on stderr — an agent's
// shell has none — and the one escape, `REPO_AEGIS_EGRESS_HUMAN=1`, is
// something an agent must never set, because an agent setting it is the
// agent approving its own publish. That left the operator with exactly one
// way to let an agent publish to a public repository: run the command
// themselves. For a release that is four commands and four context
// switches, and the instruction the operator actually gives — "push it" —
// lives in a chat the guard cannot see.
//
// An approval moves the human signal to where the guard can read it. The
// operator mints one FROM A TERMINAL (the mint refuses without a TTY, and
// does not honour the env escape, so an agent cannot mint its own):
//
//     repo-aegis approve <org>/<repo> [--ref <ref>] [--ttl 15m]
//
// Every layer — the agent hook, the `gh` shim, the git pre-push hook — then
// treats a matching, unexpired approval as "human present" for rule g and
// nothing else: the shape rules, the cross-org boundary and the payload
// scan still apply, the receipt still prints. Approvals are scoped
// (`<org>/<repo>`, `<org>/*`, or `*` — which covers personalOrgs owners and
// destination-less verbs only, optionally one ref), expire on their
// own (default 15 minutes, never more than a day), are listed and revoked
// by the same command, and every mint and every use is an audit record.
//
// Not consumed on use. A push passes the agent hook and then the pre-push
// hook, and a single-use token consumed by the first would refuse at the
// second; the TTL is the bound.
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { repoAegisHome } from "./paths.js";
import { isSafeOwner, safeDestination } from "./refusal.js";
import type { EgressIntent, EgressVerb } from "./egress-intent.js";
import type { Destination } from "./egress-policy.js";

export interface EgressApproval {
  /** Short random id, for `--revoke` and the audit trail. */
  id: string;
  /** Lower-cased org, or `*`. */
  org: string;
  /** Lower-cased repo, or `*`. */
  repo: string;
  /** When set, only this ref (branch, tag, `refs/heads/...`) is approved. */
  ref?: string;
  /** ISO timestamps. */
  createdAt: string;
  expiresAt: string;
  /** The OS user that minted it — the audit trail's "who". */
  by: string;
  /** Free text from the operator; never printed by the guard. */
  note?: string;
  /**
   * The GitHub login of the destination owner's mapped `person` identity at mint time
   * (doc/plan-owner-identity.md N3, A11). Present only on an `<org>/<repo>` or `<org>/*` approval for an owner
   * that has one; a `*` approval never carries one. It is what lets an agent write as that person's account.
   */
  login?: string;
}

export interface ApprovalStore {
  version: 1;
  approvals: EgressApproval[];
}

export const APPROVALS_FILE = "egress-approvals.json";
export const DEFAULT_APPROVAL_TTL_MS = 15 * 60 * 1000;
export const MAX_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

export function approvalsPath(home: string = repoAegisHome()): string {
  return join(home, APPROVALS_FILE);
}

/**
 * `15m`, `2h`, `90s`, `1d`, or a bare number of minutes → milliseconds; null
 * when unparseable or non-positive.
 *
 * The whitespace is trimmed BEFORE matching and the pattern itself has no
 * `\s*` runs: `^\s*(\d+(?:\.\d+)?)\s*([smhd]?)\s*$` backtracks
 * polynomially on a long run of tabs after a digit (js/polynomial-redos).
 * The value reaches here from a CLI flag, so the input is short in practice —
 * but a guardrail that can be wedged by its own argument is not one.
 */
export function parseTtl(text: string): number | null {
  const m = /^(\d+(?:\.\d+)?)([smhd]?)$/i.exec(text.trim());
  if (m === null) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = (m[2] ?? "").toLowerCase();
  const factor = unit === "s" ? 1000 : unit === "h" ? 3_600_000 : unit === "d" ? 86_400_000 : 60_000;
  return Math.round(n * factor);
}

/**
 * `<org>/<repo>`, `<org>/*`, or `*` → the scope an approval covers. A full
 * GitHub URL is not accepted here on purpose: the operator types the
 * destination they mean, in the form the guard prints it.
 */
export function parseApprovalTarget(text: string): { org: string; repo: string } | null {
  const t = text.trim();
  if (t === "*") return { org: "*", repo: "*" };
  const parts = t.replace(/\.git$/, "").split("/").filter(Boolean);
  if (parts.length !== 2) return null;
  const [org, repo] = parts as [string, string];
  if (org === "*") return null; // `*/<repo>` means nothing
  // Only plausible GitHub names (the same test the guard applies to a destination):
  // an approval for `bad_org/*` could never match anything, so refuse to mint one.
  return safeDestination(org, repo);
}

/** The id `mintApproval` produces: `randomBytes(4)` as hex. Anything else did not come from a mint. */
const APPROVAL_ID = /^[0-9a-f]{8}$/;
/** ISO-8601 date-time with a zone, as `Date.prototype.toISOString` (and any sane writer) emits it. */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function isApproval(v: unknown): v is EgressApproval {
  if (!v || typeof v !== "object") return false;
  const a = v as Record<string, unknown>;
  return (
    typeof a["id"] === "string" &&
    APPROVAL_ID.test(a["id"]) &&
    typeof a["expiresAt"] === "string" &&
    ISO_TIMESTAMP.test(a["expiresAt"]) &&
    Number.isFinite(Date.parse(a["expiresAt"])) &&
    typeof a["org"] === "string" &&
    typeof a["repo"] === "string" &&
    (a["ref"] === undefined || typeof a["ref"] === "string") &&
    typeof a["createdAt"] === "string" &&
    typeof a["by"] === "string" &&
    (a["login"] === undefined || typeof a["login"] === "string")
  );
}

/** Read the store. Never throws; malformed entries are dropped individually. Expired entries are kept — `listApprovals` filters. */
export function readApprovalStore(path: string = approvalsPath()): ApprovalStore {
  const empty: ApprovalStore = { version: 1, approvals: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return empty;
  }
  const list = (parsed as { approvals?: unknown } | null)?.approvals;
  if (!Array.isArray(list)) return empty;
  return { version: 1, approvals: list.filter(isApproval) };
}

function writeApprovalStore(store: ApprovalStore, path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

function isLive(a: EgressApproval, now: Date): boolean {
  const exp = Date.parse(a.expiresAt);
  return Number.isFinite(exp) && exp > now.getTime();
}

/** Unexpired approvals, newest first. */
export function listApprovals(path: string = approvalsPath(), now: Date = new Date()): EgressApproval[] {
  return readApprovalStore(path)
    .approvals.filter(a => isLive(a, now))
    .sort((x, y) => y.createdAt.localeCompare(x.createdAt));
}

export interface MintOptions {
  target: { org: string; repo: string };
  ref?: string;
  ttlMs?: number;
  note?: string;
  path?: string;
  now?: Date;
  by?: string;
  /** Recorded only when the target is not `*` (A11). */
  login?: string;
}

/**
 * Add an approval (and drop expired ones while the file is open). Throws
 * on an unwritable store: minting is an operator action at a terminal, so
 * a failure must be loud, unlike the guard's reads.
 */
export function mintApproval(opts: MintOptions): EgressApproval {
  const now = opts.now ?? new Date();
  const ttl = Math.min(opts.ttlMs ?? DEFAULT_APPROVAL_TTL_MS, MAX_APPROVAL_TTL_MS);
  const path = opts.path ?? approvalsPath();
  const approval: EgressApproval = {
    id: randomBytes(4).toString("hex"),
    org: opts.target.org,
    repo: opts.target.repo,
    ...(opts.ref !== undefined && opts.ref !== "" && { ref: normaliseRef(opts.ref) }),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttl).toISOString(),
    by: opts.by ?? safeUser(),
    ...(opts.note !== undefined && opts.note !== "" && { note: opts.note }),
    ...(opts.login !== undefined && opts.login !== "" && opts.target.org !== "*" && { login: opts.login }),
  };
  const store = readApprovalStore(path);
  store.approvals = [...store.approvals.filter(a => isLive(a, now)), approval];
  writeApprovalStore(store, path);
  return approval;
}

/**
 * Remove one approval by id, or every one with `"all"`, from both stores: a `p…` id is a prompt approval (its file
 * under `prompt-approvals/` next to `path`); anything else is a terminal approval. Returns the ids removed.
 */
export function revokeApprovals(which: string, path: string = approvalsPath()): string[] {
  const store = readApprovalStore(path);
  const keep = which === "all" ? [] : store.approvals.filter(a => a.id !== which);
  const removed = store.approvals.filter(a => !keep.includes(a)).map(a => a.id);
  if (removed.length > 0 || which === "all") writeApprovalStore({ version: 1, approvals: keep }, path);
  return [...removed, ...revokePromptApprovals(which, join(dirname(path), PROMPT_APPROVALS_DIR))];
}

function safeUser(): string {
  try {
    return userInfo().username;
  } catch {
    return "unknown";
  }
}

/** `refs/heads/x` and `x` are the same branch for approval purposes; `refs/tags/v1` and `v1` the same tag. */
export function normaliseRef(ref: string): string {
  return ref.replace(/^refs\/(heads|tags)\//, "").replace(/^\+/, "").split(":")[0]!;
}

/**
 * What a `*` approval may cover (decision D7, issue #151).
 *
 * A `*` approval is no longer a global wildcard. It covers a destination only
 * when the destination's owner is one of the operator's own `personalOrgs`,
 * or when the call has no repository destination at all (`npm publish`). A
 * customer's repository needs `approve <org>/*` or `approve <org>/<repo>`;
 * so does an `allowedUpstreams` repository. `<org>/*` and `<org>/<repo>`
 * approvals behave exactly as before.
 */
export interface ApprovalScope {
  /** Lower-cased `personalOrgs`. Build it with {@link approvalScopeOf}. */
  personalOrgs: ReadonlySet<string>;
  /**
   * Exact lower-cased `owner/repo` entries of `allowedUpstreams`. A `*`
   * approval never covers one of these, even if its owner is also personal:
   * an upstream is somewhere the operator proposes changes, not somewhere a
   * blanket approval publishes (D6, D7). Fail closed.
   */
  upstreams?: ReadonlySet<string>;
  /**
   * The verb has no repository destination (`npm publish`), so a `*`
   * approval covers it. This is an explicit flag, NOT a `*`/`*` destination:
   * an unresolved GraphQL mutation also carries a `*`/`*` destination, and a
   * `*` approval must not cover that (rule h refuses it first, but the
   * matcher does not rely on the ordering).
   */
  destinationless?: boolean;
}

/** The registry fields {@link approvalScopeOf} reads. */
export interface ApprovalScopeRegistry {
  personalOrgs?: readonly string[] | undefined;
  allowedUpstreams?: readonly string[] | undefined;
}

/** Build an {@link ApprovalScope} from the registry. The one place the lower-casing happens. */
export function approvalScopeOf(registry: ApprovalScopeRegistry, destinationless = false): ApprovalScope {
  return {
    personalOrgs: new Set((registry.personalOrgs ?? []).map(o => o.toLowerCase())),
    upstreams: new Set((registry.allowedUpstreams ?? []).map(u => u.toLowerCase())),
    destinationless,
  };
}

/** Why a live `*` approval did not cover a destination (for refusal text). */
export type StarApprovalGap = "not-personal" | "upstream";

/**
 * Whether a `*` approval covers `destination` under `scope`. Exported so the
 * refusal text can ask the same question the matcher answers.
 */
export function starApprovalCovers(destination: { org: string; repo: string }, scope: ApprovalScope): boolean {
  if (scope.destinationless === true) return true;
  // The owner is tested as the agent typed it, BEFORE lower-casing: lower-casing
  // first would turn U+212A (KELVIN SIGN) into a plain `k` and let `Korp` match
  // a personal org `korp`. A name that is not plain ASCII is covered by nothing.
  if (!isSafeOwner(destination.org)) return false;
  const org = destination.org.toLowerCase();
  const repo = destination.repo.toLowerCase();
  if (scope.upstreams?.has(`${org}/${repo}`) === true) return false;
  return scope.personalOrgs.has(org);
}

/**
 * The live approval covering a destination (and ref, when the command names
 * one), or null. An approval with a ref matches only that ref, one without
 * matches every ref. `<org>/*` and `<org>/<repo>` match as written; a `*`
 * approval matches only what {@link starApprovalCovers} says (D7). A
 * destination-less call (`scope.destinationless`) is matched by `*` alone,
 * never by an `<org>/…` approval. Never throws — a store that cannot be read
 * is simply no approval, which is the safe direction.
 */
export function findApproval(
  destination: { org: string; repo: string },
  ref: string | undefined,
  scope: ApprovalScope,
  path: string = approvalsPath(),
  now: Date = new Date(),
): EgressApproval | null {
  try {
    if (!existsSync(path)) return null;
    // A named destination must be a plausible ASCII GitHub name as typed, before any
    // lower-casing (Kelvin sign → `k`). This guards `<org>/*` and `<org>/<repo>`
    // approvals as well as `*`. A destination-less call has no name to check.
    if (scope.destinationless !== true && safeDestination(destination.org, destination.repo) === null) return null;
    const org = destination.org.toLowerCase();
    const repo = destination.repo.toLowerCase();
    const wanted = ref === undefined ? undefined : normaliseRef(ref);
    const starCovers = starApprovalCovers(destination, scope);
    for (const a of listApprovals(path, now)) {
      if (a.org === "*") {
        if (!starCovers) continue;
      } else {
        if (scope.destinationless === true) continue;
        if (a.org !== org) continue;
        if (a.repo !== "*" && a.repo !== repo) continue;
      }
      if (a.ref !== undefined && (wanted === undefined || a.ref !== wanted)) continue;
      return a;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The live `*` approval, if any, that exists but does NOT cover `destination`
 * under `scope`. Rule g uses it to say "your `*` approval is live but no
 * longer covers this" rather than leave the operator believing the guard is
 * broken (§3.9). Returns the approval and why.
 */
export function findUncoveringStarApproval(
  destination: { org: string; repo: string },
  ref: string | undefined,
  scope: ApprovalScope,
  path: string = approvalsPath(),
  now: Date = new Date(),
): { approval: EgressApproval; gap: StarApprovalGap } | null {
  try {
    if (!existsSync(path) || starApprovalCovers(destination, scope)) return null;
    const wanted = ref === undefined ? undefined : normaliseRef(ref);
    const upstream =
      scope.upstreams?.has(`${destination.org.toLowerCase()}/${destination.repo.toLowerCase()}`) === true;
    for (const a of listApprovals(path, now)) {
      if (a.org !== "*") continue;
      if (a.ref !== undefined && (wanted === undefined || a.ref !== wanted)) continue;
      return { approval: a, gap: upstream ? "upstream" : "not-personal" };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The live approval that lets an agent WRITE as the GitHub account `login` to `destination`
 * (doc/plan-owner-identity.md N3, A11), or null. Stricter than {@link findApproval}: only an `<org>/<repo>` or
 * `<org>/*` approval can match (never `*`), it must carry exactly this login (case-insensitively), and an
 * approval restricted to one ref does not match (a `gh` write names no ref). An approval minted before logins
 * were recorded carries none and matches nothing. Never throws.
 */
export function findLoginApproval(
  destination: { org: string; repo: string },
  login: string,
  path: string = approvalsPath(),
  now: Date = new Date(),
): EgressApproval | null {
  try {
    if (!existsSync(path) || login === "") return null;
    if (safeDestination(destination.org, destination.repo) === null) return null;
    const org = destination.org.toLowerCase();
    const repo = destination.repo.toLowerCase();
    for (const a of listApprovals(path, now)) {
      if (a.org === "*" || a.org !== org) continue;
      if (a.repo !== "*" && a.repo !== repo) continue;
      if (a.ref !== undefined) continue;
      if (a.login === undefined || a.login.toLowerCase() !== login.toLowerCase()) continue;
      return a;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The live approval that covers the deliberate-bypass refusals for `destination` because it is bound to `login`
 * (doc/plan-landscape-recommendations.md Phase U, U5), or null.
 *
 * A person who minted an approval for `<org>/<repo>` or `<org>/*`, for an owner with a mapped person identity,
 * has said, at a terminal and for a bounded time, "agents may publish here". The refusals that only defend against
 * an agent DELIBERATELY stealing a token (`AGENT_PUSH_CHAIN_UNREADABLE`, the process list cannot be read,
 * typically inside a sandbox; and `GH_IDENTITY_ARG_UNSAFE` for a local git setting that could run a program or
 * redirect the token) are outside the threat model (accidental leaks), so such an approval covers them.
 *
 * `login` is the login of the owner's CURRENT mapped person identity, read from the registry by the caller (see
 * `personLoginOf`). The approval must carry exactly that login (case-insensitively): an approval minted before the
 * person identity was re-mapped to another account stops covering at once, not when its lifetime (up to 24 hours)
 * ends. An owner with no person identity, or one without a login, has nothing to bind to: the caller passes none
 * and nothing is covered (an empty `login` matches nothing). Otherwise exactly {@link findLoginApproval}: only an
 * `<org>/<repo>` or `<org>/*` approval with a login and no ref matches; a `*` approval, an approval without a
 * login, a ref-limited one and an expired one match nothing. Never throws.
 */
export function findAccountBoundApproval(
  destination: { org: string; repo: string },
  login: string,
  path: string = approvalsPath(),
  now: Date = new Date(),
): EgressApproval | null {
  return findLoginApproval(destination, login, path, now);
}

/**
 * The live `<org>/<repo>` or `<org>/*` approval for `destination` that carries ANY login, or null. Only for
 * EXPLAINING a refusal ("an approval exists but is bound to another account"): it never covers anything. Coverage
 * is {@link findAccountBoundApproval} (the owner's current login) or {@link findLoginApproval} (a login-bound
 * person write). Same matching otherwise: no `*` approval, no ref-limited one, no empty login. Never throws.
 */
export function findApprovalWithAnyLogin(
  destination: { org: string; repo: string },
  path: string = approvalsPath(),
  now: Date = new Date(),
): EgressApproval | null {
  try {
    if (!existsSync(path)) return null;
    if (safeDestination(destination.org, destination.repo) === null) return null;
    const org = destination.org.toLowerCase();
    const repo = destination.repo.toLowerCase();
    for (const a of listApprovals(path, now)) {
      if (a.org === "*" || a.org !== org) continue;
      if (a.repo !== "*" && a.repo !== repo) continue;
      if (a.ref !== undefined) continue;
      if (a.login === undefined || a.login === "") continue;
      return a;
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Prompt approvals (doc/design/egress-guard.md §4a.1)
// ---------------------------------------------------------------------------
//
// A "yes" at the agent host's own permission prompt is a person's yes for THIS
// command only. The agent hook (the only layer that sees the prompt) writes one
// of these records when it asks; the layers below it — git's pre-push hook and
// the `gh` shim — may then honour it for the exact verb, destination and ref
// (or API endpoint) for two minutes, where they would otherwise refuse for want
// of a person.
//
// Three properties are load-bearing and must survive every future edit:
//
//   1. The agent hook NEVER reads these (it never calls `findPromptApproval`). The record is written
//      BEFORE the person answers, so a "no" leaves a live record behind; if the hook honoured it, a
//      second, different command to the same repository would pass on the first one's record (F1).
//   2. They live in their own directory, one file per record. An older binary that knows nothing
//      about them never reads that directory, so it can never mistake one for a terminal approval
//      (a ref-less terminal approval matches every verb). Nothing in the terminal store changes.
//   3. Exact match, no wildcard anywhere: verb, org, repo, and the ref or endpoint. The TTL is a
//      constant, not a flag or an environment variable.
//
// An agent cannot mint one for itself in the shell: `Edit(<home>/prompt-approvals/**)` is denied
// to the agent, and the writer here refuses unless the host reported an allowlisted permission mode.

/** `$REPO_AEGIS_HOME/prompt-approvals/`, one `p<8 hex>.json` file per approval. */
export const PROMPT_APPROVALS_DIR = "prompt-approvals";
/** How long a prompt approval lives. A constant: no flag, no environment variable. */
export const PROMPT_APPROVAL_TTL_MS = 120_000;
/**
 * The Claude Code `permission_mode` values in which a prompt answer is a person's. In `auto` (a classifier
 * answers), `bypassPermissions`, `plan` and `dontAsk` nobody answers, so nothing is written. Exact and case-sensitive.
 */
export const PROMPT_APPROVAL_MODES: ReadonlySet<string> = new Set(["default", "acceptEdits"]);

/** The verbs a prompt approval can be bound to: the ones with a repository destination and a layer below the hook. */
export type PromptVerb = Exclude<EgressVerb, "gh-gist-create" | "gh-alias-shell" | "gh-unknown" | "npm-publish">;

// `Record` makes the compiler insist this table lists every PromptVerb.
const PROMPT_VERB_TABLE: Record<PromptVerb, true> = {
  "git-push": true,
  "gh-pr-create": true,
  "gh-pr-edit": true,
  "gh-pr-merge": true,
  "gh-pr-comment": true,
  "gh-pr-review": true,
  "gh-issue-create": true,
  "gh-issue-edit": true,
  "gh-issue-comment": true,
  "gh-release-create": true,
  "gh-release-edit": true,
  "gh-release-upload": true,
  "gh-repo-create": true,
  "gh-repo-edit": true,
  "gh-workflow-run": true,
  "gh-api-mutating": true,
};

export function isPromptVerb(v: string): v is PromptVerb {
  return Object.prototype.hasOwnProperty.call(PROMPT_VERB_TABLE, v);
}

/** What a prompt approval is bound to, exactly. */
export interface PromptBinding {
  verb: PromptVerb;
  /** Lower-cased, `safeDestination`-valid, never `*`. */
  org: string;
  repo: string;
  /** `git-push` only, required there: the DESTINATION ref, normalised. */
  ref?: string;
  /** `gh-api-mutating` only, required there: the endpoint minus one leading `/`. */
  endpoint?: string;
}

export interface PromptApproval {
  /** `"p"` + 8 hex: never a terminal id, so `--revoke` and the audit trail can tell them apart. */
  id: string;
  source: "prompt";
  verb: PromptVerb;
  org: string;
  repo: string;
  ref?: string;
  endpoint?: string;
  createdAt: string;
  /** `createdAt` + {@link PROMPT_APPROVAL_TTL_MS}. */
  expiresAt: string;
  permissionMode: "default" | "acceptEdits";
  /** The host's session id when it is plain; recorded for the audit trail, NOT matched. */
  session?: string;
  by: string;
}

const PROMPT_ID = /^p[0-9a-f]{8}$/;
const PROMPT_FILE = /^(p[0-9a-f]{8})\.json$/;
const SESSION_ID = /^[A-Za-z0-9-]{1,64}$/;
/** A ref or endpoint a prompt approval may carry: visible ASCII, no whitespace or control characters (it is listed in a terminal). */
const BINDABLE_TEXT = /^[\x21-\x7e]{1,500}$/;
const PROMPT_FILE_MAX_BYTES = 4096;
const PROMPT_MAX_ENTRIES = 256;

/** Whether an approval's id says it is a prompt approval (a terminal id is 8 hex digits, which never starts with `p`). */
export function approvalSource(a: { id: string }): "terminal" | "prompt" {
  return PROMPT_ID.test(a.id) ? "prompt" : "terminal";
}

export function promptApprovalsDir(home: string = repoAegisHome()): string {
  return join(home, PROMPT_APPROVALS_DIR);
}

function isPromptApproval(v: unknown): v is PromptApproval {
  if (!v || typeof v !== "object") return false;
  const a = v as Record<string, unknown>;
  const verb = a["verb"];
  if (typeof a["id"] !== "string" || !PROMPT_ID.test(a["id"])) return false;
  if (a["source"] !== "prompt") return false;
  if (typeof verb !== "string" || !isPromptVerb(verb)) return false;
  if (typeof a["org"] !== "string" || typeof a["repo"] !== "string") return false;
  if (a["org"] === "*" || a["repo"] === "*") return false;
  // As stored: lower-case and a plausible GitHub name already (the writer lower-cases).
  const safe = safeDestination(a["org"], a["repo"]);
  if (safe === null || safe.org !== a["org"] || safe.repo !== a["repo"]) return false;
  const ref = a["ref"];
  const endpoint = a["endpoint"];
  if (verb === "git-push") {
    if (typeof ref !== "string" || !BINDABLE_TEXT.test(ref)) return false;
  } else if (ref !== undefined) return false;
  if (verb === "gh-api-mutating") {
    if (typeof endpoint !== "string" || !BINDABLE_TEXT.test(endpoint)) return false;
  } else if (endpoint !== undefined) return false;
  if (typeof a["createdAt"] !== "string" || !ISO_TIMESTAMP.test(a["createdAt"])) return false;
  if (typeof a["expiresAt"] !== "string" || !ISO_TIMESTAMP.test(a["expiresAt"])) return false;
  const created = Date.parse(a["createdAt"]);
  const expires = Date.parse(a["expiresAt"]);
  if (!Number.isFinite(created) || !Number.isFinite(expires)) return false;
  // A hand-edited long-lived file is dropped, not honoured.
  if (expires - created > PROMPT_APPROVAL_TTL_MS) return false;
  if (typeof a["permissionMode"] !== "string" || !PROMPT_APPROVAL_MODES.has(a["permissionMode"])) return false;
  if (a["session"] !== undefined && (typeof a["session"] !== "string" || !SESSION_ID.test(a["session"]))) return false;
  if (typeof a["by"] !== "string") return false;
  return true;
}

function isLivePrompt(a: PromptApproval, now: Date): boolean {
  return Date.parse(a.expiresAt) > now.getTime();
}

/** A binding the writer and the matcher both accept: valid verb, safe names, the ref/endpoint exactly where the verb needs one. */
function validBinding(b: PromptBinding): boolean {
  return isPromptApproval({
    id: "p00000000",
    source: "prompt",
    ...b,
    createdAt: "1970-01-01T00:00:00.000Z",
    expiresAt: "1970-01-01T00:00:00.000Z",
    permissionMode: "default",
    by: "",
  });
}

/**
 * Read the live prompt approvals under `home`. At most 256 entries named `p<8 hex>.json`, each at most 4 KiB, a
 * regular file, every field validated; an entry that fails any check is skipped. Never deletes (the lower layers
 * may be sandboxed and read-only) and never throws.
 */
export function listPromptApprovals(home: string = repoAegisHome(), now: Date = new Date()): PromptApproval[] {
  try {
    const dir = promptApprovalsDir(home);
    const names = readdirSync(dir)
      .filter(n => PROMPT_FILE.test(n))
      .sort()
      .slice(0, PROMPT_MAX_ENTRIES);
    const out: PromptApproval[] = [];
    for (const name of names) {
      try {
        const file = join(dir, name);
        const st = lstatSync(file);
        if (!st.isFile() || st.size > PROMPT_FILE_MAX_BYTES) continue;
        const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
        // The file name is the id: a record copied under another name is not trusted.
        if (!isPromptApproval(parsed) || `${parsed.id}.json` !== name) continue;
        if (isLivePrompt(parsed, now)) out.push(parsed);
      } catch {
        /* unreadable or malformed: no approval */
      }
    }
    return out.sort((x, y) => y.createdAt.localeCompare(x.createdAt));
  } catch {
    return [];
  }
}

/**
 * The live prompt approval that matches `b` exactly, or null: verb, org, repo (lower-cased query, the name checked as
 * typed), then the ref for `git-push` (a query with no ref matches nothing) or the endpoint for `gh-api-mutating`.
 * No wildcard anywhere. Never throws.
 */
export function findPromptApproval(
  b: PromptBinding,
  home: string = repoAegisHome(),
  now: Date = new Date(),
): PromptApproval | null {
  try {
    if (!isPromptVerb(b.verb)) return null;
    const safe = safeDestination(b.org, b.repo);
    if (safe === null || safe.org === "*" || safe.repo === "*") return null;
    if (b.verb === "git-push" && (b.ref === undefined || b.ref === "")) return null;
    if (b.verb === "gh-api-mutating" && (b.endpoint === undefined || b.endpoint === "")) return null;
    for (const a of listPromptApprovals(home, now)) {
      if (a.verb !== b.verb) continue;
      if (a.org !== safe.org || a.repo !== safe.repo) continue;
      if (b.verb === "git-push" && a.ref !== b.ref) continue;
      if (b.verb === "gh-api-mutating" && a.endpoint !== b.endpoint) continue;
      return a;
    }
    return null;
  } catch {
    return null;
  }
}

export interface RecordPromptOptions {
  binding: PromptBinding;
  /** The host's `permission_mode`, as reported. Anything outside {@link PROMPT_APPROVAL_MODES} writes nothing. */
  permissionMode: string | undefined;
  session?: string | undefined;
  home?: string;
  now?: Date;
}

/**
 * Write one prompt approval, or return null without touching the disk when the permission mode is not allowlisted or
 * the binding is not valid. One file per approval: no read-modify-write, no lock, no lost update between concurrent
 * hooks. Best-effort pruning of expired files. NEVER throws: a failure is null (the verdict stays `ask`).
 */
export function recordPromptApproval(opts: RecordPromptOptions): PromptApproval | null {
  const mode = opts.permissionMode;
  if (mode === undefined || !PROMPT_APPROVAL_MODES.has(mode)) return null;
  if (!validBinding(opts.binding)) return null;
  const now = opts.now ?? new Date();
  const home = opts.home ?? repoAegisHome();
  let tmp: string | undefined;
  try {
    const b = opts.binding;
    const approval: PromptApproval = {
      id: `p${randomBytes(4).toString("hex")}`,
      source: "prompt",
      verb: b.verb,
      org: b.org,
      repo: b.repo,
      ...(b.ref !== undefined && { ref: b.ref }),
      ...(b.endpoint !== undefined && { endpoint: b.endpoint }),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + PROMPT_APPROVAL_TTL_MS).toISOString(),
      permissionMode: mode as "default" | "acceptEdits",
      ...(opts.session !== undefined && SESSION_ID.test(opts.session) && { session: opts.session }),
      by: safeUser(),
    };
    const dir = promptApprovalsDir(home);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* best effort */
    }
    tmp = join(dir, `.${approval.id}.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(approval, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(tmp, join(dir, `${approval.id}.json`));
    tmp = undefined;
    prunePromptApprovals(dir, now);
    return approval;
  } catch {
    if (tmp !== undefined) {
      try {
        unlinkSync(tmp);
      } catch {
        /* nothing to clean */
      }
    }
    return null;
  }
}

/** Best-effort: unlink `p*.json` files whose `expiresAt` has passed. */
function prunePromptApprovals(dir: string, now: Date): void {
  try {
    for (const name of readdirSync(dir)) {
      if (!PROMPT_FILE.test(name)) continue;
      try {
        const file = join(dir, name);
        const st = lstatSync(file);
        if (!st.isFile() || st.size > PROMPT_FILE_MAX_BYTES) continue;
        const parsed = JSON.parse(readFileSync(file, "utf8")) as { expiresAt?: unknown };
        const exp = typeof parsed.expiresAt === "string" ? Date.parse(parsed.expiresAt) : NaN;
        if (Number.isFinite(exp) && exp <= now.getTime()) unlinkSync(file);
      } catch {
        /* leave it */
      }
    }
  } catch {
    /* best effort */
  }
}

/** One entry of `approve --list`: a stored terminal approval or a prompt approval, tagged with where it came from. */
export type ListedApproval = (EgressApproval & { source: "terminal" }) | PromptApproval;

/** Unexpired approvals of both kinds, newest first, each tagged with its `source`. */
export function listAllApprovals(path: string = approvalsPath(), now: Date = new Date()): ListedApproval[] {
  const terminal = listApprovals(path, now).map(a => ({ ...a, source: "terminal" as const }));
  const prompt = listPromptApprovals(dirname(path), now);
  return [...terminal, ...prompt].sort((x, y) => y.createdAt.localeCompare(x.createdAt));
}

/** Remove the prompt approval `which` (a `p…` id), or every one with `"all"`. Returns the ids removed. */
function revokePromptApprovals(which: string, dir: string): string[] {
  const removed: string[] = [];
  try {
    if (which !== "all" && !PROMPT_ID.test(which)) return removed;
    const names = which === "all" ? readdirSync(dir).filter(n => PROMPT_FILE.test(n)) : [`${which}.json`];
    for (const name of names) {
      try {
        unlinkSync(join(dir, name));
        removed.push(name.replace(/\.json$/, ""));
      } catch {
        /* absent */
      }
    }
  } catch {
    /* no directory: nothing to revoke */
  }
  return removed;
}

// ---------------------------------------------------------------------------
// The binding, computed at the hook (and re-derived by the shim)
// ---------------------------------------------------------------------------

/** Characters a destination ref may not contain: a glob, an expansion, a revision expression or whitespace. */
const UNBINDABLE_REF = /[*$`?[~^\s\\]|@\{/;

/**
 * The destination side of a push refspec as a normalised ref, or null. `main`, `HEAD:main`, `+feat:refs/heads/rel`,
 * `refs/tags/v1` and (with `resolveHead`) `HEAD`. Null for a missing or `<unparsed>` refspec, an empty destination
 * (`:main` is a delete), any glob, variable or revision syntax, and `HEAD` that cannot be resolved.
 */
function pushDestinationRef(
  refspec: string | undefined,
  dir: string,
  resolveHead: (dir: string) => string | null,
): string | null {
  if (refspec === undefined || refspec === "" || refspec === "<unparsed>") return null;
  const spec = refspec.replace(/^\+/, "");
  const colon = spec.lastIndexOf(":");
  // `:main` has no source: it DELETES the remote ref (pre-push skips deletes anyway). Never bound.
  if (colon === 0) return null;
  const dest = colon === -1 ? spec : spec.slice(colon + 1);
  if (dest === "" || UNBINDABLE_REF.test(dest)) return null;
  let ref = dest;
  if (dest === "HEAD") {
    let head: string | null = null;
    try {
      head = resolveHead(dir);
    } catch {
      head = null;
    }
    if (head === null || head === "" || UNBINDABLE_REF.test(head)) return null;
    ref = head;
  }
  const norm = normaliseRef(ref);
  return norm === "" ? null : norm;
}

/**
 * What a prompt approval for `intent` would be bound to, or null: then NOTHING is written, and nothing below the hook
 * can honour a yes. Pure apart from `resolveHead`, which maps a directory to its current branch (the hook runs
 * `git symbolic-ref`; the shim passes a resolver that returns null, because a `gh` verb has no ref).
 *
 * Null for: no destination or an unresolved one (a GraphQL mutation, an opaque URL, an ambiguous target, your own
 * account); `candidates`, a `*` owner or repo, or an unsafe name; an unresolved intent or a verb that is not a
 * {@link PromptVerb}; a `git push` whose destination ref cannot be bound; a mutating `gh api` with no endpoint.
 */
export function promptBindingOf(
  intent: Pick<EgressIntent, "verb" | "unresolved" | "refspec" | "apiEndpoint" | "cwdOverride">,
  destination: Pick<Destination, "org" | "repo" | "unresolved" | "candidates"> | null | undefined,
  resolveHead: (dir: string) => string | null,
  cwd = "",
): PromptBinding | null {
  if (destination === null || destination === undefined) return null;
  if (destination.unresolved !== undefined || destination.candidates !== undefined) return null;
  if (intent.unresolved !== undefined) return null;
  if (!isPromptVerb(intent.verb)) return null;
  if (destination.org === "*" || destination.repo === "*") return null;
  const safe = safeDestination(destination.org, destination.repo);
  if (safe === null) return null;
  const base = { verb: intent.verb, org: safe.org, repo: safe.repo };
  let binding: PromptBinding;
  if (intent.verb === "git-push") {
    const ref = pushDestinationRef(intent.refspec, intent.cwdOverride ?? cwd, resolveHead);
    if (ref === null) return null;
    binding = { ...base, ref };
  } else if (intent.verb === "gh-api-mutating") {
    if (intent.apiEndpoint === undefined) return null;
    binding = { ...base, endpoint: intent.apiEndpoint.replace(/^\//, "") };
  } else {
    binding = base;
  }
  // The same validation the writer and the reader apply, so a binding that comes out of here is one they accept.
  return validBinding(binding) ? binding : null;
}
