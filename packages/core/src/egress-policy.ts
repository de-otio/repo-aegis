// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Egress policy: the one decision function behind every destination-aware
// enforcement point (doc/design/egress-guard.md §1). Given the intents a
// command line carries, decide `allow` / `ask` / `deny`.
//
// Two properties are load-bearing and must survive every future edit:
//
//   1. **Shape rules are unconditional; context rules fail open.** Rules
//      a–d need no registry, no class and no visibility, so they always
//      apply. Rules e–g read context that may be missing (an unparseable
//      remote, an unclassified repo, a payload that does not exist); a
//      guardrail must never block on its own inability to determine
//      context — that was the spurious `CROSS_ORG_WRITE` flake
//      (doc/bugs/repo-aegis-check-write-flake.md). Asking is not blocking,
//      so an uncertain destination may still `ask`.
//
//      Rule h (issue #151) is the documented exception, and it is a refusal
//      no approval satisfies. It refuses non-interactive egress to an owner
//      that is not registered (in neither `personalOrgs` nor any engagement's
//      `githubOrgs`). The context is not missing: what is known is that a
//      write goes to an owner nobody has vouched for. That includes a write
//      whose owner cannot be named offline (`Destination.unresolved`), and an
//      unreadable or encrypted registry, where no owner can be confirmed. It
//      stays out of the way only where there is nothing to judge against: no
//      registry file at all, or a registry that declares no owners. Only a
//      person at a terminal passes it.
//   2. **Decision-only.** This module returns a decision and a reason; it
//      never returns a rewritten command. Rewriting `git push` into `git
//      push origin <branch>` would rebuild the implicit-destination defect
//      one layer up with the agent's intent still unexamined.
//
// Reasons name the destination (`<org>/<repo>`, visibility, class) and the
// ref or PR — the receipt-before-the-fact a human sees when asked. They
// never carry payload content, matched substrings, or registry entries.

import { basename, isAbsolute, join, resolve as resolvePath } from "node:path";
import { execFileSync } from "node:child_process";
import { closeSync, openSync, readSync } from "node:fs";
import { readCachedVisibility, treatAsPublicDestination, type RepoVisibility } from "./egress.js";
import {
  effectiveVisibilityLookup,
  refreshUnknownVisibility,
  UNKNOWN_VISIBILITY_HINT,
  type VisibilityLookup,
} from "./visibility-lookup.js";
import {
  graphqlOperationKind,
  parseApiEndpoint,
  type EgressIntent,
  type EgressVerb,
  type GraphqlOperationKind,
} from "./egress-intent.js";
import { resolveCachedDestination } from "./destination-cache.js";
import {
  approvalScopeOf,
  findApproval,
  findUncoveringStarApproval,
  type ApprovalScope,
  type EgressApproval,
  type StarApprovalGap,
} from "./egress-approval.js";
import { ownerAdmitted, registeredOwners, UPSTREAM_ADMITTED_VERBS } from "./registered-owners.js";
import {
  refusal,
  safeDestination,
  isSafeOwner,
  isPrintableDestination,
  INVALID_DESTINATION_LABEL,
  type RefusalFix,
} from "./refusal.js";
import { registryPath } from "./paths.js";
import { homedir } from "node:os";
import { parseRemoteUrl } from "./remote-url.js";
import { readRepoConfig, type RepoClass, type RepoConfig } from "./repo.js";
import type { Registry } from "./registry.js";
import { computeTrustBoundary, type TrustBoundary } from "./trust-boundary.js";
import { findEnclosingWorkingTree } from "./working-tree.js";
import { computeDenySet } from "./deny-set.js";
import { scanFile } from "./scan.js";

export type EgressCode =
  | "PUSH_IMPLICIT_TARGET"
  | "EGRESS_AFTER_CD"
  | "EGRESS_UNGUARDED_CHAIN"
  | "PAYLOAD_MODE_DEPENDENT_PATH"
  | "CROSS_ORG_EGRESS"
  | "PAYLOAD_MARKER_HIT"
  | "UNREGISTERED_OWNER_EGRESS"
  | "PUBLIC_EGRESS_NEEDS_HUMAN"
  | "SHIM_UNREACHABLE_NEEDS_HUMAN";

/**
 * The shape rules (a–d): unconditional, they never reach rule h. Layers use
 * this to leave rule h's standing (`ruleH`, the skip note) out of a refusal
 * that rule h had no part in.
 */
export const SHAPE_RULE_CODES: ReadonlySet<EgressCode> = new Set<EgressCode>([
  "PUSH_IMPLICIT_TARGET",
  "EGRESS_AFTER_CD",
  "EGRESS_UNGUARDED_CHAIN",
  "PAYLOAD_MODE_DEPENDENT_PATH",
]);

export interface Destination {
  org: string;
  repo: string;
  class: RepoClass;
  /**
   * From the `repo-aegis.visibility` cache. The resolver never probes; when
   * it yields `unknown`, `decideEgress` may refresh it once with a live
   * lookup (see `visibility-lookup.ts`).
   */
  visibility: RepoVisibility;
  /**
   * `treatAsPublicDestination`: `class === "public-eligible" ||
   * visibility !== "private"`. An unknown visibility counts as public.
   */
  publicFacing: boolean;
  /**
   * True when `class` / `visibility` describe *this* destination: it is the
   * working tree's own origin, or its org is registered to an engagement (see
   * `inferredFromRegistry`). False when the command targets a repository this
   * machine holds nothing about: the org/repo is still known, the class is not.
   */
  classKnown: boolean;
  /**
   * True when the class was not read from a working tree but inferred from
   * the registry: the destination org appears in an engagement's
   * `githubOrgs`, so the destination is `customer-coupled` to that
   * engagement whatever the cwd is. This is how `_self_identity` and the
   * cross-org boundary reach a payload published into a customer's
   * repository from an unclassified directory — the first incident's shape.
   * Visibility stays `unknown` (no cache to read).
   */
  inferredFromRegistry?: boolean;
  /** The engagement ids the destination is coupled to, when inferred. */
  engagements?: string[];
  /**
   * True when class and visibility were read through the machine-wide
   * destination cache (`destinations.json`): the command ran outside the
   * destination's checkout, but this machine holds one and its declaration
   * applies. `workingTree` is that checkout.
   */
  fromCache?: boolean;
  /**
   * The checkout whose declaration `class` / `visibility` came from — the
   * command's own directory, or the cached pointer. Absent when the class
   * is inferred or unknown. Rule e reads the destination's trust boundary
   * from here; rule f reads its deny set from here.
   */
  workingTree?: string;
  /**
   * True when the destination is public-facing ONLY because its visibility
   * is unknown (issue #114): nothing cached says `private`, so rule g treats
   * it as public rather than let an unknown destination through. Asking is
   * not blocking, and the alternative is the fail-open that let a push to a
   * public repository through under an `UNKNOWN` label.
   */
  assumedPublic?: boolean;
  /**
   * Set when the command HAS a destination but nothing offline can say which
   * repository it is. Today one producer: a `gh api graphql` mutation, which
   * names its target by node id (`pullRequestId: "PR_…"`) — the cwd is not
   * its destination, however it is invoked (issue #113). `org`/`repo` are
   * then `*` (so only a wildcard approval can cover it), and the destination
   * is treated as public-facing — the same fail-closed stance as
   * `assumedPublic`: rule g asks a person, or refuses from a shell with none.
   * Rule e is skipped (there is no boundary to compare against); rule f
   * still scans the payload against a public-facing deny set.
   */
  unresolved?: "graphql-mutation";
}

