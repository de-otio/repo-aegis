// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `repo-aegis hook guard-egress` — the agent pre-command hook
// (doc/design/egress-guard.md §4). It reads the *pending* shell command on
// stdin, runs the shared decision function, and allows / asks / denies.
//
// Why this layer exists at all, given the pre-push hook and the `gh` shim:
// it is the only enforcement point that sees the WHOLE compound command
// before a shell has resolved it. `git` and `gh` are handed a command the
// shell already expanded, so the shape rules — a bare `git push`, an egress
// verb after a `cd`, an egress verb `;`-joined to a prerequisite that may
// have failed — are visible here and nowhere else. Both incidents that
// motivated this design were shape failures.
//
// Each agent host has its own stdin shape and answer shape. Those two edges
// live in one adapter per host under `./hook-hosts/` (contract:
// hook-hosts/types.ts, plan doc/plan-landscape-recommendations.md §5); this
// file is the host-independent middle and never looks at a payload field or
// prints a host's JSON itself. Today:
//
//   Claude Code  PreToolUse,  matcher Bash              ask available
//   Codex CLI    PreToolUse,  matcher Bash (was shell)  no ask
//   Gemini CLI   BeforeTool,  matcher run_shell_command no ask (legacy)
//   Copilot CLI  preToolUse / PreToolUse, bash          ask available
//   Cursor       beforeShellExecution                   ask available
//   Antigravity  PreToolUse,  run_command (unverified)  no ask
//
// Where a framework has no "ask", `ask` degrades to `deny` with a
// "have a human run or approve this" reason — never to `allow`.
//
// A payload an adapter cannot read (wrong `--agent` or event, a shell tool with
// no command field) fails OPEN like the guard's own defects, but says so: one
// fixed stderr line, and an audit record when the audit log is on.
//
// Two invariants that must survive every future edit:
//
//   1. **Decision-only.** This hook NEVER emits `updatedInput` or any other
//      rewritten command. Turning `git push` into `git push origin <branch>`
//      would rebuild the implicit-destination defect one layer up with the
//      agent's intent still unexamined. `hook-guard-egress.test.ts` has an
//      oracle over everything this hook can print.
//   2. **Cheap on the common case.** Almost every Bash call carries no egress
//      intent at all; that path does no registry read and no I/O, and prints
//      the least output the host accepts as "no objection": nothing where the
//      host allows that, the host's minimal allow where it does not (Cursor,
//      Antigravity).
import {
  appendAuditRecord,
  checkNetworkRules,
  decideIdentityHookRules,
  decideEgress,
  recordWorkingTree,
  describeVerb,
  egressParseOptions,
  findHumanOnlyCommand,
  humanCommandRefusal,
  AGENT_RAN_HUMAN_COMMAND,
  AGENT_DETACHED_SESSION,
  findDetachedStart,
  detachedStartRefusal,
  isPrintableDestination,
  loadRegistry,
  parseEgressIntents,
  ruleHSkipNote,
  ruleHStatus,
  SHAPE_RULE_CODES,
  RegistryEncryptedError,
  RegistryNotFoundError,
  type Destination,
  type DetachedHit,
  type EgressDecision,
  type HumanOnlyKind,
  type Registry,
  type RegistryState,
  type RuleHStatus,
} from "@de-otio/repo-aegis-core";
import { currentHumanPresent } from "../human-presence.js";
import { ghShimIsFirstOnPath } from "./install-shim.js";
import { adapterFor, type HookVerdict, type HostAdapter } from "./hook-hosts/index.js";

