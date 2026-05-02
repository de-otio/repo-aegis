import { request } from "@octokit/request";
import type { SearchClient, SearchClientResult } from "./run.js";
import type { IssueClient } from "./issue-filer.js";

export interface OctokitClientOptions {
  token: string;
  userAgent?: string;
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
      const res = await authedRequest("GET /search/code", {
        q: query,
        page,
        per_page: perPage,
        headers: {
          accept: "application/vnd.github.v3.text-match+json",
        },
      });
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
