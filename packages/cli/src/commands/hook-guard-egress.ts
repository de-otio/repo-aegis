// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `repo-aegis hook guard-egress` — PreToolUse(Bash) entry point.
// Implemented in the L3 lane; see doc/design/egress-guard.md §4.
import { emitError } from "../format.js";

export interface HookGuardEgressOptions {
  agent?: string;
}

export async function hookGuardEgress(_opts: HookGuardEgressOptions): Promise<void> {
  emitError({ code: "NOT_IMPLEMENTED", error: "hook guard-egress is not yet implemented" }, {});
}
