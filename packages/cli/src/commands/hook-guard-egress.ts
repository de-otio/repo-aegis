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
  decideEgress,
  recordWorkingTree,
  describeVerb,
  isHumanPresent,
  loadRegistry,
  parseEgressIntents,
  RegistryEncryptedError,
  RegistryNotFoundError,
  type Destination,
  type EgressDecision,
  type Registry,
} from "@de-otio/repo-aegis-core";
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

/** Read stdin to a string, capped at 1 MiB (same cap as `hook check-write`). */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  const MAX = 1024 * 1024;
  for await (const chunk of process.stdin) {
    const b = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    total += b.length;
    if (total > MAX) break;
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const EMPTY_REGISTRY: Registry = {
  engagements: [],
  alwaysBlock: [],
  personalOrgs: [],
  schemaVersion: 2,
};

/**
 * The registry is optional here. The shape rules need no registry at all,
 * and a guard that refused to run because a registry was missing or
 * encrypted would be inert exactly where it is most needed (a fresh machine,
 * a locked registry). So every failure falls back to an empty registry and
 * the condition travels with the decision instead.
 */
function loadRegistryOrEmpty(): { registry: Registry; note?: string } {
  try {
    return { registry: loadRegistry() };
  } catch (err) {
    if (err instanceof RegistryNotFoundError) {
      return { registry: EMPTY_REGISTRY };
    }
    if (err instanceof RegistryEncryptedError) {
      return {
        registry: EMPTY_REGISTRY,
        note: "registry is encrypted, so only the shape rules ran (context rules need a readable registry)",
      };
    }
    return {
      registry: EMPTY_REGISTRY,
      note: "registry could not be read, so only the shape rules ran (context rules need a readable registry)",
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
): { org: string; repo: string; visibility: string; class: string } | undefined {
  if (!d) return undefined;
  return {
    org: d.org,
    repo: d.repo,
    visibility: d.classKnown ? d.visibility : "unknown",
    class: d.classKnown ? d.class : "unknown",
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
    stdinText = await readStdin();
  } catch (err) {
    process.stderr.write(
      `repo-aegis: hook guard-egress could not read stdin: ${(err as Error).message}\n`,
    );
    process.exit(EXIT_INTERNAL_ERROR);
  }

  let decision: EgressDecision;
  let registryNote: string | undefined;
  try {
    const { command, cwd, toolName } = parseHookInput(stdinText);
    if (toolName !== undefined && !SHELL_TOOL_NAMES.has(toolName.toLowerCase())) process.exit(0);
    if (command === undefined) process.exit(0);

    const intents = parseEgressIntents(command);
    // The common case: no publishing operation in the command line. Exit
    // before touching the registry or the filesystem.
    if (intents.length === 0) process.exit(0);

    const loaded = loadRegistryOrEmpty();
    registryNote = loaded.note;

    // Write-through: whatever this directory declares about its own origin
    // goes into the machine-wide destination cache, so the next command that
    // names this repository from *elsewhere* is judged by that declaration.
    // Best-effort by contract; a cache miss is not a reason to block.
    recordWorkingTree(cwd ?? process.cwd());

    decision = decideEgress({
      intents,
      cwd: cwd ?? process.cwd(),
      registry: loaded.registry,
      humanPresent: isHumanPresent(),
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

  const reason = registryNote === undefined ? decision.reason : `${decision.reason} (${registryNote})`;

  if (decision.action === "ask") {
    writeDecisionJson("ask", reason);
    process.exit(0);
  }

  const details: Record<string, unknown> = { verb: describeVerb(decision.intent.verb) };
  const dest = destinationDetails(decision.destination);
  if (dest !== undefined) details["destination"] = dest;
  if (registryNote !== undefined) details["registry"] = registryNote;

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
