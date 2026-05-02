import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileIssue, type IssueClient } from "./issue-filer.js";
import type { CodeSearchHit, RunSummary } from "./types.js";

function emptySummary(totalNew: number): RunSummary {
  return {
    queries: [],
    totalNew,
    totalSeen: totalNew,
    startedIso: "2026-05-01T00:00:00Z",
    endedIso: "2026-05-01T00:00:01Z",
  };
}

function fakeHits(n: number): CodeSearchHit[] {
  return Array.from({ length: n }, (_, i) => ({
    query: "q",
    repo: `org/repo${i}`,
    path: `src/file${i}.ts`,
    line: null,
    url: `https://example.com/${i}`,
  }));
}

describe("fileIssue", () => {
  it("skips when totalNew is 0", async () => {
    const calls: string[] = [];
    const client: IssueClient = {
      async findOpenIssueByTitle() {
        calls.push("findOpenIssueByTitle");
        return null;
      },
      async createIssue() {
        calls.push("createIssue");
        return { number: 0, html_url: "" };
      },
      async addComment() {
        calls.push("addComment");
        return { html_url: "" };
      },
    };
    const r = await fileIssue(emptySummary(0), [], { reportRepo: "o/r", client });
    assert.equal(r.action, "skipped");
    assert.deepEqual(calls, []);
  });

  it("creates a new issue when none open with same title", async () => {
    let createdTitle = "";
    let createdBody = "";
    const client: IssueClient = {
      async findOpenIssueByTitle() {
        return null;
      },
      async createIssue(_o, _r, title, body) {
        createdTitle = title;
        createdBody = body;
        return { number: 42, html_url: "https://example.com/42" };
      },
      async addComment() {
        throw new Error("should not be called");
      },
    };
    const r = await fileIssue(emptySummary(2), fakeHits(2), {
      reportRepo: "o/r",
      client,
      title: "test-title",
    });
    assert.equal(r.action, "created");
    assert.equal(r.issueNumber, 42);
    assert.equal(r.url, "https://example.com/42");
    assert.equal(createdTitle, "test-title");
    assert.match(createdBody, /repo-aegis-scan report/);
  });

  it("uses date-based defaultTitle when title option is omitted", async () => {
    // The dedup contract hinges on the date-based default title — two runs
    // on the same UTC day must produce the same title so the second run
    // comments on the existing issue rather than opening a new one.
    let createdTitle = "";
    const client: IssueClient = {
      async findOpenIssueByTitle() {
        return null;
      },
      async createIssue(_o, _r, title) {
        createdTitle = title;
        return { number: 1, html_url: "https://example.com/1" };
      },
      async addComment() {
        throw new Error("should not be called");
      },
    };
    const r = await fileIssue(emptySummary(1), fakeHits(1), {
      reportRepo: "o/r",
      client,
      // no `title:` — exercise the default
    });
    assert.equal(r.action, "created");
    assert.match(createdTitle, /^repo-aegis-scan: new hits \d{4}-\d{2}-\d{2}$/);
    assert.equal(r.title, createdTitle);
  });

  it("comments on existing open issue if title matches", async () => {
    let commentedOn = -1;
    const client: IssueClient = {
      async findOpenIssueByTitle(_o, _r, title) {
        return title === "dedup-title" ? 7 : null;
      },
      async createIssue() {
        throw new Error("should not be called");
      },
      async addComment(_o, _r, n) {
        commentedOn = n;
        return { html_url: "https://example.com/7#c1" };
      },
    };
    const r = await fileIssue(emptySummary(1), fakeHits(1), {
      reportRepo: "o/r",
      client,
      title: "dedup-title",
    });
    assert.equal(r.action, "commented");
    assert.equal(r.issueNumber, 7);
    assert.equal(commentedOn, 7);
  });

  it("rejects malformed reportRepo", async () => {
    const client: IssueClient = {
      async findOpenIssueByTitle() {
        return null;
      },
      async createIssue() {
        return { number: 0, html_url: "" };
      },
      async addComment() {
        return { html_url: "" };
      },
    };
    await assert.rejects(
      () => fileIssue(emptySummary(1), fakeHits(1), { reportRepo: "no-slash", client }),
      /owner\/repo/,
    );
  });

  it("dryRun returns body without calling the client", async () => {
    const client: IssueClient = {
      async findOpenIssueByTitle() {
        throw new Error("should not be called");
      },
      async createIssue() {
        throw new Error("should not be called");
      },
      async addComment() {
        throw new Error("should not be called");
      },
    };
    const r = await fileIssue(emptySummary(1), fakeHits(1), {
      reportRepo: "o/r",
      client,
      dryRun: true,
    });
    assert.equal(r.action, "dry-run");
    assert.match(r.body, /repo-aegis-scan report/);
  });
});
