// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Self-hygiene guard: repo-aegis must not leak from its own source tree.
//
// Motivation (a real incident, not a hypothetical): a test fixture in
// `egress.test.ts` hardcoded a genuine account-scoped CodeArtifact host. It
// was committed, pushed to a public repo, and shipped inside the published npm
// tarball — this package lists `src` in `files`, so fixture values are
// world-readable. It survived review for a whole release.
//
// The tool could not catch it. `egressParserFor` dispatches on FILENAME
// (package-lock.json, .npmrc, Cargo.lock, …), so a `.ts` fixture is
// structurally invisible to the egress check no matter what it contains. That
// blind spot is by design for the product feature — it would be noise to scan
// every source file for registry URLs — but it means the project needs its own
// guard. This is it.
//
// Scope: repo-aegis's own tracked source. Deliberately narrow and
// high-signal — it must never become a check people learn to ignore.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Repo root, derived from this file's location (packages/core/dist → ../../..). */
const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");

/** Files git tracks, filtered to the text shapes worth scanning. */
function trackedSourceFiles(): string[] {
  let out: string;
  try {
    out = execFileSync("git", ["ls-files", "-z"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return []; // not a git checkout (e.g. installed tarball): nothing to police
  }
  return out
    .split("\0")
    .filter(Boolean)
    .filter(f => /\.(ts|js|mjs|cjs|json|ya?ml|md|sh|txt)$/i.test(f))
    // The changelog and design docs discuss the incident in the abstract and
    // legitimately contain the words; they are prose, not fixtures.
    .filter(f => f !== "CHANGELOG.md");
}

function read(f: string): string {
  try {
    return readFileSync(join(REPO_ROOT, f), "utf8");
  } catch {
    return "";
  }
}

/**
 * A 12-digit run is the shape of an AWS account id.
 */
const ACCOUNT_ID_RE = /\b\d{12}\b/g;

/**
 * Obviously-fabricated ids are allowed, so fixtures can still look realistic:
 * a repeated digit (000000000000) or a counting run (123456789012).
 *
 * Recognising the *shape* of a dummy beats allowlisting specific literals — a
 * literal allowlist grows silently and each entry has to be re-verified by a
 * human, which is exactly the review step that failed last time.
 */
function isSyntheticAccountId(id: string): boolean {
  if (/^(\d)\1{11}$/.test(id)) return true;
  const digits = [...id].map(Number);
  const stepsBy = (delta: number): boolean =>
    digits.every((d, i) => i === 0 || d === (digits[i - 1]! + delta + 10) % 10);
  return stepsBy(1) || stepsBy(-1);
}

// The sample is assembled from fragments on purpose: a 12-digit literal in
// this file would be flagged by the very check it exists to validate.
const REALISTIC_ID = ["4738", "2910", "5736"].join("");

describe("self-hygiene: the detector itself", () => {
  it("flags a realistic account id (the check must be able to fail)", () => {
    assert.equal(isSyntheticAccountId(REALISTIC_ID), false);
    assert.match(REALISTIC_ID, /^\d{12}$/);
  });

  it("allows obviously-fabricated placeholders", () => {
    for (const id of ["000000000000", "111111111111", "123456789012", "098765432109"]) {
      assert.equal(isSyntheticAccountId(id), true, `${id} should read as a placeholder`);
    }
  });

  it("detects a private registry host embedded in arbitrary text", () => {
    // Proves the host check would have caught the original incident: a
    // CodeArtifact host inside a .ts file, which the product's own
    // filename-dispatched egress scan cannot see.
    const sample = `const CA = "acme-${REALISTIC_ID}.d.codeartifact.eu-central-1.amazonaws.com";`;
    const re = /\b[a-z0-9][a-z0-9-]*-\d{12}\.d\.codeartifact\.[a-z0-9-]+\.amazonaws\.com/gi;
    assert.ok(re.test(sample), "must match an account-scoped CodeArtifact host");
  });
});

describe("self-hygiene: repo-aegis's own tree", () => {
  const files = trackedSourceFiles();

  it("has a non-empty file list to police (guard against a silent no-op)", () => {
    // Without this, a broken `git ls-files` would make every check below pass
    // vacuously — the classic way a security test rots into decoration.
    assert.ok(files.length > 50, `expected a populated tracked-file list, got ${files.length}`);
  });

  it("contains no real-looking AWS account id", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const text = read(f);
      for (const m of text.matchAll(ACCOUNT_ID_RE)) {
        const id = m[0];
        if (isSyntheticAccountId(id)) continue;
        // Report the file and position only — never echo the value, or the
        // failure message becomes the leak it is meant to prevent.
        const line = text.slice(0, m.index).split("\n").length;
        offenders.push(`${f}:${line}`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `12-digit account-id-shaped string(s) found in tracked source at:\n  ${offenders.join("\n  ")}\n` +
        `Use an all-zero placeholder (000000000000). This package ships \`src\` to npm, ` +
        `so anything here is world-readable.`,
    );
  });

  it("contains no private package-registry host", () => {
    // Account-scoped CodeArtifact and ECR hosts embed an account id and an org
    // name; a private GHE/Artifactory host leaks internal topology. Matches the
    // host SHAPE, so it catches hosts this project has never seen.
    const HOST_RES: Array<[string, RegExp]> = [
      ["codeartifact", /\b[a-z0-9][a-z0-9-]*-\d{12}\.d\.codeartifact\.[a-z0-9-]+\.amazonaws\.com/gi],
      ["ecr", /\b\d{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com/gi],
    ];
    const offenders: string[] = [];
    for (const f of files) {
      const text = read(f);
      for (const [label, re] of HOST_RES) {
        for (const m of text.matchAll(re)) {
          if (/\b0{12}\b/.test(m[0])) continue; // synthetic placeholder
          const line = text.slice(0, m.index).split("\n").length;
          offenders.push(`${f}:${line} (${label})`);
        }
      }
    }
    assert.deepEqual(offenders, [], `private registry host(s) in tracked source:\n  ${offenders.join("\n  ")}`);
  });

  it("has no raw NUL byte in tracked text files", () => {
    // A literal NUL makes git treat the file as binary, so its diffs render as
    // "Bin ... bytes" and become unreviewable — how the account id above went
    // unnoticed in review for a release. Use the \\u0000 escape instead.
    const offenders: string[] = [];
    for (const f of files) {
      let buf: Buffer;
      try {
        buf = readFileSync(join(REPO_ROOT, f));
      } catch {
        continue;
      }
      if (buf.includes(0)) offenders.push(f);
    }
    assert.deepEqual(
      offenders,
      [],
      `raw NUL byte(s) make these files binary to git (diffs unreviewable):\n  ${offenders.join("\n  ")}`,
    );
  });
});
