// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// GitHub repo-visibility probe + cache. The egress-hygiene gate
// (`isPublicFacing` in core) and the audit visibility-reconciliation check
// read a cached `repo-aegis.visibility` git-config value so they stay offline
// and fast (no per-commit API call). This module is the WRITE side: a
// best-effort `gh` probe whose result is cached for those readers.
//
// The probe reports WHY it could not answer, not just that it could not.
// Collapsing every failure to "unknown" (issue #97.1) made three very
// different situations identical: `gh` is not installed, this repo has no
// GitHub remote, and — the dangerous one — `gh` ran under an account that
// cannot see this repo. On a machine with two `gh` accounts (a personal one
// and an employer one) the third is routine: every public repo resolves and
// every PRIVATE repo 404s, so a whole org's private repos sit at whatever
// class was guessed for them with nothing to contradict it. "This account
// cannot see the repo" is actionable; "unknown" is not.
import { execFileSync } from "node:child_process";
import { readCachedVisibility, type RepoVisibility } from "@de-otio/repo-aegis-core";

/** Outcome of running one command: never throws, always classifiable. */
export interface CommandResult {
  /** True when the command ran and exited 0. */
  ok: boolean;
  stdout: string;
  stderr: string;
  /** `errno` code when the binary itself could not be spawned (e.g. ENOENT). */
  spawnCode?: string;
}

/** Injectable command runner (for tests). */
export type CommandRunner = (cmd: string, args: string[], cwd: string) => CommandResult;

function asText(v: unknown): string {
  if (typeof v === "string") return v;
  if (Buffer.isBuffer(v)) return v.toString("utf8");
  return "";
}

const defaultRun: CommandRunner = (cmd, args, cwd) => {
  try {
    const stdout = execFileSync(cmd, args, {
      cwd,
      encoding: "utf8",
      // stderr is PIPED, not inherited: the probe needs it to tell an
      // auth/404 failure from a missing remote, and letting it reach the
      // terminal would print `gh`'s message — which embeds the org/repo
      // name, i.e. potentially a customer name — into whatever log or
      // agent tool-result is capturing this process.
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout, stderr: "" };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: unknown; stderr?: unknown };
    return {
      ok: false,
      stdout: asText(e.stdout),
      stderr: asText(e.stderr),
      ...(e.code !== undefined && { spawnCode: e.code }),
    };
  }
};

/**
 * Why a probe did not produce a visibility.
 *
 * - `resolved`     — GitHub answered; `visibility` is authoritative.
 * - `no-gh`        — the `gh` binary is not installed / not on PATH.
 * - `no-remote`    — no GitHub remote to ask about (not a GitHub repo).
 * - `unauthorized` — `gh` ran but could not see this repo: wrong account,
 *                    missing scope, expired auth, or the repo genuinely does
 *                    not exist. All four need the same human action (check
 *                    which account `gh` is using), so they share a status.
 * - `unrecognised` — `gh` failed or answered in a way we cannot classify.
 */
export type VisibilityProbeStatus =
  | "resolved"
  | "no-gh"
  | "no-remote"
  | "unauthorized"
  | "unrecognised";

export interface VisibilityProbe {
  /** "unknown" for every status other than `resolved`. */
  visibility: RepoVisibility;
  status: VisibilityProbeStatus;
  /**
   * Fixed, human-readable explanation. Deliberately NOT `gh`'s own stderr:
   * that text carries the org/repo name, which in this tool's threat model
   * may itself be the customer marker we exist to keep out of logs.
   */
  detail: string;
  /** Actionable next step. Absent when `status === "resolved"`. */
  fix?: string;
}

const RESOLVED_FIX_FREE = (visibility: RepoVisibility, detail: string): VisibilityProbe => ({
  visibility,
  status: "resolved",
  detail,
});

/**
 * Classify a failed `gh repo view` by its stderr.
 *
 * Order matters: `gh`'s "no GitHub remote" message ends with "please use
 * `gh auth login`", so it would otherwise be misread as an auth failure.
 * The no-remote test therefore runs first.
 */
