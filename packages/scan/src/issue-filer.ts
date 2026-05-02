// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import type { CodeSearchHit, RunSummary } from "./types.js";
import { renderMarkdown } from "./output.js";

export interface IssueClient {
  /**
   * Find an open issue in the target repo whose title exactly matches.
   * Returns its number, or null.
   */
  findOpenIssueByTitle(
    owner: string,
    repo: string,
    title: string,
  ): Promise<number | null>;
  createIssue(
    owner: string,
    repo: string,
    title: string,
    body: string,
  ): Promise<{ number: number; html_url: string }>;
  addComment(
    owner: string,
    repo: string,
    issueNumber: number,
    body: string,
  ): Promise<{ html_url: string }>;
}

export interface FileIssueOptions {
  reportRepo: string;          // "owner/repo"
  client: IssueClient;
  title?: string;              // default: today's date
  /**
   * If true, no GitHub call is made; the body that *would* have been
   * posted is returned for inspection. Useful for tests and dry runs.
   */
  dryRun?: boolean;
}

export interface FileIssueResult {
  action: "created" | "commented" | "skipped" | "dry-run";
  issueNumber?: number;
  url?: string;
  title: string;
  body: string;
}

function parseRepo(spec: string): { owner: string; repo: string } {
  const m = spec.match(/^([^/]+)\/([^/]+)$/);
  if (!m) throw new Error(`--report-issue-repo must be of the form 'owner/repo' (got ${JSON.stringify(spec)})`);
  return { owner: m[1]!, repo: m[2]! };
}

function defaultTitle(): string {
  const today = new Date().toISOString().slice(0, 10);
  return `repo-aegis-scan: new hits ${today}`;
}

export async function fileIssue(
  summary: RunSummary,
  hits: CodeSearchHit[],
  opts: FileIssueOptions,
): Promise<FileIssueResult> {
  const title = opts.title ?? defaultTitle();
  const body = renderMarkdown(summary, hits);

  if (summary.totalNew === 0) {
    return { action: "skipped", title, body };
  }

  if (opts.dryRun) {
    return { action: "dry-run", title, body };
  }

  const { owner, repo } = parseRepo(opts.reportRepo);
  const existing = await opts.client.findOpenIssueByTitle(owner, repo, title);

  if (existing !== null) {
    const comment = await opts.client.addComment(owner, repo, existing, body);
    return { action: "commented", issueNumber: existing, url: comment.html_url, title, body };
  }

  const created = await opts.client.createIssue(owner, repo, title, body);
  return {
    action: "created",
    issueNumber: created.number,
    url: created.html_url,
    title,
    body,
  };
}
