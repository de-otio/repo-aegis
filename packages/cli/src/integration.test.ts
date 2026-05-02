import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
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
let aRepo: string;
let bRepo: string;
let publicRepo: string;

function gitInit(path: string) {
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: path });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: path });
  execFileSync("git", ["config", "user.name", "test"], { cwd: path });
}

before(() => {
  if (skipReason) return;
  tmp = mkdtempSync(join(tmpdir(), "repo-aegis-int-"));
  home = join(tmp, "home");
  mkdirSync(home, { recursive: true });
  aRepo = join(tmp, "a-repo");
  bRepo = join(tmp, "b-repo");
  publicRepo = join(tmp, "pub-repo");
  gitInit(aRepo);
  gitInit(bRepo);
  gitInit(publicRepo);

  writeFileSync(
    join(home, "engagements.yaml"),
    `always_block:
  - PROJECT-CODENAME-ALPHA

engagements:
  - id: customer-a-2025
    name: Customer A
    markers:
      - acme-?corp[^a-zA-Z0-9]
      - acmeengineering\\.com
  - id: customer-b-2024
    name: Customer B
    markers:
      - betaco
      - betaco\\.tech
`,
  );

  // Render markers
  runCli(home, aRepo, ["render"]);
  // Configure repos
  execFileSync("git", ["config", "repo-aegis.class", "customer-coupled"], { cwd: aRepo });
  execFileSync("git", ["config", "repo-aegis.class", "customer-coupled"], { cwd: bRepo });
  execFileSync("git", ["config", "repo-aegis.class", "public-eligible"], { cwd: publicRepo });
  runCli(home, aRepo, ["allow", "customer-a-2025"]);
  runCli(home, bRepo, ["allow", "customer-b-2024"]);
});

after(() => {
  if (skipReason) return;
  rmSync(tmp, { recursive: true, force: true });
});