export type EgressDecision =
  | {
      action: "allow";
      /**
       * Set when rule g would have needed a person and a live human-minted
       * approval stood in (`repo-aegis approve`). Callers record the use.
       */
      approval?: EgressApproval;
      intent?: EgressIntent;
      destination?: Destination;
    }
  | { action: "ask"; code: EgressCode; reason: string; destination?: Destination; intent: EgressIntent }
  | { action: "deny"; code: EgressCode; reason: string; destination?: Destination; intent: EgressIntent };

/** Human-only escape for the "is a person present" test. Same contract as `REPO_AEGIS_WAIVE_NONINTERACTIVE`. */
export const EGRESS_HUMAN_ENV = "REPO_AEGIS_EGRESS_HUMAN";

/**
 * Whether a human is at the keyboard for this invocation: a TTY on stderr
 * (stdin is often a pipe even for humans — git's ref list, a heredoc — so it
 * is never the signal), or the documented human-only override.
 */
export function isHumanPresent(
  env: NodeJS.ProcessEnv = process.env,
  stderrIsTTY: boolean = !!process.stderr.isTTY,
): boolean {
  return stderrIsTTY || env[EGRESS_HUMAN_ENV] === "1";
}

/** Verbs that need a person regardless of destination: they are hard or impossible to undo. */
export const VERBS_NEEDING_HUMAN: ReadonlySet<EgressVerb> = new Set<EgressVerb>([
  "gh-pr-merge",
  "gh-release-create",
  "gh-release-edit",
  "gh-release-upload",
  "gh-repo-create",
  "gh-repo-edit",
  "gh-gist-create",
  "gh-workflow-run",
  "npm-publish",
]);

/** Resolves an intent's destination from local state and the registry. Injectable for tests. */
export type DestinationResolver = (
  intent: EgressIntent,
  cwd: string,
  registry?: Registry,
) => Destination | null;

/**
 * Scans one payload file against the destination's deny set and returns the
 * hit count, or `null` when the file could not be scanned (missing, unreadable).
 * Injectable for tests.
 */
export type PayloadScanner = (file: string, destination: Destination, cwd: string) => number | null;

/**
 * Looks up a live human-minted approval for a destination (null when the
 * command has none, e.g. `npm publish`) and the ref the command names.
 * `scope` says what a `*` approval may cover for this call (D7): the
 * registry's personal orgs and upstreams, and whether the verb is
 * destination-less. Injectable for tests; defaults to the approvals store
 * under `REPO_AEGIS_HOME`.
 */
export type ApprovalFinder = (
  destination: Destination | null,
  ref: string | undefined,
  scope: ApprovalScope,
) => EgressApproval | null;

/**
 * How the registry was obtained, so that "empty because missing", "empty
 * because unreadable" and "loaded and empty" cannot be confused (rule h,
 * issue #151, decision D4).
 *
 * - `loaded`: read successfully. Rule h judges against its owner lists, and
 *   is skipped when it declares none.
 * - `missing`: no registry file exists. Rule h is skipped.
 * - `unreadable`: a file (or ciphertext) exists but could not be read:
 *   encrypted, unparseable, or a newer schema. Rule h refuses every
 *   non-interactive egress that has a destination, because no owner can be
 *   confirmed. Falling open here would let one corrupted line switch the
 *   rule off.
 */
export type RegistryState = "loaded" | "missing" | "unreadable";

export interface DecideEgressOptions {
  intents: EgressIntent[];
  /** Where the command WILL run: the hook payload's cwd, or the shim's `$PWD`. */
  cwd: string;
  registry: Registry;
  /** How `registry` was obtained. Required: every caller must say (see {@link RegistryState}). */
  registryState: RegistryState;
  /** From {@link isHumanPresent}. */
  humanPresent: boolean;
  capabilities: {
    /** Does the enforcing framework have an "ask"? A shell does not. */
    ask: boolean;
    /**
     * Is the `gh` shim the first `gh` on the PATH the command will run with?
     *
     * Only a caller that can answer this honestly should set it — in
     * practice the agent hook, which inherits the same environment its
     * host will hand the shell. It exists because `ask` is only a real
     * refusal when a layer *below* the asker can hold the command if the
     * ask is not answered by a person; for a `gh` verb that layer is the
     * shim, and a `false` here says it is not there. `undefined` means
     * "not asked" and changes nothing: a caller that cannot determine it,
     * or whose lookup threw, must leave it unset rather than guess.
     */
    ghShimOnPath?: boolean;
  };
  resolveDestination?: DestinationResolver;
  scanPayload?: PayloadScanner;
  /** Injectable for tests; defaults to `computeTrustBoundary`. */
  trustBoundaryOf?: (workingTree: string) => TrustBoundary;
  /** Injectable for tests; defaults to the approvals store. */
  findApproval?: ApprovalFinder;
  /**
   * Injectable for tests: the lookup behind rule g's "a `*` approval is live
   * but does not cover this" sentence. When omitted it follows
   * {@link findApproval}: the real store is read only when the real finder is
   * in use (omitted, or {@link findApprovalDefault}); an injected finder
   * means no gap lookup, so an injected finder controls what rule g sees and
   * a test never reads the developer's own approvals store.
   */
  findUncoveredStar?: UncoveredStarFinder;
  /**
   * Live lookup for a destination whose visibility is unknown. Injectable
   * for tests; defaults to `gh repo view` unless
   * `REPO_AEGIS_VISIBILITY_LOOKUP=0`.
   */
  lookupVisibility?: VisibilityLookup;
}

