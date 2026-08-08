// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { captureOutput } from "../_test-utils.js";
import { installCi } from "./install-ci.js";

let tmp: string;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "repo-aegis-install-ci-test-"));
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * Every `repo-aegis audit` invocation in a workflow body, re-joined across
 * backslash continuations so flag assertions see the whole command.
 */
function auditInvocations(body: string): string[] {
  const lines = body.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.includes("repo-aegis audit")) continue;
    let cmd = lines[i]!.trim();
    while (cmd.endsWith("\\") && i + 1 < lines.length) {
      cmd = cmd.slice(0, -1).trim() + " " + lines[++i]!.trim();
    }
    out.push(cmd);
  }
  return out;
}

describe("install-ci — print mode (default)", () => {
  it("prints the workflow YAML to stdout", () => {
    const cwd = mkdtempSync(join(tmp, "print-"));
    const result = captureOutput(() => installCi({ cwd }));
    assert.ok(result.stdout.includes("name: leak-scan"));
    assert.ok(result.stdout.includes("repo-aegis audit --json"));
    assert.ok(!result.stdout.includes("repo-aegis check --path"));
    assert.ok(!result.stdout.includes("git ls-files | while read"));
    assert.ok(!result.stdout.includes("done < <(git ls-files)"));
    assert.equal(existsSync(join(cwd, ".github/workflows/leak-scan.yml")), false);
  });

  it("[H2] every generated audit command passes --no-hooks-check", () => {
    // GitHub Actions runners check out a fresh clone with no hooks
    // installed, so the H2 hooks-liveness check would fail on every
    // single CI run — a guaranteed false positive that would just get
    // muted. It belongs on developer machines, not here.
    //
    // Checked per-invocation rather than per-line: since 0.8.0 the audit
    // call is wrapped across shell continuations, and a line-scoped
    // assertion would silently stop testing anything.
    for (const profile of ["pr", "strict"] as const) {
      const cwd = mkdtempSync(join(tmp, `print-hooks-check-${profile}-`));
      const result = captureOutput(() => installCi({ cwd, profile }));
      for (const invocation of auditInvocations(result.stdout)) {
        assert.ok(
          invocation.includes("--no-hooks-check"),
          `profile ${profile}: audit invocation without --no-hooks-check:\n${invocation}`,
        );
      }
    }
  });

  it("emits content in JSON without writing", () => {
    const cwd = mkdtempSync(join(tmp, "print-json-"));
    const result = captureOutput(() => installCi({ cwd, json: true }));
    const j = JSON.parse(result.stdout) as {
      action: string;
      target: string;
      wrote: boolean;
      content: string;
    };
    assert.equal(j.action, "install-ci");
    assert.equal(j.wrote, false);
    assert.ok(j.content.includes("name: leak-scan"));
    assert.equal(existsSync(join(cwd, ".github/workflows/leak-scan.yml")), false);
  });
});

describe("install-ci — write mode", () => {
  it("writes the workflow file with --write", () => {
    const cwd = mkdtempSync(join(tmp, "write-"));
    captureOutput(() => installCi({ cwd, write: true }));
    const target = join(cwd, ".github/workflows/leak-scan.yml");
    assert.ok(existsSync(target));
    const body = readFileSync(target, "utf8");
    assert.ok(body.includes("name: leak-scan"));
  });

  it("creates .github/workflows directory if missing", () => {
    const cwd = mkdtempSync(join(tmp, "mkdir-"));
    captureOutput(() => installCi({ cwd, write: true }));
    assert.ok(existsSync(join(cwd, ".github/workflows")));
  });

  it("refuses to overwrite an existing workflow without --force", () => {
    const cwd = mkdtempSync(join(tmp, "no-overwrite-"));
    const target = join(cwd, ".github/workflows/leak-scan.yml");
    mkdirSync(join(cwd, ".github/workflows"), { recursive: true });
    writeFileSync(target, "existing content");
    const result = captureOutput(() => installCi({ cwd, write: true }));
    assert.equal(result.exitCode, 2);
    assert.ok(result.stderr.includes("already exists"));
    assert.equal(readFileSync(target, "utf8"), "existing content");
  });

  it("overwrites with --force", () => {
    const cwd = mkdtempSync(join(tmp, "force-"));
    const target = join(cwd, ".github/workflows/leak-scan.yml");
    mkdirSync(join(cwd, ".github/workflows"), { recursive: true });
    writeFileSync(target, "existing content");
    captureOutput(() => installCi({ cwd, write: true, force: true }));
    assert.ok(readFileSync(target, "utf8").includes("name: leak-scan"));
  });

  it("JSON write reports wrote=true", () => {
    const cwd = mkdtempSync(join(tmp, "write-json-"));
    const result = captureOutput(() => installCi({ cwd, write: true, json: true }));
    const j = JSON.parse(result.stdout) as { wrote: boolean; target: string };
    assert.equal(j.wrote, true);
    assert.ok(j.target.endsWith(".github/workflows/leak-scan.yml"));
  });
});

