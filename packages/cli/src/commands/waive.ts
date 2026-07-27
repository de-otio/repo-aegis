// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `repo-aegis waive` — the human-run, TTY-gated escape hatch for a
// reviewed-benign `_always` finding. See packages/core/src/waivers.ts for
// the full design rationale (why only `_always` patterns are waivable,
// why a waiver is blob-keyed) and "D. Reviewed-benign waivers" in
// doc/plan-tag-push-and-hook-liveness.md for why a waiver mechanism is
// dangerous if left unguarded: `.repo-aegis.yml` is a file inside the
// repo, so a blocked coding agent could otherwise write a waiver into it
// and retry — reconstructing `git push --no-verify` with extra steps.
// Three independent controls close that gap; only one of them (#2) lives
// in this file:
//   1. `repo-aegis hook check-write` (hook-check-write.ts) refuses agent
//      Write/Edit/MultiEdit to `.repo-aegis.yml` outright.
//   2. THIS command refuses to run when stdin is not a TTY (below) — a
//      hook, script, or agent cannot mint a waiver silently even if it
//      somehow got a shell.
//   3. `check` always reports `waived: N` / the full list, never a
//      silent filter (see check.ts).
//
// All three are required; none of them alone is sufficient.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, parseDocument, YAMLSeq, Scalar, isMap } from "yaml";
import {
  OVERRIDE_FILENAME,
  withLockSync,
  assertWaivable,
  NotWaivableError,
  parseWaivers,
  LockTimeoutError,
  appendAuditRecord,
  type Waiver,
} from "@de-otio/repo-aegis-core";
import { emitJson, emitText, emitError, type OutputOptions } from "../format.js";

interface WaiveOptions extends OutputOptions {
  cwd?: string;
  pattern?: string;
  blob?: string;
  reason?: string;
  approver?: string;
  expires?: string;
  list?: boolean;
  remove?: boolean;
}

const BLOB_SHA_REGEX = /^[0-9a-f]{40}$/;
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Git toplevel of `cwd`, or `cwd` itself outside a git repo. Mirrors the
 * resolution `readRepoConfig`'s internal `.repo-aegis.yml` loader uses
 * in `core/src/repo.ts` (private to that module, so re-derived here —
 * `check.ts` does the same for the same reason). Keeping this in step
 * with `readRepoConfig` matters: a waiver written to the wrong path
 * would silently never apply.
 */
function findRepoRoot(cwd: string): string {
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return top !== "" ? top : cwd;
  } catch {
    return cwd;
  }
}

function overridePath(cwd: string): string {
  return join(findRepoRoot(cwd), OVERRIDE_FILENAME);
}

type Doc = ReturnType<typeof parseDocument>;

/**
 * Parse `.repo-aegis.yml` as a `yaml` `Document` (not a plain object) so
 * an add/remove/update preserves the rest of the file byte-for-byte:
 * existing keys, key ordering, and — the part a plain parse+stringify
 * would silently discard — COMMENTS. A config file that loses a human's
 * comments every time a tool touches it is one people stop trusting
 * enough to hand-edit, which defeats the point of keeping waivers in a
 * reviewable, committed file at all. Missing file parses as an empty
 * document (yaml's `Document.set` on empty contents creates the
 * top-level mapping on demand).
 */
function loadOverrideDoc(path: string): Doc {
  const raw = existsSync(path) ? readFileSync(path, "utf8") : "";
  return parseDocument(raw);
}

function saveOverrideDoc(doc: Doc, path: string): void {
  writeFileSync(path, doc.toString());
}

/** `.get()` on a yaml Map/Pair scalar can hand back either the raw JS
 * value or a `Scalar` node depending on how the document was built (a
 * freshly `.add()`-ed plain object vs. one parsed from text) — this
 * normalises both to a plain string, mirroring the same dual-check
 * `engagements-mutate.ts` uses for the identical reason. */
function scalarString(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (v instanceof Scalar && typeof v.value === "string") return v.value;
  return undefined;
}

function findWaiversSeq(doc: Doc, create: true): YAMLSeq;
function findWaiversSeq(doc: Doc, create: false): YAMLSeq | null;
function findWaiversSeq(doc: Doc, create: boolean): YAMLSeq | null {
  let seq = doc.get("waivers") as YAMLSeq | null;
  if (seq === null || !(seq instanceof YAMLSeq)) {
    if (!create) return null;
    seq = new YAMLSeq();
    doc.set("waivers", seq);
  }
  return seq;
}

function findWaiverIndex(seq: YAMLSeq, pattern: string, blob: string): number {
  const items = seq.items ?? [];
  return items.findIndex(item => {
    if (!isMap(item)) return false;
    return scalarString(item.get("pattern")) === pattern && scalarString(item.get("blob")) === blob;
  });
}

