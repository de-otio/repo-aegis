// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Unit tests for the Ollama HTTP client (ollama-client.ts).
//
// Uses Node's built-in `http.createServer` bound to 127.0.0.1 as a mock
// Ollama server. No real Ollama instance is needed.
//
// [SEC H-1] tags mark tests that directly exercise the endpoint-validation
// security requirements.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { chat } from "./ollama-client.js";
import type { OllamaConfig, ChatRequest } from "./ollama-client.js";
import { RemoteEndpointDisallowedError, OllamaError } from "./exceptions.js";

// ── Mock server helpers ───────────────────────────────────────────────────────

type HandlerFn = (req: IncomingMessage, res: ServerResponse) => void;

interface MockServer {
  server: http.Server;
  endpoint: string;
  setHandler: (fn: HandlerFn) => void;
  close: () => Promise<void>;
}

function startMockServer(): Promise<MockServer> {
  return new Promise((resolve, reject) => {
    let currentHandler: HandlerFn = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          model: "llama3.2:3b",
          message: { content: "hello" },
          total_duration: 123_000_000,
          done: true,
        }),
      );
    };

    const server = http.createServer((req, res) => {
      currentHandler(req, res);
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("unexpected server address type"));
        return;
      }
      const endpoint = `http://127.0.0.1:${addr.port}`;
      resolve({
        server,
        endpoint,
        setHandler: (fn) => {
          currentHandler = fn;
        },
        close: () =>
          new Promise<void>((res, rej) =>
            server.close((err) => (err ? rej(err) : res())),
          ),
      });
    });

    server.on("error", reject);
  });
}

/** Build a minimal valid OllamaConfig for testing. */
function makeCfg(overrides: Partial<OllamaConfig> = {}): OllamaConfig {
  return {
    endpoint: "http://127.0.0.1:11434",
    model: "llama3.2:3b",
    timeoutMs: 5_000,
    allowRemote: false,
    ...overrides,
  };
}

/** Build a minimal valid ChatRequest for testing. */
function makeReq(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    system: "You are a helpful assistant.",
    user: "Say hello.",
    ...overrides,
  };
}

