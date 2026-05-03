// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { request } from "@octokit/request";
import type { SearchClient, SearchClientResult } from "./run.js";
import type { IssueClient } from "./issue-filer.js";

export interface OctokitClientOptions {
  token: string;
  userAgent?: string;
}

/**
 * Error thrown by the octokit client wrapper for HTTP-shaped failures.
 * Carries `status` and `retryAfterSeconds` so `runScan` can detect
 * GitHub secondary-rate-limit responses (403/429 with Retry-After) and
 * back off without having to type-check the underlying `RequestError`.
 *
 * Retains the original error in `cause` for debugging.
 *
 * @internal Wire shape between `runScan` and `makeOctokitClient`; not part
 * of the supported public API surface re-exported from `lib.ts`.
 */
export class HttpClientError extends Error {
  readonly status: number;
  readonly retryAfterSeconds: number | null;
  override readonly cause?: unknown;
  constructor(message: string, status: number, retryAfterSeconds: number | null, cause?: unknown) {
    super(message);
    this.name = "HttpClientError";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Heuristic: a byte buffer is likely UTF-8 text if it contains no NUL
 * bytes in the first 8 KiB. Cheap, used to skip binary payloads
 * (compiled artifacts, images) returned by `GET /contents/{path}`
 * without burning an Ollama embed call.
 */
function isLikelyText(buf: Buffer): boolean {
  const span = Math.min(buf.byteLength, 8192);
  for (let i = 0; i < span; i++) {
    if (buf[i] === 0) return false;
  }
  return true;
}

interface MaybeRequestError {
  status?: unknown;
  response?: { headers?: Record<string, unknown> } | unknown;
  message?: unknown;
}

/**
 * Inspect an error thrown by `@octokit/request` and, if it has the shape
 * of a `RequestError` (status + headers), return an `HttpClientError`
 * with the parsed `Retry-After`. For unrelated errors, returns the
 * original error untouched so callers can re-throw it.
 */
function toHttpClientErrorIfApplicable(err: unknown): unknown {
  if (!err || typeof err !== "object") return err;
  const e = err as MaybeRequestError;
  if (typeof e.status !== "number") return err;
  const status = e.status;
  let retryAfterSeconds: number | null = null;
  const resp = e.response as { headers?: Record<string, unknown> } | undefined;
  const headers = resp?.headers;
  if (headers && typeof headers === "object") {
    // Header names are normalised to lowercase by @octokit/request.
    const raw = (headers as Record<string, unknown>)["retry-after"];
    if (typeof raw === "string" || typeof raw === "number") {
      const n = typeof raw === "number" ? raw : parseInt(raw, 10);
      if (Number.isFinite(n) && n >= 0) retryAfterSeconds = n;
    }
  }
  const msg = typeof e.message === "string" ? e.message : `HTTP ${status}`;
  return new HttpClientError(msg, status, retryAfterSeconds, err);
}

export interface BlobClient {
  /**
   * Fetch the raw text contents of a file at a given repo+path. Used by
   * the Phase 3 semantic sweep to retrieve the candidate body so it
   * can be embedded.
   *
   * Returns `null` when the file is not text (binary), too large, or
   * not found — callers must tolerate missing content (the semantic
   * sweep is advisory).
   *
   * @param maxBytes optional upper bound on the file size returned;
   * default 1 MiB (`1 << 20`).
   */
  fetchBlobText(
    owner: string,
    repo: string,
    path: string,
    ref?: string,
    maxBytes?: number,
  ): Promise<string | null>;
}

/**
 * Thin wrapper over `@octokit/request` for the endpoints repo-aegis-scan
 * actually uses:
 *   - GET /search/code
 *   - GET /repos/{owner}/{repo}/contents/{path}    (semantic sweep, P3-B)
 *   - GET /repos/{owner}/{repo}/issues
 *   - POST /repos/{owner}/{repo}/issues
 *   - POST /repos/{owner}/{repo}/issues/{issue_number}/comments
 *
 * We deliberately avoid `@octokit/rest` (which transitively pulls in
 * paginate-rest, rest-endpoint-methods, request-log, retry, throttling — ~1.5
 * MB) because pagination and rate-limit handling are already done by hand in
 * `run.ts`.
 */
export function makeOctokitClient(
  opts: OctokitClientOptions,
): SearchClient & IssueClient & BlobClient {
  const userAgent = opts.userAgent ?? "repo-aegis-scan";
  const authedRequest = request.defaults({
    headers: {
      authorization: `token ${opts.token}`,
      "user-agent": userAgent,
    },
  });

  return {
    async searchCode(query: string, page: number, perPage: number): Promise<SearchClientResult> {
      let res;
      try {
        res = await authedRequest("GET /search/code", {
          q: query,
          page,
          per_page: perPage,
          headers: {
            accept: "application/vnd.github.v3.text-match+json",
          },
        });
      } catch (err) {
        throw toHttpClientErrorIfApplicable(err);
      }
      const data = res.data as {
        total_count: number;
        incomplete_results?: boolean;
        items: SearchClientResult["items"];
      };
      return {
        items: data.items,
        total_count: data.total_count,
        incomplete_results: data.incomplete_results,
      };
    },

    async findOpenIssueByTitle(owner, repo, title): Promise<number | null> {
      const res = await authedRequest("GET /repos/{owner}/{repo}/issues", {
        owner,
        repo,
        state: "open",
        per_page: 100,
      });
      const issues = res.data as { number: number; title: string }[];
      const match = issues.find(i => i.title === title);
      return match ? match.number : null;
    },

    async createIssue(owner, repo, title, body): Promise<{ number: number; html_url: string }> {
      const res = await authedRequest("POST /repos/{owner}/{repo}/issues", {
        owner,
        repo,
        title,
        body,
      });
      const d = res.data as { number: number; html_url: string };
      return { number: d.number, html_url: d.html_url };
    },

    async fetchBlobText(
      owner: string,
      repo: string,
      path: string,
      ref?: string,
      maxBytes = 1 << 20,
    ): Promise<string | null> {
      let res;
      try {
        res = await authedRequest("GET /repos/{owner}/{repo}/contents/{path}", {
          owner,
          repo,
          path,
          ...(ref ? { ref } : {}),
          headers: { accept: "application/vnd.github.v3.raw" },
        });
      } catch (err) {
        const e = err as { status?: number };
        // 404 / 403 → tolerate (file gone, rate-limited, or permission). The
        // sweep is advisory; one missing blob does not warrant a hard failure.
        if (e.status === 404 || e.status === 403) return null;
        throw toHttpClientErrorIfApplicable(err);
      }
      // With the `raw` Accept header GitHub returns the file body as-is.
      // @octokit/request decodes utf-8 strings as `string`; binary as Buffer.
      const data = res.data as unknown;
      if (typeof data === "string") {
        if (Buffer.byteLength(data, "utf8") > maxBytes) return null;
        return data;
      }
      if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
        const buf = Buffer.from(data as ArrayBuffer);
        if (buf.byteLength > maxBytes) return null;
        // Reject non-text payloads — embedding model expects UTF-8 text.
        if (!isLikelyText(buf)) return null;
        return buf.toString("utf8");
      }
      // Some clients fall back to the JSON representation when the
      // accept header is ignored; in that case the body has a base64
      // `content` field. Decode and validate.
      if (data && typeof data === "object" && "content" in data) {
        const d = data as { content?: string; encoding?: string };
        if (d.encoding === "base64" && typeof d.content === "string") {
          const buf = Buffer.from(d.content, "base64");
          if (buf.byteLength > maxBytes) return null;
          if (!isLikelyText(buf)) return null;
          return buf.toString("utf8");
        }
      }
      return null;
    },

    async addComment(owner, repo, issueNumber, body): Promise<{ html_url: string }> {
      const res = await authedRequest(
        "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
        {
          owner,
          repo,
          issue_number: issueNumber,
          body,
        },
      );
      const d = res.data as { html_url: string };
      return { html_url: d.html_url };
    },
  };
}