describe("install-ci — uninstall", () => {
  it("removes the workflow file when its body matches the emitted template", () => {
    const cwd = mkdtempSync(join(tmp, "uninstall-clean-"));
    const target = join(cwd, ".github/workflows/leak-scan.yml");
    captureOutput(() => installCi({ cwd, write: true }));
    assert.ok(existsSync(target));
    captureOutput(() => installCi({ cwd, uninstall: true }));
    assert.equal(existsSync(target), false);
  });

  it("refuses to remove a user-edited workflow", () => {
    const cwd = mkdtempSync(join(tmp, "uninstall-edited-"));
    const target = join(cwd, ".github/workflows/leak-scan.yml");
    captureOutput(() => installCi({ cwd, write: true }));
    writeFileSync(target, readFileSync(target, "utf8") + "\n# user-added comment\n");
    const r = captureOutput(() => installCi({ cwd, uninstall: true }));
    assert.equal(r.exitCode, 2);
    assert.ok(r.stderr.includes("differs from any known repo-aegis-emitted template"));
    assert.ok(existsSync(target));
  });

  it("[H2] recognises a pre-H2 workflow (no --no-hooks-check) as our own, not user-modified", () => {
    // Regression guard for the uninstall registry: the workflow body
    // changed when H2 added --no-hooks-check to the audit line, but a
    // repo that ran `install ci` before that change never re-runs the
    // command just because the CLI got smarter about hooks. Its
    // on-disk file is byte-identical to the pre-H2 template below, and
    // `uninstall` must still recognise it as repo-aegis-emitted rather
    // than misreporting WORKFLOW_MODIFIED.
    const PRE_H2_WORKFLOW_CONTENT =
      "# Generated by `repo-aegis install ci`.\n# Scans the repository for engagement-scoped marker hits on every PR\n# and on direct pushes to main/master. Runs `repo-aegis audit` once\n# in marker-scan-only mode (history/lockfile/fixture/remote checks\n# disabled) so the cost is a single node process per CI run rather\n# than one process per tracked file. To enable the other audit\n# checks, remove the corresponding --no-* flags below.\nname: leak-scan\non:\n  pull_request:\n  push:\n    branches: [main, master]\n\njobs:\n  leak-scan:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n    steps:\n      - name: Checkout\n        uses: actions/checkout@v4\n        with:\n          fetch-depth: 0\n      - name: Set up Node.js\n        uses: actions/setup-node@v4\n        with:\n          node-version: '20'\n      - name: Install repo-aegis\n        run: npm install -g @de-otio/repo-aegis\n      - name: Marker scan\n        # audit's JSON output enumerates findings per check with file:line,\n        # so a non-zero exit identifies the offending file without a\n        # per-file echo loop. Hooks must never pass --verbose; the CI\n        # runner is no different — keep marker output redacted in logs.\n        run: repo-aegis audit --json --no-history --no-lockfile-check --no-fixture-check --no-remote-check\n";
    const cwd = mkdtempSync(join(tmp, "uninstall-pre-h2-"));
    const target = join(cwd, ".github/workflows/leak-scan.yml");
    mkdirSync(join(cwd, ".github/workflows"), { recursive: true });
    writeFileSync(target, PRE_H2_WORKFLOW_CONTENT);
    const r = captureOutput(() => installCi({ cwd, uninstall: true, json: true }));
    const j = JSON.parse(r.stdout) as { removed: boolean };
    assert.equal(j.removed, true);
    assert.equal(existsSync(target), false);
  });

  it("is a silent no-op when the workflow file is missing", () => {
    const cwd = mkdtempSync(join(tmp, "uninstall-missing-"));
    const r = captureOutput(() => installCi({ cwd, uninstall: true, json: true }));
    const j = JSON.parse(r.stdout) as { absent: boolean; removed: boolean };
    assert.equal(j.absent, true);
    assert.equal(j.removed, false);
  });

  it("emits JSON on successful uninstall", () => {
    const cwd = mkdtempSync(join(tmp, "uninstall-json-"));
    captureOutput(() => installCi({ cwd, write: true }));
    const r = captureOutput(() => installCi({ cwd, uninstall: true, json: true }));
    const j = JSON.parse(r.stdout) as { action: string; removed: boolean };
    assert.equal(j.action, "uninstall-ci");
    assert.equal(j.removed, true);
  });

  it("[0.8.0] recognises a 0.7.x workflow as our own, not user-modified", () => {
    // Same regression class as the pre-H2 case above, one release later. The
    // 0.8.0 template changed substantially (SHA pins, Node 24, extra jobs), so
    // every repo that ran `install ci` under 0.7.x has an on-disk file that no
    // longer matches the current template. Its hash must stay in the registry
    // or `--uninstall` tells the user to hand-delete a file repo-aegis wrote.
    //
    // The body below is the verbatim 0.7.1 template, so this test — not a
    // hand-copied hex digest — is what proves the registry entry is right.
    const V07_WORKFLOW_CONTENT =
      "# Generated by `repo-aegis install ci`.\n# Scans the repository for engagement-scoped marker hits on every PR\n# and on direct pushes to main/master. Runs `repo-aegis audit` once\n# in marker-scan-only mode (history/lockfile/fixture/remote/hooks\n# checks disabled) so the cost is a single node process per CI run\n# rather than one process per tracked file. To enable the other audit\n# checks, remove the corresponding --no-* flags below.\n#\n# --no-hooks-check is NOT one to remove: it skips the git-hooks\n# liveness check (H2), which verifies repo-aegis's pre-commit/pre-push\n# hooks are actually installed and wired up via core.hooksPath. GitHub\n# Actions runners always check out a fresh clone with no hooks\n# installed, so that check would fail on every single run here — a\n# guaranteed false positive, not a real finding. It belongs on\n# developer machines (`repo-aegis status` / `audit` locally), not CI.\nname: leak-scan\non:\n  pull_request:\n  push:\n    branches: [main, master]\n\njobs:\n  leak-scan:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n    steps:\n      - name: Checkout\n        uses: actions/checkout@v4\n        with:\n          fetch-depth: 0\n      - name: Set up Node.js\n        uses: actions/setup-node@v4\n        with:\n          node-version: '20'\n      - name: Install repo-aegis\n        run: npm install -g @de-otio/repo-aegis\n      - name: Marker scan\n        # audit's JSON output enumerates findings per check with file:line,\n        # so a non-zero exit identifies the offending file without a\n        # per-file echo loop. Hooks must never pass --verbose; the CI\n        # runner is no different — keep marker output redacted in logs.\n        run: repo-aegis audit --json --no-history --no-lockfile-check --no-fixture-check --no-remote-check --no-hooks-check\n";
    const cwd = mkdtempSync(join(tmp, "uninstall-v07-"));
    const target = join(cwd, ".github/workflows/leak-scan.yml");
    mkdirSync(join(cwd, ".github/workflows"), { recursive: true });
    writeFileSync(target, V07_WORKFLOW_CONTENT);
    const r = captureOutput(() => installCi({ cwd, uninstall: true, json: true }));
    const j = JSON.parse(r.stdout) as { removed: boolean };
    assert.equal(j.removed, true, r.stderr);
    assert.equal(existsSync(target), false);
  });

  it("[0.8.1] recognises a workflow pinned to an OLDER CLI version", () => {
    // The template embeds the generating CLI's own version, so its literal
    // body changes on every release even when nothing structural does. Hashed
    // raw, that made recognition version-dependent: 0.8.1 would refuse to
    // uninstall a workflow 0.8.0 wrote, and every future release would repeat
    // the failure unless a human remembered to prepend a hash each time.
    //
    // Generate the CURRENT template, then rewrite only the version pin to an
    // older value — exactly what an on-disk file from a previous release looks
    // like. It must still be recognised as ours.
    const gen = captureOutput(() =>
      installCi({ cwd: mkdtempSync(join(tmp, "vgen-")), profile: "pr", json: true }),
    );
    const templates = (JSON.parse(gen.stdout) as { templates: Record<string, string> })
      .templates;
    const current = Object.values(templates)[0]!;
    assert.ok(
      /REPO_AEGIS_VERSION: '[^']+'/.test(current),
      "premise: the template must pin a version for this test to mean anything",
    );
    const olderPin = current.replace(/REPO_AEGIS_VERSION: '[^']+'/, "REPO_AEGIS_VERSION: '0.8.0'");
    assert.notEqual(olderPin, current, "premise: the rewrite must actually change the body");

    const cwd = mkdtempSync(join(tmp, "uninstall-oldver-"));
    const target = join(cwd, ".github/workflows/leak-scan.yml");
    mkdirSync(join(cwd, ".github/workflows"), { recursive: true });
    writeFileSync(target, olderPin);
    const r = captureOutput(() => installCi({ cwd, uninstall: true, json: true }));
    const j = JSON.parse(r.stdout) as { removed: boolean };
    assert.equal(j.removed, true, r.stderr);
    assert.equal(existsSync(target), false);
  });

  it("still refuses a genuinely modified workflow", () => {
    // The canonicalisation above must normalise the version pin and nothing
    // else — otherwise it becomes a hole that lets edited files be deleted.
    const gen = captureOutput(() =>
      installCi({ cwd: mkdtempSync(join(tmp, "vgen2-")), profile: "pr", json: true }),
    );
    const templates = (JSON.parse(gen.stdout) as { templates: Record<string, string> })
      .templates;
    const tampered = Object.values(templates)[0]!.replace(
      "--ignore-scripts",
      "--ignore-scripts --force",
    );

    const cwd = mkdtempSync(join(tmp, "uninstall-tampered-"));
    const target = join(cwd, ".github/workflows/leak-scan.yml");
    mkdirSync(join(cwd, ".github/workflows"), { recursive: true });
    writeFileSync(target, tampered);
    const r = captureOutput(() => installCi({ cwd, uninstall: true, json: true }));
    assert.ok(
      r.stderr.includes("WORKFLOW_MODIFIED") || r.stdout.includes("WORKFLOW_MODIFIED"),
      `expected WORKFLOW_MODIFIED, got stdout=${r.stdout} stderr=${r.stderr}`,
    );
    assert.equal(existsSync(target), true, "a modified file must not be deleted");
  });

  it("removes every profile by default, so no generated file is orphaned", () => {
    // The standing rule: every install path needs its opposite. `uninstall`
    // is called without a profile by the top-level `repo-aegis uninstall`, so
    // its default has to be "all", not "pr".
    const cwd = mkdtempSync(join(tmp, "uninstall-all-"));
    captureOutput(() => installCi({ cwd, write: true, profile: "all" }));
    const pr = join(cwd, ".github/workflows/leak-scan.yml");
    const strict = join(cwd, ".github/workflows/leak-scan-strict.yml");
    assert.ok(existsSync(pr) && existsSync(strict));
    captureOutput(() => installCi({ cwd, uninstall: true }));
    assert.equal(existsSync(pr), false);
    assert.equal(existsSync(strict), false);
  });
});

