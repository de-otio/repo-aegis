// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `repo-aegis identity list [--json]`: every registry identity and which personal orgs and engagements use it
// as their `person` (acts when a person is present) and `agent` (acts when none is) identity.
//
// READ-ONLY, so an agent may run it (it is the one `identity` subcommand the human-only list lets through; see
// core/human-commands.ts). It answers the question a refusal such as GH_IDENTITY_WRITE_NEEDS_HUMAN raises:
// "which account does repo-aegis think acts for this owner?". What it prints is what `status` already prints:
// names, kinds, a login or an App slug, and the mapping. Never a token, a key, or a key file's path or contents:
// the registry holds none (an identity is a name plus a login or a slug), and nothing here reads anything else.
//
// Redaction follows `status`: an Enterprise Managed User login carries a shortcode that can name a customer, so
// TEXT prints a login only when a personal org (the operator's own) uses the identity; an engagement-only or
// unreferenced one prints `<engagement-only login>`. `--json` carries every login, as `status --json` does.
// Engagements are named by id, never by their orgs.
import { loadRegistry, ghLoginProblem, RegistryNotFoundError, type Registry } from "@de-otio/repo-aegis-core";
import { emitJson, emitText, emitError, type OutputOptions } from "../format.js";
import { summariseIdentities, ENGAGEMENT_ONLY_LOGIN } from "./status.js";

/** What the text prints in place of a login that is empty or not GitHub login syntax. It never prints the login. */
export const NOT_A_VALID_LOGIN = "(not a valid GitHub login)";

export interface IdentityUse {
  readonly kind: "personal-org" | "engagement";
  readonly target: string;
}

export interface IdentityListEntry {
  readonly name: string;
  readonly kind: "gh-login" | "github-app";
  readonly login?: string;
  /** Set when the login is empty or not GitHub login syntax. */
  readonly loginProblem?: "empty" | "invalid";
  readonly app?: string;
  /** Where this identity is the `person` column / the `agent` column. */
  readonly person: readonly IdentityUse[];
  readonly agent: readonly IdentityUse[];
}

export interface IdentityList {
  readonly requireIdentity: boolean;
  readonly identities: readonly IdentityListEntry[];
}

/** Pure: the identities of a loaded registry, with where each is used. Sorted by name. */
export function buildIdentityList(reg: Registry): IdentityList {
  const sum = summariseIdentities(reg);
  const uses = (column: "person" | "agent", name: string): IdentityUse[] =>
    sum.mappings.filter(m => m[column] === name).map(m => ({ kind: m.kind, target: m.target }));
  const identities = [...sum.identities]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((i): IdentityListEntry => {
      const base = { name: i.name, kind: i.kind, person: uses("person", i.name), agent: uses("agent", i.name) };
      if (i.kind === "github-app") return { ...base, ...(i.app !== undefined && { app: i.app }) };
      const problem = ghLoginProblem(i.login);
      return { ...base, login: i.login ?? "", ...(problem !== null && { loginProblem: problem }) };
    });
  return { requireIdentity: sum.requireIdentity, identities };
}

function useText(uses: readonly IdentityUse[]): string {
  return uses.length === 0 ? "-" : uses.map(u => `${u.kind} ${u.target}`).join(", ");
}

/** The text form. A login is shown only when a personal org uses the identity; see the header. */
export function identityListLines(list: IdentityList): string[] {
  if (list.identities.length === 0) return ["no identities defined (add one with `identity add`; a person runs it)"];
  const lines = [`identities${list.requireIdentity ? " (requireIdentity)" : ""}:`];
  for (const i of list.identities) {
    let shown: string;
    if (i.kind === "github-app") shown = i.app ?? "";
    else if (i.loginProblem !== undefined) shown = NOT_A_VALID_LOGIN;
    else shown = i.person.concat(i.agent).some(u => u.kind === "personal-org") ? (i.login ?? "") : ENGAGEMENT_ONLY_LOGIN;
    lines.push(`  ${i.name}: ${i.kind} ${shown}`);
    lines.push(`    person: ${useText(i.person)}`);
    lines.push(`    agent:  ${useText(i.agent)}`);
  }
  return lines;
}

export function identityList(opts: OutputOptions): void {
  let list: IdentityList;
  try {
    list = buildIdentityList(loadRegistry());
  } catch (err) {
    if (err instanceof RegistryNotFoundError) {
      emitError({ code: "REGISTRY_NOT_FOUND", error: "registry not found; run `repo-aegis init` first" }, opts);
    }
    // A registry that does not load names orgs and engagement ids in its parse error: say only that it failed.
    emitError({ code: "REGISTRY_UNREADABLE", error: "the registry could not be read; run `repo-aegis doctor`" }, opts);
  }
  if (opts.json) {
    emitJson(list);
    return;
  }
  for (const line of identityListLines(list)) emitText(line);
}
