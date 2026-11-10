// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// "Is a person present?" for the egress layers (rules g and h): the hook, the
// `gh` shim and the pre-push hook. A TTY on stderr that no agent host or pty
// wrapper sits above, or the documented human-only env override.
//
// Policy when the process ancestry cannot be read, or has no positive root
// (login, sshd, a terminal emulator, an attached multiplexer): keep today's TTY
// result and SAY SO (one stderr line). Blocking a person's own publish is the
// worse failure here. `approve` and owner adds choose the opposite and refuse
// (require-terminal.ts). See core/process-ancestry.ts for what the walk cannot
// see.
import { humanPresence, type HumanPresence } from "@de-otio/repo-aegis-core";

export const ANCESTRY_UNDETERMINABLE_NOTE =
  "repo-aegis: note: could not confirm from the process list that a person runs this terminal (it is unreadable, " +
  "or the chain has no login session, terminal emulator or attached tmux/screen at its root); " +
  "the terminal alone decided that a person is present.";

/**
 * The last presence verdict this process read, for the decision log's `psReadable` fact. Mutated by
 * {@link currentHumanPresent} only; a process makes one decision, so one memo is enough.
 */
let lastPresence: HumanPresence | null = null;

/** {@link humanPresence} for this process, reporting the undeterminable-ancestry case on stderr. */
export function currentHumanPresent(): boolean {
  const presence = humanPresence();
  lastPresence = presence;
  if (presence.ancestry === "undeterminable") process.stderr.write(`${ANCESTRY_UNDETERMINABLE_NOTE}\n`);
  return presence.present;
}

/**
 * Whether the process table could be read, as far as this process has looked: `false` when the ancestry was
 * `undeterminable` (the sandbox blocks `ps`), `true` when it was walked (`clear` or `agent`), and `undefined` when it
 * was never read (no TTY, so nothing was walked).
 */
export function psReadableFact(presence: HumanPresence | null = lastPresence): boolean | undefined {
  if (presence === null) return undefined;
  if (presence.ancestry === "undeterminable") return false;
  return presence.ancestry === "skipped" ? undefined : true;
}
