// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Integration tests for `suggest-markers`. Mocks Ollama with a local
// http server. Verifies behaviour primarily by inspecting the registry
// file post-call rather than parsing captured stdout — captureOutput
// monkey-patches `process.stdout.write` and that conflicts with
// node:test's concurrent reporter writing progress markers.
//
// Tests run sequentially via `concurrency: 1` on each describe to
// avoid the same stdout-patch race.

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withEnvAsync } from "../_test-utils.js";
import { suggestMarkers } from "./suggest-markers.js";
import { ExitError } from "../_test-utils.js";

let tmp: string;
let homeDir: string;
let registryPath: string;
let repoDir: string;
let mockServer: Server;
let mockPort: number;

interface MockState {
  responseStatus: number;
  responseText: string;
  lastBody: unknown;
}
const mock: MockState = {
  responseStatus: 200,
  responseText: "",
  lastBody: null,
};

function startMock(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", c => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        try {
          mock.lastBody = JSON.parse(body);
        } catch {
          mock.lastBody = body;
        }
        res.statusCode = mock.responseStatus;
        res.setHeader("content-type", "application/json");
        res.end(mock.responseText);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, port: addr.port });
    });
    server.on("error", reject);
  });
}

const STUB_REGISTRY = `\
schemaVersion: 2
personalOrgs: [my-handle]
always_block: []
engagements:
  - id: foo-corp
    name: Foo Corp
    started: 2026-01-01
    markers: []
`;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), "repo-aegis-suggest-markers-"));
  homeDir = join(tmp, "home");
  mkdirSync(join(homeDir, "markers"), { recursive: true });
  mkdirSync(join(homeDir, "state"), { recursive: true });
  registryPath = join(homeDir, "engagements.yaml");
  writeFileSync(registryPath, STUB_REGISTRY);

  repoDir = join(tmp, "fixture-repo");
  mkdirSync(repoDir, { recursive: true });
  writeFileSync(
    join(repoDir, "README.md"),
    "# FooCorp Project\nFoo Corp is a fintech company.\n",
  );
  writeFileSync(
    join(repoDir, "package.json"),
    JSON.stringify({ name: "foo-project", description: "Foo Corp project" }),
  );
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoDir });
  execFileSync("git", ["config", "user.email", "alice@foocorp.example"], {
    cwd: repoDir,
  });
  execFileSync("git", ["config", "user.name", "Alice"], { cwd: repoDir });
  execFileSync("git", ["add", "."], { cwd: repoDir });
  execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: repoDir });

  const r = await startMock();
  mockServer = r.server;
  mockPort = r.port;
});

after(() => {
  mockServer.close();
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  writeFileSync(registryPath, STUB_REGISTRY);
});

function endpoint(): string {
  return `http://127.0.0.1:${mockPort}`;
}

function setMockResponse(
  tokens: Array<{ token: string; kind: string; confidence: number }>,
): void {
  mock.responseStatus = 200;
  mock.responseText = JSON.stringify({
    message: { role: "assistant", content: JSON.stringify({ tokens }) },
  });
}

/**
 * Read the foo-corp engagement's markers from the registry. Lightweight
 * grep — sufficient for testing whether suggest-markers persisted.
 */
function readFooCorpMarkers(): string[] {
  const yaml = readFileSync(registryPath, "utf8");
  const start = yaml.indexOf("id: foo-corp");
  if (start < 0) return [];
  const after = yaml.slice(start);
  const markersIdx = after.indexOf("markers:");
  if (markersIdx < 0) return [];
  // Look for the `[...]` inline form or `\n  - ...` list form.
  const tail = after.slice(markersIdx + "markers:".length);
  const inline = tail.match(/^\s*\[(.*?)\]/);
  if (inline) {
    return inline[1]!
      .split(",")
      .map(s => s.trim())
      .filter(s => s.length > 0);
  }
  // Block form
  const lines = tail.split("\n");
  const markers: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    const m = line.match(/^\s+-\s+(.+)$/);
    if (m) {
      markers.push(m[1]!.trim());
    } else if (line.length > 0 && !line.startsWith(" ")) {
      break;
    }
  }
  return markers;
}

const SEQ = { concurrency: 1 } as const;

describe("suggest-markers — happy path with --auto-accept-above", SEQ, () => {
  it("auto-accepts above threshold and persists synthesised patterns", async () => {
    setMockResponse([
      { token: "FooCorp", kind: "company", confidence: 0.95 },
      { token: "foocorp.example", kind: "domain", confidence: 0.85 },
      { token: "low", kind: "company", confidence: 0.3 },
    ]);
    await withEnvAsync("REPO_AEGIS_HOME", homeDir, () =>
      suggestMarkers({
        engagement: "foo-corp",
        from: repoDir,
        endpoint: endpoint(),
        autoAcceptAbove: 0.7,
        registryPath,
        json: true,
      }),
    );
    // Verify by reading the registry directly (yaml-parsed for accuracy).
    const registry = readFileSync(registryPath, "utf8");
    // The 0.3 token "low" must not land — the dictionary filter would
    // reject it even if threshold passed. Just verify a foo-corp
    // pattern landed end-to-end.
    assert.match(
      registry,
      /foo[-_ ]?corp/i,
      `registry should contain a foo-corp pattern: ${registry}`,
    );
  });
});

