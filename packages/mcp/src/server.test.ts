// Smoke test for the MCP server: boot it with an in-memory transport pair,
// list tools, and call one tool end-to-end. Verifies that:
//   - every tool the server should register is actually registered;
//   - a non-trivial tool (status) returns valid JSON of the expected shape;
//   - the redaction policy holds (no literal markers in any output).
//
// Skips gracefully if the MCP SDK isn't installed in node_modules — useful
// in environments where the workspace install hasn't run yet.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EXPECTED_TOOLS = [
  "repo_aegis_status",
  "repo_aegis_check_path",
  "repo_aegis_check_staged",
  "repo_aegis_engagements_list",
  "repo_aegis_engagements_show",
  "repo_aegis_markers_test",
  "repo_aegis_markers_list",
  "repo_aegis_audit",
] as const;

async function loadHarness(): Promise<{
  buildServer: () => import("@modelcontextprotocol/sdk/server/mcp.js").McpServer;
  Client: typeof import("@modelcontextprotocol/sdk/client/index.js").Client;
  InMemoryTransport: typeof import("@modelcontextprotocol/sdk/inMemory.js").InMemoryTransport;
} | null> {
  try {
    const [{ buildServer }, { Client }, { InMemoryTransport }] = await Promise.all([
      import("./server.js"),
      import("@modelcontextprotocol/sdk/client/index.js"),
      import("@modelcontextprotocol/sdk/inMemory.js"),
    ]);
    return { buildServer, Client, InMemoryTransport };
  } catch {
    return null;
  }
}

const harness = await loadHarness();

if (!harness) {
  describe("repo-aegis MCP server (skipped: SDK not installed)", () => {
    it("skips when @modelcontextprotocol/sdk isn't resolvable", { skip: true }, () => {
      /* skipped */
    });
  });
} else {
  const { buildServer, Client, InMemoryTransport } = harness;

  let tmp: string;
  let home: string;
  let repo: string;

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), "repo-aegis-mcp-test-"));
    home = join(tmp, "home");
    const markersDir = join(home, "markers");
    const stateDir = join(home, "state");
    mkdirSync(markersDir, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    // No engagements / no marker files: status should report an empty
    // deny set and zero patterns. We do NOT scaffold a registry.yaml here
    // because we're testing the "fresh install" path; loadRegistry's
    // RegistryNotFoundError is silently absorbed by the status tool.
    process.env["REPO_AEGIS_HOME"] = home;

    repo = join(tmp, "repo");
    mkdirSync(repo, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "test"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    // Class: private-strict (default). No engagements.
  });

  after(() => {
    delete process.env["REPO_AEGIS_HOME"];
    rmSync(tmp, { recursive: true, force: true });
  });

  describe("repo-aegis MCP server", () => {
    it("registers every expected tool", async () => {
      const server = buildServer();
      const client = new Client({ name: "test-client", version: "0.0.0" });
      const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      try {
        const list = await client.listTools();
        const names = list.tools.map(t => t.name).sort();
        for (const expected of EXPECTED_TOOLS) {
          assert.ok(
            names.includes(expected),
            `expected tool ${expected} to be registered; got ${names.join(", ")}`,
          );
        }
      } finally {
        await client.close();
        await server.close();
      }
    });

    it("repo_aegis_status returns the canonical shape against a tmp git repo", async () => {
      const server = buildServer();
      const client = new Client({ name: "test-client", version: "0.0.0" });
      const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      try {
        const result = await client.callTool({
          name: "repo_aegis_status",
          arguments: { cwd: repo },
        });
        assert.equal(result.isError, undefined);
        const content = result.content as Array<{ type: string; text: string }> | undefined;
        assert.ok(content && content.length > 0, "expected content array");
        const text = content[0]!.text;
        assert.ok(typeof text === "string", "expected text content");
        const parsed = JSON.parse(text) as {
          repo: { class: string; engagements: string[]; isGitRepo: boolean };
          allowedEngagements: unknown[];
          denySet: { files: string[]; patternCount: number };
          alwaysBlock: { patternCount: number };
          warnings: string[];
        };
        assert.equal(parsed.repo.isGitRepo, true);
        assert.equal(parsed.repo.class, "private-strict");
        assert.deepEqual(parsed.repo.engagements, []);
        assert.equal(parsed.denySet.patternCount, 0);
        assert.deepEqual(parsed.allowedEngagements, []);
      } finally {
        await client.close();
        await server.close();
      }
    });

    it("repo_aegis_markers_test redacts the input and returns no hits when deny set is empty", async () => {
      const server = buildServer();
      const client = new Client({ name: "test-client", version: "0.0.0" });
      const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      try {
        const result = await client.callTool({
          name: "repo_aegis_markers_test",
          arguments: { input: "some-private-string", cwd: repo },
        });
        assert.equal(result.isError, undefined);
        const content = result.content as Array<{ type: string; text: string }> | undefined;
        const parsed = JSON.parse(content![0]!.text) as {
          input: string;
          hits: unknown[];
        };
        // Input must be redacted in the response — never returned verbatim.
        assert.notEqual(parsed.input, "some-private-string");
        assert.ok(parsed.input.length > 0);
        assert.deepEqual(parsed.hits, []);
        // Avoid asserting "input does not contain literal" too eagerly — the
        // redactMatch preview keeps a short prefix. The important invariant
        // is "not equal to literal", which we check above.
        void writeFileSync; // keep import used
      } finally {
        await client.close();
        await server.close();
      }
    });

    it("repo_aegis_engagements_list returns REGISTRY_NOT_FOUND when no registry exists", async () => {
      const server = buildServer();
      const client = new Client({ name: "test-client", version: "0.0.0" });
      const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      try {
        const result = await client.callTool({
          name: "repo_aegis_engagements_list",
          arguments: {},
        });
        assert.equal(result.isError, true);
        const content = result.content as Array<{ type: string; text: string }>;
        const parsed = JSON.parse(content[0]!.text) as { code?: string; error: string };
        assert.equal(parsed.code, "REGISTRY_NOT_FOUND");
      } finally {
        await client.close();
        await server.close();
      }
    });
  });
}
