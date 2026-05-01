import { Octokit } from "@octokit/rest";
import type { SearchClient, SearchClientResult } from "./run.js";
import type { IssueClient } from "./issue-filer.js";

export interface OctokitClientOptions {
  token: string;
  userAgent?: string;
}

export function makeOctokitClient(
  opts: OctokitClientOptions,
): SearchClient & IssueClient {
  const octokit = new Octokit({
    auth: opts.token,
    userAgent: opts.userAgent ?? "repo-aegis-scan",
  });

  return {
    async searchCode(query: string, page: number, perPage: number): Promise<SearchClientResult> {
      const res = await octokit.rest.search.code({
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
      const res = await octokit.rest.issues.listForRepo({
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
      const res = await octokit.rest.issues.create({ owner, repo, title, body });
      const d = res.data as { number: number; html_url: string };
      return { number: d.number, html_url: d.html_url };
    },

    async addComment(owner, repo, issueNumber, body): Promise<{ html_url: string }> {
      const res = await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: issueNumber,
        body,
      });
      const d = res.data as { html_url: string };
      return { html_url: d.html_url };
    },
  };
}
