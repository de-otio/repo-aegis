// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// The shared refusal builder (doc/plan-unregistered-owner-egress.md §3.9).
//
// A refusal is the only thing an agent and its human ever see of the guard.
// A vague one teaches both to work around it. So every refusal built here
// answers five questions, in this order:
//
//   1. WHAT was refused: the verb and the destination.
//   2. WHY, in one plain sentence that names the rule's idea, not its letter.
//   3. Does an APPROVAL help? Said either way.
//   4. The FIX, and WHO runs it: a person from a terminal, or the agent
//      re-issuing the command. An agent must be able to tell from the text
//      alone that it may not run a person's step itself.
//   5. WHERE to read more: the code and `doc/agent-guide.md#<code>`.
//
// One builder, so the agent hook, the `gh` shim and the pre-push hook cannot
// drift apart in wording.
//
// Callers pass only what the command already says (the verb, the destination
// owner/repo). Never registry contents, other owners, engagement ids, payload
// bytes or matched strings: the reason can land in an agent transcript.

/** One remedy, and who carries it out. */
export interface RefusalFix {
  /**
   * `person`: must be run by a human at a terminal; an agent must not run it.
   * `agent`: the agent re-issues its own command in this shape.
   */
  by: "person" | "agent";
  /**
   * The exact command (or, for `agent`, the shape to re-issue as). May be
   * omitted for a `person` step that is simply "run the original command
   * yourself".
   */
  command?: string;
  /** Leading condition, e.g. `If "acme" is yours`. Rendered as `<when>, a person runs…`. */
  when?: string;
  /** Short trailing remark, rendered in parentheses. */
  note?: string;
}

export interface RefusalInput {
  /** The refusal code, e.g. `UNREGISTERED_OWNER_EGRESS`. */
  code: string;
  /** What was refused, e.g. `gh issue create → stranger/repo`. */
  what: string;
  /** Why, in one self-sufficient sentence. Some hosts truncate the reason. */
  why: string;
  /** Whether an approval helps, as a sentence (`No approval covers this.` or the one that would). */
  approval: string;
  /** The remedies, each marked as a person's step or an agent re-issue. */
  fixes: readonly RefusalFix[];
}

function sentence(text: string): string {
  const t = text.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

function renderFix(fix: RefusalFix): string {
  const note = fix.note !== undefined ? ` (${fix.note})` : "";
  if (fix.by === "person") {
    const lead = fix.when !== undefined ? `${fix.when}, a person runs` : "A person runs";
    return fix.command !== undefined
      ? `${lead}, from a terminal: ${fix.command}${note}.`
      : `${lead} the original command, from a terminal${note}.`;
  }
  const lead = fix.when !== undefined ? `${fix.when}, re-issue as` : "Re-issue as";
  return `${lead}: ${fix.command ?? "(no command given)"}${note}.`;
}

/** Where `doc/agent-guide.md` documents a code. */
export function agentGuideAnchor(code: string): string {
  return `doc/agent-guide.md#${code.toLowerCase()}`;
}

/**
 * Build the five-part refusal text:
 * `<what>: refused. <why> <approval> <fixes…> [<code>, see doc/agent-guide.md#<code>]`.
 */
export function refusal(input: RefusalInput): string {
  const parts = [`${input.what}: refused.`, sentence(input.why), sentence(input.approval)];
  for (const fix of input.fixes) parts.push(renderFix(fix));
  if (input.fixes.some(f => f.by === "person")) {
    parts.push("Agents: do not run that yourself, retry or reroute; report this to your human.");
  }
  parts.push(`[${input.code}, see ${agentGuideAnchor(input.code)}]`);
  return parts.join(" ");
}
