// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `repo-aegis-scan audit --org | --published`.
//
// The checks below were `repo-aegis audit --org|--published` and moved here
// with their tests; they are ported rather than rewritten so a green run here
// is evidence the behaviour did not change. Only the harness differs: `audit`
// is `runAudit` (which returns an exit code instead of calling process.exit),
// adapted by `audit` / `captureOutputAsync` below so the assertions read as
// they did in the CLI.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runAudit, type AuditOptions, type AuditRun } from "./audit.js";
import { checkOrg } from "./audit-checks.js";
import type { SearchClient, SearchClientResult } from "./run.js";

let tmp: string;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "repo-aegis-scan-audit-test-"));
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const audit = (opts: AuditOptions): Promise<AuditRun> => runAudit(opts);

/** The CLI harness reported "did not exit" as `undefined`; keep that reading. */
async function captureOutputAsync(
  fn: () => Promise<AuditRun>,
): Promise<{ stdout: string; stderr: string; exitCode?: number }> {
  const r = await fn();
  return { stdout: r.stdout, stderr: r.stderr, ...(r.exitCode !== 0 && { exitCode: r.exitCode }) };
}

async function withEnvAsync<T>(name: string, value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
}

function setupHome(name: string, fileSpec: Record<string, string[]>): string {
  const home = join(tmp, name + "-home");
  const markersDir = join(home, "markers");
  mkdirSync(markersDir, { recursive: true });
  mkdirSync(join(home, "state"), { recursive: true });
  for (const [stem, patterns] of Object.entries(fileSpec)) {
    writeFileSync(join(markersDir, `${stem}.txt`), patterns.join("\n") + "\n");
  }
  return home;
}

function makeRepo(name: string, opts: { class?: string } = {}): string {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  if (opts.class) {
    execFileSync("git", ["config", "repo-aegis.class", opts.class], { cwd: dir });
  }
  return dir;
}

