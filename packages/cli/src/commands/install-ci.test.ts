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
    assert.ok(result.stdout.includes("repo-aegis check --path"));
    assert.equal(existsSync(join(cwd, ".github/workflows/leak-scan.yml")), false);
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
