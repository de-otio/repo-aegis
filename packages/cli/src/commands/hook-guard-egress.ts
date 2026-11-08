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
// Three agents expose a compatible pre-command hook, and all three put the
// pending command in `tool_input.command`:
//
//   Claude Code  PreToolUse,  matcher Bash              ask available
//   Codex CLI    PreToolUse,  matcher shell             no ask
//   Gemini CLI   BeforeTool,  matcher run_shell_command no ask
//
// Where a framework has no "ask", `ask` degrades to `deny` with a
// "have a human run or approve this" reason — never to `allow`.
//
// Two invariants that must survive every future edit:
//
//   1. **Decision-only.** This hook NEVER emits `updatedInput` or any other
//      rewritten command. Turning `git push` into `git push origin <branch>`
//      would rebuild the implicit-destination defect one layer up with the
//      agent's intent still unexamined. `hook-guard-egress.test.ts` has an
//      oracle over everything this hook can print.
//   2. **Cheap and silent on the common case.** Almost every Bash call
//      carries no egress intent at all; that path must exit 0 with no
//      output and no registry read.
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

export interface HookGuardEgressOptions {
  /** `claude` (default) | `codex` | `gemini`. Only `claude` is assumed to have an "ask". */
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

// PreToolUse exit-code contract, shared by all three frameworks:
//   0              → proceed (with the JSON decision, if any, on stdout),
//   2              → BLOCK the tool; stderr is fed back to the model,
//   other non-zero → non-blocking error; the tool still runs (fail open).
const EXIT_BLOCK = 2;
const EXIT_INTERNAL_ERROR = 1;

/**
 * Tool names that carry a shell command. Compared case-insensitively so a
 * harness that spells its tool `bash` rather than `Bash` still matches. A
 * payload with NO `tool_name` is inspected anyway: some harnesses omit it,
 * and the parse is harmless on a non-command payload (it yields no intents).
 */
const SHELL_TOOL_NAMES = new Set(["bash", "shell", "run_shell_command"]);

interface HookInput {
  command?: string;
  cwd?: string;
  toolName?: string;
}

/**
 * Flatten an argv-style command (`["bash", "-lc", "git push"]`) to the
 * shell text it would run. Harnesses that exec directly rather than through
 * a shell send this shape; the script after `-c` / `-lc` is the part the
 * policy must see.
 */
function flattenCommand(value: unknown): string | undefined {
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  if (!Array.isArray(value)) return undefined;
  const parts = value.filter((v): v is string => typeof v === "string");
  if (parts.length === 0) return undefined;
  const dashC = parts.findIndex(p => /^-[a-z]*c$/.test(p));
  if (dashC !== -1 && dashC + 1 < parts.length) return parts[dashC + 1];
  return parts.join(" ");
}

/**
 * Tolerant field extraction across the three harness shapes, in the spirit
 * of `hook-scan-bash-output.ts`: the pending command from
 * `tool_input.command` (all three) or a root-level `command`, and the
 * session cwd from the root `cwd`.
 *
 * `cwd` matters for the same reason it does in `hook-check-write.ts`: it is
 * where the command WILL run, whereas `process.cwd()` is wherever the agent
 * happened to spawn this hook. Reading the spawn cwd was the cause of the
 * spurious `CROSS_ORG_WRITE` blocks (doc/bugs/repo-aegis-check-write-flake.md).
 */
function parseHookInput(json: string): HookInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object") return {};
  const root = parsed as Record<string, unknown>;
  const out: HookInput = {};

  const toolName = root["tool_name"];
  if (typeof toolName === "string" && toolName.length > 0) out.toolName = toolName;

  const ti = root["tool_input"];
  if (ti && typeof ti === "object") {
    const command = flattenCommand((ti as Record<string, unknown>)["command"]);
    if (command !== undefined) out.command = command;
  }
  if (out.command === undefined) {
    const command = flattenCommand(root["command"]);
    if (command !== undefined) out.command = command;
  }

  const cwd = root["cwd"];
  if (typeof cwd === "string" && cwd.length > 0) out.cwd = cwd;

  return out;
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
export function oversizedInputVerdict(prefix: string): "proceed" | "refuse" {
  const m = /"tool_name"\s*:\s*"([^"\\]{1,64})"/.exec(prefix.slice(0, 4096));
  if (m !== null && !SHELL_TOOL_NAMES.has(m[1]!.toLowerCase())) return "proceed";
  return "refuse";
}

