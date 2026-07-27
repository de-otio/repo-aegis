// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureOutput } from "../_test-utils.js";
import { installCi } from "./install-ci.js";

let tmp: string;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "repo-aegis-install-ci-test-"));
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

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

  it("[H2] the generated audit command passes --no-hooks-check", () => {
    // GitHub Actions runners check out a fresh clone with no hooks
    // installed, so the H2 hooks-liveness check would fail on every
    // single CI run — a guaranteed false positive that would just get
    // muted. It belongs on developer machines, not here.
    const cwd = mkdtempSync(join(tmp, "print-hooks-check-"));
    const result = captureOutput(() => installCi({ cwd }));
    const auditLine = result.stdout.split("\n").find(l => l.includes("repo-aegis audit --json"));
    assert.ok(auditLine, "expected an audit invocation line in the emitted workflow");
    assert.ok(auditLine!.includes("--no-hooks-check"));
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
});