describe("install-ci — profiles", () => {
  it("defaults to the pr profile", () => {
    const cwd = mkdtempSync(join(tmp, "profile-default-"));
    captureOutput(() => installCi({ cwd, write: true }));
    assert.ok(existsSync(join(cwd, ".github/workflows/leak-scan.yml")));
    assert.equal(existsSync(join(cwd, ".github/workflows/leak-scan-strict.yml")), false);
  });

  it("--profile strict writes only the scheduled workflow", () => {
    const cwd = mkdtempSync(join(tmp, "profile-strict-"));
    captureOutput(() => installCi({ cwd, write: true, profile: "strict" }));
    assert.equal(existsSync(join(cwd, ".github/workflows/leak-scan.yml")), false);
    const body = readFileSync(join(cwd, ".github/workflows/leak-scan-strict.yml"), "utf8");
    assert.ok(body.includes("name: leak-scan-strict"));
    assert.ok(body.includes("--ignore-waivers"));
    assert.ok(body.includes("--ignore-allowlist-comments"));
    assert.ok(body.includes("schedule:"));
  });

  it("rejects an unknown profile rather than silently writing the default", () => {
    const cwd = mkdtempSync(join(tmp, "profile-bogus-"));
    const r = captureOutput(() =>
      installCi({ cwd, write: true, profile: "nonsense" as "pr" }),
    );
    assert.equal(r.exitCode, 2);
    assert.ok(r.stderr.includes("unknown --profile"));
  });

  it("--json exposes every template keyed by destination path", () => {
    const cwd = mkdtempSync(join(tmp, "profile-json-"));
    const r = captureOutput(() => installCi({ cwd, json: true, profile: "all" }));
    const j = JSON.parse(r.stdout) as { templates: Record<string, string> };
    assert.deepEqual(Object.keys(j.templates).sort(), [
      ".github/workflows/leak-scan-strict.yml",
      ".github/workflows/leak-scan.yml",
    ]);
  });
});

