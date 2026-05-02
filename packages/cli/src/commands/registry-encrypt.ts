import {
  existsSync,
  mkdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  registryPath,
  statePath,
  encryptFile,
  writeBufferTo,
  AgeNotFoundError,
  AgeError,
  appendAuditRecord,
} from "@de-otio/repo-aegis-core";
import { emitJson, emitText, emitError, type OutputOptions } from "../format.js";

interface EncryptOptions extends OutputOptions {
  recipient?: string;
}

/**
 * Path of the marker file that records "registry is encrypted at rest".
 * Lives under the home's state/ dir alongside the other state metadata
 * (deny-set cache, leak-context flag). Presence of this file is the
 * canonical signal; absence means the registry is plaintext on disk.
 */
function encryptedMarkerPath(): string {
  return join(statePath(), "registry.encrypted");
}

/**
 * Encrypt `~/.config/repo-aegis/engagements.yaml` to
 * `engagements.yaml.age` with the given age recipient, then remove
 * the plaintext and write a marker file recording the transition.
 *
 * Idempotent: refuses to run if either the ciphertext or the marker
 * file already exists. Re-encrypting a still-encrypted registry would
 * silently rewrite the recipient list without confirmation, which is
 * exactly the kind of foot-gun the marker file exists to prevent.
 */
export function registryEncrypt(opts: EncryptOptions): void {
  if (!opts.recipient) {
    emitError(
      { code: "USAGE", error: "registry encrypt requires --recipient <pubkey>" },
      opts,
    );
  }

  const plain = registryPath();
  const cipher = `${plain}.age`;
  const marker = encryptedMarkerPath();

  if (existsSync(marker)) {
    emitError(
      {
        code: "REGISTRY_ALREADY_ENCRYPTED",
        error: "registry is already marked encrypted",
        details: `marker file exists at ${marker}`,
      },
      opts,
    );
  }
  if (existsSync(cipher)) {
    emitError(
      {
        code: "REGISTRY_ALREADY_ENCRYPTED",
        error: "ciphertext already present",
        details: `${cipher} exists; refuse to overwrite`,
      },
      opts,
    );
  }
  if (!existsSync(plain)) {
    emitError(
      {
        code: "REGISTRY_NOT_FOUND",
        error: "engagement registry not found",
        details: `expected at ${plain}`,
      },
      opts,
    );
  }

  let ciphertext: Buffer;
  try {
    ciphertext = encryptFile(plain, { recipients: [opts.recipient!] });
  } catch (err) {
    if (err instanceof AgeNotFoundError) {
      emitError({ code: err.code, error: err.message }, opts);
    }
    if (err instanceof AgeError) {
      emitError({ code: "ENCRYPT_ERROR", error: err.message }, opts);
    }
    emitError({ code: "ENCRYPT_ERROR", error: (err as Error).message }, opts);
  }

  writeBufferTo(cipher, ciphertext);

  // Now drop the plaintext. Keep this AFTER the ciphertext write so a
  // mid-flight failure leaves the user with the plaintext intact rather
  // than nothing at all.
  unlinkSync(plain);

  // Write the marker file. mkdir-p the state dir in case `init` hasn't
  // been run on this machine (the encrypt command shouldn't fail for a
  // missing state/ parent — it can recreate it).
  mkdirSync(dirname(marker), { recursive: true, mode: 0o700 });
  const markerBody = JSON.stringify(
    {
      encrypted: true,
      recipient: opts.recipient,
      since: new Date().toISOString(),
    },
    null,
    2,
  );
  writeFileSync(marker, markerBody, { mode: 0o600 });

  // Audit (best-effort). Emit AFTER the marker is written so the trail
  // reflects persisted state. The recipient is recorded — it's an
  // age public key, not sensitive material, and is essential to the
  // compliance question "who can read the at-rest registry?".
  try {
    appendAuditRecord({
      action: "registry-encrypt",
      details: { recipient: opts.recipient, marker },
    });
  } catch {
    /* audit log must not break user-facing ops */
  }

  if (opts.json) {
    emitJson({
      action: "registry-encrypt",
      registry: { plain, cipher },
      recipient: opts.recipient,
      marker,
    });
    return;
  }
  emitText(`repo-aegis: encrypted registry to ${cipher}`);
  emitText(`  recipient: ${opts.recipient}`);
  emitText(`  marker:    ${marker}`);
  emitText(`  plaintext removed: ${plain}`);
}