/**
 * Looks up a live `*` approval that exists but does NOT cover `destination`
 * (D7), so rule g's refusal can say so. Same injection seam as
 * {@link ApprovalFinder}: see {@link DecideEgressOptions.findUncoveredStar}.
 */
export type UncoveredStarFinder = (
  destination: Destination,
  ref: string | undefined,
  scope: ApprovalScope,
) => { approval: EgressApproval; gap: StarApprovalGap } | null;

/** Default {@link UncoveredStarFinder}: the approvals store under `REPO_AEGIS_HOME`. */
export const findUncoveredStarDefault: UncoveredStarFinder = (destination, ref, scope) =>
  findUncoveringStarApproval(destination, ref, scope);

/**
 * Default {@link ApprovalFinder}. A `*` approval covers only `personalOrgs`
 * owners and destination-less verbs (`scope.destinationless`); a null
 * destination that is not flagged destination-less is covered by nothing
 * but an explicit person.
 */
export const findApprovalDefault: ApprovalFinder = (destination, ref, scope) =>
  findApproval(destination ?? { org: "*", repo: "*" }, ref, scope);

// ---------------------------------------------------------------------------
// Destination resolution (offline)
// ---------------------------------------------------------------------------

function gitConfigGet(cwd: string, key: string): string | null {
  try {
    const out = execFileSync("git", ["config", "--get", key], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/** `o/r`, `host/o/r`, or a full remote URL → org/repo. */
function parseRepoFlag(flag: string): { org: string; repo: string } | null {
  const viaUrl = parseRemoteUrl(flag);
  if (viaUrl) return { org: viaUrl.org, repo: viaUrl.repo };
  const parts = flag.replace(/\.git$/, "").split("/").filter(Boolean);
  if (parts.length === 2) return { org: parts[0]!.toLowerCase(), repo: parts[1]!.toLowerCase() };
  if (parts.length === 3 && /github\.com$/i.test(parts[0]!)) {
    return { org: parts[1]!.toLowerCase(), repo: parts[2]!.toLowerCase() };
  }
  return null;
}

function ownOrigin(base: string): { org: string; repo: string } | null {
  const url = gitConfigGet(base, "remote.origin.url");
  const parsed = url === null ? null : parseRemoteUrl(url);
  return parsed ? { org: parsed.org, repo: parsed.repo } : null;
}

/** Engagement ids whose `githubOrgs` contain `org` (lowercased). */
function engagementsForOrg(registry: Registry | undefined, org: string): string[] {
  if (!registry) return [];
  const out: string[] = [];
  for (const e of registry.engagements) {
    if ((e.githubOrgs ?? []).some(o => o.toLowerCase() === org)) out.push(e.id);
  }
  return out;
}

/** `publicFacing` (and `assumedPublic` when only the unknown visibility makes it so), by the one shared rule. */
function gateFields(cls: RepoClass, visibility: RepoVisibility): { publicFacing: boolean; assumedPublic?: true } {
  const publicFacing = treatAsPublicDestination(cls, visibility);
  return publicFacing && cls !== "public-eligible" && visibility === "unknown"
    ? { publicFacing, assumedPublic: true }
    : { publicFacing };
}

/**
 * Issue #114: a destination whose visibility is unknown gets ONE live lookup
 * (cached into its checkout when there is one). A positive answer replaces
 * `unknown`; anything else leaves it, and it stays treated as public. Only
 * run when the answer could change the gate — a `public-eligible` class is
 * public-facing whatever GitHub says.
 */
export function refreshDestinationVisibility(destination: Destination, lookup: VisibilityLookup | null): Destination {
  if (destination.visibility !== "unknown" || destination.class === "public-eligible") return destination;
  const visibility = refreshUnknownVisibility(destination, lookup);
  if (visibility === "unknown") return destination;
  const { assumedPublic: _dropped, ...rest } = destination;
  return { ...rest, visibility, ...gateFields(destination.class, visibility) };
}

function withLocalClass(
  target: { org: string; repo: string },
  base: string,
  own: { org: string; repo: string } | null,
  registry?: Registry,
): Destination {
  const isOwn = own !== null && own.org === target.org && own.repo === target.repo;
  if (!isOwn) {
    // Not this tree's origin. The registry may still know the org: an
    // engagement's `githubOrgs` makes the destination customer-coupled to that
    // engagement, whatever directory the command runs from.
    const engagements = engagementsForOrg(registry, target.org);
    if (engagements.length > 0) {
      return {
        ...target,
        class: "customer-coupled",
        visibility: "unknown",
        ...gateFields("customer-coupled", "unknown"),
        classKnown: true,
        inferredFromRegistry: true,
        engagements,
      };
    }
    // Not a customer's either. Does this machine hold a checkout of it? The
    // cache is a pointer first and a snapshot second: read the live config
    // when the tree is still there, the snapshot when it is not.
    const cached = target.repo === "*" ? null : resolveCachedDestination(target.org, target.repo);
    if (cached !== null) {
      return {
        ...target,
        class: cached.class,
        visibility: cached.visibility,
        ...gateFields(cached.class, cached.visibility),
        classKnown: true,
        fromCache: true,
        workingTree: cached.workingTree,
      };
    }
    // Nothing on this machine describes it — in a personal org or not, the
    // visibility is unknown, and unknown is treated as public (issue #114).
    // Before that fix only `personalOrgs` got this treatment and every other
    // unknown destination was let through.
    return {
      ...target,
      class: "private-strict",
      visibility: "unknown",
      ...gateFields("private-strict", "unknown"),
      classKnown: false,
    };
  }
  let cfg: RepoConfig;
  try {
    cfg = readRepoConfig(base);
  } catch {
    return {
      ...target,
      class: "private-strict",
      visibility: "unknown",
      ...gateFields("private-strict", "unknown"),
      classKnown: false,
    };
  }
  const visibility = readCachedVisibility(base);
  return {
    ...target,
    class: cfg.class,
    visibility,
    // The class is a declaration and the cache is only an optimisation:
    // `public-eligible` counts as public-facing even with no cached value,
    // and an uncached `private-strict` repo counts too, until something
    // (a lookup, `status`, `classify`) records that it is private.
    ...gateFields(cfg.class, visibility),
    classKnown: true,
    workingTree: base,
  };
}

/** Upper bound on a GraphQL document file read to classify it. */
const GRAPHQL_FILE_MAX = 1024 * 1024;

/** A file's text, or null when it is absent, unreadable or too large. */
function readSmallFile(path: string, base: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(isAbsolute(path) ? path : resolvePath(base, path), "r");
    const buf = Buffer.alloc(GRAPHQL_FILE_MAX + 1);
    let len = 0;
    for (;;) {
      const got = readSync(fd, buf, len, buf.length - len, null);
      if (got === 0) break;
      len += got;
      if (len > GRAPHQL_FILE_MAX) return null;
    }
    return buf.subarray(0, len).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* nothing to do */
      }
    }
  }
}

