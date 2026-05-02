// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  registryPath,
  statePath,
  decryptFile,
  writeBufferTo,
  AgeNotFoundError,
  AgeError,
  appendAuditRecord,
} from "@de-otio/repo-aegis-core";
import { emitJson, emitText, emitError, type OutputOptions } from "../format.js";

interface DecryptOptions extends OutputOptions {
  identity?: string;
}

function encryptedMarkerPath(): string {
  return join(statePath(), "registry.encrypted");
}

/**
 * Decrypt `engagements.yaml.age` back to `engagements.yaml` (chmod 600)
 * with the given age identity, then remove the ciphertext and the
 * "encrypted at rest" marker.
 *
 * Idempotent: refuses to run if there's no ciphertext to decrypt
 * (silent no-op would mask a stale marker; a hard error tells the user
 * they're asking for something the filesystem doesn't support).
 */
export function registryDecrypt(opts: DecryptOptions): void {
  if (!opts.identity) {
    emitError(
      { code: "USAGE", error: "registry decrypt requires --identity <path>" },
      opts,
    );
  }

  const plain = registryPath();
  const cipher = `${plain}.age`;
  const marker = encryptedMarkerPath();

  if (!existsSync(cipher)) {
    emitError(
      {
        code: "REGISTRY_NOT_ENCRYPTED",
        error: "no encrypted registry to decrypt",
        details: `${cipher} does not exist`,
      },
      opts,
    );
  }
  if (existsSync(plain)) {
    emitError(
      {
        code: "REGISTRY_NOT_ENCRYPTED",
        error: "plaintext registry already present",
        details: `${plain} exists; refuse to overwrite`,
      },
      opts,
    );
  }

  let cleartext: Buffer;
  try {
    cleartext = decryptFile(cipher, { identityFile: opts.identity! });
  } catch (err) {
    if (err instanceof AgeNotFoundError) {
      emitError({ code: err.code, error: err.message }, opts);
    }
    if (err instanceof AgeError) {
      emitError({ code: "DECRYPT_ERROR", error: err.message }, opts);
    }
    emitError({ code: "DECRYPT_ERROR", error: (err as Error).message }, opts);
  }

  // Write the plaintext (chmod 600 via writeBufferTo) BEFORE removing
  // the ciphertext or the marker, so a mid-flight failure leaves the
  // user with the encrypted form rather than nothing.
  writeBufferTo(plain, cleartext);
  unlinkSync(cipher);
  if (existsSync(marker)) {
    unlinkSync(marker);
  }

  // Audit (best-effort). The identity-file path is a sensitive
  // (private-key-bearing) value; record only that decrypt happened
  // and the marker that was removed.
  try {
    appendAuditRecord({
      action: "registry-decrypt",
      details: { markerRemoved: marker },
    });
  } catch {
    /* audit log must not break user-facing ops */
  }

  if (opts.json) {
    emitJson({
      action: "registry-decrypt",
      registry: { plain, cipher },
      identity: opts.identity,
      markerRemoved: marker,
    });
    return;
  }
  emitText(`repo-aegis: decrypted registry to ${plain}`);
  emitText(`  identity:        ${opts.identity}`);
  emitText(`  ciphertext removed: ${cipher}`);
  emitText(`  marker removed:     ${marker}`);
}