export interface HookGuardEgressOptions {
  /** The host adapter: `claude` (default) | `codex` | `gemini` | `copilot` | `cursor` | `antigravity`, case-insensitive; see ./hook-hosts/. Unknown → no ask. */
  agent?: string;
  /** Test seam: the environment whose `PATH` decides whether the `gh` shim can run. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Whether the `gh` shim is the first `gh` on the PATH this hook was given —
 * which is the PATH its host will hand the shell it is about to permit, so
 * the hook's own environment is the right thing to read and not a guess
 * about the caller.
 *
 * `undefined` on a throw, and the policy treats `undefined` as "not asked".
 * The distinction matters: a lookup that SUCCEEDS and says the shim is
 * absent is a fact to act on, while a lookup that failed is one of this
 * guard's own defects, and this hook fails open on those by contract.
 */
function ghShimOnPath(env: NodeJS.ProcessEnv): boolean | undefined {
  try {
    return ghShimIsFirstOnPath(env);
  } catch {
    return undefined;
  }
}

/**
 * Print the adapter's rendering of `verdict` and exit with its code. The one
 * place this hook writes to stdout: every decision goes through the host
 * adapter, so no code path here can print a host shape (or a rewritten
 * command) behind the adapter's back.
 */
function emit(adapter: HostAdapter, verdict: HookVerdict): never {
  const out = adapter.render(verdict);
  if (out.stdout !== "") process.stdout.write(out.stdout);
  process.exit(out.exitCode);
}

/**
 * A payload the adapter could not read: ONE fixed stderr line and, when the
 * audit log is on, a `guard-egress-malformed` record. Both carry the adapter's
 * fixed reason text and the `--agent` name, never payload bytes. The caller
 * still answers with the host's allow (fail open).
 */
function reportNotJudged(adapter: HostAdapter, reason: string): void {
  process.stderr.write(
    `repo-aegis: guard-egress: this payload was not judged (${reason}); check that the hook is registered with the right --agent and event\n`,
  );
  try {
    appendAuditRecord({ action: "guard-egress-malformed", cwd: process.cwd(), details: { agent: adapter.name, reason } });
  } catch {
    /* audit must not block the fail-open answer */
  }
}

/** The most hook input read; a longer payload is not judged, it is refused (issue #151, final review V1). */
export const HOOK_INPUT_MAX_BYTES = 1024 * 1024;

/** Read stdin to a string, capped at {@link HOOK_INPUT_MAX_BYTES}; `truncated` says the cap cut it. */
async function readStdin(): Promise<{ text: string; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const b = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    total += b.length;
    if (total > HOOK_INPUT_MAX_BYTES) {
      chunks.push(b.subarray(0, Math.max(0, b.length - (total - HOOK_INPUT_MAX_BYTES))));
      return { text: Buffer.concat(chunks).toString("utf8"), truncated: true };
    }
    chunks.push(b);
  }
  return { text: Buffer.concat(chunks).toString("utf8"), truncated: false };
}

/**
 * A payload past the cap cannot be parsed, and treating "unparseable" as "no command" let a command padded
 * past 1 MiB through every hook-only rule (R6, the human-only and detached-session refusals, the shape rules).
 * So it is refused, unless what was read already names a tool that is not a shell (a harness that sends every
 * tool to this hook). `tool_name` comes first in every harness's payload, well inside the cap.
 */
export function oversizedInputVerdict(prefix: string, adapter: HostAdapter = adapterFor(undefined)): "proceed" | "refuse" {
  return adapter.oversized(prefix);
}

const HOOK_INPUT_TOO_LARGE_REASON =
  "repo-aegis: refused. This command is larger than 1 MiB, so the egress guard cannot read it whole and does not " +
  "judge it. No approval covers this. Fix: put large content in a file and pass the file (`--body-file`, `-F`, " +
  "`--input`, `-d @file`), keeping the command itself short. [HOOK_INPUT_TOO_LARGE; details: repo-aegis explain HOOK_INPUT_TOO_LARGE]";

const EMPTY_REGISTRY: Registry = {
  engagements: [],
  alwaysBlock: [],
  personalOrgs: [],
  schemaVersion: 2,
};

/**
 * The registry is optional here. The shape rules need no registry at all,
 * and a guard that refused to run because a registry was missing would be
 * inert exactly where it is most needed (a fresh machine). So a failure falls
 * back to an empty registry and the condition travels with the decision as
 * `registryState`, which rule h reads (issue #151, decision D4):
 *
 *   - no registry file  → `missing`: rule h is skipped;
 *   - encrypted, or a file that does not parse or validate → `unreadable`:
 *     rule h REFUSES any egress that has a destination, because no owner can
 *     be confirmed. Skipping here would let an agent that can write the file
 *     switch rule h off with one bad YAML line.
 *
 * Only {@link RegistryNotFoundError} is "missing". Anything else, including an
 * error this code does not know, is `unreadable`: fail closed.
 */