/**
 * What a `gh api graphql` call would do. The document is read from wherever
 * the command takes it — the inline `query` field, a `-F query=@file`, or the
 * `query` member of an `--input` JSON body. Anything that cannot be read here
 * (stdin, a missing file, a body that is not JSON, no `query` at all) is
 * `opaque`: the caller cannot rule a mutation out, so it must not assume a
 * read. `query` for an intent that is not a GraphQL call. Never throws.
 */
export function graphqlIntentKind(intent: EgressIntent, base: string): GraphqlOperationKind {
  const g = intent.graphql;
  if (g === undefined) return "query";
  let text: string | null = null;
  if (g.queryFile !== undefined) {
    text = g.queryFile === "-" ? null : readSmallFile(g.queryFile, base);
  } else if (g.query !== undefined) {
    text = g.query;
  } else if (g.inputFile !== undefined && g.inputFile !== "-") {
    const body = readSmallFile(g.inputFile, base);
    try {
      const parsed: unknown = body === null ? null : JSON.parse(body);
      const q = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>)["query"] : undefined;
      text = typeof q === "string" ? q : null;
    } catch {
      text = null;
    }
  }
  return text === null ? "opaque" : graphqlOperationKind(text);
}

/**
 * Default resolver. `git push <remote>` → `remote.<remote>.url` from the
 * command's directory (`git -C` or cwd); a URL given as the remote is parsed
 * directly. `gh … --repo o/r` → direct. `gh api repos/o/r/…` → from the
 * path (`orgs/o/…` → the org, repo `*`). Other `gh` → the directory's
 * origin. Class and cached visibility are read from that directory when the
 * target is its own origin; otherwise the class is inferred from the
 * registry when the org belongs to an engagement (`customer-coupled`), read
 * through the machine-wide destination cache when this machine holds a
 * checkout of the target, assumed public-facing when the org is a personal
 * org with nothing cached, and unknown otherwise. Returns `null` when
 * nothing parses — the context rules then do not fire.
 */
export const resolveDestinationOffline: DestinationResolver = (intent, cwd, registry) => {
  const base = intent.cwdOverride ?? cwd;
  const own = ownOrigin(base);

  if (intent.verb === "git-push") {
    if (intent.remote === undefined) return own ? withLocalClass(own, base, own, registry) : null;
    const direct = parseRemoteUrl(intent.remote);
    if (direct) return withLocalClass({ org: direct.org, repo: direct.repo }, base, own, registry);
    const url = gitConfigGet(base, `remote.${intent.remote}.url`);
    const parsed = url === null ? null : parseRemoteUrl(url);
    if (!parsed) return null;
    return withLocalClass({ org: parsed.org, repo: parsed.repo }, base, own, registry);
  }

  if (intent.verb === "npm-publish") return null; // registry, not a repo

  if (intent.repoFlag !== undefined) {
    const target = parseRepoFlag(intent.repoFlag);
    return target ? withLocalClass(target, base, own, registry) : null;
  }
  if (intent.apiEndpoint !== undefined) {
    // The destination is in the path. `{owner}/{repo}` placeholders, `graphql`
    // and the account-level endpoints carry none, and fall through to the
    // cwd's origin — for the placeholders that is exactly what gh does.
    const target = parseApiEndpoint(intent.apiEndpoint);
    if (target !== null) return withLocalClass({ org: target.org, repo: target.repo ?? "*" }, base, own, registry);
    // A GraphQL mutation's target is a node id, not a path, and not the cwd:
    // an `enqueuePullRequest` run from a private checkout reaches whichever
    // repository owns that PR (issue #113). A read keeps the cwd fallback.
    if (intent.graphql !== undefined && graphqlIntentKind(intent, base) !== "query") {
      return {
        org: "*",
        repo: "*",
        class: "private-strict",
        visibility: "unknown",
        publicFacing: true,
        classKnown: false,
        assumedPublic: true,
        unresolved: "graphql-mutation",
      };
    }
  }
  return own ? withLocalClass(own, base, own, registry) : null;
};

/**
 * Default payload scanner: the destination's deny set (its own class when
 * known; a synthesised `customer-coupled` config when the class was inferred
 * from the registry, so `_self_identity` and the other customers' markers
 * apply; `_always`-only otherwise) over the file, hits counted, never shown.
 * Fails open (`null`) on any error.
 */