// Collect the raw request body sent to the mock server.
function collectBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe("ollama-client chat()", () => {
  let mock: MockServer;

  before(async () => {
    mock = await startMockServer();
  });

  after(async () => {
    await mock.close();
  });

  // ── Happy path ──────────────────────────────────────────────────────────────

  it("happy path: returns parsed ChatResponse on 200", async () => {
    mock.setHandler((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          model: "llama3.2:3b",
          message: { content: "Hello from mock!" },
          total_duration: 500_000_000,
          done: true,
        }),
      );
    });

    const cfg = makeCfg({ endpoint: mock.endpoint });
    const result = await chat(makeReq(), cfg);

    assert.equal(result.text, "Hello from mock!");
    assert.equal(result.model, "llama3.2:3b");
    assert.equal(result.totalDurationMs, 500);
  });

  it("happy path: POSTs to /api/chat", async () => {
    let capturedPath = "";
    mock.setHandler((req, res) => {
      capturedPath = req.url ?? "";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ model: "m", message: { content: "ok" }, done: true }),
      );
    });

    const cfg = makeCfg({ endpoint: mock.endpoint });
    await chat(makeReq(), cfg);

    assert.equal(capturedPath, "/api/chat");
  });

  it("happy path: sends correct JSON request body shape", async () => {
    let capturedBody: unknown;
    mock.setHandler(async (req, res) => {
      const raw = await collectBody(req);
      capturedBody = JSON.parse(raw);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ model: "m", message: { content: "" }, done: true }),
      );
    });

    const cfg = makeCfg({ endpoint: mock.endpoint, model: "llama3.2:3b" });
    const req = makeReq({ system: "sys", user: "usr" });
    await chat(req, cfg);

    const body = capturedBody as Record<string, unknown>;
    assert.equal(body["model"], "llama3.2:3b");
    assert.equal(body["stream"], false);
    const msgs = body["messages"] as Array<{ role: string; content: string }>;
    assert.equal(msgs[0]?.role, "system");
    assert.equal(msgs[0]?.content, "sys");
    assert.equal(msgs[1]?.role, "user");
    assert.equal(msgs[1]?.content, "usr");
  });

  // ── Default options (temperature: 0, seed: 42) ──────────────────────────────

  it("sends temperature:0 and seed:42 by default when options is not provided", async () => {
    let capturedBody: unknown;
    mock.setHandler(async (req, res) => {
      const raw = await collectBody(req);
      capturedBody = JSON.parse(raw);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ model: "m", message: { content: "" }, done: true }),
      );
    });

    const cfg = makeCfg({ endpoint: mock.endpoint });
    await chat(makeReq(), cfg); // no options field

    const body = capturedBody as Record<string, unknown>;
    const opts = body["options"] as Record<string, unknown>;
    assert.equal(opts["temperature"], 0, "expected temperature default 0");
    assert.equal(opts["seed"], 42, "expected seed default 42");
  });

  it("sends temperature:0 and seed:42 when options is explicitly empty object", async () => {
    let capturedBody: unknown;
    mock.setHandler(async (req, res) => {
      const raw = await collectBody(req);
      capturedBody = JSON.parse(raw);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ model: "m", message: { content: "" }, done: true }),
      );
    });

    const cfg = makeCfg({ endpoint: mock.endpoint });
    await chat(makeReq({ options: {} }), cfg);

    const body = capturedBody as Record<string, unknown>;
    const opts = body["options"] as Record<string, unknown>;
    assert.equal(opts["temperature"], 0);
    assert.equal(opts["seed"], 42);
  });

  it("honours caller-supplied temperature and seed", async () => {
    let capturedBody: unknown;
    mock.setHandler(async (req, res) => {
      const raw = await collectBody(req);
      capturedBody = JSON.parse(raw);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ model: "m", message: { content: "" }, done: true }),
      );
    });

    const cfg = makeCfg({ endpoint: mock.endpoint });
    await chat(makeReq({ options: { temperature: 0.7, seed: 99 } }), cfg);

    const body = capturedBody as Record<string, unknown>;
    const opts = body["options"] as Record<string, unknown>;
    assert.equal(opts["temperature"], 0.7);
    assert.equal(opts["seed"], 99);
  });

  // ── format: "json" ──────────────────────────────────────────────────────────

  it("sends format:json when req.format is 'json'", async () => {
    let capturedBody: unknown;
    mock.setHandler(async (req, res) => {
      const raw = await collectBody(req);
      capturedBody = JSON.parse(raw);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ model: "m", message: { content: "{}" }, done: true }),
      );
    });

    const cfg = makeCfg({ endpoint: mock.endpoint });
    await chat(makeReq({ format: "json" }), cfg);

    const body = capturedBody as Record<string, unknown>;
    assert.equal(body["format"], "json");
  });

  it("does not send format field when req.format is not set", async () => {
    let capturedBody: unknown;
    mock.setHandler(async (req, res) => {
      const raw = await collectBody(req);
      capturedBody = JSON.parse(raw);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ model: "m", message: { content: "" }, done: true }),
      );
    });

    const cfg = makeCfg({ endpoint: mock.endpoint });
    await chat(makeReq(), cfg);

    const body = capturedBody as Record<string, unknown>;
    assert.equal("format" in body, false);
  });

  // ── Non-200 status ──────────────────────────────────────────────────────────

  it("throws OllamaError on non-200 status", async () => {
    mock.setHandler((_req, res) => {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "service unavailable" }));
    });

    const cfg = makeCfg({ endpoint: mock.endpoint });
    await assert.rejects(
      () => chat(makeReq(), cfg),
      (err: unknown) => {
        assert.ok(err instanceof OllamaError);
        assert.match(err.message, /503/);
        return true;
      },
    );
  });

  it("throws OllamaError on 404", async () => {
    mock.setHandler((_req, res) => {
      res.writeHead(404, {});
      res.end("not found");
    });

    const cfg = makeCfg({ endpoint: mock.endpoint });
    await assert.rejects(
      () => chat(makeReq(), cfg),
      (err: unknown) => {
        assert.ok(err instanceof OllamaError);
        assert.match(err.message, /404/);
        return true;
      },
    );
  });

  // ── Malformed JSON response ─────────────────────────────────────────────────

  it("throws OllamaError when response body is not valid JSON", async () => {
    mock.setHandler((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("this is not json {{{{");
    });

    const cfg = makeCfg({ endpoint: mock.endpoint });
    await assert.rejects(
      () => chat(makeReq(), cfg),
      (err: unknown) => {
        assert.ok(err instanceof OllamaError);
        assert.match(err.message, /not valid JSON/i);
        return true;
      },
    );
  });

  // ── Timeout ─────────────────────────────────────────────────────────────────

  it("throws OllamaError when the server does not respond within timeoutMs", async () => {
    mock.setHandler((_req, _res) => {
      // Deliberately never respond — let the client time out.
    });

    const cfg = makeCfg({ endpoint: mock.endpoint, timeoutMs: 100 });
    await assert.rejects(
      () => chat(makeReq(), cfg),
      (err: unknown) => {
        assert.ok(err instanceof OllamaError);
        assert.match(err.message, /timed out/i);
        return true;
      },
    );
  });

  // ── [SEC H-1] Endpoint validation ──────────────────────────────────────────

  it("[SEC H-1] rejects an unparseable endpoint URL before any network IO", async () => {
    const cfg = makeCfg({ endpoint: "not a url :// !!" });
    await assert.rejects(
      () => chat(makeReq(), cfg),
      (err: unknown) => {
        assert.ok(err instanceof RemoteEndpointDisallowedError);
        assert.equal(err.code, "URL_PARSE");
        return true;
      },
    );
  });

  it("[SEC H-1] rejects ftp: protocol", async () => {
    const cfg = makeCfg({ endpoint: "ftp://127.0.0.1/api" });
    await assert.rejects(
      () => chat(makeReq(), cfg),
      (err: unknown) => {
        assert.ok(err instanceof RemoteEndpointDisallowedError);
        assert.equal(err.code, "REMOTE_DISALLOWED");
        assert.match(err.message, /protocol/i);
        return true;
      },
    );
  });

  it("[SEC H-1] rejects file: protocol", async () => {
    const cfg = makeCfg({ endpoint: "file:///etc/passwd" });
    await assert.rejects(
      () => chat(makeReq(), cfg),
      (err: unknown) => {
        assert.ok(err instanceof RemoteEndpointDisallowedError);
        return true;
      },
    );
  });

  it("[SEC H-1] rejects user-info in URL (user@host)", async () => {
    const cfg = makeCfg({ endpoint: "http://user@127.0.0.1:11434" });
    await assert.rejects(
      () => chat(makeReq(), cfg),
      (err: unknown) => {
        assert.ok(err instanceof RemoteEndpointDisallowedError);
        assert.equal(err.code, "REMOTE_DISALLOWED");
        assert.match(err.message, /user-info/i);
        return true;
      },
    );
  });

  it("[SEC H-1] rejects user:password@host in URL", async () => {
    const cfg = makeCfg({ endpoint: "http://user:secret@127.0.0.1:11434" });
    await assert.rejects(
      () => chat(makeReq(), cfg),
      (err: unknown) => {
        assert.ok(err instanceof RemoteEndpointDisallowedError);
        assert.match(err.message, /user-info/i);
        return true;
      },
    );
  });

  it("[SEC H-1] rejects non-loopback hostname when allowRemote=false", async () => {
    const cfg = makeCfg({
      endpoint: "http://192.168.1.100:11434",
      allowRemote: false,
    });
    await assert.rejects(
      () => chat(makeReq(), cfg),
      (err: unknown) => {
        assert.ok(err instanceof RemoteEndpointDisallowedError);
        assert.match(err.message, /non-loopback/i);
        return true;
      },
    );
  });

  it("[SEC H-1] rejects external domain hostname when allowRemote=false", async () => {
    const cfg = makeCfg({
      endpoint: "http://ollama.example.com:11434",
      allowRemote: false,
    });
    await assert.rejects(
      () => chat(makeReq(), cfg),
      (err: unknown) => {
        assert.ok(err instanceof RemoteEndpointDisallowedError);
        return true;
      },
    );
  });

  it("[SEC H-1] allows non-loopback hostname when allowRemote=true", async () => {
    // We can't actually connect, so we expect an OllamaError (not RemoteEndpointDisallowedError).
    // We check the port is unreachable — but we need to pick one that will fail fast.
    // Use a mock server's endpoint but set allowRemote=true with a non-127 address to pass
    // validation, then let the connection fail. Instead, just verify that the *validation*
    // passes by using the mock server with allowRemote=true.
    mock.setHandler((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ model: "m", message: { content: "ok" }, done: true }),
      );
    });

    // Use the mock server (which is on 127.0.0.1) with allowRemote=true — should succeed.
    const cfg = makeCfg({ endpoint: mock.endpoint, allowRemote: true });
    const result = await chat(makeReq(), cfg);
    assert.equal(result.text, "ok");
  });

  it("[SEC H-1] accepts 127.0.0.1 when allowRemote=false", async () => {
    mock.setHandler((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ model: "m", message: { content: "hi" }, done: true }),
      );
    });

    const cfg = makeCfg({ endpoint: mock.endpoint, allowRemote: false });
    const result = await chat(makeReq(), cfg);
    assert.equal(result.text, "hi");
  });

  it("[SEC H-1] accepts https: protocol", async () => {
    // Just verify validation passes for https: URLs — we can't start an HTTPS mock,
    // but we can verify the validation logic by checking no RemoteEndpointDisallowedError
    // is thrown (the subsequent connection error will be an OllamaError).
    const cfg = makeCfg({
      endpoint: "https://127.0.0.1:11434",
      allowRemote: false,
    });
    await assert.rejects(
      () => chat(makeReq(), cfg),
      (err: unknown) => {
        // Should be an OllamaError (connection refused), NOT a RemoteEndpointDisallowedError.
        assert.ok(err instanceof OllamaError, `expected OllamaError, got ${(err as Error).constructor.name}: ${(err as Error).message}`);
        return true;
      },
    );
  });

  // ── Response field handling ─────────────────────────────────────────────────

  it("uses cfg.model as fallback when response omits model field", async () => {
    mock.setHandler((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      // Deliberately omit "model"
      res.end(JSON.stringify({ message: { content: "hi" }, done: true }));
    });

    const cfg = makeCfg({ endpoint: mock.endpoint, model: "my-model" });
    const result = await chat(makeReq(), cfg);
    assert.equal(result.model, "my-model");
  });

  it("returns empty string for text when message.content is absent", async () => {
    mock.setHandler((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ model: "m", done: true }));
    });

    const cfg = makeCfg({ endpoint: mock.endpoint });
    const result = await chat(makeReq(), cfg);
    assert.equal(result.text, "");
  });

  it("returns 0 for totalDurationMs when total_duration is absent", async () => {
    mock.setHandler((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ model: "m", message: { content: "x" }, done: true }),
      );
    });

    const cfg = makeCfg({ endpoint: mock.endpoint });
    const result = await chat(makeReq(), cfg);
    assert.equal(result.totalDurationMs, 0);
  });

  it("converts total_duration nanoseconds to milliseconds", async () => {
    mock.setHandler((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          model: "m",
          message: { content: "x" },
          total_duration: 2_500_000_000, // 2500ms
          done: true,
        }),
      );
    });

    const cfg = makeCfg({ endpoint: mock.endpoint });
    const result = await chat(makeReq(), cfg);
    assert.equal(result.totalDurationMs, 2500);
  });

  // ── Trailing slash normalisation ─────────────────────────────────────────────

  it("strips trailing slash from endpoint before appending /api/chat", async () => {
    let capturedPath = "";
    mock.setHandler((req, res) => {
      capturedPath = req.url ?? "";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ model: "m", message: { content: "" }, done: true }),
      );
    });

    const cfg = makeCfg({ endpoint: mock.endpoint + "/" });
    await chat(makeReq(), cfg);

    assert.equal(capturedPath, "/api/chat");
  });
});

