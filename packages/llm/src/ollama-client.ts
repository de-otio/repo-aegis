// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Thin HTTP wrapper around the Ollama chat API.
//
// [SEC H-1] Endpoint validation is performed before any network IO:
//   - Parse via `new URL(endpoint)`; reject on parse failure.
//   - Reject any protocol other than http: or https:.
//   - Reject URLs containing user-info (user:pw@host).
//   - When allowRemote=false, require hostname to be an exact loopback address.
//   - When hostname is "localhost", also resolve via dns.lookup (both
//     IPv4 and IPv6) and reject if either result is non-loopback.
//
// No retries on any failure (design requirement).

import { lookup } from "node:dns/promises";
import { OllamaError, RemoteEndpointDisallowedError } from "./exceptions.js";

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Exact hostnames (case-insensitive) that are considered loopback.
 * [SEC H-1]
 */
const LOOPBACK_HOSTS = new Set([
  "127.0.0.1",
  "::1",
  "::ffff:127.0.0.1",
  "0.0.0.0",
  "localhost",
]);

/**
 * Addresses that are loopback for IPv4 dns.lookup results. [SEC H-1]
 */
const LOOPBACK_IPV4_RE = /^127\./;

/**
 * Addresses that are loopback for IPv6 dns.lookup results. [SEC H-1]
 */
const LOOPBACK_IPV6_RE = /^(?:::1|::ffff:127\.|0*:0*:0*:0*:0*:0*:0*:1)$/i;

const DEFAULT_TIMEOUT_MS = 30_000;

// ── Types ─────────────────────────────────────────────────────────────────────

/** Configuration for the Ollama client. */
export interface OllamaConfig {
  /** Base URL of the Ollama server. Default: "http://127.0.0.1:11434". */
  endpoint: string;
  /** Model identifier. Default: "llama3.2:3b". */
  model: string;
  /** Request timeout in milliseconds. Default: 30_000. */
  timeoutMs: number;
  /**
   * Set to true to allow non-loopback endpoints.
   * Default: false; required for remote endpoints.
   * [SEC H-1]
   */
  allowRemote: boolean;
}

/** A chat request to send to the Ollama API. */
export interface ChatRequest {
  system: string;
  user: string;
  /** Request JSON-mode output. */
  format?: "json";
  /** Sampling options. Defaults: temperature=0, seed=42. */
  options?: { temperature?: number; seed?: number };
}

/** The parsed response from the Ollama chat API. */
export interface ChatResponse {
  text: string;
  model: string;
  totalDurationMs: number;
}

// ── Endpoint validation ───────────────────────────────────────────────────────

/**
 * Validate the endpoint URL per [SEC H-1] before any network IO.
 *
 * Throws `RemoteEndpointDisallowedError` if validation fails.
 * When the hostname is "localhost", also performs DNS lookups to guard
 * against /etc/hosts redirection.
 */
async function validateEndpoint(cfg: OllamaConfig): Promise<void> {
  // [SEC H-1] Parse URL; reject on parse error.
  let url: URL;
  try {
    url = new URL(cfg.endpoint);
  } catch {
    throw new RemoteEndpointDisallowedError(
      `[SEC H-1] Invalid endpoint URL: "${cfg.endpoint}"`,
      "URL_PARSE",
    );
  }

  // [SEC H-1] Only http: and https: allowed.
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new RemoteEndpointDisallowedError(
      `[SEC H-1] Endpoint protocol "${url.protocol}" is not allowed; use http: or https:`,
    );
  }

  // [SEC H-1] Reject user-info (user:pw@host).
  if (url.username !== "" || url.password !== "") {
    throw new RemoteEndpointDisallowedError(
      `[SEC H-1] Endpoint must not contain user-info (user@host or user:pw@host)`,
    );
  }

  const hostname = url.hostname.toLowerCase();

  if (!cfg.allowRemote) {
    // [SEC H-1] Require exact loopback hostname when allowRemote=false.
    if (!LOOPBACK_HOSTS.has(hostname)) {
      throw new RemoteEndpointDisallowedError(
        `[SEC H-1] Non-loopback endpoint "${hostname}" is not allowed when allowRemote=false. ` +
          `Set cfg.allowRemote=true to use remote endpoints.`,
      );
    }

    // [SEC H-1] When hostname is "localhost", resolve via DNS and reject if
    // either IPv4 or IPv6 resolves to a non-loopback address.
    if (hostname === "localhost") {
      await verifyLocalhostDns();
    }
  }
}

/**
 * Verify that "localhost" resolves to a loopback address on both IPv4 and
 * IPv6. Defends against /etc/hosts redirection.
 *
 * [SEC H-1]
 */
