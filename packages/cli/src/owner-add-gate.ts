// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// D8 of doc/plan-unregistered-owner-egress.md: adding an owner (or an
// upstream) to the registry needs a person at a terminal. Without the gate,
// rule h ("refuse egress to an unregistered owner") is undone by one
// non-interactive command.
import { ORG_NAME_REGEX, appendAuditRecord } from "@de-otio/repo-aegis-core";
import { requireTerminal, type RequireTerminalOptions } from "./require-terminal.js";

export const OWNER_ADD_NEEDS_TTY = "OWNER_ADD_NEEDS_TTY";

/**
 * Echo a user-typed token into the refusal only when it is plainly an owner
 * or id (so a hostile argument cannot smuggle text into a message an agent
 * reads); otherwise show the placeholder.
 */
function safeToken(raw: string, re: RegExp, placeholder: string): string {
  const t = raw.trim().toLowerCase();
  return re.test(t) ? t : placeholder;
}

const OWNER_REPO_ECHO = /^[a-z0-9][a-z0-9-]*\/[a-z0-9._-]{1,100}$/;
const ID_ECHO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * The command a person runs to do what was refused. Built from the typed
 * arguments, never from registry contents.
 */
export type OwnerAddCommand =
  | { kind: "personal-org"; owners: readonly string[] }
  | { kind: "github-org"; owners: readonly string[]; engagementId?: string }
  | { kind: "upstream"; target: string }
  | { kind: "init-migrate" };

function describeCommand(cmd: OwnerAddCommand): { refused: string; fix: string } {
  switch (cmd.kind) {
    case "personal-org": {
      const owners = cmd.owners.map(o => safeToken(o, ORG_NAME_REGEX, "<org>"));
      const flags = owners.map(o => `--personal-org ${o}`).join(" ");
      return {
        refused: `engagements add ${flags}`,
        fix: `repo-aegis engagements add ${flags}`,
      };
    }
    case "github-org": {
      const owners = cmd.owners.map(o => safeToken(o, ORG_NAME_REGEX, "<org>"));
      const flags = owners.map(o => `--github-org ${o}`).join(" ");
      const id = cmd.engagementId === undefined ? "<engagement-id>" : safeIdToken(cmd.engagementId);
      return {
        refused: `engagements add ${id} ${flags}`,
        fix: `repo-aegis engagements add ${id} ${flags}`,
      };
    }
    case "upstream": {
      const t = safeToken(cmd.target, OWNER_REPO_ECHO, "<owner>/<repo>");
      return { refused: `upstreams add ${t}`, fix: `repo-aegis upstreams add ${t}` };
    }
    case "init-migrate":
      // The owners come from classify.yml, not from the command line, so they
      // are not echoed: they may be customer names.
      return { refused: "init --migrate-classify", fix: "repo-aegis init --migrate-classify" };
  }
}

function safeIdToken(raw: string): string {
  const t = raw.trim();
  return ID_ECHO.test(t) ? t : "<engagement-id>";
}

/**
 * The five-part refusal of doc/plan-unregistered-owner-egress.md §3.9: what,
 * why, whether an approval helps, the fix and who runs it, where to read more.
 *
 * NOTE: a shared core `refusal()` helper is being written in a parallel PR.
 * This builds the same five parts locally; swap it for the helper when that
 * lands. Never include registry contents, other owners or engagement ids.
 */
export function ownerAddRefusal(cmd: OwnerAddCommand): string {
  const { refused, fix } = describeCommand(cmd);
  const what =
    cmd.kind === "upstream"
      ? "Adding an upstream tells repo-aegis that publishing PRs and issues there is safe"
      : "Adding an owner tells repo-aegis that publishing there is safe";
  return (
    `${refused}: refused. ` +
    `${what}, so only a person at a terminal can do it (an agent that registered an owner would undo the refusal of egress to unregistered owners; ` +
    `this is the same rule as repo-aegis approve). ` +
    `No approval covers this, and REPO_AEGIS_EGRESS_HUMAN is not honoured here. ` +
    `A person runs, from a terminal: ${fix}. ` +
    `Agents: do not retry or reroute; ask your human to run this command themselves. ` +
    `[${OWNER_ADD_NEEDS_TTY}, see doc/agent-guide.md#${OWNER_ADD_NEEDS_TTY}]`
  );
}

