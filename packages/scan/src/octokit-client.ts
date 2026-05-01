import { Octokit } from "@octokit/rest";
import type { SearchClient, SearchClientResult } from "./run.js";

export interface OctokitClientOptions {
  token: string;
  userAgent?: string;
}

export function makeOctokitClient(opts: OctokitClientOptions): SearchClient {
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
  };
}