describe("multi-customer scoping (end-to-end)", skipOpts, () => {
  it("customer-A repo: customer-A content is allowed", () => {
    writeFileSync(join(aRepo, "src.ts"), "see acme-corp.example for details\n");
    execFileSync("git", ["add", "src.ts"], { cwd: aRepo });
    const r = runCli(home, aRepo, ["check", "--staged", "--json"]);
    assert.equal(r.code, 0, `expected exit 0, got ${r.code}; stderr: ${r.stderr}`);
    const json = r.json as { hits: unknown[] };
    assert.equal(json.hits.length, 0);
    execFileSync("git", ["rm", "-q", "--cached", "src.ts"], { cwd: aRepo });
    rmSync(join(aRepo, "src.ts"));
  });

  it("customer-A repo: customer-B content is BLOCKED", () => {
    writeFileSync(join(aRepo, "src.ts"), "see betaco.tech\n");
    execFileSync("git", ["add", "src.ts"], { cwd: aRepo });
    const r = runCli(home, aRepo, ["check", "--staged", "--json"]);
    assert.equal(r.code, 1, `expected exit 1, got ${r.code}; stderr: ${r.stderr}`);
    const json = r.json as { hits: { matchPreview: string }[] };
    assert.ok(json.hits.length > 0);
    // redaction policy: literal must NOT appear in matchPreview
    for (const h of json.hits) {
      assert.ok(!h.matchPreview.includes("betaco"));
    }
    execFileSync("git", ["rm", "-q", "--cached", "src.ts"], { cwd: aRepo });
    rmSync(join(aRepo, "src.ts"));
  });

  it("customer-A repo: _always content is BLOCKED", () => {
    writeFileSync(join(aRepo, "src.ts"), "PROJECT-CODENAME-ALPHA\n");
    execFileSync("git", ["add", "src.ts"], { cwd: aRepo });
    const r = runCli(home, aRepo, ["check", "--staged"]);
    assert.equal(r.code, 1, `expected exit 1, got ${r.code}; stderr: ${r.stderr}`);
    execFileSync("git", ["rm", "-q", "--cached", "src.ts"], { cwd: aRepo });
    rmSync(join(aRepo, "src.ts"));
  });

  it("customer-B repo: customer-A content is BLOCKED (cross-customer leak)", () => {
    writeFileSync(join(bRepo, "src.ts"), "see acme-corp.example\n");
    execFileSync("git", ["add", "src.ts"], { cwd: bRepo });
    const r = runCli(home, bRepo, ["check", "--staged"]);
    assert.equal(r.code, 1, `expected exit 1, got ${r.code}; stderr: ${r.stderr}`);
    execFileSync("git", ["rm", "-q", "--cached", "src.ts"], { cwd: bRepo });
    rmSync(join(bRepo, "src.ts"));
  });

  it("public-eligible repo: ANY customer content is BLOCKED", () => {
    writeFileSync(join(publicRepo, "src.ts"), "see acme-corp.example\n");
    execFileSync("git", ["add", "src.ts"], { cwd: publicRepo });
    const r1 = runCli(home, publicRepo, ["check", "--staged"]);
    assert.equal(r1.code, 1, `expected 1, got ${r1.code}; stdout=${r1.stdout}; stderr=${r1.stderr}`);
    rmSync(join(publicRepo, "src.ts"));
    execFileSync("git", ["rm", "-q", "--cached", "src.ts"], { cwd: publicRepo });

    writeFileSync(join(publicRepo, "src.ts"), "see betaco.tech\n");
    execFileSync("git", ["add", "src.ts"], { cwd: publicRepo });
    const r2 = runCli(home, publicRepo, ["check", "--staged"]);
    assert.equal(r2.code, 1);
    rmSync(join(publicRepo, "src.ts"));
    execFileSync("git", ["rm", "-q", "--cached", "src.ts"], { cwd: publicRepo });
  });

  it("check with no flags: usage error (exit 2)", () => {
    // Regression test for the design contract: exactly one mode flag is
    // required. Without one, exit 2, even on a fresh repo with no markers.
    const r = runCli(home, aRepo, ["check"]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /staged|path/);
  });

  it("customer-coupled with no engagement set: hard error (exit 2)", () => {
    const orphan = join(tmp, "orphan-repo");
    gitInit(orphan);
    execFileSync("git", ["config", "repo-aegis.class", "customer-coupled"], { cwd: orphan });
    writeFileSync(join(orphan, "f"), "anything");
    execFileSync("git", ["add", "f"], { cwd: orphan });
    const r = runCli(home, orphan, ["check", "--staged"]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /repo-aegis\.engagement/);
  });
});

describe("redaction policy (CLI surface)", skipOpts, () => {
  it("hits never include the literal match by default", () => {
    writeFileSync(join(aRepo, "src.ts"), "betaco rules everything\n");
    execFileSync("git", ["add", "src.ts"], { cwd: aRepo });
    const r = runCli(home, aRepo, ["check", "--staged"]);
    assert.ok(!r.stdout.includes("betaco"));
    assert.ok(!r.stderr.includes("betaco"));
    execFileSync("git", ["rm", "-q", "--cached", "src.ts"], { cwd: aRepo });
    rmSync(join(aRepo, "src.ts"));
  });

  it("--verbose reveals literal", () => {
    writeFileSync(join(aRepo, "src.ts"), "betaco\n");
    execFileSync("git", ["add", "src.ts"], { cwd: aRepo });
    const r = runCli(home, aRepo, ["check", "--staged", "--verbose"]);
    assert.ok(r.stdout.includes("betaco"));
    execFileSync("git", ["rm", "-q", "--cached", "src.ts"], { cwd: aRepo });
    rmSync(join(aRepo, "src.ts"));
  });

  it("error messages don't enumerate engagement ids", () => {
    const r = runCli(home, aRepo, ["allow", "nonexistent-customer"]);
    assert.equal(r.code, 2);
    // Should say "no match"; should redirect to `engagements list`; should NOT
    // contain the actual engagement IDs in the error.
    assert.match(r.stderr, /engagements list/);
    assert.ok(!r.stderr.includes("customer-a-2025"));
    assert.ok(!r.stderr.includes("customer-b-2024"));
  });

  it("deny with unresolved engagement: clean error", () => {
    const r = runCli(home, aRepo, ["deny", "nonexistent-customer"]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /engagements list/);
    assert.ok(!r.stderr.includes("customer-a-2025"));
  });

  it("deny on engagement that wasn't allowed: succeeds with informative output", () => {
    const r = runCli(home, aRepo, ["deny", "customer-b-2024", "--json"]);
    assert.equal(r.code, 0);
    const j = r.json as { results: { wasAllowed: boolean; removed: boolean }[] };
    assert.equal(j.results[0]!.wasAllowed, false);
    assert.equal(j.results[0]!.removed, false);
  });

  it("deny outside a git repo: clean error", () => {
    const nonGit = join(tmp, "not-a-git-repo-for-deny");
    mkdirSync(nonGit, { recursive: true });
    const r = runCli(home, nonGit, ["deny", "customer-a-2025"]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /not inside a git repository/);
  });
});