describe("audit — published", () => {
  it("scans an extracted tarball for marker hits", async () => {
    const home = setupHome("pub-tarball", { _always: ["leaked-secret-token"] });
    const repo = makeRepo("pub-tarball-repo", { class: "private-strict" });

    // Build a tiny tarball with a leaking file inside.
    const stage = mkdtempSync(join(tmp, "stage-"));
    mkdirSync(join(stage, "package"), { recursive: true });
    writeFileSync(join(stage, "package", "config.json"), `{"key":"leaked-secret-token"}`);
    writeFileSync(join(stage, "package", "README"), "hello world");
    const tgz = join(tmp, "pkg.tgz");
    execFileSync("tar", ["-czf", tgz, "-C", stage, "package"]);

    const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() => audit({ cwd: repo, json: true, published: tgz })),
    );
    assert.equal(result.exitCode, 1);
    const j = JSON.parse(result.stdout) as {
      checks: { name: string; ok: boolean; findings: { message: string }[] }[];
    };
    const c = j.checks.find(c => c.name === "published");
    assert.ok(c);
    assert.equal(c!.ok, false);
    assert.ok(c!.findings.some(f => f.message.includes("config.json")));
  });

  it("reports tarball-not-found cleanly", async () => {
    const home = setupHome("pub-missing", {});
    const repo = makeRepo("pub-missing-repo", { class: "private-strict" });
    const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() =>
        audit({ cwd: repo, json: true, published: join(tmp, "does-not-exist.tgz") }),
      ),
    );
    assert.equal(result.exitCode, 1);
    const j = JSON.parse(result.stdout) as {
      checks: { name: string; findings: { message: string }[] }[];
    };
    const c = j.checks.find(c => c.name === "published");
    assert.ok(c!.findings.some(f => f.message.includes("not found")));
  });

  it("refuses a tarball that contains a path-traversal entry (zip-slip)", async () => {
    const home = setupHome("pub-zipslip", { _always: ["zzz-never"] });
    const repo = makeRepo("pub-zipslip-repo", { class: "private-strict" });

    // Build a tarball whose member names traverse upward. We stage the
    // `escape.txt` file at the staging-root level so `tar -C stage`
    // followed by member `../escape.txt` resolves to a real file (the
    // member name as recorded in the archive still includes `..`).
    //
    // The invariant under test: "the file recorded as `../escape.txt`
    // does not land outside the audit's extraction root." There are
    // three valid outcomes that satisfy it:
    //
    //   1. tar refuses extraction outright → audit emits a
    //      `tar extract failed` finding. Some BSD-tar configurations
    //      and stricter policy settings.
    //   2. tar accepts and extracts to an escaped path → audit's
    //      post-extract realpath check emits PUBLISHED_ARCHIVE_ESCAPE
    //      / "escapes the extraction root". BSD tar default on macOS.
    //   3. tar silently strips leading `..` from member names and
    //      extracts harmlessly inside its own extraction root. GNU
    //      tar default since ~2.30 (Linux runners). The OS-level
    //      defence has already enforced the invariant before the
    //      audit's check runs, so audit reports the archive clean.
    //
    // (1) and (2) → exitCode 1 with a refusal finding. (3) → exitCode
    // undefined / 0. Future hardening: use a fixture whose member
    // name evades GNU tar's leading-`..` strip (e.g.
    // `package/../../escape.txt`) to exercise the audit's own defence
    // on both platforms regardless of tar's behaviour.
    const stageRoot = mkdtempSync(join(tmp, "zipslip-stageroot-"));
    const stage = join(stageRoot, "stage");
    mkdirSync(join(stage, "package"), { recursive: true });
    writeFileSync(join(stage, "package", "ok.txt"), "benign");
    writeFileSync(join(stageRoot, "escape.txt"), "I should never be extracted outside the tmp root");
    const tgz = join(tmp, "zipslip.tgz");
    execFileSync(
      "tar",
      ["-czf", tgz, "-C", stage, "package/ok.txt", "../escape.txt"],
    );

    const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() => audit({ cwd: repo, json: true, published: tgz })),
    );

    if (result.exitCode !== 1) {
      // Outcome (3): tar sanitised the entry before audit could see
      // an escape. Nothing for the audit layer to flag. Pass.
      return;
    }

    const j = JSON.parse(result.stdout) as {
      checks: { name: string; ok: boolean; findings: { message: string; detail?: unknown }[] }[];
    };
    const c = j.checks.find(c => c.name === "published");
    assert.ok(c, "published check should be present");
    assert.equal(c!.ok, false);
    const refused = c!.findings.some(f => {
      const d = f.detail as { code?: string } | undefined;
      return (
        d?.code === "PUBLISHED_ARCHIVE_ESCAPE" ||
        f.message.includes("tar extract failed") ||
        f.message.includes("escapes the extraction root")
      );
    });
    assert.ok(refused, `expected refusal finding, got: ${JSON.stringify(c!.findings)}`);
  });
});