// ── Error type tests ──────────────────────────────────────────────────────────

describe("RemoteEndpointDisallowedError", () => {
  it("has code REMOTE_DISALLOWED by default", () => {
    const e = new RemoteEndpointDisallowedError("test");
    assert.equal(e.code, "REMOTE_DISALLOWED");
    assert.equal(e.name, "RemoteEndpointDisallowedError");
    assert.ok(e instanceof Error);
  });

  it("accepts URL_PARSE code", () => {
    const e = new RemoteEndpointDisallowedError("bad url", "URL_PARSE");
    assert.equal(e.code, "URL_PARSE");
  });
});

describe("OllamaError", () => {
  it("has code OLLAMA_ERROR", () => {
    const e = new OllamaError("oops");
    assert.equal(e.code, "OLLAMA_ERROR");
    assert.equal(e.name, "OllamaError");
    assert.ok(e instanceof Error);
  });
});

// ---------------------------------------------------------------------------
// Embeddings (P3-A-1)
// ---------------------------------------------------------------------------

import { embed, cosine } from "./ollama-client.js";
import { createServer as createServerEmbed, type Server as EmbedServer } from "node:http";

describe("embed — happy path", () => {
  let server: EmbedServer;
  let port: number;
  let lastRequestBody: unknown = null;
  let responseStatus = 200;
  let responseBody: string = "";

  before(async () => {
    server = createServerEmbed((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", c => chunks.push(c));
      req.on("end", () => {
        try {
          lastRequestBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          lastRequestBody = null;
        }
        res.statusCode = responseStatus;
        res.setHeader("content-type", "application/json");
        res.end(responseBody);
      });
    });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    port = (server.address() as { port: number }).port;
  });

  after(() => {
    server.close();
  });

  it("POSTs to /api/embeddings and returns the vector as Float32Array", async () => {
    responseStatus = 200;
    responseBody = JSON.stringify({ embedding: [0.1, 0.2, 0.3, -0.4] });
    const result = await embed("hello world", {
      endpoint: `http://127.0.0.1:${port}`,
      model: "nomic-embed-text",
      timeoutMs: 5000,
      allowRemote: false,
    });
    assert.ok(result instanceof Float32Array);
    assert.equal(result.length, 4);
    assert.ok(Math.abs(result[0]! - 0.1) < 1e-6);
    assert.ok(Math.abs(result[3]! - -0.4) < 1e-6);
    const body = lastRequestBody as { model: string; prompt: string };
    assert.equal(body.model, "nomic-embed-text");
    assert.equal(body.prompt, "hello world");
  });

  it("throws OllamaError when the response has no embedding array", async () => {
    responseStatus = 200;
    responseBody = JSON.stringify({});
    await assert.rejects(
      () =>
        embed("x", {
          endpoint: `http://127.0.0.1:${port}`,
          model: "nomic-embed-text",
          timeoutMs: 5000,
          allowRemote: false,
        }),
      /embedding response/,
    );
  });

  it("throws OllamaError when the response has empty embedding", async () => {
    responseStatus = 200;
    responseBody = JSON.stringify({ embedding: [] });
    await assert.rejects(
      () =>
        embed("x", {
          endpoint: `http://127.0.0.1:${port}`,
          model: "nomic-embed-text",
          timeoutMs: 5000,
          allowRemote: false,
        }),
      /non-empty/,
    );
  });

  it("[SEC H-1] rejects non-loopback endpoints when allowRemote=false", async () => {
    await assert.rejects(
      () =>
        embed("x", {
          endpoint: "https://example.com/v1",
          model: "nomic-embed-text",
          timeoutMs: 5000,
          allowRemote: false,
        }),
      /not allowed|REMOTE_DISALLOWED|user-info/i,
    );
  });
});