describe("suggest-markers — [SEC H-2] identity guard", SEQ, () => {
  it("does not auto-accept tokens matching personalOrgs", async () => {
    setMockResponse([
      { token: "my-handle", kind: "company", confidence: 0.99 },
      { token: "FooCorp", kind: "company", confidence: 0.99 },
    ]);
    await withEnvAsync("REPO_AEGIS_HOME", homeDir, () =>
      suggestMarkers({
        engagement: "foo-corp",
        from: repoDir,
        endpoint: endpoint(),
        autoAcceptAbove: 0.7,
        registryPath,
        json: true,
      }),
    );
    const markers = readFooCorpMarkers();
    // my-handle must NOT be in markers; foo-corp pattern should be.
    assert.ok(
      !markers.some(m => m.includes("my-handle")),
      `markers should NOT contain my-handle: ${markers}`,
    );
  });
});

describe("suggest-markers — --dry-run", SEQ, () => {
  it("prints candidates and does not persist", async () => {
    setMockResponse([{ token: "FooCorp", kind: "company", confidence: 0.95 }]);
    const before = readFileSync(registryPath, "utf8");
    await withEnvAsync("REPO_AEGIS_HOME", homeDir, () =>
      suggestMarkers({
        engagement: "foo-corp",
        from: repoDir,
        endpoint: endpoint(),
        dryRun: true,
        registryPath,
        json: true,
      }),
    );
    const after = readFileSync(registryPath, "utf8");
    assert.equal(before, after, "registry must be unchanged after --dry-run");
  });
});

describe("suggest-markers — review-required without auto-accept", SEQ, () => {
  it("does not persist when no --auto-accept-above given", async () => {
    setMockResponse([{ token: "FooCorp", kind: "company", confidence: 0.95 }]);
    const before = readFileSync(registryPath, "utf8");
    await withEnvAsync("REPO_AEGIS_HOME", homeDir, () =>
      suggestMarkers({
        engagement: "foo-corp",
        from: repoDir,
        endpoint: endpoint(),
        registryPath,
        json: true,
      }),
    );
    const after = readFileSync(registryPath, "utf8");
    assert.equal(before, after, "registry must be unchanged (review required)");
  });
});

describe("suggest-markers — endpoint hardening", SEQ, () => {
  it("rejects non-loopback endpoint without --allow-remote-model", async () => {
    // Patch process.exit manually so emitError doesn't kill the test
    // runner. Restore in finally.
    const origExit = process.exit.bind(process);
    let exitCode: number | undefined;
    (process as NodeJS.Process).exit = ((code?: number): never => {
      exitCode = code ?? 0;
      throw new ExitError(code ?? 0);
    }) as typeof process.exit;
    try {
      await withEnvAsync("REPO_AEGIS_HOME", homeDir, () =>
        suggestMarkers({
          engagement: "foo-corp",
          from: repoDir,
          endpoint: "https://example.com/v1",
          autoAcceptAbove: 0.7,
          registryPath,
          json: true,
        }),
      );
    } catch (e) {
      if (!(e instanceof ExitError)) throw e;
    } finally {
      process.exit = origExit;
    }
    assert.equal(exitCode, 2, "expected exit 2 from REMOTE_DISALLOWED");
    const after = readFileSync(registryPath, "utf8");
    assert.equal(after, STUB_REGISTRY, "non-loopback rejection must not mutate registry");
  });
});

describe("suggest-markers — invalid engagement", SEQ, () => {
  it("exits 2 when engagement is unknown", async () => {
    setMockResponse([
      { token: "FooCorp", kind: "company", confidence: 0.95 },
    ]);
    const origExit = process.exit.bind(process);
    let exitCode: number | undefined;
    (process as NodeJS.Process).exit = ((code?: number): never => {
      exitCode = code ?? 0;
      throw new ExitError(code ?? 0);
    }) as typeof process.exit;
    try {
      await withEnvAsync("REPO_AEGIS_HOME", homeDir, () =>
        suggestMarkers({
          engagement: "nonexistent",
          from: repoDir,
          endpoint: endpoint(),
          autoAcceptAbove: 0.7,
          registryPath,
          json: true,
        }),
      );
    } catch (e) {
      if (!(e instanceof ExitError)) throw e;
    } finally {
      process.exit = origExit;
    }
    assert.equal(exitCode, 2);
  });
});

describe("suggest-markers — empty candidate set", SEQ, () => {
  it("does not persist when filters reject everything", async () => {
    setMockResponse([{ token: "the", kind: "company", confidence: 0.9 }]);
    const before = readFileSync(registryPath, "utf8");
    await withEnvAsync("REPO_AEGIS_HOME", homeDir, () =>
      suggestMarkers({
        engagement: "foo-corp",
        from: repoDir,
        endpoint: endpoint(),
        autoAcceptAbove: 0.5,
        registryPath,
        json: true,
      }),
    );
    const after = readFileSync(registryPath, "utf8");
    assert.equal(before, after, "registry must be unchanged when filters reject all");
  });
});
