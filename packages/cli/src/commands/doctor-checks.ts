// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Shared shape for the machine-level and per-repo egress-guard checks that
// `doctor` reports alongside its hook-liveness sweep
// (doc/design/egress-guard.md §7). Each enforcement layer owns its own
// check function and exports it from its own module; `doctor.ts` only
// aggregates. Keeping the type here — and not in `doctor.ts` — is what lets
// those modules be edited independently.

/** Every code `doctor` can report. Stable: the agent guide's error-code table lists each one. */
export type DoctorCheckCode =
  | "PUSH_DEFAULT_IMPLICIT"
  | "CLASS_VISIBILITY_UNRESOLVED"
  | "PERSONAL_ORG_UNREGISTERED"
  | "SHIM_MISSING"
  | "SHIM_STALE"
  | "SHIM_NOT_FIRST"
  | "GUARD_HOOK_UNREGISTERED"
  // Registered owners (doc/plan-unregistered-owner-egress.md §3.8).
  | "OWNERS_UNDECLARED"
  | "GH_LOGIN_UNREGISTERED"
  | "GH_MEMBER_ORG_UNREGISTERED"
  | "REGISTERED_ORG_NOT_MEMBER"
  | "REGISTRY_AGENT_WRITABLE"
  | "REGISTRY_UNREADABLE"
  // Residual risks R8, R9, R11 (§8.2).
  | "PREPUSH_HOOK_MISSING"
  | "SHELL_STARTUP_OVERRIDES"
  | "SSH_GITHUB_REDIRECT";

/**
 * How loudly a failing check speaks. Only `fail` makes `doctor` exit 1.
 * `warn` is a real weakness that depends on something doctor cannot prove;
 * `info` is worth knowing and needs no action.
 */
export type DoctorSeverity = "fail" | "warn" | "info";

export interface DoctorCheck {
  code: DoctorCheckCode;
  ok: boolean;
  /**
   * Meaningful only when `ok` is false; absent means `fail`. A `warn` or `info`
   * finding is reported but never changes the exit code.
   */
  severity?: DoctorSeverity;
  /**
   * The check could not be evaluated (for example `gh` is absent or not logged
   * in). `ok` is true, so it never fails the run, but it is reported so a
   * silent gap cannot read as a clean result.
   */
  skipped?: boolean;
  /** The gh account a finding applies to, when it applies to one (the login, shown in `detail` as well). */
  account?: string;
  /**
   * Fixed, human-readable explanation. Never `gh`/git stderr (may carry an org name).
   * Org and owner names do not appear here, only in `fix` and in `--json`.
   */
  detail: string;
  /** Actionable next step; absent when `ok`. */
  fix?: string;
}

/** True when this check makes `doctor` exit 1. */
export function isFailure(c: DoctorCheck): boolean {
  return !c.ok && (c.severity ?? "fail") === "fail";
}

/** True when this check is worth a line in the text report. */
export function isReportable(c: DoctorCheck): boolean {
  return !c.ok || c.skipped === true;
}

/** The label printed before the code in the text report. */
export function checkLabel(c: DoctorCheck): "FAIL" | "WARN" | "INFO" | "SKIP" {
  if (c.skipped === true && c.ok) return "SKIP";
  const sev = c.severity ?? "fail";
  return sev === "warn" ? "WARN" : sev === "info" ? "INFO" : "FAIL";
}

/** Appended to every fix that changes the owner lists: a person runs it, an agent cannot. */
export const PERSON_RUNS_THIS = "a person runs this from their own terminal; it refuses without a TTY";
