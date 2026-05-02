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

/**
 * Thin wrapper over `@octokit/request` for the four endpoints repo-aegis-scan
 * actually uses:
 *   - GET /search/code
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
): SearchClient & IssueClient {
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