describe("audit — org", () => {
  it("requires consent before sending seeds across border", async () => {
    const home = setupHome("org-no-consent", { _always: ["acme-something"] });
    writeFileSync(
      join(home, "engagements.yaml"),
      `always_block: ["acme-something"]\nengagements: []\n`,
    );
    const repo = makeRepo("org-no-consent-repo", { class: "private-strict" });
    const prevToken = process.env["GH_TOKEN"];
    const prevConsent = process.env["REPO_AEGIS_ACCEPT_ORG_SEED_TRANSFER"];
    delete process.env["GH_TOKEN"];
    delete process.env["REPO_AEGIS_ACCEPT_ORG_SEED_TRANSFER"];
    try {
      const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
        captureOutputAsync(() => audit({ cwd: repo, json: true, org: "fake-org" })),
      );
      const j = JSON.parse(result.stdout) as {
        checks: {
          name: string;
          ok: boolean;
          findings: { message: string; detail?: { code?: string } }[];
        }[];
      };
      const c = j.checks.find(c => c.name === "org-scan");
      assert.ok(c, "org-scan check should be present");
      assert.equal(c!.ok, false);
      assert.ok(
        c!.findings.some(f => f.detail?.code === "ORG_SCAN_CONSENT_REQUIRED"),
        `expected ORG_SCAN_CONSENT_REQUIRED finding, got: ${JSON.stringify(c!.findings)}`,
      );
      // Consent gate runs before the token check, so we should not see
      // the GH_TOKEN message here.
      assert.ok(
        !c!.findings.some(f => f.message.includes("env var is not set")),
        "token-not-set finding should not surface before consent is given",
      );
    } finally {
      if (prevToken !== undefined) process.env["GH_TOKEN"] = prevToken;
      if (prevConsent !== undefined)
        process.env["REPO_AEGIS_ACCEPT_ORG_SEED_TRANSFER"] = prevConsent;
    }
  });

  it("with consent but no GH_TOKEN, reports missing token cleanly", async () => {
    const home = setupHome("org-consent-no-token", { _always: ["acme-something"] });
    writeFileSync(
      join(home, "engagements.yaml"),
      `always_block: ["acme-something"]\nengagements: []\n`,
    );
    const repo = makeRepo("org-consent-no-token-repo", { class: "private-strict" });
    const prevToken = process.env["GH_TOKEN"];
    delete process.env["GH_TOKEN"];
    try {
      const result = await withEnvAsync(
        "REPO_AEGIS_ACCEPT_ORG_SEED_TRANSFER",
        "1",
        () =>
          withEnvAsync("REPO_AEGIS_HOME", home, () =>
            captureOutputAsync(() => audit({ cwd: repo, json: true, org: "fake-org" })),
          ),
      );
      const j = JSON.parse(result.stdout) as {
        checks: {
          name: string;
          findings: { message: string; detail?: { code?: string } }[];
        }[];
      };
      const c = j.checks.find(c => c.name === "org-scan");
      assert.ok(c);
      assert.ok(c!.findings.some(f => f.message.includes("env var is not set")));
      assert.ok(
        !c!.findings.some(f => f.detail?.code === "ORG_SCAN_CONSENT_REQUIRED"),
        "should not surface consent finding once consent is given",
      );
    } finally {
      if (prevToken !== undefined) process.env["GH_TOKEN"] = prevToken;
    }
  });

  it("--accept-cross-border flag also satisfies the consent gate", async () => {
    const home = setupHome("org-flag-consent", { _always: ["acme-something"] });
    writeFileSync(
      join(home, "engagements.yaml"),
      `always_block: ["acme-something"]\nengagements: []\n`,
    );
    const repo = makeRepo("org-flag-consent-repo", { class: "private-strict" });
    const prevToken = process.env["GH_TOKEN"];
    const prevConsent = process.env["REPO_AEGIS_ACCEPT_ORG_SEED_TRANSFER"];
    delete process.env["GH_TOKEN"];
    delete process.env["REPO_AEGIS_ACCEPT_ORG_SEED_TRANSFER"];
    try {
      const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
        captureOutputAsync(() =>
          audit({
            cwd: repo,
            json: true,
            org: "fake-org",
            acceptCrossBorder: true,
          }),
        ),
      );
      const j = JSON.parse(result.stdout) as {
        checks: {
          name: string;
          findings: { message: string; detail?: { code?: string } }[];
        }[];
      };
      const c = j.checks.find(c => c.name === "org-scan");
      assert.ok(c);
      // With consent + no token, we expect the token-not-set finding,
      // not the consent finding.
      assert.ok(c!.findings.some(f => f.message.includes("env var is not set")));
      assert.ok(
        !c!.findings.some(f => f.detail?.code === "ORG_SCAN_CONSENT_REQUIRED"),
      );
    } finally {
      if (prevToken !== undefined) process.env["GH_TOKEN"] = prevToken;
      if (prevConsent !== undefined)
        process.env["REPO_AEGIS_ACCEPT_ORG_SEED_TRANSFER"] = prevConsent;
    }
  });

  // The original test skipped itself without a live GH_TOKEN and then queried
  // github.com. A fake search client drives the same code path deterministically.
  describe("with a fake search client (no network)", () => {
    const ENV = { REPO_AEGIS_ACCEPT_ORG_SEED_TRANSFER: "1", GH_TOKEN: "fake-token" } as NodeJS.ProcessEnv;
    const noSleep = (): Promise<void> => Promise.resolve();

    function recordingClient(items: SearchClientResult["items"] = []): SearchClient & { queries: string[] } {
      const queries: string[] = [];
      return {
        queries,
        async searchCode(query: string, page: number): Promise<SearchClientResult> {
          if (page === 1) queries.push(query);
          return { items: page === 1 ? items : [], total_count: items.length };
        },
      };
    }

    function homeWithSeeds(name: string, seeds: string[]): string {
      const home = setupHome(name, {});
      writeFileSync(
        join(home, "engagements.yaml"),
        `always_block:\n${seeds.map(x => `  - "${x}"`).join("\n")}\nengagements: []\n`,
      );
      return home;
    }

    it("emits ORG_SCAN_TRUNCATED when seeds exceed --max-queries budget", async () => {
      const seeds = ["seed-aaaaa", "seed-bbbbb", "seed-ccccc", "seed-ddddd", "seed-eeeee"];
      const home = homeWithSeeds("org-truncated", seeds);
      const repo = makeRepo("org-truncated-repo", { class: "private-strict" });
      const client = recordingClient();
      const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
        runAudit(
          { cwd: repo, json: true, org: "example-org", maxQueries: 2 },
          { env: ENV, client, sleep: noSleep },
        ),
      );
      const j = JSON.parse(result.stdout) as {
        checks: {
          name: string;
          ok: boolean;
          findings: { detail?: { code?: string; cap?: number; skippedCount?: number } }[];
        }[];
      };
      const c = j.checks.find(c => c.name === "org-scan");
      assert.ok(c, "org-scan check should be present");
      const trunc = c!.findings.find(f => f.detail?.code === "ORG_SCAN_TRUNCATED");
      assert.ok(trunc, `expected ORG_SCAN_TRUNCATED finding, got: ${JSON.stringify(c!.findings)}`);
      assert.equal(trunc!.detail?.cap, 2);
      assert.equal(trunc!.detail?.skippedCount, 3);
      // A truncated run is a failure: some seeds were never queried.
      assert.equal(c!.ok, false);
      assert.equal(result.exitCode, 1);
      // Only the first two seeds, in alphabetical order, were sent.
      assert.deepEqual(client.queries, ['"seed-aaaaa" org:example-org', '"seed-bbbbb" org:example-org']);
    });

    it("a clean sweep within budget passes (exit 0)", async () => {
      const home = homeWithSeeds("org-clean", ["seed-aaaaa"]);
      const repo = makeRepo("org-clean-repo", { class: "private-strict" });
      const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
        runAudit(
          { cwd: repo, json: true, org: "example-org" },
          { env: ENV, client: recordingClient(), sleep: noSleep },
        ),
      );
      assert.equal(result.exitCode, 0, result.stdout);
    });

    it("a code-search hit fails the check and is reported as repo:path:line", async () => {
      const home = homeWithSeeds("org-hit", ["seed-aaaaa"]);
      const repo = makeRepo("org-hit-repo", { class: "private-strict" });
      const client = recordingClient([
        {
          path: "src/a.ts",
          repository: { full_name: "example-org/some-repo" },
          html_url: "https://github.com/example-org/some-repo/blob/main/src/a.ts",
        },
      ]);
      const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
        runAudit(
          { cwd: repo, json: true, org: "example-org" },
          { env: ENV, client, sleep: noSleep },
        ),
      );
      assert.equal(result.exitCode, 1);
      const j = JSON.parse(result.stdout) as {
        checks: { name: string; ok: boolean; findings: { message: string }[] }[];
      };
      const c = j.checks.find(c => c.name === "org-scan")!;
      assert.equal(c.ok, false);
      assert.ok(c.findings.some(f => f.message.startsWith("example-org/some-repo:src/a.ts")));
    });

    it("no usable seeds is a skip, not a pass-by-silence", async () => {
      const result = await checkOrg("example-org", { engagements: [], alwaysBlock: ["a.b"] }, "t", 30, {
        client: recordingClient(),
        sleep: noSleep,
      });
      assert.equal(result.skipped, true);
      assert.match(result.skipReason ?? "", /no usable literal seeds/);
    });
  });
});

