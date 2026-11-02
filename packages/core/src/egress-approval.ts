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
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { repoAegisHome } from "./paths.js";
import { isSafeOwner, safeDestination } from "./refusal.js";

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
    typeof a["by"] === "string"
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
  };
  const store = readApprovalStore(path);
  store.approvals = [...store.approvals.filter(a => isLive(a, now)), approval];
  writeApprovalStore(store, path);
  return approval;
}

/** Remove one approval by id, or every one with `"all"`. Returns the ids removed. */
export function revokeApprovals(which: string, path: string = approvalsPath()): string[] {
  const store = readApprovalStore(path);
  const keep = which === "all" ? [] : store.approvals.filter(a => a.id !== which);
  const removed = store.approvals.filter(a => !keep.includes(a)).map(a => a.id);
  if (removed.length > 0 || which === "all") writeApprovalStore({ version: 1, approvals: keep }, path);
  return removed;
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