function loadRegistryOrEmpty(): { registry: Registry; registryState: RegistryState; note?: string } {
  try {
    return { registry: loadRegistry(), registryState: "loaded" };
  } catch (err) {
    if (err instanceof RegistryNotFoundError) {
      return { registry: EMPTY_REGISTRY, registryState: "missing" };
    }
    return {
      registry: EMPTY_REGISTRY,
      registryState: "unreadable",
      note:
        err instanceof RegistryEncryptedError
          ? "registry is encrypted: context rules ran without it, and any publish with a destination is refused until it is decrypted"
          : "registry could not be read: context rules ran without it, and any publish with a destination is refused until it is repaired",
    };
  }
}

/**
 * The only shape in which a destination is ever reported by this hook:
 * org, repo, visibility, class. Never the payload, never a marker, never
 * the registry. `class`/`visibility` collapse to `unknown` when the
 * destination is some other repository whose class this machine does not
 * hold — printing the local default there would be a lie.
 */
function destinationDetails(
  d: Destination | undefined,
): { org: string; repo: string; visibility: string; class: string; unresolved?: string } | undefined {
  // Defence in depth: the policy already drops an invalid name from the
  // decision, but this is what reaches the terminal, so check once more.
  if (!d || !isPrintableDestination(d)) return undefined;
  return {
    org: d.org,
    repo: d.repo,
    visibility: d.classKnown ? d.visibility : "unknown",
    class: d.classKnown ? d.class : "unknown",
    ...(d.unresolved !== undefined && { unresolved: d.unresolved }),
  };
}

/**
 * An approval stood in for a person (rule g). Best-effort audit record —
 * the mint was recorded; so is every use — and the returned reason goes out
 * as an explicit `allow` with the approval named, so a framework that shows
 * decision reasons shows this one.
 */
function recordApprovalUse(decision: Extract<EgressDecision, { action: "allow" }>, layer: string): string {
  const a = decision.approval!;
  try {
    appendAuditRecord({
      action: "egress-approval-use",
      cwd: process.cwd(),
      details: {
        id: a.id,
        layer,
        ...(decision.intent && { verb: describeVerb(decision.intent.verb) }),
        ...(decision.destination && { destination: `${decision.destination.org}/${decision.destination.repo}` }),
      },
    });
  } catch {
    /* audit must not block the allow */
  }
  return (
    `repo-aegis: human approval ${a.id} (${a.org}/${a.repo}${a.ref !== undefined ? `, ref ${a.ref}` : ""}, ` +
    `until ${a.expiresAt}) stands in for a person on this publish.`
  );
}

/**
 * Every refusal leaves on two channels: the structured `{ code, error,
 * details }` on stderr (host-independent: what most hosts feed back to the
 * model on a block) and the adapter's deny on stdout (for hosts that read
 * their JSON channel instead).
 */
function deny(adapter: HostAdapter, code: string, reason: string, details: Record<string, unknown>, stdoutReason = reason): never {
  process.stderr.write(JSON.stringify({ code, error: reason, details }, null, 2) + "\n");
  emit(adapter, { action: "deny", reason: stdoutReason });
}

/** Refuse a command line that runs a human-only repo-aegis command. Same channels as every other deny. */
function denyHumanOnlyCommand(adapter: HostAdapter, kind: HumanOnlyKind): never {
  deny(adapter, AGENT_RAN_HUMAN_COMMAND, humanCommandRefusal({ kind }), { command: kind });
}

/** Refuse a command line that starts a detached session. Same channels as every other deny. */
function denyDetachedStart(adapter: HostAdapter, hit: DetachedHit): never {
  deny(adapter, AGENT_DETACHED_SESSION, detachedStartRefusal(hit), { start: hit.kind });
}

/**
 * `repo-aegis hook guard-egress` — PreToolUse(Bash) egress guard.
 *
 * Outcomes, rendered by the host adapter (`--agent`, ./hook-hosts/):
 *   - allow, and silent (where the host allows silence) when the command
 *     carries no publishing operation, the tool is not a shell tool, or
 *     stdin is unusable (`skip` / `malformed`: fail open),
 *   - allow with the approval named, when a human approval stood in,
 *   - ask (hosts with an ask only),
 *   - deny, with the structured reason on stderr — the channel most
 *     frameworks feed back to the model — and the adapter's deny on stdout
 *     for frameworks that read it,
 *   - error: the guard's own failure, rendered as the host's fail-open
 *     answer, so it never becomes a wall between the agent and every command.
 */