const HOOK_INPUT_TOO_LARGE_REASON =
  "repo-aegis: refused. This command is larger than 1 MiB, so the egress guard cannot read it whole and does not " +
  "judge it. No approval covers this. Fix: put large content in a file and pass the file (`--body-file`, `-F`, " +
  "`--input`, `-d @file`), keeping the command itself short. See doc/agent-guide.md#hook_input_too_large.";

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
 * the mint was recorded; so is every use — and the decision goes out on
 * the JSON channel as an explicit `allow` with the approval named, so a
 * framework that shows decision reasons shows this one.
 */
function recordApprovalUse(decision: Extract<EgressDecision, { action: "allow" }>, layer: string): void {
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
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason:
          `repo-aegis: human approval ${a.id} (${a.org}/${a.repo}${a.ref !== undefined ? `, ref ${a.ref}` : ""}, ` +
          `until ${a.expiresAt}) stands in for a person on this publish.`,
      },
    }) + "\n",
  );
}

function writeDecisionJson(decision: "ask" | "deny", reason: string): void {
  // The frameworks' own JSON channel. `permissionDecision` is the entire
  // vocabulary this hook uses: there is deliberately no `updatedInput`.
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decision,
        permissionDecisionReason: reason,
      },
    }) + "\n",
  );
}

/** Refuse a command line that runs a human-only repo-aegis command. Same channels as every other deny. */
function denyHumanOnlyCommand(kind: HumanOnlyKind): never {
  const reason = humanCommandRefusal({ kind });
  process.stderr.write(JSON.stringify({ code: AGENT_RAN_HUMAN_COMMAND, error: reason, details: { command: kind } }, null, 2) + "\n");
  writeDecisionJson("deny", reason);
  process.exit(EXIT_BLOCK);
}

/** Refuse a command line that starts a detached session. Same channels as every other deny. */
function denyDetachedStart(hit: DetachedHit): never {
  const reason = detachedStartRefusal(hit);
  process.stderr.write(JSON.stringify({ code: AGENT_DETACHED_SESSION, error: reason, details: { start: hit.kind } }, null, 2) + "\n");
  writeDecisionJson("deny", reason);
  process.exit(EXIT_BLOCK);
}

/**
 * `repo-aegis hook guard-egress` — PreToolUse(Bash) egress guard.
 *
 * Exit semantics:
 *   - 0 and silent when the command carries no publishing operation,
 *     the tool is not a shell tool, or stdin is unusable,
 *   - 0 with an `ask` decision on stdout (Claude Code only),
 *   - 2 with the structured reason on stderr — the channel these
 *     frameworks feed back to the model — and the decision JSON on stdout
 *     for frameworks that read it,
 *   - 1 on an internal error: non-blocking, so the guard's own failure
 *     never becomes a wall between the agent and every Bash call.
 */