// The universal secret-shape pass over `--published` archive contents.
//
// The property that matters: this is the ONLY part of the published check
// that still does work when the deny set is empty, which is the normal
// state in CI — the engagement registry is machine-local by design, so a
// publish workflow scanning its own tarball never has engagement patterns.
// Every test here therefore uses a home with NO markers, so a passing
// assertion cannot be coming from the deny set.

describe("audit --published — universal secret-shape scan", () => {
  // Assembled from fragments so this tracked source file contains no
  // contiguous secret-shaped literal of its own — same convention as
  // self-hygiene.test.ts. A literal here would be exempt (the `_always`
  // class is path-exempt in `*.test.*`), but a detector's own test suite
  // tripping the detector is exactly the pattern that teaches operators to
  // add exemptions.
  const JWT_SHAPE =
    "eyJ" + "hbGciOiJIUzI1NiJ9" + "." + "eyJ" + "zdWIiOiIxMjM0NTY3ODkwIn0" + "." + "dBjftJeZ4CVPmB92K27uhbUJU1p1r0wW1gFWFOEjXk";
  const TOKEN_SHAPE = "ghp" + "_" + "A".repeat(36);

  function tarballContaining(name: string, body: string): string {
    const stage = mkdtempSync(join(tmp, "secret-stage-"));
    mkdirSync(join(stage, "package"), { recursive: true });
    writeFileSync(join(stage, "package", name), body);
    const tgz = join(tmp, `secret-${name}.tgz`);
    execFileSync("tar", ["-czf", tgz, "-C", stage, "package"]);
    return tgz;
  }

  it("fails on a JWT-shaped string even with an EMPTY deny set", async () => {
    const home = setupHome("secret-jwt", {});
    const repo = makeRepo("secret-jwt-repo", { class: "private-strict" });
    const tgz = tarballContaining("token.txt", `access=${JWT_SHAPE}\n`);

    const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() => audit({ cwd: repo, json: true, published: tgz })),
    );

    assert.equal(result.exitCode, 1);
    const j = JSON.parse(result.stdout) as {
      denySet: { patternCount: number };
      checks: {
        name: string;
        ok: boolean;
        findings: { message: string; detail?: { code?: string; kinds?: string[] } }[];
      }[];
    };
    // Guard the premise: if this were non-zero the test would prove nothing
    // about the secret scan, because the deny set could have caught it.
    assert.equal(j.denySet.patternCount, 0, "premise: deny set must be empty");

    const c = j.checks.find(c => c.name === "published");
    assert.ok(c);
    assert.equal(c!.ok, false);
    const hit = c!.findings.find(f => f.detail?.code === "PUBLISHED_SECRET_SHAPE");
    assert.ok(hit, `expected a secret-shape finding, got: ${JSON.stringify(c!.findings)}`);
    assert.deepEqual(hit!.detail?.kinds, ["JWT"]);
  });

  it("fails on a forge-token shape", async () => {
    const home = setupHome("secret-token", {});
    const repo = makeRepo("secret-token-repo", { class: "private-strict" });
    const tgz = tarballContaining("ci.env", `GH_TOKEN=${TOKEN_SHAPE}\n`);

    const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() => audit({ cwd: repo, json: true, published: tgz })),
    );

    assert.equal(result.exitCode, 1);
    const j = JSON.parse(result.stdout) as {
      checks: { name: string; findings: { detail?: { code?: string; kinds?: string[] } }[] }[];
    };
    const c = j.checks.find(c => c.name === "published");
    const hit = c!.findings.find(f => f.detail?.code === "PUBLISHED_SECRET_SHAPE");
    assert.ok(hit, "expected a secret-shape finding");
    assert.deepEqual(hit!.detail?.kinds, ["GITHUB_TOKEN"]);
  });

  // The whole output of this check can reach a public job log — that is the
  // deployment it was built for. `scanForSecrets` returns kind/offset/length
  // and never the matched bytes; this asserts the CLI does not reintroduce
  // them. Grep the WHOLE serialised payload, not selected fields: a
  // per-field assertion passes while a sibling key leaks.
  it("never echoes the matched secret back into output", async () => {
    const home = setupHome("secret-noecho", {});
    const repo = makeRepo("secret-noecho-repo", { class: "private-strict" });
    const tgz = tarballContaining("leak.txt", `t=${JWT_SHAPE}\n`);

    const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() => audit({ cwd: repo, json: true, published: tgz })),
    );

    assert.ok(
      !result.stdout.includes(JWT_SHAPE),
      "matched secret must never appear in output",
    );
    // Also not the distinctive signature segment on its own.
    assert.ok(!result.stdout.includes("dBjftJeZ4CVPmB92K27uhbUJU1p1r0wW1gFWFOEjXk"));
  });

  it("--no-secret-scan skips the pass", async () => {
    const home = setupHome("secret-optout", {});
    const repo = makeRepo("secret-optout-repo", { class: "private-strict" });
    const tgz = tarballContaining("token2.txt", `access=${JWT_SHAPE}\n`);

    const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() =>
        audit({ cwd: repo, json: true, published: tgz, secretScan: false }),
      ),
    );

    const j = JSON.parse(result.stdout) as {
      checks: { name: string; ok: boolean; findings: { detail?: { code?: string } }[] }[];
    };
    const c = j.checks.find(c => c.name === "published");
    assert.ok(c);
    assert.equal(c!.ok, true, "opt-out must leave the check passing");
    assert.ok(!c!.findings.some(f => f.detail?.code === "PUBLISHED_SECRET_SHAPE"));
  });

  it("a clean archive passes", async () => {
    const home = setupHome("secret-clean", {});
    const repo = makeRepo("secret-clean-repo", { class: "private-strict" });
    const tgz = tarballContaining("README", "hello world, nothing to see\n");

    const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() => audit({ cwd: repo, json: true, published: tgz })),
    );

    const j = JSON.parse(result.stdout) as {
      checks: { name: string; ok: boolean }[];
    };
    assert.equal(j.checks.find(c => c.name === "published")!.ok, true);
  });
});

