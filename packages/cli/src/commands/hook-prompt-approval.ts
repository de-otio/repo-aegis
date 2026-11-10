// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// The agent hook's half of prompt approvals (doc/design/egress-guard.md §4a.1): when the hook ASKS, and the host
// is Claude Code in a permission mode where a person answers the prompt, it records — before the answer — one
// short-lived approval per (intent, destination) that asked. The layers below the prompt (git's pre-push hook and
// the `gh` shim) may honour it for that exact command, for two minutes; the hook itself never reads one (F1).
//
// The record is written before the person answers, so a "no" leaves it behind. That is accepted and bounded by
// the exact binding and the TTL (spec §7); it is also why the hook ignores prompt records: after a "no", a
// different command to the same repository must still ask.
import { execFileSync } from "node:child_process";
import {
  appendAuditRecord,
  describeVerb,
  PROMPT_APPROVAL_MODES,
  PROMPT_APPROVAL_TTL_MS,
  promptBindingOf,
  recordPromptApproval,
  type EgressDecision,
  type PromptApproval,
  type PromptBinding,
} from "@de-otio/repo-aegis-core";
import { recordDecision, verbWords } from "../decision.js";

/** What the hook adds to an `ask`, and what it says on stderr. Both fixed text plus validated names. */
export interface PromptApprovalOutcome {
  /** One fixed sentence appended to the ask reason; absent when there is nothing to say. */
  sentence?: string;
  /** One stderr line, when a record could not be written. */
  stderr?: string;
}

export interface PromptApprovalContext {
  /** The adapter's `name`: only `claude` may write (the allowlist is Claude's vocabulary). */
  agent: string;
  /** The payload's `permission_mode`, if it was a short string. */
  permissionMode: string | undefined;
  sessionId: string | undefined;
  /** Where the command will run (`resolveHead` and the audit record read it). */
  cwd: string;
  /** Test seam: the directory → current branch lookup. */
  resolveHead?: (dir: string) => string | null;
  /** Test seam: the clock. */
  now?: Date;
}

/** The current branch of the checkout at `dir`, or null (detached, not a repository, git missing). Two-second cap. */
export function currentBranch(dir: string): string | null {
  try {
    const out = execFileSync("git", ["-C", dir, "symbolic-ref", "--short", "-q", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    }).trim();
    return out === "" ? null : out;
  } catch {
    return null;
  }
}

/** A ref worth printing in the prompt text: plain ref characters only. Anything else is left out of the sentence. */
function printableRef(ref: string): string {
  return /^[A-Za-z0-9._/+-]{1,200}$/.test(ref) ? ` ref ${ref}` : "";
}

function carries(written: readonly PromptApproval[]): string {
  const items = written.map(a => `this ${describeVerb(a.verb)} to ${a.org}/${a.repo}${a.ref !== undefined ? printableRef(a.ref) : ""}`);
  const viaGit = written.some(a => a.verb === "git-push");
  const viaGh = written.some(a => a.verb !== "git-push");
  const layer = viaGit && viaGh ? "git's pre-push hook / the gh shim" : viaGit ? "git's pre-push hook" : "the gh shim";
  return (
    `A yes here lets ${items.join(" and ")} through ${layer} for ${PROMPT_APPROVAL_TTL_MS / 60_000} minutes; ` +
    `any other command asks again.`
  );
}

function noCarry(why: string, b: PromptBinding): string {
  return `${why} a yes does not reach the layers below; a person mints \`repo-aegis approve ${b.org}/${b.repo}\` from a terminal.`;
}

/**
 * Record a prompt approval for every eligible `asked` entry of an `ask` decision and say what the yes will do. Never
 * throws: a failure becomes the stderr line and the verdict stays `ask`.
 */
export function writePromptApprovals(
  decision: Extract<EgressDecision, { action: "ask" }>,
  ctx: PromptApprovalContext,
): PromptApprovalOutcome {
  // Only Claude Code: another host's `permission_mode` (if it ever has one) must not inherit Claude's allowlist.
  if (ctx.agent !== "claude") return {};
  try {
    const resolveHead = ctx.resolveHead ?? currentBranch;
    const bindings: PromptBinding[] = [];
    const seen = new Set<string>();
    for (const entry of decision.asked) {
      const b = promptBindingOf(entry.intent, entry.destination, resolveHead, ctx.cwd);
      if (b === null) continue;
      const key = JSON.stringify(b);
      if (seen.has(key)) continue;
      seen.add(key);
      bindings.push(b);
    }
    const first = bindings[0];
    // Nothing a lower layer could honour (an unresolved destination, a delete…): nothing to write or to promise.
    if (first === undefined) return {};
    if (ctx.permissionMode === undefined || !PROMPT_APPROVAL_MODES.has(ctx.permissionMode)) {
      // P1-I: an approval not minted is a decision too (no prompt text, no command: the verb, destination and mode only).
      recordDecision({
        layer: "prompt-approval",
        outcome: "refuse",
        code: "PROMPT_APPROVAL_MODE_UNSUPPORTED",
        host: "claude-code",
        verb: verbWords(first.verb),
        destination: { org: first.org, repo: first.repo },
        ...(ctx.permissionMode !== undefined && { facts: { permissionMode: ctx.permissionMode } }),
      });
      return { sentence: noCarry("In this permission mode", first) };
    }
    const written: PromptApproval[] = [];
    let failed = 0;
    for (const b of bindings) {
      const a = recordPromptApproval({
        binding: b,
        permissionMode: ctx.permissionMode,
        ...(ctx.sessionId !== undefined && { session: ctx.sessionId }),
        ...(ctx.now !== undefined && { now: ctx.now }),
      });
      if (a === null) {
        failed++;
        recordDecision({
          layer: "prompt-approval",
          outcome: "refuse",
          code: "PROMPT_APPROVAL_NOT_RECORDED",
          host: "claude-code",
          verb: verbWords(b.verb),
          destination: { org: b.org, repo: b.repo },
          facts: { permissionMode: ctx.permissionMode },
        });
        continue;
      }
      written.push(a);
      recordDecision({
        layer: "prompt-approval",
        outcome: "allow",
        host: "claude-code",
        verb: verbWords(a.verb),
        destination: { org: a.org, repo: a.repo },
        approvalId: a.id,
        ...(a.ref !== undefined && { ref: a.ref }),
        facts: { permissionMode: a.permissionMode },
      });
      try {
        // Never the command text: the verb, the scope, the ref or endpoint, and the bounds.
        appendAuditRecord({
          action: "egress-approval-mint",
          cwd: ctx.cwd,
          details: {
            id: a.id,
            source: "prompt",
            verb: a.verb,
            scope: `${a.org}/${a.repo}`,
            ...(a.ref !== undefined && { ref: a.ref }),
            ...(a.endpoint !== undefined && { endpoint: a.endpoint }),
            expiresAt: a.expiresAt,
            permissionMode: a.permissionMode,
            ...(a.session !== undefined && { session: a.session }),
            layer: "hook guard-egress",
          },
        });
      } catch {
        /* audit must not block the ask */
      }
    }
    const stderr =
      failed > 0
        ? "repo-aegis: guard-egress: could not record a prompt approval; a yes at the prompt will not reach the layers below\n"
        : undefined;
    if (written.length === 0) {
      return { sentence: noCarry("The approval could not be recorded, so", first), ...(stderr !== undefined && { stderr }) };
    }
    return { sentence: carries(written), ...(stderr !== undefined && { stderr }) };
  } catch (err) {
    return {
      stderr: `repo-aegis: guard-egress: could not record a prompt approval: ${(err as Error).message}\n`,
    };
  }
}