export async function hookGuardEgress(opts: HookGuardEgressOptions): Promise<void> {
  const adapter = adapterFor(opts.agent);
  let stdinText: string;
  try {
    const input = await readStdin();
    if (input.truncated) {
      if (adapter.oversized(input.text) === "refuse") {
        deny(adapter, "HOOK_INPUT_TOO_LARGE", HOOK_INPUT_TOO_LARGE_REASON, { verb: "(oversized command)" });
      }
      // The prefix already proves a tool that is not a shell: a `skip`, silent like any other. The cut text
      // cannot be parsed (and must not be reported as an unreadable payload).
      emit(adapter, { action: "allow" });
    }
    stdinText = input.text;
  } catch (err) {
    process.stderr.write(
      `repo-aegis: hook guard-egress could not read stdin: ${(err as Error).message}\n`,
    );
    emit(adapter, { action: "error" });
  }

  let decision: EgressDecision;
  let registryNote: string | undefined;
  let ruleH: RuleHStatus = "applied";
  let humanPresent = false;
  try {
    const parsed = adapter.parse(stdinText);
    // Not a shell command: fail open, silently, without touching the registry.
    // A payload this adapter could not read is the same fail-open answer, but
    // NOT silent: most often the hook is registered with the wrong `--agent`
    // or event, and a guard that quietly judges nothing looks exactly like a
    // guard that is working.
    if (parsed.kind === "malformed") reportNotJudged(adapter, parsed.reason);
    if (parsed.kind !== "command") emit(adapter, { action: "allow" });
    const { command, cwd } = parsed;

    // R6 (plan §8.2): a raw HTTP client writing to the GitHub API, or `gh auth token` next to a network
    // call. Shape rules on the command text: no registry, no approval, and no `ask`.
    const network = checkNetworkRules(command);
    if (network !== null) deny(adapter, network.code, network.reason, { verb: "(raw network call)" });
    // Commands only a person may run (`approve`, owner adds, `upstreams add`,
    // `init --migrate-classify|--force`): refused in ANY agent Bash text, with
    // or without a terminal, before the egress parse and its early exit. A pty
    // wrapper can fake the terminal that those commands' own gate tests, so the
    // text is the second lock (issue #151, PR 2b).
    const humanOnly = findHumanOnlyCommand(command);
    if (humanOnly !== null) denyHumanOnlyCommand(adapter, humanOnly.kind);
    // A detached session start (`tmux new -d`, `screen -dm`, `setsid`, `daemonize`, `nohup … & disown`)
    // re-parents a pty to init, where no gate sees an agent above it: refused in any command, egress or not.
    const detached = findDetachedStart(command);
    if (detached !== null) denyDetachedStart(adapter, detached);

    // Identity hook rules (plan-owner-identity §13.2): a REPO_AEGIS_* variable or a terminal wrapper on a command
    // that runs gh, git, taaad or security (A1, never lifted), and, with no person present, the gh and keychain
    // routes to a token (A10, N9). Before the egress parse and its early exit: they apply whatever the command
    // publishes. After the two more specific refusals above, so those keep their codes. Presence is read only
    // when a person-liftable rule is the sole hit.
    const identityHit = decideIdentityHookRules(command, currentHumanPresent);
    if (identityHit !== null) deny(adapter, identityHit.code, identityHit.reason, { verb: "(identity rule)" });

    const intents = parseEgressIntents(command, egressParseOptions(opts.env ?? process.env, cwd));
    // The common case: no publishing operation in the command line. Exit
    // before touching the registry or the filesystem.
    if (intents.length === 0) emit(adapter, { action: "allow" });

    const loaded = loadRegistryOrEmpty();
    registryNote = loaded.note;
    ruleH = ruleHStatus(loaded.registryState, loaded.registry);
    humanPresent = currentHumanPresent();

    // Write-through: whatever this directory declares about its own origin
    // goes into the machine-wide destination cache, so the next command that
    // names this repository from *elsewhere* is judged by that declaration.
    // Best-effort by contract; a cache miss is not a reason to block.
    recordWorkingTree(cwd ?? process.cwd());

    decision = decideEgress({
      intents,
      cwd: cwd ?? process.cwd(),
      registry: loaded.registry,
      registryState: loaded.registryState,
      humanPresent,
      // The adapter says whether its host can ask. An unrecognised
      // `--agent` value gets an adapter without one (hook-hosts/index.ts),
      // so `ask` degrades to `deny`.
      capabilities: (() => {
        const ask = adapter.hasAsk;
        // Only worth answering where `ask` is on the table at all: without
        // an ask, rule g already denies.
        const shim = ask ? ghShimOnPath(opts.env ?? process.env) : undefined;
        return { ask, ...(shim !== undefined && { ghShimOnPath: shim }) };
      })(),
    });
  } catch (err) {
    // Fail open. A guard that blocks on its own defect is worse than one
    // that misses a command: the agent would be walled off from every Bash
    // call until someone debugged the hook.
    process.stderr.write(
      `repo-aegis: hook guard-egress failed, command not evaluated: ${(err as Error).message}\n`,
    );
    emit(adapter, { action: "error" });
  }

  // Rendering the decision can throw too (describeVerb, destinationDetails,
  // the audit write): a throw here is the guard's own defect, so it becomes the
  // `error` verdict through the adapter (the host's fail-open answer), never
  // an uncaught exception, which commander turns into exit 1 (and Copilot
  // fails CLOSED on exit 1). The outcome is computed first and emitted after.
  const outcome = outcomeOrError(decision, { registryNote, ruleH, humanPresent });
  if (outcome.stderr !== undefined) process.stderr.write(outcome.stderr);
  emit(adapter, outcome.verdict);
}