export async function hookGuardEgress(opts: HookGuardEgressOptions): Promise<void> {
  let stdinText: string;
  try {
    const input = await readStdin();
    if (input.truncated && oversizedInputVerdict(input.text) === "refuse") {
      process.stderr.write(
        JSON.stringify({ code: "HOOK_INPUT_TOO_LARGE", error: HOOK_INPUT_TOO_LARGE_REASON, details: { verb: "(oversized command)" } }, null, 2) + "\n",
      );
      writeDecisionJson("deny", HOOK_INPUT_TOO_LARGE_REASON);
      process.exit(EXIT_BLOCK);
    }
    stdinText = input.text;
  } catch (err) {
    process.stderr.write(
      `repo-aegis: hook guard-egress could not read stdin: ${(err as Error).message}\n`,
    );
    process.exit(EXIT_INTERNAL_ERROR);
  }

  let decision: EgressDecision;
  let registryNote: string | undefined;
  let ruleH: RuleHStatus = "applied";
  let humanPresent = false;
  try {
    const { command, cwd, toolName } = parseHookInput(stdinText);
    if (toolName !== undefined && !SHELL_TOOL_NAMES.has(toolName.toLowerCase())) process.exit(0);
    if (command === undefined) process.exit(0);

    // R6 (plan §8.2): a raw HTTP client writing to the GitHub API, or `gh auth token` next to a network
    // call. Shape rules on the command text: no registry, no approval, and no `ask`.
    const network = checkNetworkRules(command);
    if (network !== null) {
      process.stderr.write(
        JSON.stringify({ code: network.code, error: network.reason, details: { verb: "(raw network call)" } }, null, 2) + "\n",
      );
      writeDecisionJson("deny", network.reason);
      process.exit(EXIT_BLOCK);
    }
    // Commands only a person may run (`approve`, owner adds, `upstreams add`,
    // `init --migrate-classify|--force`): refused in ANY agent Bash text, with
    // or without a terminal, before the egress parse and its early exit. A pty
    // wrapper can fake the terminal that those commands' own gate tests, so the
    // text is the second lock (issue #151, PR 2b).
    const humanOnly = findHumanOnlyCommand(command);
    if (humanOnly !== null) denyHumanOnlyCommand(humanOnly.kind);
    // A detached session start (`tmux new -d`, `screen -dm`, `setsid`, `daemonize`, `nohup … & disown`)
    // re-parents a pty to init, where no gate sees an agent above it: refused in any command, egress or not.
    const detached = findDetachedStart(command);
    if (detached !== null) denyDetachedStart(detached);

    // Identity hook rules (plan-owner-identity §13.2): a REPO_AEGIS_* variable or a terminal wrapper on a command
    // that runs gh, git, taaad or security (A1, never lifted), and, with no person present, the gh and keychain
    // routes to a token (A10, N9). Before the egress parse and its early exit: they apply whatever the command
    // publishes. After the two more specific refusals above, so those keep their codes. Presence is read only
    // when a person-liftable rule is the sole hit.
    const identityHit = decideIdentityHookRules(command, currentHumanPresent);
    if (identityHit !== null) {
      process.stderr.write(
        JSON.stringify({ code: identityHit.code, error: identityHit.reason, details: { verb: "(identity rule)" } }, null, 2) + "\n",
      );
      writeDecisionJson("deny", identityHit.reason);
      process.exit(EXIT_BLOCK);
    }

    const intents = parseEgressIntents(command, egressParseOptions(opts.env ?? process.env, cwd));
    // The common case: no publishing operation in the command line. Exit
    // before touching the registry or the filesystem.
    if (intents.length === 0) process.exit(0);

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
      // Only Claude Code is assumed to have an "ask". Anything else —
      // including an unrecognised `--agent` value — is treated as a
      // framework without one, so `ask` degrades to `deny`.
      capabilities: (() => {
        const ask = (opts.agent ?? "claude") === "claude";
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
    process.exit(EXIT_INTERNAL_ERROR);
  }

  if (decision.action === "allow") {
    if (decision.approval !== undefined) recordApprovalUse(decision, "hook guard-egress");
    process.exit(0);
  }

  // Rule h's own refusal already says the registry could not be read and how
  // to fix it (§3.9); appending the note would only repeat it.
  if (decision.code === "UNREGISTERED_OWNER_EGRESS") registryNote = undefined;
  // D4: a skip says which state applied. Only where rule h would have been
  // judging a destination for a non-interactive command, so a shape-rule deny
  // (no destination) or a person at the keyboard gets no extra line. No
  // registry contents, ever.
  const skipNote =
    !humanPresent && decision.code !== "UNREGISTERED_OWNER_EGRESS" && !SHAPE_RULE_CODES.has(decision.code)
      ? ruleHSkipNote(ruleH)
      : null;
  const notes = [registryNote, skipNote].filter((n): n is string => n !== undefined && n !== null);
  const reason = notes.length === 0 ? decision.reason : `${decision.reason} (${notes.join("; ")})`;

  if (decision.action === "ask") {
    writeDecisionJson("ask", reason);
    process.exit(0);
  }

  const details: Record<string, unknown> = { verb: describeVerb(decision.intent.verb) };
  const dest = destinationDetails(decision.destination);
  if (dest !== undefined) details["destination"] = dest;
  if (registryNote !== undefined) details["registry"] = registryNote;
  if (skipNote !== null) details["ruleH"] = ruleH;

  // stderr carries the reason because that is what these frameworks feed
  // back to the model on a non-zero exit (Bug A in
  // doc/bugs/repo-aegis-check-write-flake.md); stdout carries the same
  // decision for frameworks that read the JSON channel instead.
  process.stderr.write(
    JSON.stringify({ code: decision.code, error: decision.reason, details }, null, 2) + "\n",
  );
  writeDecisionJson("deny", reason);
  process.exit(EXIT_BLOCK);
}