// An empty deny set is legitimate for `--published` (see checkPublished),
// so it must not fail the check — but it must not be invisible either.
describe("audit --published — inert marker scan is reported", () => {
  it("emits an informational finding, keeps ok true, and exits 0", async () => {
    const home = setupHome("pub-inert", {});
    const repo = makeRepo("pub-inert-repo", { class: "private-strict" });

    const stage = mkdtempSync(join(tmp, "inert-stage-"));
    mkdirSync(join(stage, "package"), { recursive: true });
    writeFileSync(join(stage, "package", "README"), "nothing interesting\n");
    const tgz = join(tmp, "inert.tgz");
    execFileSync("tar", ["-czf", tgz, "-C", stage, "package"]);

    const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() =>
        audit({
          cwd: repo,
          json: true,
          published: tgz,
        }),
      ),
    );

    assert.equal(result.exitCode, undefined, "an inert marker scan must not fail the publish");
    const j = JSON.parse(result.stdout) as {
      summary: { informationalFindings: number };
      checks: {
        name: string;
        ok: boolean;
        findings: { detail?: { code?: string }; informational?: boolean }[];
      }[];
    };
    const c = j.checks.find(c => c.name === "published");
    assert.ok(c);
    assert.equal(c!.ok, true);
    const inert = c!.findings.find(f => f.detail?.code === "PUBLISHED_EMPTY_DENY_SET");
    assert.ok(inert, `expected PUBLISHED_EMPTY_DENY_SET, got ${JSON.stringify(c!.findings)}`);
    assert.equal(inert!.informational, true);
    assert.equal(j.summary.informationalFindings, 1);
  });

  it("is absent when the deny set has patterns", async () => {
    const home = setupHome("pub-not-inert", { _always: ["zzz-marker-never-present"] });
    const repo = makeRepo("pub-not-inert-repo", { class: "private-strict" });

    const stage = mkdtempSync(join(tmp, "notinert-stage-"));
    mkdirSync(join(stage, "package"), { recursive: true });
    writeFileSync(join(stage, "package", "README"), "nothing interesting\n");
    const tgz = join(tmp, "notinert.tgz");
    execFileSync("tar", ["-czf", tgz, "-C", stage, "package"]);

    const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      captureOutputAsync(() => audit({ cwd: repo, json: true, published: tgz })),
    );

    const j = JSON.parse(result.stdout) as {
      checks: { name: string; findings: { detail?: { code?: string } }[] }[];
    };
    const c = j.checks.find(c => c.name === "published");
    assert.ok(!c!.findings.some(f => f.detail?.code === "PUBLISHED_EMPTY_DENY_SET"));
  });
});

