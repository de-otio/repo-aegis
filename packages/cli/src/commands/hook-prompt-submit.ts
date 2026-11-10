// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `repo-aegis hook prompt-submit` — the Claude Code UserPromptSubmit hook
// (doc/design/egress-guard.md §4a.1).
//
// A prompt approval is a person's yes at the host's permission prompt, for one exact command. It is recorded when the
// guard hook asks, BEFORE the answer, so a "no" leaves it live for up to two minutes. This hook closes the rest of that
// window interactively: the moment the person types anything, every prompt approval is revoked. After a "no", the
// person's next message ends it; after a "yes", a push that happens after the person typed again asks again.
//
// It is silent (plain stdout on this event becomes context for the model, so it prints nothing), it exits 0 on every
// path, and it never blocks the prompt: a hook that can fail a person's message is worse than a leftover record that
// expires on its own. Terminal approvals (`repo-aegis approve`) are untouched.
import { appendAuditRecord, revokeAllPromptApprovals } from "@de-otio/repo-aegis-core";
import { recordDecision } from "../decision.js";

/** Read and discard stdin (the host writes the prompt JSON to it), capped so a huge prompt cannot stall the hook. */
async function drainStdin(): Promise<void> {
  let total = 0;
  for await (const chunk of process.stdin) {
    total += (chunk as Buffer).length;
    if (total > 1024 * 1024) break;
  }
}

export async function hookPromptSubmit(): Promise<void> {
  try {
    await drainStdin();
  } catch {
    /* the revoke below does not depend on what was typed */
  }
  try {
    const removed = revokeAllPromptApprovals();
    if (removed.length > 0) {
      // P1-I: one record per revoke that removed something (no prompt text: the hook never reads it).
      recordDecision({ layer: "prompt-submit", outcome: "notice", host: "claude-code" });
      try {
        appendAuditRecord({
          action: "egress-approval-revoke",
          cwd: process.cwd(),
          details: { removed, source: "prompt", layer: "hook prompt-submit" },
        });
      } catch {
        /* audit must not block the prompt */
      }
    }
  } catch {
    /* never block the prompt */
  }
  process.exit(0);
}