function classifyFailure(res: CommandResult): VisibilityProbe {
  if (res.spawnCode === "ENOENT") {
    return {
      visibility: "unknown",
      status: "no-gh",
      detail: "the `gh` CLI is not installed or not on PATH",
      fix: "install the GitHub CLI, or set the class explicitly: git config repo-aegis.class <class>",
    };
  }

  const err = res.stderr.toLowerCase();

  if (
    /no git remotes/.test(err) ||
    /none of the git remotes/.test(err) ||
    /not a git repository/.test(err) ||
    /no remotes found/.test(err)
  ) {
    return {
      visibility: "unknown",
      status: "no-remote",
      detail: "this repo has no GitHub remote",
    };
  }

  if (
    /could not resolve to a/.test(err) ||
    /http 401|http 403|http 404/.test(err) ||
    /\b404\b/.test(err) ||
    /not found/.test(err) ||
    /bad credentials/.test(err) ||
    /requires authentication/.test(err) ||
    /gh auth login/.test(err) ||
    /authentication token|not logged in|no accounts? (are )?logged/.test(err)
  ) {
    return {
      visibility: "unknown",
      status: "unauthorized",
      detail:
        "`gh` ran but could not see this repo — the active account may have no " +
        "access to this org, or its auth may be expired",
      fix:
        "check which account `gh` is using (`gh auth status`), then re-run with the " +
        "right one, e.g. GH_TOKEN=$(gh auth token --user <user>) repo-aegis status",
    };
  }

  return {
    visibility: "unknown",
    status: "unrecognised",
    detail: "`gh` failed in a way this probe does not recognise",
    fix: "run `gh repo view --json visibility` by hand to see the underlying error",
  };
}

/**
 * Probe GitHub for this repo's visibility via the `gh` CLI.
 *
 * Never throws. `visibility` is "unknown" for every non-`resolved` status —
 * callers must treat "unknown" as "don't change state" — but `status` says
 * which kind of not-knowing it is, and callers that can act on the
 * difference (see `status` and `classify`) must surface it.
 *
 * `INTERNAL` (GitHub Enterprise) maps to "private" — not publicly reachable.
 */
export function probeGithubVisibility(
  cwd: string,
  run: CommandRunner = defaultRun,
): VisibilityProbe {
  const res = run("gh", ["repo", "view", "--json", "visibility", "--jq", ".visibility"], cwd);
  if (!res.ok) return classifyFailure(res);

  const v = res.stdout.trim().toLowerCase();
  if (v === "public") return RESOLVED_FIX_FREE("public", "GitHub reports this repo is public");
  if (v === "private" || v === "internal") {
    return RESOLVED_FIX_FREE("private", "GitHub reports this repo is not publicly reachable");
  }
  return {
    visibility: "unknown",
    status: "unrecognised",
    detail: "`gh` returned a visibility value this probe does not recognise",
    fix: "run `gh repo view --json visibility` by hand to see what it reports",
  };
}

/** Persist a known visibility into git config (`repo-aegis.visibility`). No-op for "unknown". */
export function cacheVisibility(
  cwd: string,
  vis: RepoVisibility,
  run: CommandRunner = defaultRun,
): void {
  if (vis === "unknown") return;
  run("git", ["config", "repo-aegis.visibility", vis], cwd);
}

export interface ResolvedVisibility {
  visibility: RepoVisibility;
  probe: VisibilityProbe;
  /** True when `visibility` came from the git-config cache, not the live probe. */
  fromCache: boolean;
}

/**
 * Resolve this repo's visibility: probe live and refresh the cache when the
 * probe succeeds; otherwise fall back to the last cached value. Best-effort —
 * never throws.
 *
 * The probe result is returned alongside the value even when the cache
 * answered, because a cached value plus a blind probe is not the same as a
 * freshly confirmed one: the cache may predate a visibility flip, and the
 * operator needs to know their `gh` can no longer check.
 */
export function resolveVisibility(cwd: string, run: CommandRunner = defaultRun): ResolvedVisibility {
  const probe = probeGithubVisibility(cwd, run);
  if (probe.status === "resolved") {
    cacheVisibility(cwd, probe.visibility, run);
    return { visibility: probe.visibility, probe, fromCache: false };
  }
  return { visibility: readCachedVisibility(cwd), probe, fromCache: true };
}
