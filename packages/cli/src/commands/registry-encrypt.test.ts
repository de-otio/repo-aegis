// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureOutput } from "../_test-utils.js";
import { registryEncrypt } from "./registry-encrypt.js";
import { registryDecrypt } from "./registry-decrypt.js";

// ---------------------------------------------------------------------------
// Test setup: an isolated REPO_AEGIS_HOME per test, age binary detection
// ---------------------------------------------------------------------------

let tmp: string;
let home: string;
let originalHome: string | undefined;
let ageAvailable = false;
let recipient = "";
let identityFile = "";

function ageInstalled(): boolean {
  const probe = spawnSync("age", ["--version"], { stdio: "ignore" });
  return !probe.error && probe.status === 0;
}

/**
 * Generate an age keypair via `age-keygen` into the given file. Returns
 * the public-key recipient string. Skips the test if age-keygen is
 * absent. We use age-keygen rather than hard-coding a fixture keypair
 * so the private key never lives in the repo.
 */
function makeKeypair(path: string): string {
  const result = spawnSync("age-keygen", ["-o", path], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new Error(`age-keygen failed: ${result.stderr}`);
  }
  // age-keygen writes the pubkey as a `# public key:` comment in the
  // identity file and also to stderr ("Public key: age1..."). Pull it
  // from the identity file so we don't depend on stderr formatting.
  const body = readFileSync(path, "utf8");
  const m = body.match(/# public key: (age1\S+)/);
  if (!m) throw new Error(`could not parse pubkey from ${path}`);
  return m[1]!;
}

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "repo-aegis-registry-enc-"));
  ageAvailable = ageInstalled();
  if (ageAvailable) {
    identityFile = join(tmp, "identity.txt");
    recipient = makeKeypair(identityFile);
  }
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  home = mkdtempSync(join(tmp, "home-"));
  originalHome = process.env["REPO_AEGIS_HOME"];
  process.env["REPO_AEGIS_HOME"] = home;
});

function restoreHome(): void {
  if (originalHome === undefined) {
    delete process.env["REPO_AEGIS_HOME"];
  } else {
    process.env["REPO_AEGIS_HOME"] = originalHome;
  }
}

const SAMPLE_REGISTRY = `engagements:
  - id: customer-a
    name: Customer A
    markers:
      - acme-corp
`;

function seedPlaintextRegistry(): { plain: string; cipher: string; marker: string } {
  const plain = join(home, "engagements.yaml");
  writeFileSync(plain, SAMPLE_REGISTRY, { mode: 0o600 });
  return {
    plain,
    cipher: `${plain}.age`,
    marker: join(home, "state", "registry.encrypted"),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("registry encrypt / decrypt", () => {
  it("requires --recipient on encrypt", { skip: !ageAvailable }, () => {
    seedPlaintextRegistry();
    const { stderr, exitCode } = captureOutput(() => registryEncrypt({}));
    assert.equal(exitCode, 2);
    assert.match(stderr, /--recipient/);
    restoreHome();
  });

  it("requires --identity on decrypt", { skip: !ageAvailable }, () => {
    const { stderr, exitCode } = captureOutput(() => registryDecrypt({}));
    assert.equal(exitCode, 2);
    assert.match(stderr, /--identity/);
    restoreHome();
  });

  it("round-trips: encrypt then decrypt yields the original bytes", { skip: !ageAvailable }, () => {
    const { plain, cipher, marker } = seedPlaintextRegistry();

    captureOutput(() => registryEncrypt({ recipient, json: true }));
    assert.ok(existsSync(cipher), "ciphertext should exist");
    assert.ok(!existsSync(plain), "plaintext should be removed");
    assert.ok(existsSync(marker), "marker should be written");

    const markerBody = JSON.parse(readFileSync(marker, "utf8")) as {
      encrypted: boolean;
      recipient: string;
      since: string;
    };
    assert.equal(markerBody.encrypted, true);
    assert.equal(markerBody.recipient, recipient);
    assert.match(markerBody.since, /\d{4}-\d{2}-\d{2}T/);

    captureOutput(() => registryDecrypt({ identity: identityFile, json: true }));
    assert.ok(existsSync(plain), "plaintext should be restored");
    assert.ok(!existsSync(cipher), "ciphertext should be removed");
    assert.ok(!existsSync(marker), "marker should be removed");

    assert.equal(readFileSync(plain, "utf8"), SAMPLE_REGISTRY);

    restoreHome();
  });

  it("refuses to encrypt when ciphertext already exists", { skip: !ageAvailable }, () => {
    const { plain, cipher } = seedPlaintextRegistry();
    writeFileSync(cipher, "preexisting-ciphertext");
    const { stderr, exitCode } = captureOutput(() => registryEncrypt({ recipient }));
    assert.equal(exitCode, 2);
    assert.match(stderr, /already/);
    // Plaintext untouched
    assert.ok(existsSync(plain), "plaintext should NOT have been removed");
    restoreHome();
  });

  it("refuses to encrypt when marker file already exists", { skip: !ageAvailable }, () => {
    const { plain, marker } = seedPlaintextRegistry();
    // Pre-create the state dir + marker
    mkdirSync(join(home, "state"), { recursive: true, mode: 0o700 });
    writeFileSync(marker, JSON.stringify({ encrypted: true }));

    const { stderr, exitCode } = captureOutput(() => registryEncrypt({ recipient }));
    assert.equal(exitCode, 2);
    assert.match(stderr, /already/);
    assert.ok(existsSync(plain), "plaintext should NOT have been removed");
    restoreHome();
  });

  it("refuses to decrypt when no ciphertext exists", { skip: !ageAvailable }, () => {
    const { stderr, exitCode } = captureOutput(() =>
      registryDecrypt({ identity: identityFile }),
    );
    assert.equal(exitCode, 2);
    assert.match(stderr, /no encrypted registry/i);
    restoreHome();
  });

  it("refuses to decrypt when plaintext already exists", { skip: !ageAvailable }, () => {
    const { plain, cipher } = seedPlaintextRegistry();
    captureOutput(() => registryEncrypt({ recipient }));
    // Restore plaintext (simulate user racing or the marker getting stale)
    writeFileSync(plain, SAMPLE_REGISTRY, { mode: 0o600 });
    assert.ok(existsSync(cipher), "ciphertext should still be present");

    const { stderr, exitCode } = captureOutput(() =>
      registryDecrypt({ identity: identityFile }),
    );
    assert.equal(exitCode, 2);
    assert.match(stderr, /already/);
    restoreHome();
  });
});
