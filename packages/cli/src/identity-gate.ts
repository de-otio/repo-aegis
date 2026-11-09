// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Changing which GitHub identity acts for an owner needs a person at a terminal
// (doc/plan-owner-identity.md §5.1, D2): it is an owner-registry change, gated
// exactly like `engagements add --personal-org` (same `requireTerminal` path,
// same five-part refusal), with its own code so a refusal names the right fix.
import { IDENTITY_NAME_REGEX, ORG_NAME_REGEX, refusalTrailer } from "@de-otio/repo-aegis-core";
import { requireTerminal, type RequireTerminalOptions } from "./require-terminal.js";

export const IDENTITY_CHANGE_NEEDS_TTY = "IDENTITY_CHANGE_NEEDS_TTY";

/** The command a person runs to do what was refused. Built from typed arguments, echoed only when plainly a name. */
export type IdentityCommand =
  | { kind: "identity-add"; name: string }
  | { kind: "identity-remove"; name: string }
  | { kind: "identity-require-off" }
  | { kind: "set-identity-engagement"; id: string }
  | { kind: "set-identity-personal-org"; org: string };

const ID_ECHO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function echo(raw: string, re: RegExp, placeholder: string): string {
  const t = raw.trim().toLowerCase();
  return re.test(t) ? t : placeholder;
}

function describe(cmd: IdentityCommand): { refused: string; fix: string } {
  switch (cmd.kind) {
    case "identity-add": {
      const n = echo(cmd.name, IDENTITY_NAME_REGEX, "<name>");
      return { refused: `identity add ${n}`, fix: `repo-aegis identity add ${n} --gh-login <login>   (or --app <slug>)` };
    }
    case "identity-remove": {
      const n = echo(cmd.name, IDENTITY_NAME_REGEX, "<name>");
      return { refused: `identity remove ${n}`, fix: `repo-aegis identity remove ${n}` };
    }
    case "identity-require-off":
      return { refused: "identity require --off", fix: "repo-aegis identity require --off" };
    case "set-identity-engagement": {
      const id = ID_ECHO.test(cmd.id.trim()) ? cmd.id.trim() : "<engagement-id>";
      return {
        refused: `engagements set-identity ${id}`,
        fix: `repo-aegis engagements set-identity ${id} --person <name> --agent <name>`,
      };
    }
    case "set-identity-personal-org": {
      const o = echo(cmd.org, ORG_NAME_REGEX, "<org>");
      return {
        refused: `engagements set-identity --personal-org ${o}`,
        fix: `repo-aegis engagements set-identity --personal-org ${o} --person <name> --agent <name>`,
      };
    }
  }
}

/** The five-part refusal of doc/plan-unregistered-owner-egress.md §3.9. Never includes registry contents. */
export function identityChangeRefusal(cmd: IdentityCommand): string {
  const { refused, fix } = describe(cmd);
  return (
    `${refused}: refused. ` +
    `Identities decide which GitHub account acts for an owner, so only a person at a terminal can change them ` +
    `(an agent that chose its own identity would undo the point of having one; this is the same rule as adding an owner). ` +
    `No approval covers this, and REPO_AEGIS_EGRESS_HUMAN is not honoured here. ` +
    `A person runs, from a terminal: ${fix}. ` +
    `Agents: do not retry or reroute; ask your human to run this command themselves. ` +
    refusalTrailer(IDENTITY_CHANGE_NEEDS_TTY)
  );
}

/** Gate an identity change: exit 2 with `IDENTITY_CHANGE_NEEDS_TTY` unless a person is at a terminal. */
export function requireTerminalForIdentityChange(cmd: IdentityCommand, opts: RequireTerminalOptions): void {
  requireTerminal(IDENTITY_CHANGE_NEEDS_TTY, identityChangeRefusal(cmd), opts);
}