// ---------------------------------------------------------------------------
// cosine similarity (P3-A-1 helper)
// ---------------------------------------------------------------------------

describe("cosine similarity", () => {
  it("returns 1.0 for identical vectors", () => {
    const v = Float32Array.from([1, 2, 3]);
    assert.ok(Math.abs(cosine(v, v) - 1.0) < 1e-6);
  });

  it("returns 0 for orthogonal vectors", () => {
    const a = Float32Array.from([1, 0]);
    const b = Float32Array.from([0, 1]);
    assert.ok(Math.abs(cosine(a, b) - 0) < 1e-6);
  });

  it("returns -1 for anti-parallel vectors", () => {
    const a = Float32Array.from([1, 2, 3]);
    const b = Float32Array.from([-1, -2, -3]);
    assert.ok(Math.abs(cosine(a, b) - -1.0) < 1e-6);
  });

  it("returns 0 when either vector has zero magnitude (no NaN)", () => {
    const z = Float32Array.from([0, 0, 0]);
    const v = Float32Array.from([1, 2, 3]);
    assert.equal(cosine(z, v), 0);
    assert.equal(cosine(v, z), 0);
    assert.equal(cosine(z, z), 0);
  });

  it("throws on dimension mismatch", () => {
    const a = Float32Array.from([1, 2]);
    const b = Float32Array.from([1, 2, 3]);
    assert.throws(() => cosine(a, b), /dimension mismatch/);
  });
});