export const scanPayloadAgainstDestination: PayloadScanner = (file, destination, cwd) => {
  try {
    let repo: RepoConfig;
    if (destination.inferredFromRegistry) {
      repo = {
        cwd,
        isGitRepo: false,
        class: "customer-coupled",
        classExplicit: true,
        engagements: destination.engagements ?? [],
      };
    } else if (destination.classKnown) {
      repo = readRepoConfig(destination.workingTree ?? cwd);
    } else {
      repo = { cwd, isGitRepo: false, class: "private-strict", classExplicit: false, engagements: [] };
    }
    const denySet = computeDenySet(repo, { publicFacing: destination.publicFacing });
    const tree = findEnclosingWorkingTree(file) ?? undefined;
    const result = scanFile(file, denySet, { revealMatches: false }, tree);
    if (result.skipped.length > 0 && result.hits.length === 0) return null;
    return result.hits.length;
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const VERB_LABEL: Record<EgressVerb, string> = {
  "git-push": "git push",
  "gh-pr-create": "gh pr create",
  "gh-pr-edit": "gh pr edit",
  "gh-pr-merge": "gh pr merge",
  "gh-pr-comment": "gh pr comment",
  "gh-pr-review": "gh pr review",
  "gh-issue-create": "gh issue create",
  "gh-issue-edit": "gh issue edit",
  "gh-issue-comment": "gh issue comment",
  "gh-release-create": "gh release create",
  "gh-release-edit": "gh release edit",
  "gh-release-upload": "gh release upload",
  "gh-repo-create": "gh repo create",
  "gh-repo-edit": "gh repo edit",
  "gh-gist-create": "gh gist create",
  "gh-workflow-run": "gh workflow run",
  "gh-api-mutating": "gh api (mutating)",
  "npm-publish": "npm publish",
};

export function describeVerb(verb: EgressVerb): string {
  return VERB_LABEL[verb];
}

/** `<org>/<repo> (<visibility>, class <class>)` — the only way a destination is ever printed. */
export function describeDestination(d: Destination | null | undefined): string {
  if (!d) return "unresolved destination";
  if (d.unresolved === "graphql-mutation") {
    return "UNKNOWN repository (GraphQL mutation: the target is a node id, not resolvable offline; treated as public)";
  }
  // The name comes from the agent's command line (see refusal.ts): never print one that is not a GitHub name.
  if (safeDestination(d.org, d.repo) === null) return INVALID_DESTINATION_LABEL;
  const vis = d.assumedPublic ? "visibility uncached, treated as public" : d.classKnown ? d.visibility : "visibility unknown";
  const cls = d.classKnown ? d.class : "class unknown";
  return `${d.org}/${d.repo} (${vis}, ${cls})`;
}

/**
 * The receipt's rendering of a destination: visibility in capitals, so that
 * PUBLIC is the word the eye lands on. Shared by the post-hoc receipt and
 * the `EGRESS FAILED` line.
 */
export function describeDestinationForReceipt(d: Destination | null | undefined): string {
  if (!d) return "(destination not resolved)";
  if (d.unresolved === "graphql-mutation") return "UNKNOWN (GRAPHQL MUTATION TARGET NOT RESOLVED, TREATED AS PUBLIC)";
  if (safeDestination(d.org, d.repo) === null) return INVALID_DESTINATION_LABEL.toUpperCase();
  const vis = d.assumedPublic
    ? "VISIBILITY UNCACHED, TREATED AS PUBLIC"
    : d.classKnown
      ? d.visibility.toUpperCase()
      : "VISIBILITY UNKNOWN";
  const cls = d.classKnown ? `class ${d.class}` : "class unknown";
  return `${d.org}/${d.repo} (${vis}, ${cls})`;
}

/**
 * Rule d: a payload path whose meaning depends on how the shell was launched.
 * `$TMPDIR` resolves to a different directory under a sandbox than outside
 * it; `/var/folders/**` is macOS's per-user temp; `/tmp/claude-*` is the
 * sandboxed `$TMPDIR` root, shared by every session on the machine — a stale
 * file of the same name from another session is read silently. A relative
 * path resolves against whatever the cwd turns out to be.
 *
 * The one exemption: the agent's *session scratchpad*, which lives under
 * that same root but inside a session-unique directory
 * (`…/<session-id>/scratchpad/…`). It is exactly the location the design
 * tells agents to use, so refusing it would teach them to bypass the rule.
 * `-` (stdin) is not a path.
 */
export function isModeDependentPath(path: string): { dependent: boolean; why?: string } {
  if (path === "-") return { dependent: false };
  if (/\$\{?TMPDIR\}?|\$\{?TMP\}?|%TEMP%|%TMP%/.test(path)) {
    return { dependent: true, why: "expands $TMPDIR, which differs between sandboxed and unsandboxed shells" };
  }
  if (!isAbsolute(path) && !/^[A-Za-z]:[\\/]/.test(path)) {
    return { dependent: true, why: "is relative and resolves against whatever the cwd turns out to be" };
  }
  if (/^\/(?:private\/)?var\/folders\//.test(path)) {
    return { dependent: true, why: "is under the per-user temp root, which only an unsandboxed shell sees" };
  }
  if (/^\/(?:private\/)?tmp\/claude-[^/]*\//.test(path) && !/\/scratchpad\//.test(path)) {
    return {
      dependent: true,
      why: "is under the shared sandbox temp root; use the session scratchpad (…/<session>/scratchpad/) instead",
    };
  }
  return { dependent: false };
}

function positivelyDisjoint(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  for (const o of a) if (b.has(o)) return false;
  return true;
}

/**
 * `d` if it may be printed or attached to a decision (see
 * {@link isPrintableDestination}), else `undefined`: the name is dropped, as
 * the refusal text drops it. Layers print the attached destination as JSON, so
 * an invalid name (shell syntax, a line break, U+202E) never reaches a
 * terminal through that channel either.
 */
function printable(d: Destination): Destination | undefined {
  return isPrintableDestination(d) ? d : undefined;
}

/** Orgs for a message: valid names, sorted; any invalid ones are counted, not shown. */
function printOrgs(orgs: Iterable<string>): string {
  const valid: string[] = [];
  let invalid = 0;
  for (const o of orgs) {
    if (isSafeOwner(o)) valid.push(o.toLowerCase());
    else invalid++;
  }
  const names = [...new Set(valid)].sort();
  if (invalid > 0) names.push(invalid === 1 ? "1 invalid name" : `${invalid} invalid names`);
  return names.join(", ");
}

/** A path for a message; one with control or format characters (U+202E and friends) is described instead. */
function printablePath(p: string | undefined): string {
  return p !== undefined && !/[\p{C}]/u.test(p) ? p : "a checkout on this machine";
}

/**
 * Where the registry file is, for the repair hint. The path is printed only
 * when it is the default location under the home directory; for an override
 * the hint names the variable instead, so a path the environment chose (and
 * that could carry anything) is never echoed.
 */
function registryPathLabel(): string {
  try {
    const viaRegistry = process.env["REPO_AEGIS_REGISTRY"];
    if (viaRegistry !== undefined) return "the registry file (set by REPO_AEGIS_REGISTRY)";
    if (process.env["REPO_AEGIS_HOME"] !== undefined) return "the registry file (under REPO_AEGIS_HOME)";
    const h = homedir();
    if (h.length > 1 && registryPath() === join(h, ".config", "repo-aegis", "engagements.yaml")) {
      return "~/.config/repo-aegis/engagements.yaml";
    }
    return "the registry file";
  } catch {
    return "the registry file";
  }
}

/**
 * Rule h's refusal text (§3.9). Names the verb and the destination's own
 * owner/repo, which the command already carries, and nothing else: never the
 * registered owners, engagement ids or upstreams (the redaction oracle).
 */
/**
 * The sentence rule g ADDS to its existing refusal when a live `*` approval
 * exists but does not cover the destination (D7, §3.9: "existing message,
 * plus"): it says so, says why, and gives the narrower, quoted approve
 * commands. Leading space included, so it concatenates; empty when the
 * destination's name is not a plausible GitHub owner/repo (nothing
 * interpolated from an invalid name, no command to paste). Names only the
 * destination's own owner/repo, which the command already carries; never
 * another owner, an engagement id or the registry's contents.
 */
function uncoveredStarSentence(
  destination: Destination,
  star: EgressApproval,
  gap: StarApprovalGap,
  registry: Registry,
): string {
  const safe = safeDestination(destination.org, destination.repo);
  if (safe === null) return "";
  const owner = safe.org;
  const target = `${safe.org}/${safe.repo}`;
  const isCustomer = registry.engagements.some(e => (e.githubOrgs ?? []).some(o => o.toLowerCase() === owner));
  const kind =
    gap === "upstream"
      ? `${target} is an allowed upstream, not one of your own repositories`
      : isCustomer
        ? `${owner} is a customer org`
        : `${owner} is not one of your personal orgs`;
  return (
    ` A '*' approval (${star.id}, until ${star.expiresAt}) is live, but since 0.11.0 '*' covers only ` +
    `personal-org repositories and destination-less commands such as npm publish; ${kind}. ` +
    `No '*' approval covers it. A person runs, from a terminal: \`repo-aegis approve '${owner}/*'\` ` +
    `(the whole org) or \`repo-aegis approve ${target}\` (this repository only).`
  );
}

function unregisteredOwnerReason(
  intent: EgressIntent,
  destination: Destination,
  state: RegistryState,
  registry: Registry,
): string {
  const verb = describeVerb(intent.verb);
  const code = "UNREGISTERED_OWNER_EGRESS";
  const unresolved = destination.unresolved !== undefined;
  // Names come from the agent's own command line and end up in text a person
  // is told to paste. Only validated, lower-cased names are interpolated, and
  // `refusal()` discards the whole message for an invalid one (it is handed
  // `subject`), so nothing built from `owner`/`target` below can reach output
  // when the name is bad.
  const safe = unresolved ? null : safeDestination(destination.org, destination.repo);
  const owner = safe?.org ?? "";
  const target = safe === null ? "" : `${safe.org}/${safe.repo}`;
  const subject = unresolved ? {} : { destination: { verb, org: destination.org, repo: destination.repo } };
  const what = unresolved
    ? destination.unresolved === "graphql-mutation"
      ? "gh api graphql (mutation)"
      : `${verb} (unresolved destination)`
    : `${verb} → ${target}`;

  if (state === "unreadable") {
    return refusal({
      code,
      ...subject,
      what,
      why:
        `The registry could not be read (it is encrypted or damaged), so repo-aegis cannot confirm that ` +
        (unresolved ? `this destination's owner` : `the owner "${owner}"`) +
        ` is registered and refuses egress it cannot vouch for`,
      approval: "No approval covers this",
      fixes: [
        { by: "person", when: "If the registry is encrypted", command: "repo-aegis registry decrypt --identity <key>" },
        {
          by: "person",
          when: "If it is damaged",
          step: `repairs ${registryPathLabel()}, then re-runs the command (\`repo-aegis status\` shows why it fails to load)`,
        },
      ],
    });
  }

  if (unresolved) {
    return refusal({
      code,
      what,
      why:
        `A GraphQL mutation names its target by node id, so repo-aegis cannot tell offline which owner it ` +
        `writes to, and an unknown owner is treated as unregistered`,
      approval: "No approval covers this (since 0.11.0 a '*' approval no longer does)",
      fixes: [
        {
          by: "agent",
          when: "To act on a repository",
          command: "a gh command that names it, such as gh issue comment --repo <owner>/<repo> …",
        },
        { by: "person" },
      ],
    });
  }

  const upstreamKey = target.toLowerCase();
  const isUpstream = (registry.allowedUpstreams ?? []).some(u => u.toLowerCase() === upstreamKey);
  if (isUpstream && !UPSTREAM_ADMITTED_VERBS.has(intent.verb)) {
    return refusal({
      code,
      ...subject,
      what,
      why: `${target} is an allowed upstream, but allowed upstreams accept only PRs, issues and comments, not ${verb}`,
      approval: "No approval covers this",
      fixes: [
        {
          by: "agent",
          when: "To propose a change",
          command: `gh pr create --repo ${target} …`,
          note: "push the branch to your own fork first",
        },
      ],
    });
  }

  return refusal({
    code,
    ...subject,
    what,
    why:
      `The owner "${owner}" is not registered (in neither personalOrgs nor any engagement), so repo-aegis ` +
      `cannot tell whether this repository is yours`,
    approval: "No approval covers this",
    fixes: [
      {
        by: "person",
        when: `If "${owner}" is yours or a customer's`,
        command: `repo-aegis engagements add --personal-org ${owner}`,
        note: `or --github-org ${owner} under the engagement, for a customer`,
      },
      ...(destination.repo === "*"
        ? []
        : [
            {
              by: "person",
              when: "If it is an upstream you contribute to",
              command: `repo-aegis upstreams add ${target}`,
              note: "PRs and issues only",
            } satisfies RefusalFix,
          ]),
    ],
  });
}

function decideOne(intent: EgressIntent, opts: DecideEgressOptions): EgressDecision {
  const verb = describeVerb(intent.verb);
  const deny = (code: EgressCode, reason: string, destination?: Destination): EgressDecision => ({
    action: "deny",
    code,
    reason,
    ...(destination && { destination }),
    intent,
  });

  // ---- a: bare `git push` --------------------------------------------------
  if (intent.verb === "git-push" && (intent.remote === undefined || intent.refspec === undefined)) {
    return deny(
      "PUSH_IMPLICIT_TARGET",
      `\`git push\` without an explicit <remote> <refspec>: a bare push resolves its target from the ` +
        `current checkout's branch config, which is how a private branch reached a public remote. ` +
        `Re-issue as \`git push <remote> <branch>\`; the command is never rewritten for you.`,
    );
  }

  // ---- b: egress after `cd` in the same command ----------------------------
  if (intent.precededByCd) {
    return deny(
      "EGRESS_AFTER_CD",
      `${verb} after a \`cd\` in the same command: \`cd\` does not persist between tool calls, and ` +
        `a \`cd\` that failed leaves the egress running in the wrong checkout. Use \`git -C <abs-path>\` ` +
        `or \`gh --repo <org>/<repo>\` and give the egress its own call.`,
    );
  }

  // ---- c: joined to earlier segments by `;` / `||` / `&` -------------------
  if (intent.joinedBy === ";" || intent.joinedBy === "||" || intent.joinedBy === "&") {
    return deny(
      "EGRESS_UNGUARDED_CHAIN",
      `${verb} joined to earlier segments with \`${intent.joinedBy}\`: a failed prerequisite would not ` +
        `stop it. Chain with \`&&\` or run the egress as its own call.`,
    );
  }

  // ---- d: mode-dependent payload path --------------------------------------
  for (const file of intent.payloadFiles) {
    const check = isModeDependentPath(file);
    if (check.dependent) {
      return deny(
        "PAYLOAD_MODE_DEPENDENT_PATH",
        `${verb}: payload file \`${basename(file)}\` ${check.why}. Write the payload to an absolute, ` +
          `session-unique path in the session scratchpad and pass that path.`,
      );
    }
  }

  // ---- context ---------------------------------------------------------------
  const resolve = opts.resolveDestination ?? resolveDestinationOffline;
  let destination: Destination | null = null;
  try {
    destination = resolve(intent, opts.cwd, opts.registry);
  } catch {
    destination = null;
  }

  // ---- h: unregistered owner (issue #151) -----------------------------------
  // Right after resolution and BEFORE the visibility lookup and rule e: it is
  // offline and cheap, and it must not send `gh repo view` to an owner the
  // guard is about to refuse. No approval satisfies it (the finder is never
  // consulted); only a person does. Only the registry's owner lists count —
  // not the destination cache, a local class, or an approval (D2).
  if (destination !== null && !opts.humanPresent) {
    let refused = false;
    if (opts.registryState === "unreadable") {
      // No owner can be confirmed, so none is admitted (D4, revised).
      refused = true;
    } else if (opts.registryState === "loaded") {
      const owners = registeredOwners(opts.registry);
      // A registry that declares no owners has nothing to judge against.
      refused = owners.size > 0 && !ownerAdmitted(destination, intent, owners, opts.registry);
    }
    // "missing": no registry file at all, rule h is skipped.
    if (refused) {
      // A destination whose name is not a plausible GitHub owner/repo is not
      // attached to the decision: layers print it as JSON, and the refusal
      // text deliberately carries no such name either.
      return deny(
        "UNREGISTERED_OWNER_EGRESS",
        unregisteredOwnerReason(intent, destination, opts.registryState, opts.registry),
        printable(destination),
      );
    }
  }

  if (destination !== null) {
    destination = refreshDestinationVisibility(destination, effectiveVisibilityLookup(opts.lookupVisibility));
  }
  const boundaryOf = opts.trustBoundaryOf ?? ((wt: string) => computeTrustBoundary(wt, opts.registry));

  if (destination !== null) {
    // ---- e: cross-org egress ---------------------------------------------
    const destOrgs = new Set<string>([destination.org]);
    const base = intent.cwdOverride ?? opts.cwd;
    if (destination.inferredFromRegistry) {
      // The destination's boundary is its engagements' org set.
      for (const e of opts.registry.engagements) {
        if (!(destination.engagements ?? []).includes(e.id)) continue;
        for (const o of e.githubOrgs ?? []) destOrgs.add(o.toLowerCase());
      }
    } else if (destination.classKnown) {
      try {
        for (const o of boundaryOf(destination.workingTree ?? base).orgs) destOrgs.add(o);
      } catch {
        /* fail open: the destination org alone is the boundary */
      }
    }
    const sourceTrees: string[] = [];
    if (destination.unresolved !== undefined) {
      // No org to compare: its `*` would be "disjoint" from every boundary.
      // Rule f still scans the payload (as public-facing) and rule g asks.
    } else if (intent.verb === "git-push") {
      sourceTrees.push(base);
    } else {
      for (const file of intent.payloadFiles) {
        if (file === "-") continue;
        const tree = findEnclosingWorkingTree(file);
        if (tree !== null) sourceTrees.push(tree);
      }
    }
    for (const tree of sourceTrees) {
      let src: TrustBoundary;
      try {
        src = boundaryOf(tree);
      } catch {
        continue;
      }
      if (positivelyDisjoint(src.orgs, destOrgs)) {
        return deny(
          "CROSS_ORG_EGRESS",
          `${verb} → ${describeDestination(destination)}: the ${
            intent.verb === "git-push" ? "repository being pushed" : "payload's working tree"
          } belongs to a trust boundary (${printOrgs(src.orgs)}) that does not overlap ` +
            `the destination's (${printOrgs(destOrgs)}). This is the boundary both incidents crossed.`,
          printable(destination),
        );
      }
    }

    // ---- f: payload content vs the destination's deny set ------------------
    const scan = opts.scanPayload ?? scanPayloadAgainstDestination;
    for (const file of intent.payloadFiles) {
      if (file === "-") continue;
      let hits: number | null = null;
      try {
        hits = scan(file, destination, base);
      } catch {
        hits = null;
      }
      if (hits !== null && hits > 0) {
        return deny(
          "PAYLOAD_MARKER_HIT",
          `${verb} → ${describeDestination(destination)}: payload file \`${basename(file)}\` matches the ` +
            `destination's deny set (${hits} hit${hits === 1 ? "" : "s"}). Run \`repo-aegis check --path\` ` +
            `on it from the destination repo to see which patterns; nothing is shown here.`,
          printable(destination),
        );
      }
    }
  }

  // ---- g: public destination or irreversible verb needs a person -----------
  const irreversible = VERBS_NEEDING_HUMAN.has(intent.verb);
  const publicFacing = destination?.publicFacing === true;
  if ((publicFacing || irreversible) && !opts.humanPresent) {
    // A person may have declared themselves in advance: a live approval
    // minted at a terminal for this destination (and ref, when scoped).
    // Rule g is the ONLY rule it satisfies — everything above still ran.
    // `*` covers personalOrgs owners and destination-less verbs only (D7). The
    // destination-less flag is explicit and tied to the verb: a null
    // destination on any other verb, or an unresolved `*`/`*` one (GraphQL),
    // is not destination-less.
    const approvalScope = approvalScopeOf(opts.registry, destination === null && intent.verb === "npm-publish");
    let approval: EgressApproval | null = null;
    try {
      approval = (opts.findApproval ?? findApprovalDefault)(destination, intent.refspec, approvalScope);
    } catch {
      approval = null;
    }
    if (approval !== null) {
      const shown = destination && printable(destination);
      return { action: "allow", approval, intent, ...(shown && { destination: shown }) };
    }
    const shownDestination = destination ? printable(destination) : undefined;
    const what =
      destination?.unresolved !== undefined
        ? `UNRESOLVED destination`
        : publicFacing
          ? `PUBLIC destination`
          : `an operation that is hard to undo`;
    const target = intent.verb === "git-push" && intent.refspec ? `${intent.refspec} → ` : "";
    // The destination's name comes from the agent's command line and this hint
    // is text a person pastes: interpolate only a validated name. A name that
    // fails validation gets no approve command at all (see refusal.ts).
    // `approve '*'` is only offered where a `*` approval actually covers the
    // call (destination-less `npm publish`). An unresolved destination, or a
    // null one on another verb, is covered by no approval, so none is offered.
    const approveTarget =
      destination && destination.unresolved === undefined
        ? safeDestination(destination.org, destination.repo)
        : destination === null && approvalScope.destinationless === true
          ? "wildcard"
          : null;
    const approveCommand =
      approveTarget === null
        ? null
        : `repo-aegis approve ${
            approveTarget === "wildcard"
              ? "'*'"
              : approveTarget.repo === "*"
                ? // `*` is a shell glob: quote it, as the global form is.
                  `'${approveTarget.org}/*'`
                : `${approveTarget.org}/${approveTarget.repo}`
          }`;
    // Public only because nothing says private (issue #114): say so, and say
    // how the visibility gets recorded, so the refusal is not a dead end. Not
    // for an unresolved GraphQL target — there is no repository to record.
    const hint =
      publicFacing && destination?.assumedPublic === true && destination.unresolved === undefined
        ? UNKNOWN_VISIBILITY_HINT
        : "";
    // Everything up to and including "A person must approve this"; the three
    // branches below differ only in what a person can do about it here.
    const head =
      `${verb}: ${what} — ${target}${describeDestination(destination)}` +
      (destination?.unresolved !== undefined
        ? ` — the cwd's repository is not its destination`
        : intent.repoFlag !== undefined
          ? ` (from --repo)`
          : destination?.fromCache
            ? ` (from the checkout at ${printablePath(destination.workingTree)})`
            : intent.apiEndpoint !== undefined && destination !== null
              ? ` (from the API path)`
              : "") +
      `, from a non-interactive shell. A person must approve this`;
    // A live `*` approval that exists but does not cover this destination (D7):
    // say exactly that, with the narrower command, so the operator does not
    // conclude the guard is broken (§3.9). Only for a named destination.
    // The sentence is ADDED to the existing message (§3.9: "existing message,
    // plus"), before the visibility hint, so every existing clause stays.
    // The lookup is behind the same injection seam as the finder.
    const gapFinder: UncoveredStarFinder | null =
      opts.findUncoveredStar ??
      (opts.findApproval === undefined || opts.findApproval === findApprovalDefault ? findUncoveredStarDefault : null);
    let starGap = "";
    if (gapFinder !== null && destination !== null && destination.unresolved === undefined) {
      try {
        const uncovered = gapFinder(destination, intent.refspec, approvalScope);
        if (uncovered !== null) {
          starGap = uncoveredStarSentence(destination, uncovered.approval, uncovered.gap, opts.registry);
        }
      } catch {
        starGap = "";
      }
    }
    if (opts.capabilities.ask) {
      // An `ask` is a refusal only if something can still hold the command
      // when the ask is not answered by a person — and on at least one agent
      // host an unanswered `ask` is resolved by a classifier, not a human.
      // For a `gh` verb the layer that holds it is the shim; when the caller
      // reports the shim is not the first `gh` on the PATH this command will
      // run with, nothing below this decision can refuse, so asking would be
      // theatre. Deny instead, with its own code: the operator's fix is a
      // PATH, not a prompt. Scoped to `gh` deliberately — `git push` still
      // has the pre-push hook, which is PATH-independent, and `npm publish`
      // has no shim to be unreachable, so for neither does this PATH fact
      // change what can refuse them.
      if (opts.capabilities.ghShimOnPath === false && intent.verb.startsWith("gh-")) {
        return deny(
          "SHIM_UNREACHABLE_NEEDS_HUMAN",
          `${head}, and in this shell nothing below this hook can hold the command: the \`gh\` shim is not ` +
            `the first \`gh\` on PATH, so an unanswered prompt would let it run. ` +
            (approveCommand === null
              ? `Re-run it from a terminal`
              : `Mint an approval from a terminal (\`${approveCommand}\`) and re-run`) +
            `, or start the agent from a shell where the shim ` +
            `comes first (\`repo-aegis doctor\` says which).` +
            starGap +
            hint,
          shownDestination,
        );
      }
      const reason =
        approveCommand === null
          ? `${head}: re-issue the command naming a valid owner/repo, or run it from a terminal.${starGap}${hint}`
          : `${head}, or mint an approval first: \`${approveCommand}\` from a terminal.${starGap}${hint}`;
      return {
        action: "ask",
        code: "PUBLIC_EGRESS_NEEDS_HUMAN",
        reason,
        ...(shownDestination && { destination: shownDestination }),
        intent,
      };
    }
    return deny(
      "PUBLIC_EGRESS_NEEDS_HUMAN",
      `${head}: re-run it from a terminal, ` +
        (approveCommand === null ? "" : `mint an approval first (\`${approveCommand}\`), `) +
        `or a human sets ${EGRESS_HUMAN_ENV}=1 for this one invocation (an agent never sets it).` +
        starGap +
        hint,
      shownDestination,
    );
  }

  // ---- otherwise: allow ------------------------------------------------------
  return { action: "allow" };
}

/**
 * Decide for a whole command line. Every intent is judged; the most severe
 * decision wins (`deny` over `ask` over `allow`), earliest intent first
 * within a severity. A command with no intents is `allow`.
 */
export function decideEgress(opts: DecideEgressOptions): EgressDecision {
  let ask: EgressDecision | null = null;
  let approved: EgressDecision | null = null;
  for (const intent of opts.intents) {
    const d = decideOne(intent, opts);
    if (d.action === "deny") return d;
    if (d.action === "ask" && ask === null) ask = d;
    if (d.action === "allow" && d.approval !== undefined && approved === null) approved = d;
  }
  return ask ?? approved ?? { action: "allow" };
}

/**
 * The one-line receipt printed after a permitted egress:
 * `PUBLISHED → <org>/<repo> (<visibility>, class <class>): <detail>`.
 * A model that has just pushed to the wrong repository will skim past twenty
 * lines of git output; it will not skim past one line that says PUBLIC and a
 * name it did not intend.
 */
export function formatReceipt(destination: Destination | null, detail: string): string {
  return `PUBLISHED → ${describeDestinationForReceipt(destination)}: ${detail}`;
}
