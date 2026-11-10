// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `registry decrypt` is kept for at least one release so a registry that was
// encrypted by an earlier version can be brought back to plaintext. `registry
// encrypt` is gone: the command only says so and exits 2.
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encryptFile } from "@de-otio/repo-aegis-core";
import { captureOutput } from "../_test-utils.js";
import { cliBuilt, cliPath } from "../_subprocess-utils.js";
import { registryDecrypt } from "./registry-decrypt.js";

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

/** Generate a keypair into `path`; the private key never lives in the repo. */
function makeKeypair(path: string): string {
  const result = spawnSync("age-keygen", ["-o", path], { encoding: "utf8" });
  if (result.error || result.status !== 0) throw new Error(`age-keygen failed: ${result.stderr}`);
  const m = readFileSync(path, "utf8").match(/# public key: (age1\S+)/);
  if (!m) throw new Error(`could not parse pubkey from ${path}`);
  return m[1]!;
}

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "repo-aegis-registry-dec-"));
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
  if (originalHome === undefined) delete process.env["REPO_AEGIS_HOME"];
  else process.env["REPO_AEGIS_HOME"] = originalHome;
}

const SAMPLE_REGISTRY = `engagements:
  - id: customer-a
    name: Customer A
    markers:
      - acme-corp
`;

/** An encrypted-at-rest registry as an earlier version left it: ciphertext plus the marker, no plaintext. */
function seedEncryptedRegistry(): { plain: string; cipher: string; marker: string } {
  const plain = join(home, "engagements.yaml");
  const cipher = `${plain}.age`;
  const marker = join(home, "state", "registry.encrypted");
  const source = join(home, "source.yaml");
  writeFileSync(source, SAMPLE_REGISTRY);
  writeFileSync(cipher, encryptFile(source, { recipients: [recipient] }), { mode: 0o600 });
  rmSync(source);
  mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(marker, JSON.stringify({ encrypted: true }));
  return { plain, cipher, marker };
}

describe("registry decrypt (kept for migration)", () => {
  it("requires --identity", () => {
    const { stderr, exitCode } = captureOutput(() => registryDecrypt({}));
    assert.equal(exitCode, 2);
    assert.match(stderr, /--identity/);
    restoreHome();
  });

  it("restores the plaintext registry and removes the ciphertext and the marker", { skip: !ageAvailable }, () => {
    const { plain, cipher, marker } = seedEncryptedRegistry();
    captureOutput(() => registryDecrypt({ identity: identityFile, json: true }));
    assert.equal(readFileSync(plain, "utf8"), SAMPLE_REGISTRY);
    assert.equal(existsSync(cipher), false, "ciphertext removed");
    assert.equal(existsSync(marker), false, "marker removed");
    restoreHome();
  });

  it("refuses when no ciphertext exists", () => {
    const { stderr, exitCode } = captureOutput(() => registryDecrypt({ identity: "/nonexistent/identity" }));
    assert.equal(exitCode, 2);
    assert.match(stderr, /no encrypted registry/i);
    restoreHome();
  });

  it("refuses to overwrite a plaintext registry that is already present", { skip: !ageAvailable }, () => {
    const { plain, cipher } = seedEncryptedRegistry();
    writeFileSync(plain, "engagements: []\n", { mode: 0o600 });
    const { stderr, exitCode } = captureOutput(() => registryDecrypt({ identity: identityFile }));
    assert.equal(exitCode, 2);
    assert.match(stderr, /already/);
    assert.equal(readFileSync(plain, "utf8"), "engagements: []\n", "plaintext untouched");
    assert.ok(existsSync(cipher), "ciphertext kept");
    restoreHome();
  });
});

describe("registry encrypt (removed)", { skip: !cliBuilt() }, () => {
  function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
    const r = spawnSync(process.execPath, [cliPath, "registry", "encrypt", ...args], {
      encoding: "utf8",
      env: { ...process.env, REPO_AEGIS_HOME: home },
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }

  it("exits 2 with a one-line removal notice, with or without the old --recipient flag", () => {
    for (const args of [[], ["--recipient", "age1example"]]) {
      const r = run(args);
      assert.equal(r.status, 2);
      assert.match(r.stderr, /registry encrypt was removed in 0\.15\.0; at-rest encryption is not part of accident prevention/);
      // The once-per-version notice (P1-G) may precede it on a home that exists; the removal notice itself is one line.
      const lines = r.stderr.trim().split("\n").filter(l => !l.includes("is new here: run `repo-aegis upgrade`"));
      assert.equal(lines.length, 1, "one line");
    }
    restoreHome();
  });

  it("does not touch an existing plaintext registry", () => {
    const plain = join(home, "engagements.yaml");
    writeFileSync(plain, SAMPLE_REGISTRY);
    run(["--recipient", "age1example"]);
    assert.equal(readFileSync(plain, "utf8"), SAMPLE_REGISTRY);
    assert.equal(existsSync(`${plain}.age`), false);
    restoreHome();
  });
});
