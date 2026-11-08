// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Which GitHub identity a `gh` call runs as (doc/plan-owner-identity.md §5.2, §13.1).
//
// PURE: no file, environment, process, clock or randomness. The cwd's remote, GH_REPO, the registry, the
// presence verdict, the approvals and the caller's environment all come in as arguments, so the hook, the
// CLI and the credential helper decide with the same code. TOTAL: nothing here throws; an input that cannot
// be judged is a refusal. A reason text never contains a token (this code never sees one) and interpolates
// a destination only through `refusal()`, which discards a name that is not a plausible owner/repo.
import { refusal, type RefusalFix } from "./refusal.js";
import {
  analyseApiEndpoint,
  isGhBuiltinGroup,
  parseRepoRef,
  scanGhCommand,
} from "./egress-intent.js";
import type { Identity, OwnerIdentities, Registry } from "./registry.js";
import type { TerminalCheck } from "./process-ancestry.js";

// ---------------------------------------------------------------------------
// Presence (A1)
// ---------------------------------------------------------------------------

export type IdentityPresence = "person" | "agent" | "unknown";

/**
 * A1. Never reads the environment, and an approval does not count. `clear` → person; `agent` and `no-tty` →
 * agent; `unrooted` and `undeterminable` → unknown. `skipped` (test only) → person. Anything else → unknown.
 */
