// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Shared plumbing for commands that edit the registry YAML in place: parse as
// a comment-preserving document (so unknown and newer fields such as
// `allowedUpstreams` round-trip untouched), mutate under the registry lock,
// write mode 0600. Extracted from engagements-mutate.ts so `upstreams` can
// mutate the registry the same way.
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { parseDocument } from "yaml";
import {
  withLockSync,
  PatternValidationError,
  RegistryNotFoundError,
  LockTimeoutError,
} from "@de-otio/repo-aegis-core";
import { emitError, type OutputOptions } from "../format.js";

export type Doc = ReturnType<typeof parseDocument>;

export function loadDoc(path: string): Doc {
  if (!existsSync(path)) throw new RegistryNotFoundError(path);
  const raw = readFileSync(path, "utf8");
  return parseDocument(raw);
}

export function saveDoc(doc: Doc, path: string): void {
  writeFileSync(path, doc.toString(), { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* platform-restricted */
  }
}

/**
 * Load the registry YAML doc or call emitError (which exits 2). Used to
 * collapse the `let doc; try { doc = ... } catch { emitError(...) }`
 * pattern into a single expression so TypeScript flow analysis narrows
 * the result without `!` assertions.
 */
export function loadDocOrExit(path: string, opts: OutputOptions): Doc {
  try {
    return loadDoc(path);
  } catch (err) {
    if (err instanceof RegistryNotFoundError) {
      emitError(
        {
          code: "REGISTRY_NOT_FOUND",
          error: "registry not found; run `repo-aegis init` first",
          details: err.path,
        },
        opts,
      );
    }
    emitError({ error: (err as Error).message }, opts);
  }
}

/**
 * Run a callback under the registry write lock; map known exception types
 * to their canonical CLI error payloads. Centralises the lock+error dance
 * shared by add / end / remove.
 */
export function withRegistryLock<T>(opts: OutputOptions, fn: () => T): T {
  try {
    return withLockSync(fn);
  } catch (err) {
    if (err instanceof LockTimeoutError) {
      emitError({ code: err.code, error: err.message }, opts);
    }
    if (err instanceof PatternValidationError) {
      emitError(
        { code: "PATTERN_VALIDATION", error: err.message, details: err.invalid },
        opts,
      );
    }
    emitError({ code: "RENDER_ERROR", error: (err as Error).message }, opts);
  }
}
