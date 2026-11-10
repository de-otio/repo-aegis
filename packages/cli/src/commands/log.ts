// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `repo-aegis log [--since <dur>] [--code X] [--layer Y] [--last N] [--json]`, `log --off` and `log --on`: the reader
// of the decision log (complexity-review P1-I; core/decision-log.ts has the design and the writer).
//
// WHO MAY DO WHAT.
//   - Reading is allowed for an agent, and is the point: when a refusal ends `(logged: repo-aegis log --last 1)`, this is
//     the command the agent runs. It prints only what the reader rebuilds through the builder's validators (closed
//     enums, validated owner/repo and ref names), so it cannot show free text, a path, a URL or a token, even from a file
//     someone edited.
//   - `--off` needs a person's terminal, exactly like `pause` (`LOG_OFF_NEEDS_TTY`), and is on the human-only list in
//     core/human-commands.ts, so the egress guard refuses an agent whose command text runs it. The honest mistake it
//     stops: an agent switching the log off because it is "noise", which removes the data its next refusal needs.
//   - `--on` is allowed for an agent: it only turns recording back on.
import {
  appendAuditRecord,
  isDecisionLogEnabled,
  parseTtl,
  readDecisionRecords,
  setDecisionLogEnabled,
  type DecisionRecord,
  type LoggedDecision,
} from "@de-otio/repo-aegis-core";
import { emitError, emitJson, emitText, type OutputOptions } from "../format.js";
import { requireTerminal, type RequireTerminalOptions } from "../require-terminal.js";
import { findRow, loadDocs, type Docs } from "./explain.js";

export interface LogOptions extends OutputOptions, RequireTerminalOptions {
  since?: string;
  code?: string;
  layer?: string;
  last?: string | number;
  off?: boolean;
  on?: boolean;
  /** Test seam: the home (default: the repo-aegis home). */
  home?: string;
  /** Test seam: the `$TMPDIR` the fallback file is under. */
  tmp?: string;
  /** Test seam: the clock for `--since`. */
  now?: () => Date;
  /** Test seam: read the docs from here instead of `dist/docs`. */
  docsDir?: string;
}

/** The default view: this many of the most recent refusals, asks and fallbacks. */
const DEFAULT_REFUSALS = 20;
/** `--last` without a number cap and the flat view's default length. */
const DEFAULT_FLAT = 50;
const MAX_LAST = 1000;
const REFUSAL_OUTCOMES: ReadonlySet<string> = new Set(["refuse", "ask", "fallback"]);