describe("install-ci — generated workflow hardening", () => {
  // These assertions are the shipped-artefact half of the repo's workflow
  // hygiene rules. `tests/workflow-hygiene.mjs` enforces the same properties
  // structurally (it parses the YAML); these keep the intent legible at the
  // point the template is authored, and fail fast in the unit suite.
  const bodies = (): string[] => {
    const cwd = mkdtempSync(join(tmp, "harden-"));
    const r = captureOutput(() => installCi({ cwd, json: true, profile: "all" }));
    const j = JSON.parse(r.stdout) as { templates: Record<string, string> };
    return Object.values(j.templates);
  };

  /** Parsed jobs of a generated workflow. Parsing beats line regexes here: an
   *  `on:` key at the same indentation as a job is not a job, and a
   *  regex-counted "every job has a timeout" check that miscounts either way
   *  is worse than none. */
  interface ParsedJob {
    id: string;
    timeout: unknown;
    steps: { name?: string; uses?: string; run?: string }[];
  }
  const jobsOf = (body: string): ParsedJob[] => {
    const doc = parseYaml(body) as {
      jobs?: Record<string, { "timeout-minutes"?: unknown; steps?: ParsedJob["steps"] }>;
    };
    return Object.entries(doc.jobs ?? {}).map(([id, j]) => ({
      id,
      timeout: j["timeout-minutes"],
      steps: j.steps ?? [],
    }));
  };

  it("pins every third-party action to a full commit SHA", () => {
    for (const body of bodies()) {
      for (const job of jobsOf(body)) {
        for (const step of job.steps) {
          if (!step.uses) continue;
          assert.match(
            step.uses,
            /@[0-9a-f]{40}$/,
            `unpinned action in job ${job.id}: ${step.uses}`,
          );
        }
      }
    }
  });

  it("never interpolates \\${{ }} inside a run: block", () => {
    // The injection class: GitHub splices the expression in before the shell
    // sees it, so an attacker-influenced value can close the quoting. Values
    // must arrive via env:.
    for (const body of bodies()) {
      for (const job of jobsOf(body)) {
        for (const step of job.steps) {
          if (typeof step.run !== "string") continue;
          assert.ok(
            !step.run.includes("${{"),
            `interpolation inside run: in job ${job.id} — pass via env: instead\n${step.run}`,
          );
        }
      }
    }
  });

  it("gives every job a timeout-minutes", () => {
    // The default is 360 minutes. A wedged step should fail fast, not bill six
    // hours of runner time.
    for (const body of bodies()) {
      const jobs = jobsOf(body);
      assert.ok(jobs.length > 0, "expected at least one job");
      for (const job of jobs) {
        assert.equal(typeof job.timeout, "number", `job ${job.id} has no timeout-minutes`);
      }
    }
  });

  it("fails closed on an empty deny set and redacts attribution", () => {
    for (const body of bodies()) {
      assert.ok(
        body.includes("REPO_AEGIS_REDACT_ATTRIBUTION: '1'"),
        "generated workflows publish output; attribution must be redacted",
      );
      for (const invocation of auditInvocations(body)) {
        assert.ok(
          invocation.includes("--require-deny-set"),
          `audit invocation without --require-deny-set:\n${invocation}`,
        );
      }
    }
  });

  it("installs the CLI outside the checkout, pinned, with scripts disabled", () => {
    // npm reads ./.npmrc from the working directory. Run from the checkout, a
    // PR-supplied .npmrc can repoint the registry and substitute the package —
    // whose install scripts would then run in a job that may hold secrets.
    for (const body of bodies()) {
      assert.ok(body.includes("working-directory: ${{ runner.temp }}"));
      assert.ok(body.includes("--ignore-scripts"));
      assert.ok(body.includes("--registry=https://registry.npmjs.org"));
      assert.ok(
        !/npm install -g\s+"?@de-otio\/repo-aegis"?\s*$/m.test(body),
        "the global install must be version-pinned, not floating",
      );
    }
  });

  it("keeps issues: write out of the PR-triggered workflow", () => {
    // The strict workflow files issues and needs the permission. The PR gate
    // must not be able to reach it: a PR-triggered job holding issues: write
    // is a write primitive attached to an untrusted trigger.
    const cwd = mkdtempSync(join(tmp, "perms-"));
    const r = captureOutput(() => installCi({ cwd, json: true, profile: "all" }));
    const j = JSON.parse(r.stdout) as { templates: Record<string, string> };
    assert.ok(
      !j.templates[".github/workflows/leak-scan.yml"]!.includes("issues: write"),
      "the PR gate must not hold issues: write",
    );
    assert.ok(j.templates[".github/workflows/leak-scan-strict.yml"]!.includes("issues: write"));
  });
});
