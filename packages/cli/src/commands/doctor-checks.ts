// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Shared shape for the machine-level and per-repo egress-guard checks that
// `doctor` reports alongside its hook-liveness sweep
// (doc/design/egress-guard.md §7). Each enforcement layer owns its own
// check function and exports it from its own module; `doctor.ts` only
// aggregates. Keeping the type here — and not in `doctor.ts` — is what lets
// those modules be edited independently.

export interface DoctorCheck {
  /** Stable, upper-snake code; the agent guide's error-code table lists each one. */
  code:
    | "PUSH_DEFAULT_IMPLICIT"
    | "CLASS_VISIBILITY_UNRESOLVED"
    | "PERSONAL_ORG_UNREGISTERED"
    | "SHIM_MISSING"
    | "SHIM_NOT_FIRST"
    | "GUARD_HOOK_UNREGISTERED";
  ok: boolean;
  /** Fixed, human-readable explanation. Never `gh`/git stderr (may carry an org name). */
  detail: string;
  /** Actionable next step; absent when `ok`. */
  fix?: string;
}