export function identityPresence(check: TerminalCheck): IdentityPresence {
  switch (check.kind) {
    case "clear":
    case "skipped":
      return "person";
    case "agent":
    case "no-tty":
      return "agent";
    default:
      return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

export interface GhCallTarget {
  owner: string;
  repo: string | null;
  source: "literal" | "gh-repo-env" | "cwd";
}

const BARE_NAME = /^[A-Za-z0-9_.-]+$/;

/** `owner/repo` (or a URL, or `HOST/owner/repo`), or a bare owner as `intentRepoTargets` accepts it; null otherwise. */
function parseTarget(ref: string): { owner: string; repo: string | null } | null {
  const parsed = parseRepoRef(ref);
  if (parsed !== null) return { owner: parsed.org, repo: parsed.repo };
  if (BARE_NAME.test(ref) && ref !== "." && ref !== "..") return { owner: ref.toLowerCase(), repo: null };
  return null;
}

/** The value of the last occurrence of any of `names` (pflag: the last occurrence of a string flag wins). */
function lastFlagValue(flags: readonly { flag: string; value: string | undefined }[], ...names: string[]): string | undefined {
  let out: string | undefined;
  for (const f of flags) if (names.includes(f.flag) && f.value !== undefined) out = f.value;
  return out;
}

const HAS_URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * The owners a gh argv names, for reads as well as writes. In gh's own precedence: `--repo`/`-R` (or a
 * github.com URL argument, a `repos/<o>/<r>/…` or `orgs/<o>/…` api endpoint, `--org`/`-o` of the commands that
 * take one, `repo view <o>/<r>`-style positionals) are literal; with none of those GH_REPO (source
 * `gh-repo-env`); with neither the cwd's remote (source `cwd`), resolved by the caller the way rule h does.
 *
 * A literal that cannot be read (`--repo '$X'`, an opaque api endpoint, an unparsable GH_REPO) yields NO
 * target for its source and no fallback to a lower source: the egress rules refuse such a write, and a read
 * must not be sent as another owner's identity. Aliases are not expanded: an alias is not a built-in group,
 * which `chooseIdentity` refuses when it would inject. Owners are lowercased. Pure; never throws.
 */
export function ghCallTargets(
  args: readonly string[],
  ctx: { ghRepoEnv?: string; cwdRemoteOwnerRepo?: { owner: string; repo: string } },
): GhCallTarget[] {
  try {
    const scan = scanGhCommand(args);
    if (scan === null) return [];
    const out: GhCallTarget[] = [];
    const seen = new Set<string>();
    const add = (t: { owner: string; repo: string | null }, source: GhCallTarget["source"]): void => {
      const owner = t.owner.toLowerCase();
      const repo = t.repo === null ? null : t.repo.toLowerCase();
      const key = `${source}\n${owner}\n${repo ?? ""}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ owner, repo, source });
    };
    let literal = false;
    const literalRef = (ref: string): void => {
      literal = true;
      const t = parseTarget(ref);
      if (t !== null) add(t, "literal");
    };

    const repoFlag = lastFlagValue(scan.flags, "--repo", "-R");
    if (repoFlag !== undefined) literalRef(repoFlag);

    const key = `${scan.group} ${scan.sub ?? ""}`;
    let baseForPlaceholder = false;
    if (scan.group === "api") {
      const endpoint = scan.positionals[0];
      if (endpoint !== undefined) {
        const t = analyseApiEndpoint(endpoint);
        if (t.kind === "named") {
          literal = true;
          add({ owner: t.org, repo: t.repo }, "literal");
        } else if (t.kind === "opaque") {
          literal = true;
        } else if (t.kind === "cwd") {
          baseForPlaceholder = true;
        }
      }
    } else {
      for (const p of scan.positionals) {
        if (HAS_URL_SCHEME.test(p)) {
          const t = parseRepoRef(p);
          if (t !== null) {
            literal = true;
            add({ owner: t.org, repo: t.repo }, "literal");
          }
        }
      }
      // `gh repo view|clone|edit|… <owner>/<repo>`, and the destination of `gh issue transfer <n> <owner>/<repo>`.
      const refIdx = scan.group === "repo" ? 0 : key === "issue transfer" ? 1 : -1;
      const ref = refIdx >= 0 ? scan.positionals[refIdx] : undefined;
      if (ref !== undefined && !HAS_URL_SCHEME.test(ref)) {
        const t = parseRepoRef(ref);
        if (t !== null) {
          literal = true;
          add({ owner: t.org, repo: t.repo }, "literal");
        }
      }
      if (key === "secret set" || key === "secret delete" || key === "variable set" || key === "variable delete" || key === "repo fork") {
        const org = lastFlagValue(scan.flags, "--org", ...(scan.group === "repo" ? [] : ["-o"]));
        if (org !== undefined) {
          literal = true;
          const t = parseTarget(org);
          if (t !== null) add({ owner: t.owner, repo: null }, "literal");
        }
      }
      if (key === "issue develop") {
        const br = lastFlagValue(scan.flags, "--branch-repo");
        if (br !== undefined) literalRef(br);
      }
    }

    // Targets that are in ADDITION to the base repository, so the base is judged too.
    const keepsBase = (key === "issue transfer" || key === "issue develop") && repoFlag === undefined;
    const needsBase = !literal || baseForPlaceholder || keepsBase;
    if (needsBase) {
      if (ctx.ghRepoEnv !== undefined && ctx.ghRepoEnv !== "") {
        const t = parseTarget(ctx.ghRepoEnv);
        if (t !== null) add(t, "gh-repo-env");
      } else if (ctx.cwdRemoteOwnerRepo !== undefined) {
        add({ owner: ctx.cwdRemoteOwnerRepo.owner, repo: ctx.cwdRemoteOwnerRepo.repo }, "cwd");
      }
    }
    return out;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

export type IdentityScope = "read" | "write" | "contents-write";
export type IdentityRefusalCode =
  | "GH_AUTH_NEEDS_HUMAN"
  | "GH_IDENTITY_PRESENCE_UNKNOWN"
  | "GH_IDENTITY_NEEDS_LITERAL_TARGET"
  | "GH_IDENTITY_SEVERAL_OWNERS"
  | "GH_IDENTITY_UNMAPPED_OWNER"
  | "GH_IDENTITY_WRITE_NEEDS_HUMAN"
  | "GH_IDENTITY_TOKEN_SUPPLIED"
  | "GH_IDENTITY_ENV_REDIRECT"
  | "GH_IDENTITY_ARG_UNSAFE"
  | "GH_IDENTITY_UNAVAILABLE";
export type IdentityChoice =
  | { kind: "none"; hint?: string }
  | {
      kind: "inject";
      identity: Identity;
      column: "person" | "agent";
      owner: string;
      repo: string | null;
      scope: IdentityScope;
      compareSuppliedToken: boolean;
      approvalId?: string;
    }
  | { kind: "refuse"; code: IdentityRefusalCode; reason: string };

export interface ChooseIdentityInput {
  args: readonly string[]; // the gh argv
  isWrite: boolean; // the existing parser yields an egress intent for this call
  targets: readonly GhCallTarget[];
  registry: Registry; // from the pinned home only (D8)
  presence: IdentityPresence;
  /** A live approval for org/repo minted for this login, never a '*' approval (A11); returns its id or null. */
  approvalFor: (owner: string, repo: string | null, login: string) => string | null;
  suppliedToken: boolean; // GH_TOKEN or GITHUB_TOKEN set in the caller's environment
  redirect: string | null; // the name of a D9 variable or `http_unix_socket`, if present
  registeredOwner: (owner: string) => boolean;
}

const TERMINAL_FIX: RefusalFix = { by: "person" };
const NO_APPROVAL = "No approval covers this.";

function refuse(
  code: IdentityRefusalCode,
  what: string,
  why: string,
  approval: string,
  fixes: readonly RefusalFix[],
  destination?: { owner: string; repo: string | null },
): IdentityChoice {
  const reason = refusal({
    code,
    ...(destination !== undefined && { destination: { verb: "gh", org: destination.owner, repo: destination.repo ?? "*" } }),
    what,
    why,
    approval,
    fixes,
  });
  return { kind: "refuse", code, reason };
}

/** A10 (rule 1): `gh` commands that read a token or change which account gh acts as. */
function authVerbRefusal(args: readonly string[]): IdentityChoice | null {
  const scan = scanGhCommand(args);
  if (scan === null) return null;
  const { group, sub } = scan;
  let hit = false;
  if (group === "auth") {
    if (sub !== undefined) {
      hit = sub !== "status" || scan.flags.some(f => f.flag === "--show-token" || f.flag === "-t");
    }
  } else if (group === "config") hit = sub === "set" || sub === "clear-cache";
  else if (group === "alias") hit = sub === "set" || sub === "import" || sub === "delete";
  else if (group === "extension") hit = sub === "install" || sub === "upgrade" || sub === "exec";
  if (!hit) return null;
  return refuse(
    "GH_AUTH_NEEDS_HUMAN",
    `gh ${group}`,
    "it reads a token or changes which account or program gh uses, and no person is at this terminal",
    NO_APPROVAL,
    [TERMINAL_FIX],
  );
}

/** A2 (rule 8): arguments that could redirect an injected token. Null when none. */
function unsafeArg(args: readonly string[]): boolean {
  const scan = scanGhCommand(args);
  if (scan === null) return false;
  if (!isGhBuiltinGroup(scan.group)) return true;
  if (scan.flags.some(f => f.flag === "--editor" || f.flag === "-e" || f.flag === "--web" || f.flag === "-w")) return true;
  if (scan.group === "api") {
    if (scan.flags.some(f => f.flag === "--hostname")) return true;
    const endpoint = scan.positionals[0];
    if (endpoint !== undefined && HAS_URL_SCHEME.test(endpoint)) return true;
  }
  return false;
}

function entryOf(registry: Registry, owner: string): OwnerIdentities | undefined {
  const e = registry.identityMap?.get(owner);
  return e !== undefined && (e.person !== undefined || e.agent !== undefined) ? e : undefined;
}

function choose(input: ChooseIdentityInput): IdentityChoice {
  const { args, isWrite, targets, registry, presence } = input;
  // 1. A10.
  if (presence !== "person") {
    const r = authVerbRefusal(args);
    if (r !== null) return r;
  }
  // 2. No target.
  if (targets.length === 0) return { kind: "none" };

  const owners = [...new Set(targets.map(t => t.owner.toLowerCase()))];
  // 3. Several owners, any mapped.
  if (owners.length > 1 && owners.some(o => entryOf(registry, o) !== undefined)) {
    return refuse(
      "GH_IDENTITY_SEVERAL_OWNERS",
      "this gh call",
      "it names several owners and at least one of them has a GitHub identity, so repo-aegis cannot pick the account to run it as",
      NO_APPROVAL,
      [{ by: "agent", command: "one gh call per owner, each naming its repository with --repo <owner>/<repo>" }],
    );
  }
  const owner = owners[0]!;
  const mine = targets.filter(t => t.owner.toLowerCase() === owner);
  const repos = new Set(mine.map(t => t.repo));
  const repo = repos.size === 1 ? [...repos][0]! : null;
  const dest = { owner, repo };
  const entry = entryOf(registry, owner);

  // 4. Unmapped.
  if (entry === undefined) {
    if (registry.requireIdentity === true && isWrite && presence !== "person") {
      const bad = owners.find(o => input.registeredOwner(o));
      if (bad !== undefined) {
        return refuse(
          "GH_IDENTITY_UNMAPPED_OWNER",
          "a gh write",
          "the registry requires every registered owner to have a GitHub identity, and this owner has none",
          NO_APPROVAL,
          [{ by: "person", command: "repo-aegis engagements set-identity <id> --person <name>, or personal-org set-identity for a personal org" }],
          { owner: bad, repo: bad === owner ? repo : null },
        );
      }
    }
    return { kind: "none" };
  }

  // 5. Presence unknown.
  if (presence === "unknown") {
    return refuse(
      "GH_IDENTITY_PRESENCE_UNKNOWN",
      "this gh call",
      "repo-aegis cannot tell whether a person or an agent is running it, so it will not choose between the person's account and the agent's",
      NO_APPROVAL,
      [{ by: "person", step: "runs it from a terminal they opened themselves" }],
      dest,
    );
  }
  // 6. Redirecting environment.
  if (input.redirect !== null) {
    return refuse(
      "GH_IDENTITY_ENV_REDIRECT",
      "this gh call",
      "the environment redirects where gh sends its requests (a proxy, a socket or a host override), which would send the injected token elsewhere",
      NO_APPROVAL,
      [{ by: "agent", command: "the same command with the redirecting variable unset" }],
      dest,
    );
  }
  // 7. A token the caller supplied.
  if (presence === "agent" && input.suppliedToken) {
    return refuse(
      "GH_IDENTITY_TOKEN_SUPPLIED",
      "this gh call",
      "the environment already carries GH_TOKEN or GITHUB_TOKEN, and an agent may not choose which token a call uses",
      NO_APPROVAL,
      [{ by: "agent", command: "the same command with GH_TOKEN and GITHUB_TOKEN unset" }],
      dest,
    );
  }
  // 8. A2 arguments: only the agent column gets a token the agent must not see through an editor, pager or browser.
  if (presence === "agent" && unsafeArg(args)) {
    return refuse(
      "GH_IDENTITY_ARG_UNSAFE",
      "this gh call",
      "its arguments (an editor or browser option, an api host or full-URL endpoint, or a command that is not a built-in gh group) could hand the injected token to another program or host",
      NO_APPROVAL,
      [{ by: "agent", command: "the same call without --editor/-e, --web/-w, --hostname or a full-URL endpoint, using a built-in gh command" }],
      dest,
    );
  }

  const scope: IdentityScope = isWrite ? "write" : "read";
  // 9. A person is present.
  if (presence === "person") {
    if (entry.person === undefined) {
      return { kind: "none", hint: "this owner has only an agent identity, so the active gh account applies while a person is present" };
    }
    return { kind: "inject", identity: entry.person, column: "person", owner, repo, scope, compareSuppliedToken: input.suppliedToken };
  }
  // Presence is `agent` from here.
  // 10. An agent identity exists.
  if (entry.agent !== undefined) {
    if (isWrite && mine.some(t => t.source === "cwd")) {
      return refuse(
        "GH_IDENTITY_NEEDS_LITERAL_TARGET",
        "a gh write",
        "its repository comes from the working directory's remote, and an agent write must name the repository it changes",
        NO_APPROVAL,
        [{ by: "agent", command: "the same command with --repo <owner>/<repo>" }],
        dest,
      );
    }
    return { kind: "inject", identity: entry.agent, column: "agent", owner, repo, scope, compareSuppliedToken: input.suppliedToken };
  }
  // 11. Agent presence, only a person identity.
  const person = entry.person!;
  if (!isWrite) {
    return { kind: "inject", identity: person, column: "person", owner, repo, scope, compareSuppliedToken: input.suppliedToken };
  }
  const approvalId = person.kind === "gh-login" ? input.approvalFor(owner, repo, person.login) : null;
  if (approvalId === null) {
    return refuse(
      "GH_IDENTITY_WRITE_NEEDS_HUMAN",
      "a gh write",
      "it would write as a person's GitHub account, this owner has no agent identity, and no person has approved a write as that account here",
      "Only an approval minted for this owner and repository, for that account, covers this; a '*' approval does not.",
      [{ by: "person", command: "repo-aegis approve <owner>/<repo> (it records the account), or run the original command yourself" }],
      dest,
    );
  }
  return { kind: "inject", identity: person, column: "person", owner, repo, scope, compareSuppliedToken: input.suppliedToken, approvalId };
}

/**
 * The §13.1 decision, rules 1 to 11 in order, the first that applies deciding. Total: a throw from an
 * argument, a registry getter or a callback is a refusal (`GH_IDENTITY_UNAVAILABLE`), never an exception.
 */
export function chooseIdentity(input: ChooseIdentityInput): IdentityChoice {
  try {
    return choose(input);
  } catch {
    return refuse(
      "GH_IDENTITY_UNAVAILABLE",
      "this gh call",
      "repo-aegis could not judge its arguments or the registry safely",
      NO_APPROVAL,
      [{ by: "person", step: "checks the registry with `repo-aegis status` and re-runs the command" }],
    );
  }
}
