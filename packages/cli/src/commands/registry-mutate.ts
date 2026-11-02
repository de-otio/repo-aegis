// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Shared plumbing for commands that edit the registry YAML in place: parse as
// a comment-preserving document (so unknown and newer fields such as
// `allowedUpstreams` round-trip untouched), mutate under the registry lock,
// write mode 0600.
//
// The contract every mutator follows (issue #151, PR 5 review):
//   1. Read the file INSIDE `withRegistryLock`, so a concurrent writer's edit
//      is never overwritten by a stale read.
//   2. Finish with `commitRegistry`, which (a) refuses, without a terminal,
//      a change that empties the owner set, (b) proves the candidate text is
//      a valid registry in memory, and only then (c) writes it atomically
//      (temp file + rename). A failed edit never leaves an unreadable
//      registry on disk: an unreadable registry makes rule h refuse every
//      non-interactive egress (D4) and prints schema errors that name orgs
//      and engagement ids into agent transcripts.
//   3. Fail by throwing `RegistryCliError`, never by calling `emitError`
//      inside the lock: `withRegistryLock` maps it to the CLI error payload.
import { existsSync, readFileSync, writeFileSync, chmodSync, renameSync, rmSync } from "node:fs";
import { parseDocument } from "yaml";
import {
  withLockSync,
  parseRegistryText,
  isActive,
  PatternValidationError,
  RegistryNotFoundError,
  LockTimeoutError,
  type Engagement,
} from "@de-otio/repo-aegis-core";
import { emitError, type OutputOptions } from "../format.js";
import { isHumanTerminal, type RequireTerminalOptions } from "../require-terminal.js";
import { ownerSetEmptyRefusal, OWNER_SET_EMPTY_NEEDS_TTY, type EmptyingCommand } from "../owner-add-gate.js";

export type Doc = ReturnType<typeof parseDocument>;

/** A mutator failure with a CLI error payload. Thrown inside the lock, mapped by `withRegistryLock`. */
export class RegistryCliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "RegistryCliError";
  }
}

export function loadDoc(path: string): Doc {
  if (!existsSync(path)) throw new RegistryNotFoundError(path);
  const raw = readFileSync(path, "utf8");
  return parseDocument(raw);
}

/** Atomic write: temp file in the same directory, then rename. Mode 0600. */
export function writeRegistryText(text: string, path: string): void {
  const tmp = `${path}.write.tmp.${process.pid}`;
  try {
    writeFileSync(tmp, text, { mode: 0o600 });
    try {
      chmodSync(tmp, 0o600);
    } catch {
      /* platform-restricted */
    }
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * Number of owners the guard would treat as registered in `doc`: personalOrgs
 * plus the githubOrgs of every ACTIVE engagement. Tolerant of a malformed
 * document (it is used on the text before and after an edit, either of which
 * may be invalid).
 *
 * Counting only active engagements is the fail-closed reading: an engagement
 * ended past the retention window (`end --purge`) stops counting, so purging
 * the last owner-holding engagement is treated as emptying the owner set.
 */
export function ownerCount(doc: Doc): number {
  let js: unknown;
  try {
    js = doc.toJS();
  } catch {
    return 0;
  }
  if (js === null || typeof js !== "object") return 0;
  const root = js as Record<string, unknown>;
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const owners = new Set<string>(strings(root["personalOrgs"]));
  const engagements = Array.isArray(root["engagements"]) ? root["engagements"] : [];
  for (const e of engagements) {
    if (e === null || typeof e !== "object") continue;
    const eng = e as Record<string, unknown>;
    const ended = typeof eng["ended"] === "string" || eng["ended"] instanceof Date ? String(eng["ended"]) : undefined;
    // `isActive` reads only `ended`.
    if (!isActive({ ended } as Engagement)) continue;
    for (const o of strings(eng["githubOrgs"])) owners.add(o);
  }
  return owners.size;
}

export interface CommitOptions extends RequireTerminalOptions {
  /** What a person would run to do this, for the owner-set-empty refusal. */
  command: EmptyingCommand;
  /** `ownerCount` of the document as it was read, before any edit. */
  ownersBefore: number;
}

/**
 * Gate, validate, then write. See the contract at the top of this file.
 * Must be called inside `withRegistryLock`.
 */
export function commitRegistry(doc: Doc, path: string, opts: CommitOptions): void {
  if (opts.ownersBefore > 0 && ownerCount(doc) === 0 && !isHumanTerminal(opts)) {
    throw new RegistryCliError(OWNER_SET_EMPTY_NEEDS_TTY, ownerSetEmptyRefusal(opts.command));
  }
  const text = doc.toString();
  assertValidRegistryText(text);
  writeRegistryText(text, path);
}

/**
 * Throw a content-free `RegistryCliError` unless `text` is a valid registry.
 * The zod message is deliberately dropped: it names orgs and engagement ids.
 */
export function assertValidRegistryText(text: string): void {
  try {
    parseRegistryText(text);
  } catch {
    throw new RegistryCliError(
      "REGISTRY_WOULD_BE_INVALID",
      "nothing was written: the change would leave the registry unreadable. " +
        "An org can be registered only once (in personalOrgs or in one engagement's githubOrgs); " +
        "otherwise fix the registry by hand. Run `repo-aegis doctor` once it loads.",
    );
  }
}

/**
 * Run a callback under the registry write lock; map known exception types
 * to their canonical CLI error payloads. Centralises the lock+error dance
 * shared by every registry mutator.
 */
export function withRegistryLock<T>(opts: OutputOptions, fn: () => T): T {
  try {
    return withLockSync(fn);
  } catch (err) {
    if (err instanceof RegistryCliError) {
      emitError(
        { code: err.code, error: err.message, ...(err.details !== undefined && { details: err.details }) },
        opts,
      );
    }
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
