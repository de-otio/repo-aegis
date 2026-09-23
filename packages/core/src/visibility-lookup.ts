// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Refreshing an UNKNOWN destination visibility at the moment of egress
// (issue #114).
//
// The egress gate treats an unknown visibility as public
// (`treatAsPublicDestination`), which is correct but, on its own, would leave
// every push to a repository nobody has run `classify` / `status` in asking
// for a person forever. So when a destination's visibility is unknown, the
// guard asks GitHub once — `gh repo view <org>/<repo> --json visibility`,
// with a short timeout — and writes a positive answer into the same
// `repo-aegis.visibility` git-config cache `classify` / `status` populate, so
// the next call is offline again.
//
// The lookup can only ever REPLACE "unknown" with an answer. It never runs
// when a value is cached, and every failure — no `gh`, no auth, no network, a
// timeout, an answer we cannot parse — returns null, which leaves the
// destination unknown and therefore refused without a person. The fail-closed
// path does not depend on the network being there; only the convenience does.
import { execFileSync } from "node:child_process";
import type { RepoVisibility } from "./egress.js";
import { recordWorkingTree } from "./destination-cache.js";

/**
 * Ask GitHub for `org/repo`'s visibility. `null` means "could not find out" —
 * for any reason. Injectable for tests; tests must never reach the network.
 */
export type VisibilityLookup = (org: string, repo: string) => "public" | "private" | null;

/**
 * Set to `0` to disable the live lookup entirely: an unknown visibility then
 * stays unknown (and is refused without a person). For machines where a
 * hook must never spawn `gh`, and for the test suite.
 */
export const VISIBILITY_LOOKUP_ENV = "REPO_AEGIS_VISIBILITY_LOOKUP";

/** Hard ceiling on one lookup: it runs inside a pre-push hook. */
export const VISIBILITY_LOOKUP_TIMEOUT_MS = 5_000;

/**
 * Appended to a refusal whose destination is public only because its
 * visibility is unknown. Points at `status`, which asks GitHub — never at
 * setting the git-config value by hand, which is a declaration an agent must
 * not be told to make for itself.
 */
export const UNKNOWN_VISIBILITY_HINT =
  " Its visibility is not cached and could not be looked up (`gh repo view` did not answer), " +
  "so it is treated as public; if it is private, `repo-aegis status` from its checkout records that.";

// A GitHub org never starts with `-`, so `<org>/<repo>` can never be read by
// `gh` as an option; `.` / `..` are not repositories.
const ORG_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const REPO_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Default {@link VisibilityLookup}: `gh repo view <org>/<repo> --json
 * visibility`. `INTERNAL` (GitHub Enterprise) maps to private, as in
 * `status`. stderr is piped, never inherited: `gh`'s error text names the
 * org/repo, which may itself be a customer marker.
 */
export const lookupVisibilityViaGh: VisibilityLookup = (org, repo) => {
  if (!ORG_RE.test(org) || !REPO_RE.test(repo) || repo === "." || repo === "..") return null;
  try {
    const out = execFileSync(
      "gh",
      ["repo", "view", `${org}/${repo}`, "--json", "visibility", "--jq", ".visibility"],
      {
        encoding: "utf8",
        timeout: VISIBILITY_LOOKUP_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GH_PROMPT_DISABLED: "1" },
      },
    )
      .trim()
      .toLowerCase();
    if (out === "public") return "public";
    if (out === "private" || out === "internal") return "private";
    return null;
  } catch {
    return null;
  }
};

/** The lookup to use: the injected one, none when disabled by env, else `gh`. */
export function effectiveVisibilityLookup(
  injected: VisibilityLookup | undefined,
  env: NodeJS.ProcessEnv = process.env,
): VisibilityLookup | null {
  if (injected !== undefined) return injected;
  if (env[VISIBILITY_LOOKUP_ENV] === "0") return null;
  return lookupVisibilityViaGh;
}

/**
 * Resolve an unknown visibility for `org/repo` and, when there is a checkout
 * to hold it, cache the answer there (`git config repo-aegis.visibility`)
 * and refresh the machine-wide destination cache from it. Returns the
 * visibility to use now — the lookup's answer, or `unknown` unchanged.
 *
 * Callers pass only destinations whose visibility is already unknown; a
 * known value is never re-asked or overwritten here. `repo === "*"` (an
 * org-level API endpoint) has no visibility to look up and stays unknown.
 * Never throws.
 */
export function refreshUnknownVisibility(
  target: { org: string; repo: string; workingTree?: string },
  lookup: VisibilityLookup | null,
): RepoVisibility {
  if (lookup === null || target.repo === "*") return "unknown";
  let vis: "public" | "private" | null = null;
  try {
    vis = lookup(target.org, target.repo);
  } catch {
    vis = null;
  }
  if (vis === null) return "unknown";
  if (target.workingTree !== undefined) {
    try {
      execFileSync("git", ["config", "repo-aegis.visibility", vis], {
        cwd: target.workingTree,
        stdio: ["ignore", "ignore", "ignore"],
      });
      recordWorkingTree(target.workingTree);
    } catch {
      /* best-effort: the answer still applies to this call */
    }
  }
  return vis;
}
