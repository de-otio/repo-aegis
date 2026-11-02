// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// "Is a person present?" for the egress layers (rules g and h): the hook, the
// `gh` shim and the pre-push hook. A TTY on stderr that no agent host or pty
// wrapper sits above, or the documented human-only env override.
//
// Policy when the process ancestry cannot be read: keep today's TTY result and
// SAY SO (one stderr line). Blocking a person's own publish is the worse
// failure here. `approve` and owner adds choose the opposite and refuse
// (require-terminal.ts). See core/process-ancestry.ts for what the walk cannot
// see.
import { humanPresence } from "@de-otio/repo-aegis-core";

export const ANCESTRY_UNDETERMINABLE_NOTE =
  "repo-aegis: note: could not read the process list to check that no agent runs this terminal; " +
  "the terminal alone decided that a person is present.";

/** {@link humanPresence} for this process, reporting the undeterminable-ancestry case on stderr. */
export function currentHumanPresent(): boolean {
  const presence = humanPresence();
  if (presence.ancestry === "undeterminable") process.stderr.write(`${ANCESTRY_UNDETERMINABLE_NOTE}\n`);
  return presence.present;
}
