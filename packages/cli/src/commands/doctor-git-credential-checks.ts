// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `doctor`'s credential-helper order check (doc/plan-owner-identity.md §12.1 A6). An agent's HTTPS push gets its
// narrowed App token only if the repo-aegis helper is the FIRST helper git runs for https://github.com: a reset
// entry, a system-scope `osxkeychain`, or `gh auth setup-git` can put another one first, and that one answers
// with the person's credential. So when any owner is mapped to an agent identity, a wrong order is a failure.
import { repoAegisHome, type Registry } from "@de-otio/repo-aegis-core";
import { currentEnforcementPin } from "../enforcement-pin.js";
import { scopeLabel, helperOrder, readCredentialConfig, type ConfigEntry } from "../git-credential-config.js";
import type { DoctorCheck } from "./doctor-checks.js";
import { helperCommand } from "./install-git-credential.js";

/** True when some owner has an `agent` identity, so an agent push there must go through the helper. */
export function hasMappedAgentIdentity(registry: Registry): boolean {
  for (const entry of registry.identityMap?.values() ?? []) if (entry.agent !== undefined) return true;
  return false;
}

export interface GitCredentialCheckOptions {
  /** Test seams. */
  entries?: readonly ConfigEntry[] | null;
  helper?: string;
  cwd?: string;
}

export function gitCredentialOrderChecks(registry: Registry, opts: GitCredentialCheckOptions = {}): DoctorCheck[] {
  if (!hasMappedAgentIdentity(registry)) return [];
  const entries = opts.entries !== undefined ? opts.entries : readCredentialConfig(opts.cwd ?? process.cwd());
  if (entries === null) {
    return [
      {
        code: "GIT_CREDENTIAL_HELPER_ORDER",
        ok: true,
        skipped: true,
        detail: "git's configuration could not be read, so the credential helper order was not checked",
        fix: "run `git config --list --show-scope` and fix what it reports",
      },
    ];
  }
  const ours = opts.helper ?? helperCommand(currentEnforcementPin(), repoAegisHome());
  const verdict = helperOrder(entries, ours);
  if (verdict.kind === "first") {
    return [{ code: "GIT_CREDENTIAL_HELPER_ORDER", ok: true, detail: "the repo-aegis git credential helper is the first helper for https://github.com" }];
  }
  const detail =
    verdict.kind === "behind"
      ? `another credential helper for github.com (${scopeLabel(verdict.precededBy.scope)} scope) answers before the repo-aegis helper, so an agent's HTTPS push there gets the person's credential, not the App token`
      : verdict.stale
        ? "the configured repo-aegis credential helper is from a different install (a moved or upgraded CLI or Node), so it is not the pinned one"
        : "an owner is mapped to an agent identity, but the repo-aegis git credential helper is not installed, so an agent's HTTPS push there gets the person's credential, not the App token";
  return [
    {
      code: "GIT_CREDENTIAL_HELPER_ORDER",
      ok: false,
      detail,
      fix: `a person runs, from a terminal: repo-aegis install git-credential   (it refuses, with instructions, when a system-scope helper or a global one with no reset in front would still answer first)`,
    },
  ];
}
