// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Integration tests for `scan-env`. Like suggest-markers.test.ts, behaviour is
// asserted against the registry file on disk rather than captured stdout.

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withEnv, captureOutput } from "../_test-utils.js";
import { scanEnv } from "./scan-env.js";

let tmp: string;
let aegisHome: string;
let scanHome: string;
let registryPath: string;

const TOKEN = "SUPER-SECRET-TOKEN-VALUE";
const DOCKER_AUTH = "ZG9ja2VyLXNlY3JldA==";

function writeRegistry(): void {
  writeFileSync(
    registryPath,
    `schemaVersion: 2
engagements:
  - id: customer-a
    name: Customer A
    markers: [acme-corp]
`,
  );
}

function writeDotfiles(): void {
  mkdirSync(join(scanHome, ".docker"), { recursive: true });
  writeFileSync(
    join(scanHome, ".npmrc"),
    [
      "registry=https://npm.internal.example.com/npm/",
      `//npm.internal.example.com/npm/:_authToken=${TOKEN}`,
      "@pub:registry=https://registry.npmjs.org/",
    ].join("\n"),
  );
  writeFileSync(
    join(scanHome, ".docker", "config.json"),
    JSON.stringify({ auths: { "docker.internal.example.com": { auth: DOCKER_AUTH } } }),
  );
}

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "repo-aegis-scanenv-"));
  aegisHome = join(tmp, "aegis");
  scanHome = join(tmp, "home");
  registryPath = join(aegisHome, "engagements.yaml");
  mkdirSync(aegisHome, { recursive: true });
  mkdirSync(scanHome, { recursive: true });
  writeDotfiles();
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  writeRegistry();
});

/**
 * Run the command with output captured. Capturing is not cosmetic: `emitError`
 * calls `process.exit`, which `captureOutput` patches into a catchable
 * ExitError — without it a usage-error test would kill the whole test process.
 */
function run(opts: Parameters<typeof scanEnv>[0]): { exitCode?: number } {
  return withEnv("REPO_AEGIS_HOME", aegisHome, () =>
    captureOutput(() =>
      scanEnv({ scanHome, from: join(tmp, "no-project"), registryPath, ...opts }),
    ),
  );
}

describe("scan-env", { concurrency: 1 }, () => {
  it("dry-runs by default: finds private hosts and persists nothing", () => {
    run({ json: true });
    const reg = readFileSync(registryPath, "utf8");
    assert.ok(!reg.includes("privateInfra"), "must not write without --accept");
    assert.ok(!reg.includes("internal.example.com"));
  });

  it("records hosts under privateInfra with --accept private-infra", () => {
    run({ accept: "private-infra", json: true });
    const reg = readFileSync(registryPath, "utf8");
    assert.ok(reg.includes("privateInfra"));
    // Escaped literals, not raw hosts — dots must not act as wildcards.
    assert.ok(reg.includes("npm\\.internal\\.example\\.com"));
    assert.ok(reg.includes("docker\\.internal\\.example\\.com"));
  });

  it("NEVER persists an auth token or docker credential", () => {
    run({ accept: "private-infra", json: true });
    const reg = readFileSync(registryPath, "utf8");
    assert.ok(!reg.includes(TOKEN), "npm auth token must never be written");
    assert.ok(!reg.includes(DOCKER_AUTH), "docker credential must never be written");
    // Also check the rendered marker output.
    const markerFile = join(aegisHome, "markers", "_private_infra.txt");
    if (existsSync(markerFile)) {
      const rendered = readFileSync(markerFile, "utf8");
      assert.ok(!rendered.includes(TOKEN));
      assert.ok(!rendered.includes(DOCKER_AUTH));
    }
  });

  it("filters public registries — npmjs must never become a marker", () => {
    run({ accept: "private-infra", json: true });
    const reg = readFileSync(registryPath, "utf8");
    assert.ok(
      !reg.includes("registry.npmjs.org") && !reg.includes("npmjs"),
      "blocking the public npm registry would break every project",
    );
  });

  it("is idempotent — a second run adds nothing new", () => {
    run({ accept: "private-infra", json: true });
    const first = readFileSync(registryPath, "utf8");
    run({ accept: "private-infra", json: true });
    assert.equal(readFileSync(registryPath, "utf8"), first);
  });

  it("routes to always_block when asked", () => {
    run({ accept: "always-block", json: true });
    const reg = readFileSync(registryPath, "utf8");
    assert.ok(reg.includes("always_block"));
    assert.ok(!reg.includes("privateInfra"));
  });

  it("routes to a named engagement's markers", () => {
    run({ accept: "engagement", engagement: "customer-a", json: true });
    const reg = readFileSync(registryPath, "utf8");
    assert.ok(reg.includes("npm\\.internal\\.example\\.com"));
    assert.ok(!reg.includes("privateInfra"));
  });

  it("rejects an unknown placement and an engagement placement with no id", () => {
    assert.equal(run({ accept: "nonsense", json: true }).exitCode, 2);
    // Nothing may be written on a usage error.
    assert.ok(!readFileSync(registryPath, "utf8").includes("internal.example.com"));
    assert.equal(run({ accept: "engagement", json: true }).exitCode, 2);
    assert.ok(!readFileSync(registryPath, "utf8").includes("internal.example.com"));
  });
});
