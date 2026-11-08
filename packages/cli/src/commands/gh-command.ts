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
// FAULTS (D4). A mapped owner never silently falls back to the active account: any throw between choosing
// and spawning is `GH_IDENTITY_UNAVAILABLE` and `gh` is not run. An unmapped call keeps warn-and-run.
//
// THE TOKEN lives in one local variable and in the `gh` child's environment. See `gh-identity-token.ts`.
import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import {
  approvalsPath,
  chooseIdentity,
  describeVerb,
  findLoginApproval,
  ghBaseRepo,
  isGhBuiltinGroup,
  ghCallInfo,
  checkTerminal,
  identityPresence,
  loadRegistry,
  refusal,
  registeredOwners,
  safeDestination,
  statePath,
  RegistryNotFoundError,
  type ChooseIdentityInput,
  type GhCallTarget,
  type EgressIntent,
  type Identity,
  type IdentityChoice,
  type IdentityPresence,
  type IdentityScope,
  type Registry,
  type RefusalFix,
  type TerminalCheck,
} from "@de-otio/repo-aegis-core";
import type { OutputOptions } from "../format.js";
import { evaluateEgress, readbackResult, type AllowVerdict } from "./egress-check.js";
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
  /** Capture the `gh` child's output through `io` instead of inheriting the terminal. */
  captureChild?: boolean;
}

