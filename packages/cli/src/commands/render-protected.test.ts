// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `render` when the markers directory is write-protected (the Edit deny rules
// from `install claude-md` reach the sandbox): a refusal that tells the person
// to run it, not a bare EACCES to retry or work around.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureOutput, withEnv } from "../_test-utils.js";
import { isPermissionDenied } from "../fs-utils.js";
import { render } from "./render.js";

let tmp: string;
before(() => {
  tmp = mkdtempSync(join(tmpdir(), "repo-aegis-render-protected-"));
});
after(() => {
  // Restore write permission so the temp tree can be removed.
  try {
    chmodSync(join(tmp, "locked"), 0o700);
  } catch {
    /* not created */
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe("isPermissionDenied", () => {
  it("is true for EACCES and EPERM only", () => {
    assert.equal(isPermissionDenied(Object.assign(new Error("x"), { code: "EACCES" })), true);
    assert.equal(isPermissionDenied(Object.assign(new Error("x"), { code: "EPERM" })), true);
    assert.equal(isPermissionDenied(Object.assign(new Error("x"), { code: "ENOENT" })), false);
    assert.equal(isPermissionDenied(new Error("x")), false);
    assert.equal(isPermissionDenied(null), false);
  });
});

describe("render into a write-protected markers directory", () => {
  // As root, a read-only directory is still writable: the refusal cannot be provoked.
  const asRoot = typeof process.getuid === "function" && process.getuid() === 0;

  it("refuses with MARKERS_WRITE_PROTECTED and says a person runs it", { skip: asRoot }, () => {
    const home = join(tmp, "aegis");
    mkdirSync(home, { recursive: true });
    // `render` re-chmods an existing markers directory itself, so the refusal is provoked the way the
    // sandbox would: the place it has to create the directory in cannot be written.
    const locked = join(tmp, "locked");
    mkdirSync(locked, { recursive: true });
    const registry = join(home, "engagements.yaml");
    writeFileSync(
      registry,
      "always_block: []\nengagements:\n  - id: customer-a\n    name: Customer A\n    markers:\n      - customer-a-marker\n",
    );
    chmodSync(locked, 0o500); // what the sandbox's merged Edit deny looks like to the writer

    const out = withEnv("REPO_AEGIS_MARKERS_DIR", join(locked, "markers"), () =>
      withEnv("REPO_AEGIS_REGISTRY", registry, () =>
        withEnv("REPO_AEGIS_HOME", home, () => captureOutput(() => render({ json: true }))),
      ),
    );
    assert.equal(out.exitCode, 2);
    const payload = JSON.parse(out.stderr) as { code: string; error: string; details: string };
    assert.equal(payload.code, "MARKERS_WRITE_PROTECTED");
    assert.match(payload.details, /person runs `repo-aegis render` from their own terminal/);
    assert.match(payload.details, /Do not retry/);
    assert.doesNotMatch(out.stderr, /customer-a-marker/);
  });
});
