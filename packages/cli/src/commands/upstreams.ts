// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `repo-aegis upstreams add|remove|list <owner>/<repo>` — manage the
// registry's `allowedUpstreams` (issue #151, D6): exact `owner/repo` entries
// that lift rule h ("refuse egress to an unregistered owner") for PRs, issues
// and comments only, for a fork's upstream.
//
// `add` tells repo-aegis that publishing to a repo it does not know is safe,
// so it needs a person at a terminal (D8). `remove` only tightens and `list`
// is read-only, so neither does.
import { readFileSync, writeFileSync } from "node:fs";
import { YAMLSeq, Scalar } from "yaml";
import {
  registryPath as defaultRegistryPath,
  loadRegistry,
  RegistryNotFoundError,
  OWNER_REPO_REGEX,
} from "@de-otio/repo-aegis-core";
import { emitJson, emitText, emitError, type OutputOptions } from "../format.js";
import { requireTerminalForOwnerAdd, recordOwnerAdd } from "../owner-add-gate.js";
import { loadDocOrExit, saveDoc, withRegistryLock, type Doc } from "./registry-mutate.js";

export interface UpstreamsOptions extends OutputOptions {
  registryPath?: string;
  /** Test seam: defaults to `process.stderr.isTTY`. Only `add` consults it. */
  stderrIsTTY?: boolean;
}

type Normalized = { ok: true; value: string } | { ok: false; reason: string };

/**
 * Lower-case (GitHub names are case-insensitive) and validate an
 * `owner/repo` argument. Same shape the registry schema enforces, so a value
 * accepted here always loads: OWNER_REPO_REGEX, minus the traversal names
 * `.` and `..` for the repo half. No wildcards, no URLs, no extra segments.
 */
export function normalizeUpstream(raw: string | undefined): Normalized {
  if (raw === undefined || raw.trim() === "") {
    return { ok: false, reason: "expected <owner>/<repo>" };
  }
  const value = raw.trim().toLowerCase();
  if (!OWNER_REPO_REGEX.test(value)) {
    return {
      ok: false,
      reason:
        "upstream must be exactly 'owner/repo': owner [a-z0-9-], repo [a-z0-9._-], no wildcards, URLs or extra segments",
    };
  }
  const repo = value.slice(value.indexOf("/") + 1);
  if (repo === "." || repo === "..") {
    return { ok: false, reason: "upstream repo name must not be '.' or '..'" };
  }
  return { ok: true, value };
}

function normalizeOrExit(raw: string | undefined, verb: string, opts: OutputOptions): string {
  const n = normalizeUpstream(raw);
  if (!n.ok) {
    emitError(
      {
        code: "INVALID_UPSTREAM",
        error: `upstreams ${verb}: ${n.reason}`,
        ...(raw !== undefined && { details: `got ${JSON.stringify(raw.slice(0, 120))}` }),
      },
      opts,
    );
  }
  return n.value;
}

function seqStrings(seq: YAMLSeq): string[] {
  const out: string[] = [];
  for (const item of seq.items) {
    if (typeof item === "string") out.push(item);
    else if (item instanceof Scalar && typeof item.value === "string") out.push(item.value);
  }
  return out;
}

function upstreamSeq(doc: Doc, create: boolean): YAMLSeq | null {
  const cur = doc.get("allowedUpstreams");
  if (cur instanceof YAMLSeq) return cur;
  if (!create) return null;
  const seq = new YAMLSeq();
  doc.set("allowedUpstreams", seq);
  return seq;
}

/**
 * Write the mutated doc, then prove the registry still loads. If it does
 * not, put the original bytes back and fail: a command that edits the file
 * the guard reads must not leave it unreadable (an unreadable registry makes
 * rule h refuse everything, D4).
 */
function saveValidated(doc: Doc, path: string): void {
  const before = readFileSync(path, "utf8");
  saveDoc(doc, path);
  try {
    loadRegistry(path);
  } catch (err) {
    writeFileSync(path, before, { mode: 0o600 });
    throw err;
  }
}

export function upstreamsAdd(target: string | undefined, opts: UpstreamsOptions): void {
  // D8: gate first, before validation and before any write.
  requireTerminalForOwnerAdd({ kind: "upstream", target: target ?? "" }, opts);
  const upstream = normalizeOrExit(target, "add", opts);
  const path = opts.registryPath ?? defaultRegistryPath();
  const doc = loadDocOrExit(path, opts);

  const added = withRegistryLock(opts, () => {
    const seq = upstreamSeq(doc, true);
    if (seq === null) return false; // unreachable: create=true
    if (seqStrings(seq).includes(upstream)) return false;
    seq.add(upstream);
    saveValidated(doc, path);
    return true;
  });

  if (added) recordOwnerAdd({ kind: "upstream", added: 1, via: "upstreams-add" });

  if (opts.json) {
    emitJson({ action: "upstreams-add", upstream, added });
    return;
  }
  emitText(
    added
      ? `added upstream ${upstream} (PRs, issues and comments only; each publish still needs approval)`
      : `upstream ${upstream} already present`,
  );
}

export function upstreamsRemove(target: string | undefined, opts: UpstreamsOptions): void {
  // No TTY needed: removing only tightens.
  const upstream = normalizeOrExit(target, "remove", opts);
  const path = opts.registryPath ?? defaultRegistryPath();
  const doc = loadDocOrExit(path, opts);

  const removed = withRegistryLock(opts, () => {
    const seq = upstreamSeq(doc, false);
    if (seq === null) return false;
    const idx = seq.items.findIndex(
      item => item === upstream || (item instanceof Scalar && item.value === upstream),
    );
    if (idx < 0) return false;
    seq.items.splice(idx, 1);
    saveValidated(doc, path);
    return true;
  });

  if (opts.json) {
    emitJson({ action: "upstreams-remove", upstream, removed });
    return;
  }
  emitText(removed ? `removed upstream ${upstream}` : `upstream ${upstream} not in registry`);
}

export function upstreamsList(opts: UpstreamsOptions): void {
  let upstreams: string[];
  try {
    upstreams = loadRegistry(opts.registryPath ?? defaultRegistryPath()).allowedUpstreams ?? [];
  } catch (err) {
    if (err instanceof RegistryNotFoundError) {
      emitError(
        { code: "REGISTRY_NOT_FOUND", error: "registry not found; run `repo-aegis init` first", details: err.path },
        opts,
      );
    }
    emitError({ error: (err as Error).message }, opts);
  }
  if (opts.json) {
    emitJson({ action: "upstreams-list", upstreams });
    return;
  }
  emitText(`repo-aegis upstreams (${upstreams.length}):`);
  if (upstreams.length === 0) emitText("  (none)");
  for (const u of upstreams) emitText(`  ${u}`);
}
