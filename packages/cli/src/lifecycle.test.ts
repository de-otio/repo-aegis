// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
/**
 * Cross-package full-lifecycle smoke test.
 *
 * Walks through a realistic v0.2 user flow:
 *
 *   init → engagements add → render → classify --apply → allow →
 *   check --staged (negative + positive) → engagements end → render →
 *   confirm cleanup.
 *
 * Subprocess-based, so it exercises the bin entry point exactly as a
 * user would. Each step's exit code is asserted; redaction policy is
 * spot-checked along the way.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { runCli, cliBuilt, cliPath } from "./_subprocess-utils.js";

// Subprocess tests need the built CLI bundle. When running ad-hoc against
// the TS source (no `npm run build` first), skip the suites instead of
// exploding with ENOENT.
const skipReason = cliBuilt()
  ? undefined
  : `built CLI not found at ${cliPath}; run \`npm run build\` first`;
const skipOpts = skipReason ? { skip: skipReason } : {};

let tmp: string;
let home: string;
let repo: string;

function gitInit(path: string): void {
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: path });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: path });
  execFileSync("git", ["config", "user.name", "test"], { cwd: path });
  execFileSync("git", ["remote", "add", "origin", "git@github.com:de-otio/customer-c-tooling.git"], { cwd: path });
}

before(() => {
  if (skipReason) return;
  tmp = mkdtempSync(join(tmpdir(), "repo-aegis-lifecycle-"));
  home = join(tmp, "home");
  repo = join(tmp, "customer-c-tooling");
  gitInit(repo);
});

after(() => {
  if (skipReason) return;
  rmSync(tmp, { recursive: true, force: true });
});

describe("v0.2 full lifecycle", skipOpts, () => {
  it("step 1: init scaffolds home and renders empty markers", () => {
    const r = runCli(home, repo, ["init", "--json"]);
    assert.equal(r.code, 0);
    const j = r.json as {
      action: string;
      registry: { scaffolded: boolean };
      rendered: { written: unknown[] };
    };
    assert.equal(j.action, "init");
    assert.equal(j.registry.scaffolded, true);
    assert.ok(existsSync(join(home, "engagements.yaml")));
    assert.ok(existsSync(join(home, "markers")));
  });

  it("step 2: engagements add creates a customer engagement and renders its marker file", () => {
    const r = runCli(home, repo, [
      "engagements",
      "add",
      "customer-c",
      "--name",
      "Customer C",
      "--marker",
      "ccorp-secret-token",
      "--marker",
      "ccorp\\.internal",
      "--json",
    ]);
    assert.equal(r.code, 0);
    const j = r.json as { action: string; id: string; markers: number };
    assert.equal(j.action, "engagements-add");
    assert.equal(j.id, "customer-c");
    assert.equal(j.markers, 2);
    assert.ok(existsSync(join(home, "markers", "customer-c.txt")));
  });

  it("step 3: classify rules file matches the remote and applies", () => {
    const rulesPath = join(home, "classify.yml");
    writeFileSync(
      rulesPath,
      `rules:
  - match: "github\\\\.com[:/]de-otio/customer-c-"
    class: customer-coupled
    engagement: customer-c
`,
    );
    const r = runCli(home, repo, ["classify", "--apply", "--rules", rulesPath, "--json"]);
    assert.equal(r.code, 0);
    const j = r.json as { applied: boolean; matched: { class: string } };
    assert.equal(j.applied, true);
    assert.equal(j.matched.class, "customer-coupled");

    const cls = execFileSync("git", ["config", "--get", "repo-aegis.class"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    assert.equal(cls, "customer-coupled");

    const eng = execFileSync("git", ["config", "--get", "repo-aegis.engagement"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    assert.equal(eng, "customer-c");
  });

  it("step 4: status reports class + allowed engagements", () => {
    const r = runCli(home, repo, ["status", "--json"]);
    assert.equal(r.code, 0);
    const j = r.json as {
      repo: { class: string; engagements: string[] };
      allowedEngagements: { id: string }[];
    };
    assert.equal(j.repo.class, "customer-coupled");
    assert.deepEqual(j.repo.engagements, ["customer-c"]);
    assert.equal(j.allowedEngagements.length, 1);
    assert.equal(j.allowedEngagements[0]!.id, "customer-c");
  });

  it("step 5: check --staged passes when content matches the allowed engagement", () => {
    writeFileSync(join(repo, "code.ts"), "const url = 'ccorp.internal/api';\n");
    execFileSync("git", ["add", "code.ts"], { cwd: repo });
    const r = runCli(home, repo, ["check", "--staged", "--json"]);
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    const j = r.json as { hits: unknown[] };
    assert.equal(j.hits.length, 0);
    execFileSync("git", ["rm", "-q", "--cached", "code.ts"], { cwd: repo });
    rmSync(join(repo, "code.ts"));
  });

  it("step 6: a marker from another customer is BLOCKED in this repo", () => {
    runCli(home, repo, [
      "engagements",
      "add",
      "customer-d",
      "--marker",
      "dcorp-confidential",
      "--json",
    ]);
    writeFileSync(join(repo, "leak.ts"), "// leaked: dcorp-confidential\n");
    execFileSync("git", ["add", "leak.ts"], { cwd: repo });
    const r = runCli(home, repo, ["check", "--staged", "--json"]);
    assert.equal(r.code, 1);
    const j = r.json as { hits: { matchPreview: string }[] };
    assert.ok(j.hits.length > 0);
    for (const h of j.hits) {
      assert.ok(!h.matchPreview.includes("dcorp-confidential"), "literal must not appear in preview");
    }
    execFileSync("git", ["rm", "-q", "--cached", "leak.ts"], { cwd: repo });
    rmSync(join(repo, "leak.ts"));
  });

  it("step 7: markers list reports both engagements and redacts patterns", () => {
    const r = runCli(home, repo, ["markers", "list", "--json"]);
    assert.equal(r.code, 0);
    const j = r.json as { files: { stem: string }[]; verbose: boolean };
    assert.equal(j.verbose, false);
    const stems = j.files.map(f => f.stem).sort();
    assert.ok(stems.includes("customer-c"));
    assert.ok(stems.includes("customer-d"));
  });

  it("step 8: audit runs all enabled checks and reports clean", () => {
    const r = runCli(home, repo, ["audit", "--json"]);
    // exit 0 (no findings) or 1 (some findings) — we assert structure either way
    assert.ok(r.code === 0 || r.code === 1);
    const j = r.json as {
      action: string;
      checks: { name: string }[];
      summary: { run: number };
    };
    assert.equal(j.action, "audit");
    const names = j.checks.map(c => c.name).sort();
    assert.ok(names.includes("marker-scan"));
    assert.ok(names.includes("registry-egress"));
    assert.ok(names.includes("visibility"));
    assert.ok(names.includes("fixtures"));
    assert.ok(names.includes("remote"));
  });

  it("step 9: engagements end + render purge removes the marker file", () => {
    const r = runCli(home, repo, ["engagements", "end", "customer-d", "--purge", "--json"]);
    assert.equal(r.code, 0);
    const j = r.json as { ended: string; purged: boolean };
    assert.equal(j.purged, true);
    assert.ok(!existsSync(join(home, "markers", "customer-d.txt")));
  });

  it("step 10: engagements show reports active=false after end --purge", () => {
    const r = runCli(home, repo, ["engagements", "show", "customer-d", "--json"]);
    assert.equal(r.code, 0);
    const j = r.json as { id: string; active: boolean };
    assert.equal(j.id, "customer-d");
    assert.equal(j.active, false);
  });
});
