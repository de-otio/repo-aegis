import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encryptFile, decryptFile, writeBufferTo, AgeError } from "./age.js";

let tmp: string;
let ageAvailable = false;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "repo-aegis-scan-age-test-"));
  const probe = spawnSync("age", ["--version"], { stdio: "ignore" });
  ageAvailable = !probe.error && probe.status === 0;
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makeIdentity(): { identityPath: string; pubkey: string } {
  // age-keygen writes the private key to stdout (or a file with -o); the
  // public key is on a `# public key:` comment line.
  const result = spawnSync("age-keygen", [], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new Error(`age-keygen failed: ${result.stderr}`);
  }
  const out = result.stdout;
  const m = out.match(/# public key: (\S+)/);
  if (!m) throw new Error(`could not parse public key from age-keygen output: ${out}`);
  const pubkey = m[1]!;
  const identityPath = join(tmp, `identity-${Math.random().toString(36).slice(2)}.txt`);
  writeFileSync(identityPath, out);
  return { identityPath, pubkey };
}

describe("encryptFile + decryptFile", () => {
  it("round-trips a file through age encrypt and decrypt (skipped if age not installed)", () => {
    if (!ageAvailable) {
      // The wrapper still throws cleanly; just don't run the round-trip.
      return;
    }
    const { identityPath, pubkey } = makeIdentity();
    const plain = join(tmp, "plain.yaml");
    writeFileSync(plain, "queries:\n  - name: x\n    query: '\"foo\" org:de-otio'\n");

    const cipherBuf = encryptFile(plain, { recipients: [pubkey] });
    const cipherPath = join(tmp, "plain.yaml.age");
    writeBufferTo(cipherPath, cipherBuf);
    assert.ok(existsSync(cipherPath));
    assert.notEqual(cipherBuf.toString("utf8"), readFileSync(plain, "utf8"));

    const recovered = decryptFile(cipherPath, { identityFile: identityPath });
    assert.equal(recovered.toString("utf8"), readFileSync(plain, "utf8"));
  });

  it("encryptFile rejects when no recipient is provided", () => {
    const plain = join(tmp, "plain-no-recip.yaml");
    writeFileSync(plain, "x");
    assert.throws(() => encryptFile(plain, {}), /recipient/);
  });

  it("encryptFile rejects when source missing", () => {
    assert.throws(() => encryptFile(join(tmp, "missing.yaml"), { recipients: ["age1xxx"] }), /not found/);
  });

  it("decryptFile rejects when source missing", () => {
    assert.throws(
      () => decryptFile(join(tmp, "missing.age"), { identityFile: join(tmp, "noid") }),
      /not found/,
    );
  });

  it("decryptFile rejects when identity file missing", () => {
    const cipher = join(tmp, "ciph.age");
    writeFileSync(cipher, "");
    assert.throws(
      () => decryptFile(cipher, { identityFile: join(tmp, "nope.txt") }),
      /identity file not found/,
    );
  });

  it("AgeError surfaces on malformed input (skipped if age not installed)", () => {
    if (!ageAvailable) return;
    const { identityPath } = makeIdentity();
    const garbage = join(tmp, "garbage.age");
    writeFileSync(garbage, "this is not an age ciphertext");
    assert.throws(() => decryptFile(garbage, { identityFile: identityPath }), AgeError);
  });
});
