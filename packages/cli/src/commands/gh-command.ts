// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `repo-aegis gh --home <pinned home> -- <gh args…>` — what the `gh` PATH shim `exec`s for every `gh` call
// but `--version`, `help` and `completion` (doc/plan-owner-identity.md D1, §13.3).
//
// The IMPERATIVE SHELL around two pure decisions. In order:
//
//   1. the egress decision, exactly as `egress-check` makes it (`evaluateEgress`): the same refusals (exit 2),
//      the same receipts and read-back;
//   2. the identity decision (`chooseIdentity`, core), made from the registry and the approvals under
//      `--home` ONLY (D8: `REPO_AEGIS_HOME`, `REPO_AEGIS_REGISTRY` and the other `REPO_AEGIS_*` variables of
//      the caller are ignored), the presence verdict of `checkTerminal()` (A1) and the caller's environment;
//   3. when it says inject: a token from the identity's source, then the trusted `gh` spawned with an
//      ALLOWLISTED environment plus `GH_TOKEN` (A2). Otherwise the real `gh` runs with the caller's
//      environment unchanged, as it always has.
//
// FAULTS (D4). A mapped WRITE never silently falls back to the active account: any throw between choosing
// and spawning is `GH_IDENTITY_UNAVAILABLE` and `gh` is not run. (P1-I reversed ONE half of D4: a decision record
// that cannot be written no longer stops an inject. The log has a fallback file and doctor reports an unwritable
// one; refusing every identity-mapped call from a sandbox because a log was read-only would be the lockout.) An unmapped call keeps warn-and-run. A mapped
// READ whose identity cannot be produced runs as the active gh account with one warning line naming the code
// and the reason (doc/plan-landscape-recommendations.md U4): a read publishes nothing, and a read that
// stopped for want of a token cost a person a round-trip for no protection. "Read" is the egress parser's
// verdict (no intents), exactly as the rest of this file uses it; a parse fault counts as a write.
//
// THE TOKEN lives in one local variable and in the `gh` child's environment. See `gh-identity-token.ts`.
import { spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { constants as osConstants, homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import {
  appendAuditRecord,
  approvalsPath,
  chooseIdentity,
  describeVerb,
  findAccountBoundApproval,
  findApprovalWithAnyLogin,
  findLoginApproval,
  ghBaseRepo,
  isGhBuiltinGroup,
  ghCallInfo,
  checkTerminal,
  identityPresence,
  loadRegistryState,
  parseEgressIntents,
  egressParseOptions,
  pauseNotice,
  pausePath,
  personLoginOf,
  refusal,
  registeredOwners,
  safeDestination,
  withLogTrailer,
  type DecisionAppendResult,
  type DecisionInput,
  type ChooseIdentityInput,
  type GhCallTarget,
  type EgressIntent,
  type Identity,
  type PauseState,
  type IdentityChoice,
  type IdentityPresence,
  type IdentityScope,
  type Registry,
  type RefusalFix,
  type TerminalCheck,
} from "@de-otio/repo-aegis-core";
import type { OutputOptions } from "../format.js";
import { firstIntentDestination, pauseCoveringIntents, recordPausedAllow } from "../pause-scope.js";
import { buildGhCommand, evaluateEgress, readbackResult, recordedDenyLine, type AllowVerdict, type EgressEvaluation } from "./egress-check.js";
import { recordDecision, verbWords } from "../decision.js";
import { gitSpawnViolation, readCredentialConfig, type ConfigEntry } from "../git-credential-config.js";
import { resolveTrustedGh } from "./doctor-owner-checks.js";
import { fetchLoginToken, ghChildEnv, mintAppToken, runGhAsNobody, tokensEqual } from "./gh-identity-token.js";
import { readPinnedTaaad, type TaaadPin } from "./taaad-pin.js";

export interface GhCommandOptions extends OutputOptions {
  /** The pinned repo-aegis home the shim passes: the ONLY place the registry and the approvals are read from. */
  home?: string;
  cwd?: string;
}

/** Everything a test may replace. None of it is reachable from the command line. */
export interface GhCommandDeps {
  /** The caller's environment. Default: a copy of `process.env` taken before anything is changed. */
  env?: NodeJS.ProcessEnv;
  /** The presence reader. Default: `checkTerminal()` (the real terminal and process tree). */
  terminal?: () => TerminalCheck;
  /** `"permissive"`: skip the location and ownership vetting of the `gh` and the taaad (stubs live in temp directories). */
  trust?: "default" | "permissive";
  /** The pinned taaad. Default: read from the shim under `<home>/bin/gh`. */
  taaad?: TaaadPin | null;
  /** Where this command's own output goes. Default: the process's stdout and stderr. */
  io?: { out: (text: string) => void; err: (text: string) => void };
  /** Replaces the egress decision (a test seam for a fault in it). Default: `evaluateEgress`. */
  evaluate?: (args: string[], cwd: string) => EgressEvaluation;
  /** Capture the `gh` child's output through `io` instead of inheriting the terminal. */
  captureChild?: boolean;
}

/** Variables that would send an injected token to a server or config the person did not choose (D9). */
const REDIRECT_VARS = ["GH_HOST", "GH_CONFIG_DIR", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"] as const;

/** The caller-controlled variables that select where this process reads its registry and approvals from (D8). */
const HOME_SELECTING_VARS = ["REPO_AEGIS_REGISTRY", "REPO_AEGIS_MARKERS_DIR"] as const;

const AUTH_GROUPS = ["auth", "config", "alias", "extension"];

/**
 * One decision record for this run (P1-I), written to the PINNED home's decision log (`gh-decisions.jsonl` is no longer
 * written; `repo-aegis log` still reads it). Never throws, and its result never changes what the shim does: D4's "no
 * unlogged identity use" half is covered by the fallback file and doctor's DECISION_LOG_* codes instead.
 */
function logShim(home: string, record: Pick<DecisionInput, "outcome" | "code" | "destination" | "identityColumn" | "approvalId"> & { verb: string }): DecisionAppendResult {
  return recordDecision({ layer: "shim", host: "unknown", home, ...record, verb: logVerb(record.verb) });
}

/** `gh api (mutating)` as the log's closed verb words: only lower-case words survive (`gh api mutating`). */
function logVerb(verb: string): string {
  return verb.replace(/[^a-z-]+/g, " ").trim();
}

/** A word that is safe to log and print as a verb: lower-case letters and hyphens only. */
function verbWord(word: string | undefined): string | undefined {
  return word !== undefined && /^[a-z][a-z-]{0,30}$/.test(word) ? word : undefined;
}

/** `pr create`, `api`, … : the group (and sub-command for the groups that have one), never a flag value. */
function verbOf(args: readonly string[], intents: readonly EgressIntent[]): string {
  const first = intents[0];
  if (first !== undefined) return describeVerb(first.verb);
  const words = args.filter(a => !a.startsWith("-"));
  const group = verbWord(words[0]);
  if (group === undefined) return "gh";
  const sub = group === "api" ? undefined : verbWord(words[1]);
  return sub === undefined ? `gh ${group}` : `gh ${group} ${sub}`;
}

function destLabel(owner: string, repo: string | null): string {
  const safe = safeDestination(owner, repo ?? "*");
  return safe === null ? "a destination with an invalid owner/repo name" : `${safe.org}/${safe.repo}`;
}

/** The structured refusal line `egress-check` also prints (`{code, error, details}`), so agents see one shape. */
function refusalLine(code: string, reason: string, verb: string): string {
  return JSON.stringify({ code, error: reason, details: { verb } }) + "\n";
}

const NO_APPROVAL = "No approval covers this.";
/** For the refusals about an identity that could not be chosen or a token that could not be minted (rule 4 of the U7 audit). */
const NO_APPROVAL_IDENTITY = "No approval covers this: an approval cannot stand in for an identity that could not be chosen or a token that could not be minted.";

/** A refusal this command builds itself (codes core's `chooseIdentity` does not produce). */
function ownRefusal(
  code: string,
  what: string,
  why: string,
  fixes: readonly RefusalFix[],
  dest?: { owner: string; repo: string | null },
  approval: string = NO_APPROVAL,
): string {
  return refusal({
    code,
    ...(dest !== undefined && { destination: { verb: "gh", org: dest.owner, repo: dest.repo ?? "*" } }),
    what,
    why,
    approval,
    fixes,
  });
}

/**
 * The approval line of the repository-git-setting refusal (U5): an account-bound approval covers it. Only an
 * approval minted by a person for an owner with a mapped GitHub account carries a login; an approval without
 * one, a `*` approval and an expired one do not cover it.
 */
const SETTING_APPROVAL =
  "No approval covers this yet. An account-bound approval does: a person runs `repo-aegis approve <owner>/<repo>` " +
  "(or `<owner>/*`) from a terminal, for an owner with a mapped GitHub account, and the same call then runs " +
  "for the life of that approval. A `*` approval, one with no recorded account and one recorded for an account " +
  "the owner is no longer mapped to do not.";

/**
 * The fix line for a repository git setting refused as GH_IDENTITY_ARG_UNSAFE. A person runs it; an agent never does.
 * Only a key repo-aegis itself names (`core.*` or `http.*`, from gitSpawnViolation's fixed phrases) in the
 * repository's own scope becomes a command, so nothing from the repository's configuration is interpolated into
 * text a person is told to paste. Any other hit (a `url.<base>.insteadOf` rewrite, a credential helper, a remote's
 * proxy, a worktree or command scope) gets a step that says where to look.
 */
function settingFix(hit: string): RefusalFix {
  const m = /^(core\.[A-Za-z]+|http\.[A-Za-z]+) (?:is|are) (?:set|off) in local scope$/.exec(hit);
  if (m !== null) {
    return {
      by: "person",
      command: `git config --local --unset-all ${m[1]!}`,
      note: `it only stops that setting applying to this checkout, so read its value first with \`git config --local --get-all ${m[1]!}\``,
    };
  }
  return {
    by: "person",
    step: "finds the setting with `git config --list --show-origin` and removes it from the file it names (it only stops applying to this checkout or account, so read its value first)",
  };
}

/** `core.hooksPath (local scope)` out of gitSpawnViolation's phrase `core.hooksPath is set in local scope`; the phrase itself when it has another shape. */
function settingOf(hit: string): string {
  const m = /^(.*?) (?:is|are) set in (\w+) scope$/.exec(hit);
  return m === null ? hit : `${m[1]!} (${m[2]!} scope)`;
}

/**
 * Is this entry a repo-LOCAL `core.hooksPath` that points at the directory `install hooks` writes under the
 * pinned home (`<home>/hooks`)? `install hooks --local` writes exactly that, and the same value is usually
 * already set globally, so judging it "a program the agent could run" refuses repo-aegis's own configuration
 * (U1). Compared by realpath, so a symlink or a trailing slash is the same directory; a relative value is not
 * accepted (git resolves it against a directory this check does not know). Any other value, and every other
 * key, is still judged by `gitSpawnViolation`. `~/` is expanded as git does for a path-typed value.
 */
export function isOwnHooksPath(entry: ConfigEntry, home: string, env: NodeJS.ProcessEnv): boolean {
  if (entry.key !== "core.hookspath" || entry.scope !== "local" || entry.value === null || entry.value === "") return false;
  let value = entry.value;
  if (value === "~" || value.startsWith("~/")) value = join(env["HOME"] ?? homedir(), value.slice(1));
  if (!isAbsolute(value)) return false;
  return canonical(value) === canonical(join(home, "hooks"));
}

// ---------------------------------------------------------------------------
// Locating the real gh
// ---------------------------------------------------------------------------

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * The `gh` the shim would run: the first executable `gh` on PATH that is neither in the shim's own directory
 * nor the shim itself. The same scan the shim script makes (relative and empty entries included: that is what
 * `gh` does today for a caller who runs it without the shim), for the call that injects nothing.
 */
export function findPlainGh(pathValue: string | undefined, home: string): string | null {
  if (pathValue === undefined || pathValue === "") return null;
  const shimDir = canonical(join(home, "bin"));
  for (const entry of pathValue.split(delimiter)) {
    const dir = entry === "" ? "." : entry;
    const candidate = join(dir, "gh");
    try {
      const st = statSync(candidate);
      if (!st.isFile() || (st.mode & 0o111) === 0) continue;
    } catch {
      continue;
    }
    if (canonical(resolve(dir)) === shimDir) continue;
    return candidate;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The shell
// ---------------------------------------------------------------------------

type IdentityOutcome =
  | { kind: "plain"; hint?: string; note?: string }
  | { kind: "refuse"; code: string; reason: string; logged?: DecisionAppendResult["written"] }
  | {
      kind: "inject";
      ghPath: string;
      env: NodeJS.ProcessEnv;
      label: string;
    };

/** A registry with nothing in it, for the verb-only rules when the real one is missing or unreadable. */
const NO_REGISTRY: Registry = { engagements: [], alwaysBlock: [] };

/**
 * Verbs whose gh runs `git` in the working directory or clones (H1): `pr checkout`, `pr create`, `repo sync`,
 * `repo clone`, `gist clone`, `repo fork --clone`, `issue develop --checkout`. Judged by the first two words.
 */
function spawnsGitHere(args: readonly string[]): boolean {
  const words = args.filter(a => !a.startsWith("-"));
  const key = `${words[0] ?? ""} ${words[1] ?? ""}`;
  if (["pr checkout", "pr create", "repo sync", "repo clone", "gist clone"].includes(key)) return true;
  if (key === "repo fork") return args.some(a => a === "--clone" || a.startsWith("--clone="));
  if (key === "issue develop") return args.some(a => a === "--checkout" || a === "-c" || a.startsWith("--checkout="));
  return false;
}

/**
 * The registry in the pinned home, by the one core loader. `none` (with a note when it is encrypted: repo-aegis
 * runs as if there were no registry); `unreadable` for a file that does not parse or a newer schema.
 */
function loadPinnedRegistry(
  home: string,
): { kind: "none"; note?: string } | { kind: "unreadable" } | { kind: "ok"; registry: Registry } {
  const load = loadRegistryState(join(home, "engagements.yaml"));
  switch (load.state) {
    case "loaded":
      return { kind: "ok", registry: load.registry };
    case "missing":
      return { kind: "none" };
    case "encrypted":
      return { kind: "none", note: "the registry is encrypted, so repo-aegis ran as if there were none and no GitHub identity was chosen" };
    case "unparseable":
    case "newer-schema":
      return { kind: "unreadable" };
  }
}

function firstSet(env: NodeJS.ProcessEnv, names: readonly string[]): string | null {
  for (const n of names) if ((env[n] ?? "") !== "") return n;
  return null;
}

/**
 * Steps 2 and 3: choose, and when injecting obtain the token and build the child's environment. Pure of
 * output: the caller prints. Throws are the caller's to map (D4).
 */
function decideIdentity(
  args: readonly string[],
  home: string,
  cwd: string,
  callerEnv: NodeJS.ProcessEnv,
  intents: readonly EgressIntent[] | null,
  deps: GhCommandDeps,
  state: { mapped: boolean },
): IdentityOutcome {
  const trust = deps.trust ?? "default";
  const verb = verbOf(args, intents ?? []);
  const loaded = loadPinnedRegistry(home);
  const presenceOf = (): IdentityPresence => identityPresence((deps.terminal ?? (() => checkTerminal()))());
  // Rule 1 (A10) and the alias/extension rule: verbs that read or change tokens, or that could expand to one.
  const firstWord = args.find(a => !a.startsWith("-"));
  const authVerb = args.some(a => AUTH_GROUPS.includes(a));
  const aliasLike = firstWord !== undefined && !isGhBuiltinGroup(firstWord);

  const presenceMemo: { v?: IdentityPresence } = {};
  const presence = (): IdentityPresence => (presenceMemo.v ??= presenceOf());
  const registry: Registry | null = loaded.kind === "ok" ? loaded.registry : null;
  const hasMapping = registry !== null && ((registry.identityMap?.size ?? 0) > 0 || registry.requireIdentity === true);

  // Rule 1 (A10) and the alias rule are about the VERB, so they apply whatever the registry: missing, unreadable
  // or with nothing mapped (M1). Cheap pre-check first: the presence reader may read the process table.
  // An alias or extension is judged only where an identity could be injected (a mapping exists): with none,
  // nothing is at stake, and refusing every extension for every unregistered user would break them.
  if (authVerb || (aliasLike && hasMapping)) {
    const first = chooseIdentity(baseInput(args, intents, [], registry ?? NO_REGISTRY, presence(), home, callerEnv));
    if (first.kind === "refuse") return refuseOutcome(first, home, verb);
  }
  if (loaded.kind === "none") return { kind: "plain", ...(loaded.note !== undefined && { note: loaded.note }) };

  // Targets: the cwd's remote is read only when the argv would use it.
  const ghRepoEnv = callerEnv["GH_REPO"];
  // `isWrite` is the egress parser's verdict: a graphql read gets no base target (core decides with it).
  const isWrite = intents === null ? true : intents.length > 0;
  const ctxBase = { isWrite, ...(ghRepoEnv !== undefined && ghRepoEnv !== "" && { ghRepoEnv }) };
  const targetsInfo = (): ReturnType<typeof ghCallInfo> => {
    const probe = ghCallInfo(args, { ...ctxBase, cwdRemoteOwnerRepo: { owner: "cwd-probe", repo: "cwd-probe" } });
    let found = ghCallInfo(args, ctxBase);
    if (probe.targets.some(t => t.source === "cwd")) {
      const plain = intents?.[0]?.ghPlainBase === true;
      const base = ghBaseRepo(cwd, plain);
      if (base.kind === "repo") {
        found = ghCallInfo(args, { ...ctxBase, cwdRemoteOwnerRepo: { owner: base.org, repo: base.repo } });
      }
    }
    return found;
  };

  if (loaded.kind === "unreadable") {
    // The registry says which owners are mapped, and it cannot be read. A person at a terminal runs as
    // themselves (doctor reports REGISTRY_UNREADABLE); with nobody present, a call that names an owner (literal,
    // GH_REPO or the cwd's remote) is refused (M1). A call that names none is not about an owner.
    if (presence() === "person") return { kind: "plain", note: "the registry could not be read, so no GitHub identity was chosen" };
    const named = targetsInfo();
    if (named.targets.length === 0 && !named.foreignHost) return { kind: "plain" };
    return refuseUnavailable("the registry in the pinned home could not be read (it does not parse or validate, or a newer repo-aegis wrote it; repo-aegis did not change it), so repo-aegis cannot tell whether this owner has a GitHub identity", verb, home, isWrite);
  }
  if (!hasMapping) return { kind: "plain" };

  const info = targetsInfo();
  const targets = info.targets;
  const foreignHost = info.foreignHost;

  const input: ChooseIdentityInput = { ...baseInput(args, intents, targets, registry!, presence(), home, callerEnv), foreignHost };
  let choice = chooseIdentity(input);
  /** U5: the approval that covered a repository git setting, to be printed and recorded with the injection. */
  let covered: { id: string; setting: string } | undefined;
  if (choice.kind === "inject") {
    state.mapped = true;
    // M5: without the egress parse nobody knows what this call publishes; an agent's call for a mapped owner
    // does not proceed on a guess. A person at a terminal keeps warn-and-run.
    if (intents === null && presence() !== "person") {
      return refuseUnavailable("the egress decision for this call could not be made (the command line could not be taken apart; nothing repo-aegis wrote caused it), so repo-aegis will not run it as a mapped identity", verb, home, isWrite, choice);
    }
    // H1: for the agent column, the repository's own git configuration is judged before a token is minted, for
    // the verbs whose gh spawns git in this directory.
    if (presence() === "agent" && spawnsGitHere(args)) {
      // Read as the CHILD would: without the caller's GIT_CONFIG_* (the child gets its own, fixed ones).
      const readEnv: NodeJS.ProcessEnv = {};
      for (const [k, v] of Object.entries(callerEnv)) {
        if (k === "GIT_CONFIG_COUNT" || k === "GIT_CONFIG_PARAMETERS" || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(k)) continue;
        readEnv[k] = v;
      }
      const entries = readCredentialConfig(cwd, readEnv);
      // U1: repo-aegis's own pinned hooks directory, set repo-locally by `install hooks --local`, is not a
      // setting that could run a program of the agent's choosing.
      const judged = entries === null ? null : entries.filter(e => !isOwnHooksPath(e, home, readEnv));
      const hit = judged === null ? "the git configuration could not be read" : gitSpawnViolation(judged, { path: null }, {});
      if (hit !== null) {
        // U5: an account-bound approval for this owner/repo, within its lifetime, covers the refusal. The shape,
        // cross-org and payload rules were decided above and still apply. A configuration git could not read is
        // not a setting an approval can vouch for, so it is never covered.
        // It must be bound to the login the owner's person identity has NOW: an approval minted before that
        // identity was re-mapped covers nothing, and an owner with no person login has nothing to bind to.
        const boundLogin = personLoginOf(registry!, choice.owner);
        const covering =
          judged === null || boundLogin === null
            ? null
            : findAccountBoundApproval({ org: choice.owner, repo: choice.repo ?? "*" }, boundLogin, approvalsPath(home));
        if (covering === null) {
          return refuseOutcome(
            {
              kind: "refuse",
              code: "GH_IDENTITY_ARG_UNSAFE",
              reason: ownRefusal(
                "GH_IDENTITY_ARG_UNSAFE",
                "this gh call",
                judged === null
                  ? "it runs git in this directory with a token, and the git configuration could not be read (an unreadable or corrupt config file, or git failing to start), so repo-aegis cannot rule out a setting that runs a program or sends the token elsewhere"
                  : `it runs git in this directory with a token, and ${hit}, which could run a program or send the token elsewhere; repo-aegis did not set it (its own hooks directory, written by \`install hooks --local\`, is exempt)`,
                judged === null
                  ? [
                      { by: "agent", command: "the same call from a checkout whose git configuration can be read" },
                      { by: "person", command: "git config --list --show-origin", note: "it shows which file fails to read; repair or remove that file" },
                    ]
                  : [
                      { by: "agent", command: "the same call from a checkout whose local git configuration sets none of core.hooksPath, core.fsmonitor, core.sshCommand, url.*.insteadOf or credential.helper" },
                      settingFix(hit),
                      { by: "person", command: "repo-aegis approve <owner>/<repo>", note: "account-bound: it covers this setting for the approval's lifetime, without changing the configuration" },
                    ],
                choice,
                judged === null
                  ? "No approval covers this: a git configuration that could not be read is not something an approval can vouch for."
                  : SETTING_APPROVAL,
              ),
            },
            home,
            verb,
          );
        }
        covered = { id: covering.id, setting: settingOf(hit) };
      }
    }
    // D9 second half, only for a call that will inject: the trusted gh's own config. Needs the trusted gh anyway.
    const trusted = resolveTrustedGh({ ...callerEnv, REPO_AEGIS_HOME: home }, trust);
    if (trusted.kind === "skip") {
      return refuseOutcome(
        {
          kind: "refuse",
          code: "GH_BINARY_UNTRUSTED",
          reason: ownRefusal(
            "GH_BINARY_UNTRUSTED",
            "this gh call",
            `there is no gh repo-aegis may hand a token (${trusted.reason}); repo-aegis did not put that gh there, it only refuses to trust it`,
            [{ by: "person", command: "repo-aegis doctor", note: "it names which gh is first on PATH and why it is untrusted; then put a package-manager gh (for example Homebrew's) first, or install gh into a root-owned directory" }],
            choice,
            "No approval covers this: an approval cannot make a gh binary trustworthy.",
          ),
        },
        home,
        verb,
      );
    }
    const socket = runGhAsNobody(trusted.path, ["config", "get", "http_unix_socket"], callerEnv, trust);
    if (socket === null) {
      return refuseUnavailable("gh's http_unix_socket setting could not be read (the trusted gh failed to run `gh config get`; repo-aegis did not set it)", verb, home, isWrite, choice);
    }
    if (socket.trim() !== "") {
      choice = chooseIdentity({ ...input, redirect: "http_unix_socket" });
      if (choice.kind !== "inject") return refuseOutcome(choice, home, verb);
    }
    const injected = inject(choice, trusted.path, home, callerEnv, verb, isWrite, trust, deps, covered);
    // U5: say, once and where the person will see it, that an approval let this call past a git setting.
    if (covered !== undefined && injected.kind === "inject") {
      return { ...injected, label: `repo-aegis: approval ${covered.id} covers ${covered.setting} for ${destLabel(choice.owner, choice.repo)}\n${injected.label}` };
    }
    return injected;
  }
  if (choice.kind === "refuse") return refuseOutcome(choice, home, verb);
  return { kind: "plain", ...(choice.hint !== undefined && { hint: choice.hint }) };

  function baseInput(
    a: readonly string[],
    its: readonly EgressIntent[] | null,
    tg: readonly GhCallTarget[],
    reg: Registry,
    presence: IdentityPresence,
    h: string,
    env: NodeJS.ProcessEnv,
  ): ChooseIdentityInput {
    const owners = registeredOwners(reg);
    return {
      args: a,
      // A parse fault leaves no intents: judge it as a write (the stricter reading).
      isWrite: its === null ? true : its.length > 0,
      targets: tg,
      registry: reg,
      presence,
      approvalFor: (owner, repo, login) =>
        findLoginApproval({ org: owner, repo: repo ?? "*" }, login, approvalsPath(h))?.id ?? null,
      // Explanation only: an approval with ANY login, so a refusal can say it is bound to another account.
      boundApprovalFor: (owner, repo) => findApprovalWithAnyLogin({ org: owner, repo: repo ?? "*" }, approvalsPath(h))?.id ?? null,
      suppliedToken: (env["GH_TOKEN"] ?? "") !== "" || (env["GITHUB_TOKEN"] ?? "") !== "",
      redirect: firstSet(env, REDIRECT_VARS),
      registeredOwner: o => owners.has(o.toLowerCase()),
    };
  }
}

/** A refusal with any code: core's `IdentityRefusalCode`s plus the ones only this command produces. */
interface Refusal {
  kind: "refuse";
  code: string;
  reason: string;
}

function refuseOutcome(choice: IdentityChoice | Refusal, home: string, verb: string): IdentityOutcome {
  if (choice.kind !== "refuse") return { kind: "plain" };
  // Written first, so the trailer the caller puts on the printed reason says what happened.
  const written = logShim(home, { outcome: "refuse", verb, code: choice.code }).written;
  return { kind: "refuse", code: choice.code, reason: choice.reason, logged: written };
}

/**
 * U4: a READ whose identity cannot be produced runs as the active gh account, with one warning line that names
 * the code and the reason. No token of any kind is attached: this is the "plain" outcome the unmapped-owner
 * path already has, so a read can never carry a minted App token through here. The decision log records that
 * the fallback happened (best effort, like a refusal's record).
 */
function readFallback(why: string, verb: string, home: string): IdentityOutcome {
  logShim(home, { outcome: "fallback", verb, code: "GH_IDENTITY_UNAVAILABLE" });
  return { kind: "plain", note: `GH_IDENTITY_UNAVAILABLE: ${why}, so this read runs as the active gh account` };
}

/** `GH_IDENTITY_UNAVAILABLE` for a write (refused, D4); for a read, {@link readFallback}. */
function refuseUnavailable(
  why: string,
  verb: string,
  home: string,
  isWrite: boolean,
  dest?: { owner: string; repo: string | null },
): IdentityOutcome {
  if (!isWrite) return readFallback(why, verb, home);
  return refuseOutcome(
    {
      kind: "refuse",
      code: "GH_IDENTITY_UNAVAILABLE",
      reason: ownRefusal(
        "GH_IDENTITY_UNAVAILABLE",
        "this gh call",
        why,
        [{ by: "person", command: "repo-aegis doctor", note: "it reports the registry and the mapped account (`repo-aegis status` shows the mapping); then re-run the command" }],
        dest,
        NO_APPROVAL_IDENTITY,
      ),
    },
    home,
    verb,
  );
}

/** The token and the child environment for an inject choice; every failure is a refusal (D4). */
function inject(
  choice: Extract<IdentityChoice, { kind: "inject" }>,
  ghPath: string,
  home: string,
  callerEnv: NodeJS.ProcessEnv,
  verb: string,
  isWrite: boolean,
  trust: "default" | "permissive",
  deps: GhCommandDeps,
  covered?: { id: string; setting: string },
): IdentityOutcome {
  const { identity, owner, repo, scope } = choice;
  const dest = { owner, repo };
  const mint = obtainToken(identity, owner, repo, scope, ghPath, callerEnv, trust, deps, home);
  if (mint.kind === "refuse") {
    // U4: only the "could not produce an identity" code, and only for a read. A mismatch, an untrusted binary or
    // a writable taaad is a finding about the identity itself, not a missing one, and still refuses.
    if (!isWrite && mint.code === "GH_IDENTITY_UNAVAILABLE") return readFallback(mint.why, verb, home);
    return refuseOutcome({ kind: "refuse", code: mint.code, reason: mint.reason(dest) }, home, verb);
  }
  const token = mint.token;
  if (choice.compareSuppliedToken) {
    // N7, the person path: a token the caller brought must be exactly the mapped login's (D6 of the parked plan).
    const supplied = ["GH_TOKEN", "GITHUB_TOKEN"].map(n => callerEnv[n] ?? "").filter(v => v !== "");
    if (identity.kind !== "gh-login" || supplied.some(s => !tokensEqual(s, token))) {
      return refuseOutcome(
        {
          kind: "refuse",
          code: "GH_IDENTITY_TOKEN_MISMATCH",
          reason: ownRefusal(
            "GH_IDENTITY_TOKEN_MISMATCH",
            "this gh call",
            "the environment carries a GH_TOKEN or GITHUB_TOKEN that is not the token of the GitHub account mapped to this owner",
            [{ by: "agent", command: "the same command with GH_TOKEN and GITHUB_TOKEN unset" }],
            dest,
          ),
        },
        home,
        verb,
      );
    }
  }
  const env = ghChildEnv(callerEnv, ghPath, trust, token);
  // D6, A15: the record is written BEFORE the call, whatever the audit log's setting, and never holds the token (nor the
  // login: the identity COLUMN is recorded). P1-I reversed D4 here: failing to write it no longer stops the call.
  logShim(home, {
    outcome: "inject",
    verb,
    destination: { org: owner, repo: repo ?? "*" },
    identityColumn: choice.column,
    ...(choice.approvalId !== undefined && { approvalId: choice.approvalId }),
  });
  if (covered !== undefined) {
    // U5: also the audit log (when enabled), under the action every approval use is recorded as. Ids and the
    // setting's name only.
    try {
      appendAuditRecord({
        action: "egress-approval-use",
        details: { id: covered.id, layer: "gh shim", covers: covered.setting, destination: destLabel(owner, repo), verb },
      });
    } catch {
      /* audit must not block the allow */
    }
  }
  return { kind: "inject", ghPath, env, label: `repo-aegis: as ${identity.name} (${identity.kind}) for ${destLabel(owner, repo)}\n` };
}

type TokenOutcome =
  | { kind: "token"; token: string }
  | { kind: "refuse"; code: string; why: string; reason: (dest: { owner: string; repo: string | null }) => string };

function obtainToken(
  identity: Identity,
  owner: string,
  repo: string | null,
  scope: IdentityScope,
  ghPath: string,
  callerEnv: NodeJS.ProcessEnv,
  trust: "default" | "permissive",
  deps: GhCommandDeps,
  home: string,
): TokenOutcome {
  const unavailable = (why: string): TokenOutcome => ({
    kind: "refuse",
    code: "GH_IDENTITY_UNAVAILABLE",
    why,
    reason: dest =>
      ownRefusal("GH_IDENTITY_UNAVAILABLE", "this gh call", why, [
        { by: "person", command: "repo-aegis doctor", note: "it reports why the mapped account cannot be used; then re-run the command" },
      ], dest, NO_APPROVAL_IDENTITY),
  });
  if (identity.kind === "gh-login") {
    const token = fetchLoginToken(ghPath, identity.login, callerEnv, trust);
    return token === null ? unavailable("the mapped GitHub account has no usable token on this machine") : { kind: "token", token };
  }
  const minted = mintAppToken({
    pin: deps.taaad !== undefined ? deps.taaad : readPinnedTaaad(home),
    slug: identity.app,
    owner,
    repo,
    scope,
    callerEnv,
    trust,
  });
  if (minted.ok) return { kind: "token", token: minted.token };
  const f = minted.failure;
  const fixes: readonly RefusalFix[] =
    f.code === "GH_IDENTITY_INSTALLATION_MISMATCH"
      ? [{ by: "person", command: "repo-aegis status", note: "it shows which App the registry maps to this owner; that App must be installed on the owner's own account" }]
      : f.code === "GH_IDENTITY_UNAVAILABLE"
        ? [{ by: "person", command: "repo-aegis doctor", note: "it reports why a token cannot be minted; then re-run the command" }]
        : [{ by: "person", step: "installs taaad v0.6.0 or later and re-runs `repo-aegis install shim` (repo-aegis pins taaad only at that step, so none is pinned yet or the pin was removed)" }];
  return { kind: "refuse", code: f.code, why: f.why, reason: dest => ownRefusal(f.code, "this gh call", f.why, fixes, dest, NO_APPROVAL_IDENTITY) };
}

// ---------------------------------------------------------------------------
// Running gh
// ---------------------------------------------------------------------------

interface RunResult {
  status: number;
  /** gh's stdout, when it was captured (the read-back needs the PR URL it printed). */
  stdout: string;
}

function signalStatus(signal: NodeJS.Signals | null): number {
  const n = signal === null ? undefined : (osConstants.signals as Record<string, number>)[signal];
  return 128 + (n ?? 1);
}

function spawnGh(
  ghPath: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  captureStdout: boolean,
  deps: GhCommandDeps,
  io: { out: (t: string) => void; err: (t: string) => void },
): RunResult {
  const capture = deps.captureChild === true;
  const res = spawnSync(ghPath, [...args], {
    env,
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    // The terminal is inherited so gh keeps its colours, prompts and pager decisions; stdout is piped only when
    // the caller needs the PR URL for the read-back (today's `| tee`).
    stdio: [capture ? "ignore" : "inherit", capture || captureStdout ? "pipe" : "inherit", capture ? "pipe" : "inherit"],
  });
  const stdout = typeof res.stdout === "string" ? res.stdout : "";
  if (capture || captureStdout) io.out(stdout);
  if (capture && typeof res.stderr === "string") io.err(res.stderr);
  if (res.error !== undefined) {
    io.err(`repo-aegis: could not run gh: ${(res.error as NodeJS.ErrnoException).code ?? "error"}\n`);
    return { status: 127, stdout };
  }
  return { status: res.status ?? signalStatus(res.signal), stdout };
}

/**
 * Run `repo-aegis gh`. Returns the exit status the process should end with; never calls `process.exit`
 * itself (the command wrapper does), so tests can run it in-process.
 */
export function runGhCommand(args: string[], opts: GhCommandOptions, deps: GhCommandDeps = {}): number {
  const io = deps.io ?? { out: (t: string) => void process.stdout.write(t), err: (t: string) => void process.stderr.write(t) };
  const callerEnv: NodeJS.ProcessEnv = deps.env ?? { ...process.env };
  if (opts.home === undefined || opts.home === "" || !isAbsolute(opts.home)) {
    io.err(refusalLine("USAGE", "repo-aegis gh needs --home <absolute path of the pinned repo-aegis home> (the shim passes it)", "gh"));
    return 2;
  }
  const home = opts.home;
  const cwd = opts.cwd ?? process.cwd();

  // D8: from here on every reader that defaults to the environment reads the PINNED home. Restored on the way
  // out so an in-process caller (a test) is not changed.
  const saved: Record<string, string | undefined> = {};
  for (const k of ["REPO_AEGIS_HOME", ...HOME_SELECTING_VARS]) saved[k] = process.env[k];
  process.env["REPO_AEGIS_HOME"] = home;
  for (const k of HOME_SELECTING_VARS) delete process.env[k];
  try {
    return runPinned(args, home, cwd, callerEnv, deps, io);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** The pause covering this call (and the intents parsed for it, null on a parse fault), or null. */
function pausedGhRun(args: readonly string[], cwd: string, home: string): { pause: PauseState; intents: EgressIntent[] | null } | null {
  try {
    const path = pausePath(home);
    let intents: EgressIntent[] | null = null;
    try {
      intents = parseEgressIntents(buildGhCommand([...args]), egressParseOptions(process.env, cwd));
    } catch {
      intents = null; // a parse fault: a machine-wide pause still covers the call; a scoped one cannot say where it goes
    }
    const pause = pauseCoveringIntents(intents ?? [], cwd, { path });
    return pause === null ? null : { pause, intents };
  } catch {
    return null;
  }
}

function runPinned(
  args: string[],
  home: string,
  cwd: string,
  callerEnv: NodeJS.ProcessEnv,
  deps: GhCommandDeps,
  io: { out: (t: string) => void; err: (t: string) => void },
): number {
  // P1-E: a person's emergency pause (read from the pinned home). In scope, the egress decision is not made at all,
  // and a refusal of the identity step below becomes a plain run as the caller; the intents are still parsed, for
  // the identity step and to say where the call goes. Verbs that read or change tokens and gh's own config
  // (`auth`, `config`, `alias`, `extension`) are identity surface, and keep their refusal: a pause never lets an
  // agent read the person's token.
  const paused = pausedGhRun(args, cwd, home);

  // 1. The egress decision, as `egress-check` makes it.
  let verdict: AllowVerdict | null = null;
  let intents: EgressIntent[] | null = null;
  if (paused !== null) {
    io.err(`${pauseNotice(paused.pause)}\n`);
    intents = paused.intents;
    recordPausedAllow("shim", {
      pause: paused.pause,
      verb: intents !== null && intents[0] !== undefined ? verbWords(intents[0].verb) : "gh",
      destination: intents === null ? null : firstIntentDestination(intents, cwd),
      home,
    });
  } else {
    try {
      const ev = (deps.evaluate ?? evaluateEgress)(args, cwd);
      if (ev.kind === "deny") {
        io.err(recordedDenyLine(ev, home));
        return 2;
      }
      if (ev.kind === "fault") {
        io.err(`repo-aegis gh: the egress decision failed (${ev.message}); proceeding\n`);
      } else {
        verdict = ev.verdict;
        intents = ev.intents;
      }
    } catch (err) {
      io.err(`repo-aegis gh: the egress decision failed (${(err as Error).message}); proceeding\n`);
    }
  }

  // 2 and 3. The identity.
  const state = { mapped: false };
  let outcome: IdentityOutcome;
  try {
    outcome = decideIdentity(args, home, cwd, callerEnv, intents, deps, state);
  } catch {
    // D4: a fault on a mapped WRITE is never a call as the active account; an unmapped one keeps today's
    // behaviour. U4: a mapped READ (a parsed call with no intents) runs plain, with the warning line.
    const isWrite = intents === null || intents.length > 0;
    outcome = state.mapped && !isWrite
      ? readFallback("repo-aegis faulted while preparing the GitHub identity for a mapped owner", verbOf(args, intents ?? []), home)
      : state.mapped
      ? {
          kind: "refuse",
          code: "GH_IDENTITY_UNAVAILABLE",
          logged: logShim(home, { outcome: "refuse", verb: verbOf(args, intents ?? []), code: "GH_IDENTITY_UNAVAILABLE" }).written,
          reason: ownRefusal("GH_IDENTITY_UNAVAILABLE", "this gh call", "repo-aegis hit an internal error while preparing the GitHub identity for a mapped owner (not a setting you made, and not one repo-aegis wrote), and will not run it as the active account", [
            { by: "person", command: "repo-aegis doctor", note: "it reports whether the registry and the mapped account are usable; then re-run the command" },
          ], undefined, NO_APPROVAL_IDENTITY),
        }
      : { kind: "plain", note: "repo-aegis faulted while choosing a GitHub identity" };
  }

  // The refusals a pause never converts: verbs that read or change tokens and gh's config, and running an alias or an
  // extension (a name that is not a gh command: it can expand to anything, with the mapped token in its environment).
  const firstWord = args.find(a => !a.startsWith("-"));
  const aliasLike = firstWord !== undefined && !isGhBuiltinGroup(firstWord);
  if (outcome.kind === "refuse" && paused !== null && !aliasLike && !args.some(a => AUTH_GROUPS.includes(a))) outcome = { kind: "plain" };
  if (outcome.kind === "refuse") {
    io.err(refusalLine(outcome.code, outcome.logged === undefined ? outcome.reason : withLogTrailer(outcome.reason, outcome.logged), verbOf(args, intents ?? [])));
    return 2;
  }

  let ghPath: string;
  let env: NodeJS.ProcessEnv;
  if (outcome.kind === "inject") {
    ghPath = outcome.ghPath;
    env = outcome.env;
    io.err(outcome.label);
  } else {
    const plain = findPlainGh(callerEnv["PATH"], home);
    if (plain === null) {
      io.err("repo-aegis shim: real gh not found on PATH\n");
      return 127;
    }
    ghPath = plain;
    env = callerEnv;
    // P1-I: a call that parsed as an egress shape and ran as the caller is a decision worth one record (a plain read is
    // not: it would be a record for every `gh pr view`). A pause records itself above.
    if (paused === null && intents !== null && intents[0] !== undefined) {
      const dest = firstIntentDestination(intents, cwd);
      logShim(home, { outcome: "allow", verb: verbWords(intents[0].verb), ...(dest !== null && { destination: dest }) });
    }
    if (outcome.note !== undefined) io.err(`repo-aegis gh: ${outcome.note}; proceeding\n`);
    if (outcome.hint !== undefined) io.err(`repo-aegis: ${outcome.hint}\n`);
  }

  // Run it, then say where it went. A receipt printed before gh returns could claim a publish that failed.
  const readback = verdict?.readback;
  const run = spawnGh(ghPath, args, env, cwd, readback !== undefined, deps, io);

  if (verdict?.receipt !== undefined) io.err(`${run.status === 0 ? verdict.receipt : (verdict.failedReceipt ?? "")}\n`);

  if (readback !== undefined && run.status === 0) {
    const r = readbackResult({ cwd, bodyFile: readback.bodyFile, pr: run.stdout, gh: ghPath, env });
    if (r.kind === "unavailable") {
      io.err(JSON.stringify({ code: "READBACK_UNAVAILABLE", reason: r.reason }) + "\n");
    } else if (r.kind === "mismatch") {
      io.err(r.payload);
      return 1;
    }
  }
  return run.status;
}

/** Process wrapper: run, then exit with the status. */
export function ghCommand(args: string[], opts: GhCommandOptions): never {
  process.exit(runGhCommand(args, opts));
}
