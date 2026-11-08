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
  loadRegistry,
  registeredOwners,
  safeDestination,
  RegistryNotFoundError,
  DEFAULT_APPROVAL_TTL_MS,
  MAX_APPROVAL_TTL_MS,
  type EgressApproval,
  type Registry,
} from "@de-otio/repo-aegis-core";
import { emitJson, emitText, emitError, type OutputOptions } from "../format.js";
import { requireTerminal } from "../require-terminal.js";

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
  /** Test seam: the registry path the mint warnings read. Defaults to the machine's registry. */
  registryPath?: string;
  /** Test seam: the clock. */
  now?: () => Date;
}

function describe(a: EgressApproval, now: Date): string {
  const left = Math.max(0, Math.round((Date.parse(a.expiresAt) - now.getTime()) / 60_000));
  const scope = `${a.org}/${a.repo}${a.ref !== undefined ? ` (ref ${a.ref})` : ""}`;
  const as = a.login !== undefined ? `  as ${a.login}` : "";
  return `${a.id}  ${scope}${as}  by ${a.by}  expires ${a.expiresAt} (${left} min left)`;
}

/** The login of `owner`'s mapped `person` identity (a `gh-login`), or undefined: no registry, no mapping, or an app. */
function mappedPersonLogin(owner: string, registryPath: string | undefined): string | undefined {
  try {
    const registry = registryPath === undefined ? loadRegistry() : loadRegistry(registryPath);
    const person = registry.identityMap?.get(owner.toLowerCase())?.person;
    return person !== undefined && person.kind === "gh-login" ? person.login : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What a minted approval will and will not do, as plain sentences for the
 * operator (§3.2, §3.9). Content-free about the registry: it never lists
 * owners. It names only what the person typed, and only when that passes
 * `safeDestination()` (the typed name is echoed into a terminal and pasted).
 */
function mintWarnings(target: { org: string; repo: string }, registryPath: string | undefined): string[] {
  let registry: Registry | null = null;
  let unreadable = false;
  try {
    registry = registryPath === undefined ? loadRegistry() : loadRegistry(registryPath);
  } catch (err) {
    unreadable = !(err instanceof RegistryNotFoundError);
  }
  const owners = registry === null ? new Set<string>() : registeredOwners(registry);

  if (target.org === "*") {
    const notes = [
      "'*' now covers repositories under your personalOrgs, and commands with no repository " +
        "(npm publish), only. It does not cover customer orgs, allowed upstreams or unregistered owners: " +
        "approve <org>/* or <org>/<repo> for those.",
    ];
    if (unreadable) {
      notes.push("The registry could not be read, so repo-aegis cannot say which owners '*' covers until it is repaired.");
    } else if ((registry?.personalOrgs ?? []).length === 0) {
      notes.push(
        "Your registry declares no personalOrgs, so '*' currently covers npm publish only. " +
          "A person registers an owner from a terminal: repo-aegis engagements add --personal-org <login>.",
      );
    }
    return notes;
  }

  const safe = safeDestination(target.org, target.repo);
  if (safe === null) return [];
  if (unreadable) {
    return [
      "The registry could not be read (it is encrypted or damaged), so rule h (UNREGISTERED_OWNER_EGRESS) " +
        "refuses every non-interactive publish until a person repairs or decrypts it. This approval will not help before then.",
    ];
  }
  const exactUpstream =
    safe.repo !== "*" &&
    (registry?.allowedUpstreams ?? []).some(u => u.toLowerCase() === `${safe.org}/${safe.repo}`);
  // A missing registry or one with no owners leaves rule h inert: nothing to warn about.
  if (owners.size === 0 || owners.has(safe.org) || exactUpstream) return [];
  // `<owner>/*` for an owner that is not registered but has an allowed upstream:
  // rule h admits that upstream for PR and issue verbs, so the approval is not
  // useless, only narrow. Does not name the upstream.
  if (safe.repo === "*" && (registry?.allowedUpstreams ?? []).some(u => u.toLowerCase().startsWith(`${safe.org}/`))) {
    return [
      `"${safe.org}" is not a registered owner. This approval covers only that owner's allowed upstream ` +
        `repositories, and only for PR and issue verbs; everything else under it stays refused by rule h ` +
        `(UNREGISTERED_OWNER_EGRESS) until a person registers the owner.`,
    ];
  }
  return [
    `"${safe.org}" is not a registered owner, so rule h (UNREGISTERED_OWNER_EGRESS) will still refuse ` +
      `non-interactive egress there until a person registers it, whatever approval exists. ` +
      `From a terminal: repo-aegis engagements add --personal-org ${safe.org} (or --github-org ${safe.org} ` +
      `under the engagement)` +
      (safe.repo === "*" ? "" : `; for an upstream you contribute to: repo-aegis upstreams add ${safe.org}/${safe.repo}`) +
      `.`,
  ];
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
  requireTerminal(
    "APPROVE_NEEDS_TTY",
    "an egress approval can only be minted from a terminal: this shell has no TTY on stderr. " +
      "(REPO_AEGIS_EGRESS_HUMAN is not honoured here — an agent must never mint its own approval.)",
    opts,
  );
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

  // N3, A11: for an owner whose registry entry maps a `person` identity (a gh login), the approval records that
  // login, so an agent write as that account is covered by THIS approval and no other. `*` never carries one.
  const login = parsed.org === "*" ? undefined : mappedPersonLogin(parsed.org, opts.registryPath);
  const approval = mintApproval({
    target: parsed,
    ...(login !== undefined && { login }),
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
        ...(approval.login !== undefined && { login: approval.login }),
      },
    });
  } catch {
    /* audit must not break the operation */
  }

  const warnings = mintWarnings(parsed, opts.registryPath);
  if (opts.json) {
    emitJson({ action: "approve", approval, ...(warnings.length > 0 && { warnings }) });
  } else {
    emitText(`repo-aegis approve: ${describe(approval, now)}`);
    if (approval.login !== undefined) {
      emitText(
        `  bound to the GitHub account ${approval.login}: an agent may write there as that account under this approval, ` +
          `and only this one (an approval without an account, or for another, does not cover it)`,
      );
    }
    for (const w of warnings) emitText(`  warning: ${w}`);
    emitText(
      "  every egress layer now treats a matching publish from a non-interactive shell as human-approved " +
        "(rule g only; shape, cross-org and payload rules still apply). Revoke: repo-aegis approve --revoke " +
        approval.id,
    );
  }
}
