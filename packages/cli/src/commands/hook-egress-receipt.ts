// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `repo-aegis hook egress-receipt` — PostToolUse(Bash) entry point.
// Implemented in the L4 lane; see doc/design/egress-guard.md §5.
import { emitError } from "../format.js";

export async function hookEgressReceipt(): Promise<void> {
  emitError({ code: "NOT_IMPLEMENTED", error: "hook egress-receipt is not yet implemented" }, {});
}
