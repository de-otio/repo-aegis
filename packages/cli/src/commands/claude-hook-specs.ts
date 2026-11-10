// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// The CLI arguments and matchers of the Claude Code hooks `install claude-md`
// registers into the user's `settings.json` (`install-claude-md.ts`).

/**
 * The CLI arguments of the PostToolUse hook on Write/Edit/MultiEdit. The
 * `command` written into `settings.json` runs them on the pinned node and
 * CLI by absolute path (D7 of doc/plan-pin-enforcement-binary.md), never a
 * `repo-aegis` resolved through PATH; `jq` is not needed because the
 * subcommand parses stdin JSON natively.
 *
 * Keep these arguments stable across releases: `install claude-md` and
 * `--uninstall` recognise an existing entry, pinned or by name, by them.
 */
export const HOOK_ARGS = "hook scan-after-write";

/**
 * PreToolUse hook command for cross-org write refusal. Same matcher
 * as `HOOK_ARGS` (Write|Edit|MultiEdit) but a different event
 * (PreToolUse), so a non-zero exit blocks the tool *before* it runs.
 * Added in v0.3.0 to make the cross-org-write refusal genuine
 * prevention rather than post-write detection.
 */
export const CHECK_WRITE_HOOK_ARGS = "hook check-write";

/**
 * SessionStart hook command — Phase 1 onboarding. Calls
 * `firstTouchClassify` and emits the result as JSON. Same naming
 * stability rule as `HOOK_ARGS` above.
 */
export const FIRST_TOUCH_HOOK_ARGS = "hook first-touch";

export const FIRST_TOUCH_HOOK_MATCHER = "*";

/**
 * PostToolUse hook command for Bash output scanning. Invoked with a
 * `Bash` matcher entry, distinct from the file-write matcher. Same
 * naming-stability rule as the other hook commands.
 */
export const BASH_HOOK_ARGS = "hook scan-bash-output";

export const BASH_HOOK_MATCHER = "Bash";

/**
 * PreToolUse(Bash) egress guard — doc/design/egress-guard.md §4. Judges
 * the *destination* of a publishing command before the shell runs it, which
 * is the axis every content-based control in this tool is blind to. The
 * `--agent claude` flag is explicit rather than defaulted so the registered
 * command reads the same as the Codex / Gemini snippets in
 * doc/agent-install.md, where the flag is what selects the `ask` degradation.
 *
 * Same naming-stability rule as the other hook commands: changing this
 * string does not auto-update anyone's settings.json.
 */
export const GUARD_EGRESS_HOOK_ARGS = "hook guard-egress --agent claude";

/**
 * PostToolUse(Bash) receipt — doc/design/egress-guard.md §5. Shares the
 * `Bash` matcher entry with `scan-bash-output`; both hooks run on the same
 * tool result and neither replaces the other.
 */
export const EGRESS_RECEIPT_HOOK_ARGS = "hook egress-receipt";

/**
 * UserPromptSubmit — revokes the prompt approvals (a yes at the agent's permission prompt, recorded by the guard hook;
 * doc/design/egress-guard.md §4a.1) when the person types. A yes covers the one command it was given for, and a person
 * who types something after answering has moved on: the push that comes later asks again. Silent, exits 0, never
 * blocks the prompt. The event has no matcher, so `*` is a placeholder the settings shape wants.
 */
export const PROMPT_SUBMIT_HOOK_ARGS = "hook prompt-submit";

export const PROMPT_SUBMIT_HOOK_MATCHER = "*";

export const HOOK_MATCHER = "Write|Edit|MultiEdit";