describe("audit --published — pre-flight binary checks", () => {
  it("emits NPM_NOT_FOUND when npm is not on PATH", async () => {
    const home = setupHome("preflight-no-npm", {});
    const repo = makeRepo("preflight-no-npm-repo", { class: "private-strict" });
    // PATH-mask: point PATH at an empty dir so npm/tar/unzip resolve to
    // nothing, but keep `git` available via absolute calls in makeRepo
    // (already done before this point).
    const emptyDir = join(tmp, "empty-path-1");
    mkdirSync(emptyDir, { recursive: true });
    const prevPath = process.env["PATH"];
    process.env["PATH"] = emptyDir;
    try {
      // Use a bare package name so checkPublished takes the npm-pack path.
      const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
        captureOutputAsync(() =>
          audit({ cwd: repo, json: true, published: "some-fake-package" }),
        ),
      );
      const j = JSON.parse(result.stdout) as {
        checks: {
          name: string;
          findings: { message: string; detail?: { code?: string } }[];
        }[];
      };
      const c = j.checks.find(c => c.name === "published");
      assert.ok(c);
      assert.ok(
        c!.findings.some(f => f.detail?.code === "NPM_NOT_FOUND"),
        `expected NPM_NOT_FOUND finding, got: ${JSON.stringify(c!.findings)}`,
      );
    } finally {
      if (prevPath !== undefined) process.env["PATH"] = prevPath;
      else delete process.env["PATH"];
    }
  });

  it("emits TAR_NOT_FOUND when tar is not on PATH for a .tgz input", async () => {
    const home = setupHome("preflight-no-tar", {});
    const repo = makeRepo("preflight-no-tar-repo", { class: "private-strict" });
    // Make a dummy .tgz so the existsSync check passes; the file does not
    // need to be a valid archive because the binary check fires first.
    const tgz = join(tmp, "dummy-preflight.tgz");
    writeFileSync(tgz, "not a real tarball");
    const emptyDir = join(tmp, "empty-path-2");
    mkdirSync(emptyDir, { recursive: true });
    const prevPath = process.env["PATH"];
    process.env["PATH"] = emptyDir;
    try {
      const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
        captureOutputAsync(() =>
          audit({ cwd: repo, json: true, published: tgz }),
        ),
      );
      const j = JSON.parse(result.stdout) as {
        checks: {
          name: string;
          findings: { message: string; detail?: { code?: string } }[];
        }[];
      };
      const c = j.checks.find(c => c.name === "published");
      assert.ok(c);
      assert.ok(
        c!.findings.some(f => f.detail?.code === "TAR_NOT_FOUND"),
        `expected TAR_NOT_FOUND finding, got: ${JSON.stringify(c!.findings)}`,
      );
    } finally {
      if (prevPath !== undefined) process.env["PATH"] = prevPath;
      else delete process.env["PATH"];
    }
  });

  it("emits UNZIP_NOT_FOUND when unzip is not on PATH for a .vsix input", async () => {
    const home = setupHome("preflight-no-unzip", {});
    const repo = makeRepo("preflight-no-unzip-repo", { class: "private-strict" });
    const vsix = join(tmp, "dummy-preflight.vsix");
    writeFileSync(vsix, "not a real vsix");
    const emptyDir = join(tmp, "empty-path-3");
    mkdirSync(emptyDir, { recursive: true });
    const prevPath = process.env["PATH"];
    process.env["PATH"] = emptyDir;
    try {
      const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
        captureOutputAsync(() =>
          audit({ cwd: repo, json: true, published: vsix }),
        ),
      );
      const j = JSON.parse(result.stdout) as {
        checks: {
          name: string;
          findings: { message: string; detail?: { code?: string } }[];
        }[];
      };
      const c = j.checks.find(c => c.name === "published");
      assert.ok(c);
      assert.ok(
        c!.findings.some(f => f.detail?.code === "UNZIP_NOT_FOUND"),
        `expected UNZIP_NOT_FOUND finding, got: ${JSON.stringify(c!.findings)}`,
      );
    } finally {
      if (prevPath !== undefined) process.env["PATH"] = prevPath;
      else delete process.env["PATH"];
    }
  });
});

