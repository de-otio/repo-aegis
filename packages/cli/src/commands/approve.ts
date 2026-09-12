// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `repo-aegis approve` — mint, list or revoke a human egress approval
// (doc/design/egress-guard.md §4a; core `egress-approval.ts`).
//
// The mint is the one operation in the egress guard that MUST come from a
// person, so it is gated harder than anything else: a TTY on stderr, full
// stop. `REPO_AEGIS_EGRESS_HUMAN` is deliberately not honoured here — it is
// the escape for one invocation, and an agent that set it to mint a
// fifteen-minute approval would have turned a per-command declaration into
// a standing one.
import {
  appendAuditRecord,
  approvalsPath,
  listApprovals,
  mintApproval,
  parseApprovalTarget,
  parseTtl,
  revokeApprovals,
  DEFAULT_APPROVAL_TTL_MS,
  MAX_APPROVAL_TTL_MS,
  type EgressApproval,
} from "@de-otio/repo-aegis-core";
import { emitJson, emitText, emitError, type OutputOptions } from "../format.js";

export interface ApproveOptions extends OutputOptions {
  ref?: string;
  ttl?: string;
  note?: string;
  list?: boolean;
  revoke?: string;
  /** Test seam: defaults to `process.stderr.isTTY`. */
  stderrIsTTY?: boolean;
  /** Test seam: the approvals store path. */
  path?: string;
  /** Test seam: the clock. */
  now?: () => Date;
}

function describe(a: EgressApproval, now: Date): string {
  const left = Math.max(0, Math.round((Date.parse(a.expiresAt) - now.getTime()) / 60_000));
  const scope = `${a.org}/${a.repo}${a.ref !== undefined ? ` (ref ${a.ref})` : ""}`;
  return `${a.id}  ${scope}  by ${a.by}  expires ${a.expiresAt} (${left} min left)`;
}

export function approve(target: string | undefined, opts: ApproveOptions): void {
  const path = opts.path ?? approvalsPath();
  const now = (opts.now ?? (() => new Date()))();

  if (opts.list) {
    const live = listApprovals(path, now);
    if (opts.json) {
      emitJson({ action: "approve", list: live });
    } else if (live.length === 0) {
      emitText("repo-aegis approve: no live approvals");
    } else {
      emitText(`repo-aegis approve: ${live.length} live approval(s)`);
      for (const a of live) emitText(`  ${describe(a, now)}`);
    }
    return;
  }

  if (opts.revoke !== undefined) {
    const removed = revokeApprovals(opts.revoke, path);
    try {
      appendAuditRecord({ action: "egress-approval-revoke", cwd: process.cwd(), details: { removed } });
    } catch {
      /* audit must not break the operation */
    }
    if (opts.json) emitJson({ action: "approve", revoked: removed });
    else emitText(`repo-aegis approve: revoked ${removed.length} approval(s)${removed.length ? ` (${removed.join(", ")})` : ""}`);
    return;
  }

  // ---- mint -----------------------------------------------------------------
  const isTTY = opts.stderrIsTTY ?? !!process.stderr.isTTY;
  if (!isTTY) {
    emitError(
      {
        code: "APPROVE_NEEDS_TTY",
        error:
          "an egress approval can only be minted from a terminal: this shell has no TTY on stderr. " +
          "(REPO_AEGIS_EGRESS_HUMAN is not honoured here — an agent must never mint its own approval.)",
      },
      opts,
    );
  }
  if (target === undefined || target.trim() === "") {
    emitError({ code: "USAGE", error: "approve <org>/<repo> | <org>/* | *   (or --list / --revoke <id|all>)" }, opts);
  }
  const parsed = parseApprovalTarget(target);
  if (parsed === null) {
    emitError({ code: "USAGE", error: `not a destination: ${JSON.stringify(target)} — use <org>/<repo>, <org>/*, or *` }, opts);
  }
  let ttlMs = DEFAULT_APPROVAL_TTL_MS;
  if (opts.ttl !== undefined) {
    const t = parseTtl(opts.ttl);
    if (t === null) emitError({ code: "USAGE", error: `--ttl must be like 15m, 2h, 90s or 1d (got ${JSON.stringify(opts.ttl)})` }, opts);
    if (t > MAX_APPROVAL_TTL_MS) {
      emitError({ code: "USAGE", error: `--ttl may not exceed 24h: an approval is for a task, not a standing grant` }, opts);
    }
    ttlMs = t;
  }

  const approval = mintApproval({
    target: parsed,
    ...(opts.ref !== undefined && { ref: opts.ref }),
    ttlMs,
    ...(opts.note !== undefined && { note: opts.note }),
    path,
    now,
  });
  try {
    appendAuditRecord({
      action: "egress-approval-mint",
      cwd: process.cwd(),
      details: {
        id: approval.id,
        scope: `${approval.org}/${approval.repo}`,
        ...(approval.ref !== undefined && { ref: approval.ref }),
        expiresAt: approval.expiresAt,
      },
    });
  } catch {
    /* audit must not break the operation */
  }

  if (opts.json) {
    emitJson({ action: "approve", approval });
  } else {
    emitText(`repo-aegis approve: ${describe(approval, now)}`);
    emitText(
      "  every egress layer now treats a matching publish from a non-interactive shell as human-approved " +
        "(rule g only; shape, cross-org and payload rules still apply). Revoke: repo-aegis approve --revoke " +
        approval.id,
    );
  }
}