/** A one-line, fixed-shape rendering of a record: only validated values go in. */
export function formatRecord(r: DecisionRecord): string {
  const facts = r.facts === undefined ? [] : Object.entries(r.facts).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(",") || "-" : String(v)}`);
  const parts = [
    r.ts,
    r.layer,
    r.outcome,
    r.code,
    r.verb,
    r.destination,
    r.ref !== undefined ? `ref=${r.ref}` : undefined,
    r.identityColumn !== undefined ? `identity=${r.identityColumn}` : undefined,
    r.approvalId !== undefined ? `approval=${r.approvalId}` : undefined,
    r.paused !== undefined && r.paused !== "no" ? `paused=${r.paused}` : undefined,
    r.host !== undefined ? `host=${r.host}` : undefined,
    r.pinFallback === true ? "pinFallback" : undefined,
    facts.length > 0 ? `[${facts.join(" ")}]` : undefined,
  ];
  return parts.filter((p): p is string => p !== undefined).join(" ");
}

/** The first sentence of an `explain` row's recovery, as the one fix line (X-10's table replaces this when it lands). */
export function fixLineFor(docs: Docs | null, code: string): string {
  const fallback = `repo-aegis explain ${code}`;
  if (docs === null) return fallback;
  try {
    const row = findRow(docs, code);
    if (row === null) return fallback;
    const text = row.recovery.replace(/\s+/g, " ").trim();
    const end = /[.!?](?:\s|$)/.exec(text);
    const first = end === null ? text : text.slice(0, end.index + 1);
    return first === "" ? fallback : first.length > 240 ? `${first.slice(0, 237)}...` : first;
  } catch {
    return fallback;
  }
}

function parseLast(v: string | number | undefined, opts: OutputOptions): number | undefined {
  if (v === undefined) return undefined;
  const n = typeof v === "number" ? v : /^\d+$/.test(v.trim()) ? Number(v.trim()) : Number.NaN;
  if (!Number.isInteger(n) || n < 1 || n > MAX_LAST) {
    emitError({ code: "USAGE", error: `--last must be a whole number from 1 to ${MAX_LAST}` }, opts);
  }
  return n;
}

export function log(opts: LogOptions): void {
  if (opts.off === true && opts.on === true) emitError({ code: "USAGE", error: "--off and --on cannot be used together" }, opts);

  if (opts.off === true) {
    // The gate first, before any write. REPO_AEGIS_EGRESS_HUMAN is NOT honoured (as for `pause` and `approve`).
    requireTerminal(
      "LOG_OFF_NEEDS_TTY",
      "the decision log can only be switched off from a terminal: this shell has no TTY on stderr. " +
        "(REPO_AEGIS_EGRESS_HUMAN is not honoured here — an agent must never remove the data its own next refusal needs.)",
      opts,
    );
    setDecisionLogEnabled(false, opts.home);
    try {
      appendAuditRecord({ action: "decision-log-off", cwd: process.cwd() });
    } catch {
      /* the audit log is best-effort */
    }
    if (opts.json) emitJson({ action: "log", enabled: false });
    else emitText("repo-aegis log: the decision log is OFF; refusals no longer say why. Turn it back on with: repo-aegis log --on");
    return;
  }
  if (opts.on === true) {
    setDecisionLogEnabled(true, opts.home);
    try {
      appendAuditRecord({ action: "decision-log-on", cwd: process.cwd() });
    } catch {
      /* the audit log is best-effort */
    }
    if (opts.json) emitJson({ action: "log", enabled: true });
    else emitText("repo-aegis log: the decision log is ON");
    return;
  }

  const now = (opts.now ?? (() => new Date()))();
  let sinceIso: string | undefined;
  if (opts.since !== undefined) {
    const ms = parseTtl(opts.since);
    if (ms === null) emitError({ code: "USAGE", error: `--since must be like 30m, 2h, 1d (got ${JSON.stringify(opts.since.slice(0, 40))})` }, opts);
    sinceIso = new Date(now.getTime() - ms).toISOString();
  }
  const last = parseLast(opts.last, opts);
  const code = opts.code === undefined ? undefined : opts.code.trim().toUpperCase().replace(/-/g, "_");

  const all: LoggedDecision[] = readDecisionRecords(opts.home, opts.tmp !== undefined ? { tmp: opts.tmp } : {});
  const filtered = all.filter(d => {
    const r = d.record;
    if (sinceIso !== undefined && r.ts < sinceIso) return false;
    if (code !== undefined && r.code !== code) return false;
    if (opts.layer !== undefined && r.layer !== opts.layer) return false;
    return true;
  });
  const enabled = isDecisionLogEnabled(opts.home);
  const flat = last !== undefined || code !== undefined || opts.layer !== undefined || sinceIso !== undefined;

  if (flat) {
    const shown = filtered.slice(-(last ?? DEFAULT_FLAT)).map(d => d.record);
    if (opts.json) {
      emitJson({ enabled, records: shown });
      return;
    }
    if (!enabled) emitText("repo-aegis log: the decision log is OFF (a person switched it off); these are older records");
    if (shown.length === 0) emitText("repo-aegis log: no matching records");
    for (const r of shown) emitText(formatRecord(r));
    return;
  }

  // The default view: the most recent refusals, grouped by code, each with its one fix line.
  const refusals = filtered.filter(d => REFUSAL_OUTCOMES.has(d.record.outcome)).slice(-DEFAULT_REFUSALS).map(d => d.record);
  const docs = loadDocs(opts.docsDir);
  const groups = new Map<string, DecisionRecord[]>();
  for (const r of refusals) {
    const key = r.code ?? "invalid";
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const ordered = [...groups.entries()].sort((a, b) => (b[1].at(-1)!.ts < a[1].at(-1)!.ts ? -1 : 1));
  if (opts.json) {
    emitJson({
      enabled,
      groups: ordered.map(([c, rs]) => ({ code: c, count: rs.length, fix: fixLineFor(docs, c), records: rs })),
    });
    return;
  }
  if (!enabled) emitText("repo-aegis log: the decision log is OFF (a person switched it off); these are older records");
  if (ordered.length === 0) {
    emitText("repo-aegis log: no refusals recorded");
    return;
  }
  emitText(`repo-aegis log: the last ${refusals.length} refusal${refusals.length === 1 ? "" : "s"}, by code (newest group first)`);
  for (const [c, rs] of ordered) {
    emitText("");
    emitText(`${c}  (${rs.length})`);
    emitText(`  fix: ${fixLineFor(docs, c)}`);
    emitText(`  details: repo-aegis explain ${c}`);
    for (const r of rs.slice(-3)) emitText(`  ${formatRecord(r)}`);
  }
}