async function verifyLocalhostDns(): Promise<void> {
  let ipv4Address: string;
  let ipv6Address: string;

  try {
    const ipv4Result = await lookup("localhost", { family: 4 });
    ipv4Address = ipv4Result.address;
  } catch {
    // If IPv4 lookup fails entirely (e.g. no IPv4 stack), treat as safe.
    ipv4Address = "127.0.0.1";
  }

  try {
    const ipv6Result = await lookup("localhost", { family: 6 });
    ipv6Address = ipv6Result.address;
  } catch {
    // If IPv6 lookup fails entirely (e.g. no IPv6 stack), treat as safe.
    ipv6Address = "::1";
  }

  if (!LOOPBACK_IPV4_RE.test(ipv4Address)) {
    throw new RemoteEndpointDisallowedError(
      `[SEC H-1] "localhost" resolves to non-loopback IPv4 address "${ipv4Address}" — ` +
        `/etc/hosts may be redirecting it. Refusing connection.`,
    );
  }

  if (!LOOPBACK_IPV6_RE.test(ipv6Address)) {
    throw new RemoteEndpointDisallowedError(
      `[SEC H-1] "localhost" resolves to non-loopback IPv6 address "${ipv6Address}" — ` +
        `/etc/hosts may be redirecting it. Refusing connection.`,
    );
  }
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

/**
 * Perform a POST request with JSON body and return the parsed response.
 * Throws `OllamaError` on non-200, network error, or malformed JSON.
 */
async function postJson<T>(
  url: string,
  body: unknown,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if ((err as { name?: string }).name === "AbortError") {
      throw new OllamaError(`Ollama request timed out after ${timeoutMs}ms`);
    }
    throw new OllamaError(`Ollama request failed: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    let body = "";
    try {
      body = await response.text();
    } catch {
      // ignore
    }
    throw new OllamaError(
      `Ollama returned HTTP ${response.status}: ${body.slice(0, 256)}`,
    );
  }

  let text: string;
  try {
    text = await response.text();
  } catch (err) {
    throw new OllamaError(`Failed to read Ollama response body: ${(err as Error).message}`);
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new OllamaError(
      `Ollama response is not valid JSON: ${text.slice(0, 256)}`,
    );
  }
}

// ── Ollama API response shapes ────────────────────────────────────────────────

interface OllamaChatApiResponse {
  model?: string;
  message?: { content?: string };
  total_duration?: number;
  done?: boolean;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Send a chat request to the Ollama `/api/chat` endpoint.
 *
 * Applies endpoint validation ([SEC H-1]) before any network IO.
 * Defaults `temperature: 0, seed: 42` when `req.options` is not provided.
 * No retries on failure.
 *
 * @throws {RemoteEndpointDisallowedError} if the endpoint fails validation.
 * @throws {OllamaError} on network error, timeout, non-200 status, or malformed JSON.
 */
export async function chat(
  req: ChatRequest,
  cfg: OllamaConfig,
): Promise<ChatResponse> {
  // [SEC H-1] Validate before opening any connection.
  await validateEndpoint(cfg);

  const url = `${cfg.endpoint.replace(/\/$/, "")}/api/chat`;

  // Apply default sampling options (temperature: 0, seed: 42 per design §2.4).
  const options = req.options ?? { temperature: 0, seed: 42 };
  const effectiveOptions = {
    temperature: options.temperature ?? 0,
    seed: options.seed ?? 42,
  };

  const requestBody = {
    model: cfg.model,
    messages: [
      { role: "system", content: req.system },
      { role: "user", content: req.user },
    ],
    stream: false,
    options: effectiveOptions,
    ...(req.format === "json" ? { format: "json" } : {}),
  };

  const raw = await postJson<OllamaChatApiResponse>(url, requestBody, cfg.timeoutMs);

  const text = raw.message?.content ?? "";
  const model = raw.model ?? cfg.model;
  const totalDurationMs =
    typeof raw.total_duration === "number"
      ? Math.round(raw.total_duration / 1_000_000)
      : 0;

  return { text, model, totalDurationMs };
}

// ---------------------------------------------------------------------------
// Embeddings (P3-A-1)
// ---------------------------------------------------------------------------

interface OllamaEmbedApiResponse {
  embedding?: number[];
}

/**
 * POST a single string to the Ollama `/api/embeddings` endpoint and
 * return the resulting vector as a `Float32Array`. Same network-safety
 * guarantees as {@link chat} ([SEC H-1] endpoint validation, no retries,
 * no automatic fallbacks).
 *
 * Default model: `nomic-embed-text` (768-dim). Caller can override via
 * `cfg.model` if a different embedding model is in use.
 *
 * Runtime-asserts that the embedding length is >= 1.
 *
 * @throws {RemoteEndpointDisallowedError} if endpoint validation fails.
 * @throws {OllamaError} on network error, timeout, non-200, or empty embedding.
 */
export async function embed(
  text: string,
  cfg: OllamaConfig,
): Promise<Float32Array> {
  await validateEndpoint(cfg);

  const url = `${cfg.endpoint.replace(/\/$/, "")}/api/embeddings`;
  const requestBody = { model: cfg.model, prompt: text };

  const raw = await postJson<OllamaEmbedApiResponse>(url, requestBody, cfg.timeoutMs);

  if (!Array.isArray(raw.embedding) || raw.embedding.length === 0) {
    throw new OllamaError(
      `embedding response did not contain a non-empty 'embedding' array`,
    );
  }
  // Defensive copy into Float32Array — caller may subsequently store
  // these in profile files, where Float32 is the canonical
  // representation.
  return Float32Array.from(raw.embedding);
}

// ---------------------------------------------------------------------------
// Cosine similarity helper (P3-A-2 will use this)
// ---------------------------------------------------------------------------

/**
 * Cosine similarity between two equal-length Float32Arrays. Returns 0
 * when either vector has magnitude 0 (avoids NaN). Pure, no IO.
 */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(
      `cosine: dimension mismatch ${a.length} vs ${b.length}`,
    );
  }
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] as number;
    const bi = b[i] as number;
    dot += ai * bi;
    magA += ai * ai;
    magB += bi * bi;
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}