describe("audit — arguments and gating (new in scan)", () => {
  it("neither --org nor --published is a usage error (exit 2), not a silent pass", async () => {
    const home = setupHome("args-none", {});
    const repo = makeRepo("args-none-repo", { class: "private-strict" });
    const result = await withEnvAsync("REPO_AEGIS_HOME", home, () => runAudit({ cwd: repo }));
    assert.equal(result.exitCode, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /--org .*--published/);
  });

  it("--require-deny-set exits 2 on an empty deny set (fail-closed floor, as in the CLI)", async () => {
    const home = setupHome("floor-empty", {});
    const repo = makeRepo("floor-empty-repo", { class: "private-strict" });
    const tgz = join(tmp, "floor.tgz");
    const stage = mkdtempSync(join(tmp, "floor-stage-"));
    mkdirSync(join(stage, "package"), { recursive: true });
    writeFileSync(join(stage, "package", "README"), "x\n");
    execFileSync("tar", ["-czf", tgz, "-C", stage, "package"]);
    const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      runAudit({ cwd: repo, json: true, published: tgz, requireDenySet: true }),
    );
    assert.equal(result.exitCode, 2);
    assert.equal(result.stdout, "", "a below-floor run must not print a result that looks like a pass");
    assert.match(result.stderr, /DENY_SET_BELOW_FLOOR/);
  });

  it("the Action's REPO_AEGIS_MIN_PATTERNS env applies too", async () => {
    const home = setupHome("floor-env", {});
    const repo = makeRepo("floor-env-repo", { class: "private-strict" });
    const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      runAudit(
        { cwd: repo, json: true, published: join(tmp, "nope.tgz") },
        { env: { REPO_AEGIS_MIN_PATTERNS: "1" } as NodeJS.ProcessEnv },
      ),
    );
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /DENY_SET_BELOW_FLOOR/);
  });

  it("--redact-attribution blanks engagement ids in the payload, including on a clean run", async () => {
    const home = setupHome("redact", { "customer-a": ["zzz-never-appears-zzz"] });
    const repo = makeRepo("redact-repo", { class: "customer-coupled" });
    execFileSync("git", ["config", "--add", "repo-aegis.engagement", "customer-a"], { cwd: repo });
    const tgz = join(tmp, "redact.tgz");
    const stage = mkdtempSync(join(tmp, "redact-stage-"));
    mkdirSync(join(stage, "package"), { recursive: true });
    writeFileSync(join(stage, "package", "README"), "nothing\n");
    execFileSync("tar", ["-czf", tgz, "-C", stage, "package"]);

    const plain = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      runAudit({ cwd: repo, json: true, published: tgz }),
    );
    // Premise: without redaction the id IS in the payload, so the next assertion can fail.
    assert.ok(plain.stdout.includes("customer-a"), "premise: unredacted output carries the id");

    const redacted = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      runAudit({ cwd: repo, json: true, published: tgz, redactAttribution: true }),
    );
    assert.equal(redacted.exitCode, 0, redacted.stdout);
    assert.ok(!redacted.stdout.includes("customer-a"), redacted.stdout);
    assert.equal((JSON.parse(redacted.stdout) as { attributionRedacted?: boolean }).attributionRedacted, true);
  });

  it("text output lists each check, as `repo-aegis audit` did", async () => {
    const home = setupHome("text", { _always: ["zzz-never-appears-zzz"] });
    const repo = makeRepo("text-repo", { class: "private-strict" });
    const result = await withEnvAsync("REPO_AEGIS_HOME", home, () =>
      runAudit({ cwd: repo, published: join(tmp, "absent.tgz") }),
    );
    assert.equal(result.exitCode, 1);
    assert.match(result.stdout, /^audit: 1 check\(s\) run, 1 failed, 1 finding\(s\)/);
    assert.match(result.stdout, /published: fail \(1 finding\(s\)\)/);
  });
});

