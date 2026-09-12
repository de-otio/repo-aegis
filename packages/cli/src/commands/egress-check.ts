// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `repo-aegis egress-check -- <gh args…>` — the decision call behind the
// `gh` shim, and `repo-aegis egress-readback` — the post-publish body
// read-back. Implemented in the L2 lane; see doc/design/egress-guard.md §3.
import { emitError, type OutputOptions } from "../format.js";

export interface EgressCheckOptions extends OutputOptions {
  cwd?: string;
}

export function egressCheck(_args: string[], _opts: EgressCheckOptions): void {
  emitError({ code: "NOT_IMPLEMENTED", error: "egress-check is not yet implemented" }, {});
}

export interface EgressReadbackOptions extends OutputOptions {
  cwd?: string;
  bodyFile?: string;
  pr?: string;
  repo?: string;
  gh?: string;
  timeoutMs?: number;
}

export function egressReadback(_opts: EgressReadbackOptions): void {
  emitError({ code: "NOT_IMPLEMENTED", error: "egress-readback is not yet implemented" }, {});
}
