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
//      apply. Rules e–h read context that may be missing (an unparseable
//      remote, an unclassified repo, a payload that does not exist); a
//      guardrail must never block on its own inability to determine
//      context — that was the spurious `CROSS_ORG_WRITE` flake
//      (doc/bugs/repo-aegis-check-write-flake.md). Asking is not blocking,
//      so an uncertain destination may still `ask`.
//   2. **Decision-only.** This module returns a decision and a reason; it
//      never returns a rewritten command. Rewriting `git push` into `git
//      push origin <branch>` would rebuild the implicit-destination defect
//      one layer up with the agent's intent still unexamined.
//
// Reasons name the destination (`<org>/<repo>`, visibility, class) and the
// ref or PR — the receipt-before-the-fact a human sees when asked. They
// never carry payload content, matched substrings, or registry entries.

import { basename, isAbsolute } from "node:path";
import { execFileSync } from "node:child_process";
import { readCachedVisibility, type RepoVisibility } from "./egress.js";
import { parseApiEndpoint, type EgressIntent, type EgressVerb } from "./egress-intent.js";
import { resolveCachedDestination } from "./destination-cache.js";
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
  | "PUBLIC_EGRESS_NEEDS_HUMAN";

export interface Destination {
  org: string;
  repo: string;
  class: RepoClass;
  /** From the `repo-aegis.visibility` cache only — never a live probe on this path. */
  visibility: RepoVisibility;
  /** `class === "public-eligible" || visibility === "public"`. */
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
   * True when nothing on this machine describes the destination but its org
   * is in `personalOrgs` — the operator's own org, where the public
   * repositories live. Treated as public-facing so rule g asks rather than
   * lets an unknown personal-org destination through: asking is not
   * blocking, and the alternative is the fail-open the cache exists to close.
   */
  assumedPublic?: boolean;
}

export type EgressDecision =
  | { action: "allow" }
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

export interface DecideEgressOptions {
  intents: EgressIntent[];
  /** Where the command WILL run: the hook payload's cwd, or the shim's `$PWD`. */
  cwd: string;
  registry: Registry;
  /** From {@link isHumanPresent}. */
  humanPresent: boolean;
  /** Does the enforcing framework have an "ask"? A shell does not. */
  capabilities: { ask: boolean };
  resolveDestination?: DestinationResolver;
  scanPayload?: PayloadScanner;
  /** Injectable for tests; defaults to `computeTrustBoundary`. */
  trustBoundaryOf?: (workingTree: string) => TrustBoundary;
}

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
        publicFacing: false,
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
        publicFacing: cached.class === "public-eligible" || cached.visibility === "public",
        classKnown: true,
        fromCache: true,
        workingTree: cached.workingTree,
      };
    }
    if ((registry?.personalOrgs ?? []).some(o => o.toLowerCase() === target.org)) {
      return {
        ...target,
        class: "private-strict",
        visibility: "unknown",
        publicFacing: true,
        classKnown: false,
        assumedPublic: true,
      };
    }
    return {
      ...target,
      class: "private-strict",
      visibility: "unknown",
      publicFacing: false,
      classKnown: false,
    };
  }
  let cfg: RepoConfig;
  try {
    cfg = readRepoConfig(base);
  } catch {
    return { ...target, class: "private-strict", visibility: "unknown", publicFacing: false, classKnown: false };
  }
  const visibility = readCachedVisibility(base);
  return {
    ...target,
    class: cfg.class,
    visibility,
    // The class is a declaration and the cache is only an optimisation:
    // `public-eligible` counts as public-facing even with no cached value.
    publicFacing: cfg.class === "public-eligible" || visibility === "public",
    classKnown: true,
    workingTree: base,
  };
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
  const vis = d.classKnown ? d.visibility : d.assumedPublic ? "visibility uncached, treated as public" : "visibility unknown";
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
  const vis = d.classKnown
    ? d.visibility.toUpperCase()
    : d.assumedPublic
      ? "VISIBILITY UNCACHED, TREATED AS PUBLIC"
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
    if (intent.verb === "git-push") {
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
          } belongs to a trust boundary (${[...src.orgs].sort().join(", ")}) that does not overlap ` +
            `the destination's (${[...destOrgs].sort().join(", ")}). This is the boundary both incidents crossed.`,
          destination,
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
          destination,
        );
      }
    }
  }

  // ---- g: public destination or irreversible verb needs a person -----------
  const irreversible = VERBS_NEEDING_HUMAN.has(intent.verb);
  const publicFacing = destination?.publicFacing === true;
  if ((publicFacing || irreversible) && !opts.humanPresent) {
    const what = publicFacing
      ? `PUBLIC destination`
      : `an operation that is hard to undo`;
    const target = intent.verb === "git-push" && intent.refspec ? `${intent.refspec} → ` : "";
    const reason =
      `${verb}: ${what} — ${target}${describeDestination(destination)}` +
      (intent.repoFlag !== undefined
        ? ` (from --repo)`
        : destination?.fromCache
          ? ` (from the checkout at ${destination.workingTree})`
          : intent.apiEndpoint !== undefined && destination !== null
            ? ` (from the API path)`
            : "") +
      `, from a non-interactive shell. A person must approve this` +
      (opts.capabilities.ask
        ? `.`
        : `: re-run it from a terminal, or a human sets ${EGRESS_HUMAN_ENV}=1 for this one invocation ` +
          `(an agent never sets it).`);
    if (opts.capabilities.ask) {
      return { action: "ask", code: "PUBLIC_EGRESS_NEEDS_HUMAN", reason, ...(destination && { destination }), intent };
    }
    return deny("PUBLIC_EGRESS_NEEDS_HUMAN", reason, destination ?? undefined);
  }

  // ---- h: scratch, and everything else ---------------------------------------
  return { action: "allow" };
}

/**
 * Decide for a whole command line. Every intent is judged; the most severe
 * decision wins (`deny` over `ask` over `allow`), earliest intent first
 * within a severity. A command with no intents is `allow`.
 */
export function decideEgress(opts: DecideEgressOptions): EgressDecision {
  let ask: EgressDecision | null = null;
  for (const intent of opts.intents) {
    const d = decideOne(intent, opts);
    if (d.action === "deny") return d;
    if (d.action === "ask" && ask === null) ask = d;
  }
  return ask ?? { action: "allow" };
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
