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
import {
  existsSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  renameSync,
  rmSync,
  realpathSync,
  statSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, basename, join } from "node:path";
import { parseDocument } from "yaml";
import {
  withLockSync,
  parseRegistryText,
  PatternValidationError,
  RegistryNotFoundError,
  LockTimeoutError,
} from "@de-otio/repo-aegis-core";
import { emitError, type OutputOptions } from "../format.js";
import { isHumanTerminal, type RequireTerminalOptions } from "../require-terminal.js";
import { ownerSetEmptyRefusal, OWNER_SET_EMPTY_NEEDS_TTY, type EmptyingCommand } from "../owner-add-gate.js";

export type Doc = ReturnType<typeof parseDocument>;

/** A mutator failure with a CLI error payload. Thrown inside the lock, mapped by `withRegistryLock`. */
export class RegistryCliError extends Error {
  constructor(
    /** Undefined keeps the code-less `{ error }` payload shape. */
    readonly code: string | undefined,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "RegistryCliError";
  }
}

/**
 * Read the registry as a YAML document. A missing file is
 * `RegistryNotFoundError` (mapped to `REGISTRY_NOT_FOUND`); any other read
 * failure keeps the code-less `{ error }` payload these commands always used.
 */
export function loadDoc(path: string): Doc {
  if (!existsSync(path)) throw new RegistryNotFoundError(path);
  try {
    return parseDocument(readFileSync(path, "utf8"));
  } catch (err) {
    throw new RegistryCliError(undefined, (err as Error).message);
  }
}

/**
 * Atomic write: a temp file next to the REAL target, then rename over it.
 *
 * `path` may be a symlink (a registry kept in a dotfiles repo, say). Renaming
 * a temp file over the link itself would replace the link with a regular file
 * and leave its target silently diverging, so resolve it first. The temp file
 * is created exclusively (`wx`) with a random suffix, so a pre-planted file or
 * link at a predictable name cannot redirect the write; mode is the target's
 * existing permission bits, else 0600.
 */
export function writeRegistryText(text: string, path: string): void {
  const real = existsSync(path) ? realpathSync(path) : path;
  let mode = 0o600;
  try {
    mode = statSync(real).mode & 0o777;
  } catch {
    /* new file: 0600 */
  }
  const tmp = join(dirname(real), `.${basename(real)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, text, { mode, flag: "wx" });
    try {
      chmodSync(tmp, mode);
    } catch {
      /* platform-restricted */
    }
    renameSync(tmp, real);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * The registered-owner set of `doc`: personalOrgs plus the githubOrgs of EVERY
 * engagement (ended or not), lower-cased, as a set.
 *
 * MUST MATCH core `registeredOwners()` (rule h, branch pr1-rule-h,
 * packages/core/src/registered-owners.ts); replace this with that import when
 * the branches merge. If the two disagree, this gate's idea of "the owner set
 * just became empty" differs from the guard's, and a non-interactive caller can
 * empty the set the guard sees one step at a time. Tolerant of a malformed
 * document: it runs on the text before and after an edit, either of which may
 * be invalid.
 */
export function registeredOwnerSet(doc: Doc): Set<string> {
  const owners = new Set<string>();
  let js: unknown;
  try {
    js = doc.toJS();
  } catch {
    return owners;
  }
  if (js === null || typeof js !== "object") return owners;
  const root = js as Record<string, unknown>;
  const add = (v: unknown): void => {
    if (Array.isArray(v)) for (const x of v) if (typeof x === "string") owners.add(x.toLowerCase());
  };
  add(root["personalOrgs"]);
  const engagements = Array.isArray(root["engagements"]) ? root["engagements"] : [];
  for (const e of engagements) {
    if (e !== null && typeof e === "object") add((e as Record<string, unknown>)["githubOrgs"]);
  }
  return owners;
}

/** Size of {@link registeredOwnerSet}. */
export function ownerCount(doc: Doc): number {
  return registeredOwnerSet(doc).size;
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
        {
          ...(err.code !== undefined && { code: err.code }),
          error: err.message,
          ...(err.details !== undefined && { details: err.details }),
        },
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