/** Gate an owner or upstream add: exit 2 with `OWNER_ADD_NEEDS_TTY` unless a person is at a terminal. */
export function requireTerminalForOwnerAdd(
  cmd: OwnerAddCommand,
  opts: RequireTerminalOptions,
): void {
  requireTerminal(OWNER_ADD_NEEDS_TTY, ownerAddRefusal(cmd), opts);
}

/**
 * Audit record for a successful owner or upstream add. Counts and the kind
 * only, never the owner names: the audit log can be read back into an agent
 * transcript (`audit-log show`), and owners may be customer names.
 */
export interface OwnerAddAudit {
  kind: "personal-org" | "github-org" | "upstream" | "init-migrate";
  added: number;
  via: "engagements-add" | "upstreams-add" | "init-migrate-classify";
}

/** Best-effort: the audit log must never break the operation (it is off by default). */
export function recordOwnerAdd(audit: OwnerAddAudit): void {
  try {
    appendAuditRecord({
      action: "registry-owner-add",
      details: { kind: audit.kind, added: audit.added, via: audit.via },
    });
  } catch {
    /* audit log must not break user-facing ops */
  }
}

// ---------------------------------------------------------------------------
// Emptying the owner set (PR 5 review, H1)
// ---------------------------------------------------------------------------
//
// Under D4 a registry that loads with NO owners skips rule h entirely, so a
// change that leaves zero registered owners is equivalent to registering every
// owner. Removing one owner among several only tightens and stays ungated;
// removing the last one (or overwriting a populated registry with the empty
// stub) needs a person, exactly like adding.

export const OWNER_SET_EMPTY_NEEDS_TTY = "OWNER_SET_EMPTY_NEEDS_TTY";

export type EmptyingCommand =
  | { kind: "engagements-end"; id: string; purge: boolean }
  | { kind: "engagements-remove"; id: string }
  | { kind: "engagements-add"; id?: string }
  | { kind: "upstreams-add"; target: string }
  | { kind: "upstreams-remove"; target: string }
  | { kind: "init-force" }
  | { kind: "init-migrate" };

function describeEmptying(cmd: EmptyingCommand): string {
  switch (cmd.kind) {
    case "engagements-end":
      return `engagements end ${safeIdToken(cmd.id)}${cmd.purge ? " --purge" : ""}`;
    case "engagements-remove":
      return `engagements remove ${safeIdToken(cmd.id)} --hard`;
    case "engagements-add":
      return `engagements add ${cmd.id === undefined ? "<engagement-id>" : safeIdToken(cmd.id)}`;
    case "upstreams-add":
      return `upstreams add ${safeToken(cmd.target, OWNER_REPO_ECHO, "<owner>/<repo>")}`;
    case "upstreams-remove":
      return `upstreams remove ${safeToken(cmd.target, OWNER_REPO_ECHO, "<owner>/<repo>")}`;
    case "init-force":
      return "init --force";
    case "init-migrate":
      return "init --migrate-classify";
  }
}

/**
 * The five-part refusal of §3.9 for a change that would leave repo-aegis with
 * no registered owners. Names the command the caller typed, never registry
 * contents. (Swap for the core `refusal()` helper when it lands.)
 */
export function ownerSetEmptyRefusal(cmd: EmptyingCommand): string {
  const command = describeEmptying(cmd);
  const effect =
    cmd.kind === "init-force"
      ? "This would replace the registry with an empty one, discarding its owners, upstreams, engagements, markers and always-block patterns"
      : "This change would leave no registered owners (no personalOrgs and no active engagement githubOrgs)";
  return (
    `${command}: refused. ` +
    `${effect}. With no owners registered, the refusal of egress to unregistered owners (rule h) switches itself off, ` +
    `so emptying the owner set is the same as registering every owner, and only a person at a terminal can do it ` +
    `(removing one owner among several needs no terminal). ` +
    `No approval covers this, and REPO_AEGIS_EGRESS_HUMAN is not honoured here. ` +
    `A person runs, from a terminal: repo-aegis ${command}. ` +
    `Agents: do not retry or reroute; ask your human to run this command themselves. ` +
    `[${OWNER_SET_EMPTY_NEEDS_TTY}, see doc/agent-guide.md#${OWNER_SET_EMPTY_NEEDS_TTY}]`
  );
}
