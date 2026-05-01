import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export class AgeNotFoundError extends Error {
  readonly code = "AGE_NOT_FOUND" as const;
  constructor() {
    super(
      "the `age` binary is required for encrypt-query / decrypt-query but was not found on PATH; " +
        "install from https://age-encryption.org",
    );
  }
}

export class AgeError extends Error {
  readonly code = "AGE_ERROR" as const;
  constructor(public action: "encrypt" | "decrypt", public stderr: string) {
    super(`age ${action} failed: ${stderr.trim() || "(no stderr)"}`);
  }
}

function ageBinary(): string {
  const probe = spawnSync("age", ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (probe.error || probe.status !== 0) {
    throw new AgeNotFoundError();
  }
  return "age";
}

export interface EncryptOptions {
  /** Recipients (pubkey strings starting with `age1...` or `ssh-ed25519 ...`). */
  recipients?: string[];
  /** Path to a file holding one recipient per line. */
  recipientFile?: string;
}

/**
 * Encrypt a file with age. Returns the ciphertext as a Buffer (binary
 * format by default; ASCII-armoured if -a is added later). Caller is
 * responsible for writing it.
 */
export function encryptFile(plainPath: string, opts: EncryptOptions): Buffer {
  if (!existsSync(plainPath)) {
    throw new Error(`source file not found: ${plainPath}`);
  }
  if ((!opts.recipients || opts.recipients.length === 0) && !opts.recipientFile) {
    throw new Error("encrypt requires at least one --recipient or --recipient-file");
  }
  const args: string[] = [];
  for (const r of opts.recipients ?? []) {
    args.push("-r", r);
  }
  if (opts.recipientFile) {
    if (!existsSync(opts.recipientFile)) {
      throw new Error(`recipient file not found: ${opts.recipientFile}`);
    }
    args.push("-R", opts.recipientFile);
  }

  const bin = ageBinary();
  const plaintext = readFileSync(plainPath);
  const result = spawnSync(bin, args, {
    input: plaintext,
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new AgeError("encrypt", (result.stderr ?? Buffer.from("")).toString("utf8"));
  }
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? "");
}

export interface DecryptOptions {
  /** Path to an age identity file (one or more identities). */
  identityFile: string;
}

/**
 * Decrypt a file with age. Returns the cleartext as a Buffer.
 */
export function decryptFile(cipherPath: string, opts: DecryptOptions): Buffer {
  if (!existsSync(cipherPath)) {
    throw new Error(`source file not found: ${cipherPath}`);
  }
  if (!existsSync(opts.identityFile)) {
    throw new Error(`identity file not found: ${opts.identityFile}`);
  }
  const bin = ageBinary();
  const ciphertext = readFileSync(cipherPath);
  const result = spawnSync(bin, ["-d", "-i", opts.identityFile], {
    input: ciphertext,
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new AgeError("decrypt", (result.stderr ?? Buffer.from("")).toString("utf8"));
  }
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? "");
}

export function writeBufferTo(target: string, buf: Buffer): void {
  writeFileSync(target, buf, { mode: 0o600 });
}