/** What to print and say, computed before anything is written. */
export interface Outcome {
  verdict: HookVerdict;
  /** Written to stderr before the verdict is rendered: the structured refusal of a deny. */
  stderr?: string;
}

/**
 * {@link planOutcome}, with a throw turned into the `error` verdict (and the
 * same one-line stderr as the guard's other internal failures). Pure apart from
 * the approval audit record; never throws.
 */
export function outcomeOrError(decision: EgressDecision, ctx: OutcomeContext): Outcome {
  try {
    return planOutcome(decision, ctx);
  } catch (err) {
    return {
      verdict: { action: "error" },
      stderr: `repo-aegis: hook guard-egress failed, command not evaluated: ${(err as Error).message}\n`,
    };
  }
}

interface OutcomeContext {
  registryNote: string | undefined;
  ruleH: RuleHStatus;
  humanPresent: boolean;
}

function planOutcome(
  decision: EgressDecision,
  ctx: OutcomeContext,
): Outcome {
  let { registryNote } = ctx;
  if (decision.action === "allow") {
    if (decision.approval !== undefined) return { verdict: { action: "allow", reason: recordApprovalUse(decision, "hook guard-egress") } };
    return { verdict: { action: "allow" } };
  }

  // Rule h's own refusal already says the registry could not be read and how
  // to fix it (§3.9); appending the note would only repeat it.
  if (decision.code === "UNREGISTERED_OWNER_EGRESS") registryNote = undefined;
  // D4: a skip says which state applied. Only where rule h would have been
  // judging a destination for a non-interactive command, so a shape-rule deny
  // (no destination) or a person at the keyboard gets no extra line. No
  // registry contents, ever.
  const skipNote =
    !ctx.humanPresent && decision.code !== "UNREGISTERED_OWNER_EGRESS" && !SHAPE_RULE_CODES.has(decision.code)
      ? ruleHSkipNote(ctx.ruleH)
      : null;
  const notes = [registryNote, skipNote].filter((n): n is string => n !== undefined && n !== null);
  const reason = notes.length === 0 ? decision.reason : `${decision.reason} (${notes.join("; ")})`;

  if (decision.action === "ask") return { verdict: { action: "ask", reason } };

  const details: Record<string, unknown> = { verb: describeVerb(decision.intent.verb) };
  const dest = destinationDetails(decision.destination);
  if (dest !== undefined) details["destination"] = dest;
  if (registryNote !== undefined) details["registry"] = registryNote;
  if (skipNote !== null) details["ruleH"] = ctx.ruleH;

  // stderr carries the reason because that is what these frameworks feed
  // back to the model on a non-zero exit (Bug A in
  // doc/bugs/repo-aegis-check-write-flake.md); stdout carries the same
  // decision for frameworks that read the JSON channel instead. stderr gets
  // the bare reason (the notes travel in `details`), stdout the noted one.
  return {
    verdict: { action: "deny", reason },
    stderr: JSON.stringify({ code: decision.code, error: decision.reason, details }, null, 2) + "\n",
  };
}