/**
 * Run `fn` under the shared repo-aegis write lock, mapping a lock
 * timeout to the CLI's standard error payload. Same lock other
 * write-commands take (`allow`, `engagements add/end/remove`) — it is a
 * single machine-wide mutex, not scoped to a particular file, which is
 * fine here: it only needs to serialise concurrent repo-aegis writers,
 * not model file-level contention.
 */
function withWriteLock<T>(opts: WaiveOptions, fn: () => T): T {
  try {
    return withLockSync(fn);
  } catch (err) {
    if (err instanceof LockTimeoutError) {
      emitError({ code: err.code, error: err.message }, opts);
    }
    emitError({ error: (err as Error).message }, opts);
  }
}

/**
 * Read the raw `waivers:` field out of `.repo-aegis.yml`, if present, as
 * plain JS (not through the Document API — listing doesn't need to
 * preserve comments, only add/remove/update do). Returns `[]` for a
 * missing file. A malformed `waivers:` block is a hard error, matching
 * `check.ts`'s fail-closed handling of the same file.
 */
function readWaiversField(path: string, opts: WaiveOptions): unknown {
  if (!existsSync(path)) return undefined;
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(path, "utf8"));
  } catch (err) {
    emitError(
      { code: "WAIVER_PARSE", error: `failed to parse ${OVERRIDE_FILENAME}: ${(err as Error).message}` },
      opts,
    );
  }
  if (parsed === null || parsed === undefined || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  return (parsed as Record<string, unknown>)["waivers"];
}

function listWaivers(opts: WaiveOptions): void {
  const cwd = opts.cwd ?? process.cwd();
  const path = overridePath(cwd);
  const field = readWaiversField(path, opts);
  // Re-parse through the schema so `list` shows exactly what `check`
  // would apply (same validation), not a raw/possibly-invalid dump.
  let waivers: Waiver[];
  try {
    waivers = parseWaivers(field);
  } catch (err) {
    emitError({ code: "WAIVER_PARSE", error: `${OVERRIDE_FILENAME}: ${(err as Error).message}` }, opts);
  }

  if (opts.json) {
    emitJson({ action: "waive-list", path, waivers });
    return;
  }
  if (waivers.length === 0) {
    emitText(`repo-aegis: no waivers in ${OVERRIDE_FILENAME}`);
    return;
  }
  for (const w of waivers) {
    const exp = w.expires ? `  expires=${w.expires}` : "";
    emitText(`  ${w.pattern}  ${w.blob}  approver=${w.approver}  date=${w.date}${exp}`);
    emitText(`    reason: ${w.reason}`);
  }
}

function removeWaiver(opts: WaiveOptions): void {
  if (!opts.pattern) {
    emitError({ code: "USAGE", error: "waive --remove requires --pattern <id>" }, opts);
  }
  if (!opts.blob) {
    emitError({ code: "USAGE", error: "waive --remove requires --blob <sha>" }, opts);
  }

  const cwd = opts.cwd ?? process.cwd();
  const path = overridePath(cwd);
  if (!existsSync(path)) {
    if (opts.json) {
      emitJson({ action: "waive-remove", removed: false, pattern: opts.pattern, blob: opts.blob });
      return;
    }
    emitText(`repo-aegis: ${OVERRIDE_FILENAME} does not exist; nothing to remove`);
    return;
  }

  const doc = loadOverrideDoc(path);
  const seq = findWaiversSeq(doc, false);
  const idx = seq ? findWaiverIndex(seq, opts.pattern, opts.blob) : -1;

  if (idx < 0) {
    if (opts.json) {
      emitJson({ action: "waive-remove", removed: false, pattern: opts.pattern, blob: opts.blob });
      return;
    }
    emitText(`repo-aegis: no waiver found for ${opts.pattern} / ${opts.blob}`);
    return;
  }

  withWriteLock(opts, () => {
    // Non-null: idx >= 0 only when `seq` was non-null above.
    seq!.items.splice(idx, 1);
    saveOverrideDoc(doc, path);
  });

  try {
    appendAuditRecord({ action: "waive-remove", cwd, repo: cwd, details: { pattern: opts.pattern, blob: opts.blob } });
  } catch {
    /* audit log must not break user-facing ops */
  }

  if (opts.json) {
    emitJson({ action: "waive-remove", removed: true, pattern: opts.pattern, blob: opts.blob });
    return;
  }
  emitText(`repo-aegis: removed waiver ${opts.pattern} / ${opts.blob}`);
}