/** Variables that would send an injected token to a server or config the person did not choose (D9). */
const REDIRECT_VARS = ["GH_HOST", "GH_CONFIG_DIR", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"] as const;

/** The caller-controlled variables that select where this process reads its registry and approvals from (D8). */
const HOME_SELECTING_VARS = ["REPO_AEGIS_REGISTRY", "REPO_AEGIS_MARKERS_DIR"] as const;

const AUTH_GROUPS = ["auth", "config", "alias", "extension"];

/** The decision log: JSON Lines under the pinned home's `state/`, written whatever the audit log's setting (A15). */
export const DECISION_LOG_FILE = "gh-decisions.jsonl";

export function decisionLogPath(home: string): string {
  return join(statePath(home), DECISION_LOG_FILE);
}

interface DecisionRecord {
  decision: "inject" | "refuse";
  verb: string;
  owner?: string;
  repo?: string | null;
  identity?: string;
  kind?: string;
  column?: string;
  scope?: string;
  approvalId?: string;
  code?: string;
}

/** Append one record. Throws when it cannot: on an injecting call that is a fault (D4), so no unlogged identity use. */
function appendDecision(home: string, record: DecisionRecord): void {
  const path = decisionLogPath(home);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const line = JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n";
  appendFileSync(path, line, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* platform-restricted */
  }
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

/** A refusal this command builds itself (codes core's `chooseIdentity` does not produce). */
function ownRefusal(
  code: string,
  what: string,
  why: string,
  fixes: readonly RefusalFix[],
  dest?: { owner: string; repo: string | null },
): string {
  return refusal({
    code,
    ...(dest !== undefined && { destination: { verb: "gh", org: dest.owner, repo: dest.repo ?? "*" } }),
    what,
    why,
    approval: NO_APPROVAL,
    fixes,
  });
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
  | { kind: "refuse"; code: string; reason: string }
  | {
      kind: "inject";
      ghPath: string;
      env: NodeJS.ProcessEnv;
      label: string;
    };

function loadPinnedRegistry(home: string): { kind: "none" } | { kind: "unreadable" } | { kind: "ok"; registry: Registry } {
  try {
    return { kind: "ok", registry: loadRegistry(join(home, "engagements.yaml")) };
  } catch (err) {
    return err instanceof RegistryNotFoundError ? { kind: "none" } : { kind: "unreadable" };
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
  const authish = args.some(a => AUTH_GROUPS.includes(a)) || (firstWord !== undefined && !isGhBuiltinGroup(firstWord));

  let registry: Registry | null = loaded.kind === "ok" ? loaded.registry : null;
  const hasMapping = registry !== null && ((registry.identityMap?.size ?? 0) > 0 || registry.requireIdentity === true);

  // Rule 1 (A10) is about the VERB, so it applies even where nothing is mapped. Cheap pre-check first: the
  // presence reader may read the process table.
  if (authish && registry !== null) {
    const first = chooseIdentity(baseInput(args, intents, [], registry, presenceOf(), home, callerEnv));
    if (first.kind === "refuse") return refuseOutcome(first, home, verb);
  }
  if (loaded.kind === "none" || !hasMapping) return { kind: "plain" };

  if (loaded.kind === "unreadable") {
    // The registry says which owners are mapped, and it cannot be read. A person at a terminal runs as
    // themselves (doctor reports REGISTRY_UNREADABLE); with nobody present, a call that names an owner is refused.
    return presenceOf() === "person"
      ? { kind: "plain", note: "the registry could not be read, so no GitHub identity was chosen" }
      : refuseUnavailable("the registry could not be read, so repo-aegis cannot tell whether this owner has a GitHub identity", verb, home);
  }
  registry = loaded.registry;

  // Targets: the cwd's remote is read only when the argv would use it.
  const ghRepoEnv = callerEnv["GH_REPO"];
  // `isWrite` is the egress parser's verdict: a graphql read gets no base target (core decides with it).
  const isWrite = intents === null ? true : intents.length > 0;
  const ctxBase = { isWrite, ...(ghRepoEnv !== undefined && ghRepoEnv !== "" && { ghRepoEnv }) };
  const probe = ghCallInfo(args, { ...ctxBase, cwdRemoteOwnerRepo: { owner: "cwd-probe", repo: "cwd-probe" } });
  let info = ghCallInfo(args, ctxBase);
  if (probe.targets.some(t => t.source === "cwd")) {
    const plain = intents?.[0]?.ghPlainBase === true;
    const base = ghBaseRepo(cwd, plain);
    if (base.kind === "repo") {
      info = ghCallInfo(args, { ...ctxBase, cwdRemoteOwnerRepo: { owner: base.org, repo: base.repo } });
    }
  }
  const targets = info.targets;
  const foreignHost = info.foreignHost;

  const input: ChooseIdentityInput = { ...baseInput(args, intents, targets, registry, presenceOf(), home, callerEnv), foreignHost };
  let choice = chooseIdentity(input);
  if (choice.kind === "inject") {
    state.mapped = true;
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
            `there is no gh repo-aegis may hand a token (${trusted.reason})`,
            [{ by: "person", step: "fixes PATH so a package-manager gh is the first one, or installs gh into a root-owned directory" }],
            choice,
          ),
        },
        home,
        verb,
      );
    }
    const socket = runGhAsNobody(trusted.path, ["config", "get", "http_unix_socket"], callerEnv, trust);
    if (socket === null) {
      return refuseUnavailable("gh's http_unix_socket setting could not be read", verb, home, choice);
    }
    if (socket.trim() !== "") {
      choice = chooseIdentity({ ...input, redirect: "http_unix_socket" });
      if (choice.kind !== "inject") return refuseOutcome(choice, home, verb);
    }
    return inject(choice, trusted.path, home, callerEnv, verb, trust, deps);
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
  try {
    appendDecision(home, { decision: "refuse", verb, code: choice.code });
  } catch {
    /* a refusal is not made worse by an unwritable log */
  }
  return { kind: "refuse", code: choice.code, reason: choice.reason };
}

function refuseUnavailable(
  why: string,
  verb: string,
  home: string,
  dest?: { owner: string; repo: string | null },
): IdentityOutcome {
  return refuseOutcome(
    {
      kind: "refuse",
      code: "GH_IDENTITY_UNAVAILABLE",
      reason: ownRefusal(
        "GH_IDENTITY_UNAVAILABLE",
        "this gh call",
        why,
        [{ by: "person", step: "checks the identity with `repo-aegis status` and `repo-aegis doctor`, then re-runs the command" }],
        dest,
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
  trust: "default" | "permissive",
  deps: GhCommandDeps,
): IdentityOutcome {
  const { identity, owner, repo, scope } = choice;
  const dest = { owner, repo };
  const mint = obtainToken(identity, owner, repo, scope, ghPath, callerEnv, trust, deps, home);
  if (mint.kind === "refuse") {
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
  // D6, A15: the record is written BEFORE the call, whatever the audit log's setting, and never holds the token.
  // Failing to write it is a fault on a mapped call: no unlogged use of an identity.
  appendDecision(home, {
    decision: "inject",
    verb,
    owner,
    repo,
    identity: identity.name,
    kind: identity.kind,
    column: choice.column,
    scope,
    ...(choice.approvalId !== undefined && { approvalId: choice.approvalId }),
  });
  return { kind: "inject", ghPath, env, label: `repo-aegis: as ${identity.name} (${identity.kind}) for ${destLabel(owner, repo)}\n` };
}

type TokenOutcome =
  | { kind: "token"; token: string }
  | { kind: "refuse"; code: string; reason: (dest: { owner: string; repo: string | null }) => string };

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
    reason: dest =>
      ownRefusal("GH_IDENTITY_UNAVAILABLE", "this gh call", why, [
        { by: "person", step: "checks the identity with `repo-aegis doctor`, then re-runs the command" },
      ], dest),
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
      ? [{ by: "person", step: "checks which App the registry maps to this owner" }]
      : f.code === "GH_IDENTITY_UNAVAILABLE"
        ? [{ by: "person", step: "checks the identity with `repo-aegis doctor`, then re-runs the command" }]
        : [{ by: "person", step: "installs taaad into a root-owned prefix and re-runs `repo-aegis install shim`" }];
  return { kind: "refuse", code: f.code, reason: dest => ownRefusal(f.code, "this gh call", f.why, fixes, dest) };
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

function runPinned(
  args: string[],
  home: string,
  cwd: string,
  callerEnv: NodeJS.ProcessEnv,
  deps: GhCommandDeps,
  io: { out: (t: string) => void; err: (t: string) => void },
): number {
  // 1. The egress decision, as `egress-check` makes it.
  let verdict: AllowVerdict | null = null;
  let intents: EgressIntent[] | null = null;
  try {
    const ev = evaluateEgress(args, cwd);
    if (ev.kind === "deny") {
      io.err(ev.stderrLine);
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

  // 2 and 3. The identity.
  const state = { mapped: false };
  let outcome: IdentityOutcome;
  try {
    outcome = decideIdentity(args, home, cwd, callerEnv, intents, deps, state);
  } catch {
    // D4: a fault on a mapped call is never a call as the active account; an unmapped one keeps today's behaviour.
    outcome = state.mapped
      ? {
          kind: "refuse",
          code: "GH_IDENTITY_UNAVAILABLE",
          reason: ownRefusal("GH_IDENTITY_UNAVAILABLE", "this gh call", "repo-aegis faulted while preparing the GitHub identity for a mapped owner, and will not run it as the active account", [
            { by: "person", step: "checks the identity with `repo-aegis doctor`, then re-runs the command" },
          ]),
        }
      : { kind: "plain", note: "repo-aegis faulted while choosing a GitHub identity" };
  }

  if (outcome.kind === "refuse") {
    io.err(refusalLine(outcome.code, outcome.reason, verbOf(args, intents ?? [])));
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