describe("status", skipOpts, () => {
  it("prints repo state in human-readable form", () => {
    const r = runCli(home, aRepo, ["status"]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /class:\s+customer-coupled/);
    assert.match(r.stdout, /allowed:\s+customer-a-2025/);
    assert.match(r.stdout, /blocked:.*customer-b-2024/);
    assert.match(r.stdout, /always-block/);
  });

  it("prints repo state as JSON with --json", () => {
    const r = runCli(home, aRepo, ["status", "--json"]);
    assert.equal(r.code, 0);
    const j = r.json as { repo: { class: string }; allowedEngagements: unknown[] };
    assert.equal(j.repo.class, "customer-coupled");
    assert.equal(j.allowedEngagements.length, 1);
  });

  it("handles non-git directories gracefully", () => {
    const nonGit = join(tmp, "not-a-git-repo");
    mkdirSync(nonGit, { recursive: true });
    const r = runCli(home, nonGit, ["status"]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /not inside a git repository/);
  });
});

describe("engagements list", skipOpts, () => {
  it("prints registered engagements", () => {
    const r = runCli(home, aRepo, ["engagements", "list"]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /customer-a-2025/);
    assert.match(r.stdout, /customer-b-2024/);
    assert.match(r.stdout, /always-block: 1 pattern/);
  });

  it("emits JSON with --json", () => {
    const r = runCli(home, aRepo, ["engagements", "list", "--json"]);
    assert.equal(r.code, 0);
    const j = r.json as { engagements: unknown[]; alwaysBlock: { patternCount: number } };
    assert.equal(j.engagements.length, 2);
    assert.equal(j.alwaysBlock.patternCount, 1);
  });
});

describe("render", skipOpts, () => {
  it("dry-run does not write files but reports plan", () => {
    const r = runCli(home, aRepo, ["render", "--dry-run", "--json"]);
    assert.equal(r.code, 0);
    const j = r.json as { dryRun: boolean; written: unknown[] };
    assert.equal(j.dryRun, true);
    assert.ok(j.written.length >= 1);
  });
});

describe("variadic allow/deny", skipOpts, () => {
  const varRepo = join(tmpdir(), `repo-aegis-var-${Date.now()}`);

  before(() => {
    gitInit(varRepo);
    execFileSync("git", ["config", "repo-aegis.class", "customer-coupled"], { cwd: varRepo });
  });

  after(() => {
    rmSync(varRepo, { recursive: true, force: true });
  });

  it("accepts multiple engagements in one call", () => {
    const r = runCli(home, varRepo, ["allow", "customer-a-2025", "customer-b-2024", "--json"]);
    assert.equal(r.code, 0);
    const j = r.json as { results: { added: boolean }[] };
    assert.equal(j.results.length, 2);
    assert.ok(j.results.every(x => x.added));
  });

  it("deny accepts multiple engagements in one call", () => {
    const r = runCli(home, varRepo, ["deny", "customer-a-2025", "customer-b-2024", "--json"]);
    assert.equal(r.code, 0);
    const j = r.json as { results: { removed: boolean }[] };
    assert.equal(j.results.length, 2);
  });
});