function addWaiver(opts: WaiveOptions): void {
  // CONTROL 2: a waiver is a human decision, never something a hook,
  // script, or agent can mint by piping input at this command. TTY-ness
  // of stdin is the signal: a real terminal session has one, a
  // subprocess spawned by a hook or an agent's tool-call generally does
  // not. The escape hatch is opt-in and explicit (a human deliberately
  // scripting their own waiver still needs to set the env var
  // themselves) rather than silently permissive.
  const nonInteractiveOverride = process.env["REPO_AEGIS_WAIVE_NONINTERACTIVE"] === "1";
  if (!process.stdin.isTTY && !nonInteractiveOverride) {
    emitError(
      {
        code: "WAIVE_NONINTERACTIVE",
        error:
          "repo-aegis waive refuses to run when stdin is not a TTY. A waiver must be a " +
          "human decision — it is not something a hook, script, or agent may mint on its " +
          "own behalf, because that would reconstruct `git push --no-verify` with extra " +
          "steps. If you are a human deliberately scripting this, set " +
          "REPO_AEGIS_WAIVE_NONINTERACTIVE=1.",
      },
      opts,
    );
  }

  if (!opts.pattern) {
    emitError({ code: "USAGE", error: "waive requires --pattern <id>" }, opts);
  }
  if (!opts.blob) {
    emitError({ code: "USAGE", error: "waive requires --blob <sha>" }, opts);
  }
  if (!opts.reason || opts.reason.trim() === "") {
    emitError(
      { code: "USAGE", error: "waive requires --reason <text> (a waiver with no reason is not auditable)" },
      opts,
    );
  }
  if (!opts.approver || opts.approver.trim() === "") {
    emitError(
      { code: "USAGE", error: "waive requires --approver <name> (a waiver with no named reviewer is not auditable)" },
      opts,
    );
  }
  if (!BLOB_SHA_REGEX.test(opts.blob)) {
    emitError({ code: "USAGE", error: "--blob must be a 40-character lowercase hex git blob sha" }, opts);
  }
  if (opts.expires !== undefined && !DATE_REGEX.test(opts.expires)) {
    emitError({ code: "USAGE", error: "--expires must be YYYY-MM-DD" }, opts);
  }

  // Only `_always` patterns may be waived — see assertWaivable's doc for
  // the two hard reasons (non-goal of weakening the customer-marker deny
  // set; a waived pattern's digest, committed to a possibly-public repo,
  // is an offline oracle for anything but a generic `_always` shape).
  try {
    assertWaivable(opts.pattern);
  } catch (err) {
    if (err instanceof NotWaivableError) {
      emitError({ code: err.code, error: err.message }, opts);
    }
    throw err;
  }

  const cwd = opts.cwd ?? process.cwd();
  const path = overridePath(cwd);
  const doc = loadOverrideDoc(path);
  const seq = findWaiversSeq(doc, true);
  const existingIdx = findWaiverIndex(seq, opts.pattern, opts.blob);

  const date = todayIso();
  const entry: Record<string, unknown> = {
    pattern: opts.pattern,
    blob: opts.blob,
    reason: opts.reason,
    approver: opts.approver,
    date,
  };
  if (opts.expires !== undefined) entry["expires"] = opts.expires;

  // Idempotent upsert: re-running `waive` for the same (pattern, blob)
  // updates the existing entry (new reason/approver/date/expires) rather
  // than erroring or duplicating — this is how a waiver gets re-approved
  // or its expiry extended.
  const updated = existingIdx >= 0;
  withWriteLock(opts, () => {
    if (updated) {
      seq.items[existingIdx] = entry;
    } else {
      seq.add(entry);
    }
    saveOverrideDoc(doc, path);
  });

  try {
    appendAuditRecord({
      action: "waive-add",
      cwd,
      repo: cwd,
      details: {
        pattern: opts.pattern,
        blob: opts.blob,
        approver: opts.approver,
        expires: opts.expires ?? null,
        updated,
      },
    });
  } catch {
    /* audit log must not break user-facing ops */
  }

  if (opts.json) {
    emitJson({
      action: "waive-add",
      pattern: opts.pattern,
      blob: opts.blob,
      reason: opts.reason,
      approver: opts.approver,
      date,
      expires: opts.expires ?? null,
      updated,
    });
    return;
  }
  emitText(`repo-aegis: waived ${opts.pattern} / ${opts.blob}${updated ? " (updated)" : ""}`);
  emitText(`  reason:   ${opts.reason}`);
  emitText(`  approver: ${opts.approver}`);
  if (opts.expires) emitText(`  expires:  ${opts.expires}`);
}

export function waive(opts: WaiveOptions): void {
  const modes = [opts.list === true, opts.remove === true].filter(Boolean).length;
  if (modes > 1) {
    emitError({ code: "USAGE", error: "specify at most one of --list or --remove" }, opts);
  }

  if (opts.list) {
    listWaivers(opts);
    return;
  }
  if (opts.remove) {
    removeWaiver(opts);
    return;
  }
  addWaiver(opts);
}
