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
import { scanEnv, findPackageNames, AGENT_SESSION_LINK_PATTERN } from "./scan-env.js";

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

// ---------------------------------------------------------------------------
// `--self`: the inverse direction. Candidates are the operator's own names.
// ---------------------------------------------------------------------------

describe("scan-env --self", { concurrency: 1 }, () => {
  let projectRoot: string;

  /** A tiny workspace: a scoped root package and an unscoped nested one. */
  function writeProject(): void {
    projectRoot = join(tmp, "project");
    rmSync(projectRoot, { recursive: true, force: true });
    mkdirSync(join(projectRoot, "packages", "widget"), { recursive: true });
    mkdirSync(join(projectRoot, "node_modules", "left-pad-placeholder"), {
      recursive: true,
    });
    writeFileSync(
      join(projectRoot, "package.json"),
      JSON.stringify({ name: "@example-scope/toolkit" }),
    );
    writeFileSync(
      join(projectRoot, "packages", "widget", "package.json"),
      JSON.stringify({ name: "internal-project-codename" }),
    );
    writeFileSync(
      join(projectRoot, "node_modules", "left-pad-placeholder", "package.json"),
      JSON.stringify({ name: "somebody-elses-package" }),
    );
  }

  function writeSelfRegistry(): void {
    writeFileSync(
      registryPath,
      `schemaVersion: 2
personalOrgs: [example-org, tiny]
engagements:
  - id: customer-a
    name: Customer A
    markers: [acme-corp]
`,
    );
  }

  function runSelf(opts: Parameters<typeof scanEnv>[0] = {}): { exitCode?: number } {
    return withEnv("REPO_AEGIS_HOME", aegisHome, () =>
      captureOutput(() =>
        scanEnv({ self: true, from: projectRoot, registryPath, ...opts }),
      ),
    );
  }

  before(() => {
    writeProject();
  });

  beforeEach(() => {
    writeSelfRegistry();
  });

  it("finds package names, skipping node_modules — a dependency is someone else's identity", () => {
    const names = findPackageNames(projectRoot).map(n => n.name);
    // A scoped name yields BOTH halves: the scope travels in registry URLs and
    // import paths, the bare name in stack traces and lockfiles.
    assert.ok(names.includes("example-scope"));
    assert.ok(names.includes("toolkit"));
    assert.ok(names.includes("internal-project-codename"));
    assert.ok(
      !names.includes("somebody-elses-package"),
      "blocking a dependency's name would block the world",
    );
  });

  it("dry-runs by default: offers candidates and persists nothing", () => {
    runSelf({ json: true });
    const reg = readFileSync(registryPath, "utf8");
    assert.ok(!reg.includes("selfIdentity"), "must not write without --accept");
  });

  it("offers personalOrgs, package names and the session-link shape", () => {
    runSelf({ accept: "self-identity", json: true });
    const reg = readFileSync(registryPath, "utf8");
    assert.ok(reg.includes("selfIdentity"));
    assert.ok(reg.includes("example-org"), "a declared personal org");
    assert.ok(reg.includes("example-scope"), "the npm scope");
    assert.ok(reg.includes("internal-project-codename"), "a workspace package name");
    assert.ok(
      reg.includes(AGENT_SESSION_LINK_PATTERN),
      "the agent session-link shape is offered verbatim, already escaped",
    );
    assert.ok(!reg.includes("somebody-elses-package"));
  });

  it("drops names too short to match safely, rather than flooding every file", () => {
    // `tiny` would match inside `destiny`, `mutiny`, `tinymce` — in a
    // customer-coupled repo that is a guardrail nobody can work next to.
    runSelf({ accept: "self-identity", json: true });
    const reg = readFileSync(registryPath, "utf8");
    const selfBlock = reg.slice(reg.indexOf("selfIdentity"));
    assert.ok(!selfBlock.includes("tiny"), "short org must not become a pattern");
  });

  it("escapes the literals it synthesises — a name is not a regex", () => {
    writeFileSync(
      join(projectRoot, "package.json"),
      JSON.stringify({ name: "example-scope.tool+kit" }),
    );
    runSelf({ accept: "self-identity", json: true });
    const reg = readFileSync(registryPath, "utf8");
    assert.ok(reg.includes("example-scope\\.tool\\+kit"), "dots and plus are escaped");
    writeFileSync(
      join(projectRoot, "package.json"),
      JSON.stringify({ name: "@example-scope/toolkit" }),
    );
  });

  it("renders to the reserved _self_identity stem, not markers.txt", () => {
    runSelf({ accept: "self-identity", json: true });
    const rendered = readFileSync(
      join(aegisHome, "markers", "_self_identity.txt"),
      "utf8",
    );
    assert.ok(rendered.includes("example-org"));
    const flat = readFileSync(join(aegisHome, "markers.txt"), "utf8");
    assert.ok(
      !flat.includes("example-org"),
      "the class-gated stem must stay out of the flat union",
    );
  });

  it("is idempotent — a second --accept adds nothing new", () => {
    runSelf({ accept: "self-identity", json: true });
    const first = readFileSync(registryPath, "utf8");
    runSelf({ accept: "self-identity", json: true });
    assert.equal(readFileSync(registryPath, "utf8"), first);
  });

  it("still offers package names and the session shape when no registry can be read", () => {
    const r = withEnv("REPO_AEGIS_HOME", aegisHome, () =>
      captureOutput(() =>
        scanEnv({
          self: true,
          from: projectRoot,
          registryPath: join(tmp, "definitely-absent.yaml"),
          json: true,
        }),
      ),
    );
    assert.notEqual(r.exitCode, 2, "a missing registry is not an error for a dry run");
  });

  it("refuses a host placement: --self records identity, not hosts", () => {
    for (const bad of ["private-infra", "always-block", "engagement"]) {
      assert.equal(runSelf({ accept: bad, json: true }).exitCode, 2);
      assert.ok(!readFileSync(registryPath, "utf8").includes("selfIdentity"));
    }
  });

  it("leaves the host-scanning mode untouched when --self is absent", () => {
    // `self-identity` is not a host placement, so the unchanged path rejects it.
    const r = withEnv("REPO_AEGIS_HOME", aegisHome, () =>
      captureOutput(() =>
        scanEnv({ scanHome, from: join(tmp, "no-project"), registryPath, accept: "self-identity", json: true }),
      ),
    );
    assert.equal(r.exitCode, 2);
    assert.ok(!readFileSync(registryPath, "utf8").includes("selfIdentity"));
  });
});
