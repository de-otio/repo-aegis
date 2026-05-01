import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureOutput } from "../_test-utils.js";
import { installGitignore } from "./install-gitignore.js";

let tmp: string;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "repo-aegis-install-gitignore-test-"));
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("install-gitignore — fresh install", () => {
  let target: string;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmp, "fresh-"));
    target = join(dir, "ignore");
  });

  it("creates the file with managed-block content when missing", () => {
    captureOutput(() => installGitignore({ gitignorePath: target }));
    assert.ok(existsSync(target));
    const body = readFileSync(target, "utf8");
    assert.ok(body.includes("repo-aegis: managed gitignore block"));
    assert.ok(body.includes(".env"));
    assert.ok(body.includes("id_rsa"));
  });

  it("appends without leading newline when target is empty", () => {
    captureOutput(() => installGitignore({ gitignorePath: target }));
    const body = readFileSync(target, "utf8");
    assert.ok(!body.startsWith("\n"), "should not start with a stray newline");
  });

  it("appends after a trailing newline if file already had one", () => {
    writeFileSync(target, "*.log\n");
    captureOutput(() => installGitignore({ gitignorePath: target }));
    const body = readFileSync(target, "utf8");
    assert.ok(body.startsWith("*.log\n"));
    assert.ok(body.includes("repo-aegis: managed gitignore block"));
  });

  it("inserts a newline when existing file has no trailing newline", () => {
    writeFileSync(target, "*.log");
    captureOutput(() => installGitignore({ gitignorePath: target }));
    const body = readFileSync(target, "utf8");
    assert.ok(body.startsWith("*.log\n"), "must add a separator newline");
  });
});

describe("install-gitignore — idempotency", () => {
  it("does not append a second time when block already present", () => {
    const dir = mkdtempSync(join(tmp, "idem-"));
    const target = join(dir, "ignore");

    captureOutput(() => installGitignore({ gitignorePath: target }));
    const first = readFileSync(target, "utf8");

    captureOutput(() => installGitignore({ gitignorePath: target }));
    const second = readFileSync(target, "utf8");

    assert.equal(first, second, "second install must not change the file");
  });

  it("reports alreadyPresent in JSON when block exists", () => {
    const dir = mkdtempSync(join(tmp, "idem-json-"));
    const target = join(dir, "ignore");
    captureOutput(() => installGitignore({ gitignorePath: target }));
    const result = captureOutput(() =>
      installGitignore({ gitignorePath: target, json: true }),
    );
    const j = JSON.parse(result.stdout) as { alreadyPresent: boolean; appended: boolean };
    assert.equal(j.alreadyPresent, true);
    assert.equal(j.appended, false);
  });
});

describe("install-gitignore — JSON output", () => {
  it("emits the expected shape on first install", () => {
    const dir = mkdtempSync(join(tmp, "json-"));
    const target = join(dir, "ignore");
    const result = captureOutput(() =>
      installGitignore({ gitignorePath: target, json: true }),
    );
    const j = JSON.parse(result.stdout) as {
      action: string;
      target: string;
      appended: boolean;
      alreadyPresent: boolean;
    };
    assert.equal(j.action, "install-gitignore");
    assert.equal(j.target, target);
    assert.equal(j.appended, true);
    assert.equal(j.alreadyPresent, false);
  });
});

describe("install-gitignore — directory creation", () => {
  it("creates parent directory if missing", () => {
    const dir = mkdtempSync(join(tmp, "mkdir-"));
    const target = join(dir, "git", "ignore");
    captureOutput(() => installGitignore({ gitignorePath: target }));
    assert.ok(existsSync(target));
  });
});