// The bin wrapper: exit code and stream routing are what a workflow step sees.
describe("repo-aegis-scan audit — bin wiring", () => {
  const bin = join(dirname(fileURLToPath(import.meta.url)), "index.js");

  function runBin(args: string[], home: string): { status: number | null; stdout: string; stderr: string } {
    const r = spawnSync(process.execPath, [bin, "audit", ...args], {
      encoding: "utf8",
      env: { ...process.env, REPO_AEGIS_HOME: home, GH_TOKEN: "", REPO_AEGIS_ACCEPT_ORG_SEED_TRANSFER: "" },
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }

  it("--org without consent exits 1 with ORG_SCAN_CONSENT_REQUIRED on stdout (no network attempted)", () => {
    const home = setupHome("bin-consent", { _always: ["acme-something"] });
    const repo = makeRepo("bin-consent-repo", { class: "private-strict" });
    const r = runBin(["--org", "example-org", "--json", "--cwd", repo], home);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stdout, /ORG_SCAN_CONSENT_REQUIRED/);
  });

  it("--published on a bad path exits 1; no flags exits 2", () => {
    const home = setupHome("bin-pub", {});
    const repo = makeRepo("bin-pub-repo", { class: "private-strict" });
    const bad = runBin(["--published", join(tmp, "missing.tgz"), "--json", "--cwd", repo], home);
    assert.equal(bad.status, 1, bad.stderr);
    const none = runBin(["--json", "--cwd", repo], home);
    assert.equal(none.status, 2);
  });
});
