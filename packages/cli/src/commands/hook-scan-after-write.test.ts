import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliBuilt, runCli } from "../_subprocess-utils.js";

let tmp: string;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "repo-aegis-hook-scan-test-"));
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

interface Env {
  aegisHome: string;
  cwd: string;
}

function setupAegisHome(name: string): Env {
  const aegisHome = join(tmp, `${name}-aegis`);
  mkdirSync(join(aegisHome, "markers"), { recursive: true });
  mkdirSync(join(aegisHome, "state"), { recursive: true });
  return { aegisHome, cwd: tmp };
}

const SUBPROCESS_TESTS_AVAILABLE = cliBuilt();

describe("hook scan-after-write", { skip: !SUBPROCESS_TESTS_AVAILABLE }, () => {
  it("exits 0 silently when stdin is empty", () => {
    const env = setupAegisHome("empty-stdin");
    const r = runCli(env.aegisHome, env.cwd, ["hook", "scan-after-write"], {
      input: "",
    });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
  });

  it("exits 0 silently when JSON has no tool_input.file_path", () => {
    const env = setupAegisHome("no-path");
    const r = runCli(env.aegisHome, env.cwd, ["hook", "scan-after-write"], {
      input: '{"tool_name":"Bash"}',
    });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
  });

  it("exits 0 silently when the file_path does not exist", () => {
    const env = setupAegisHome("missing-file");
    const r = runCli(env.aegisHome, env.cwd, ["hook", "scan-after-write"], {
      input: JSON.stringify({ tool_input: { file_path: "/nonexistent/abc/xyz" } }),
    });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
  });

  it("exits 0 silently on unparseable JSON", () => {
    const env = setupAegisHome("bad-json");
    const r = runCli(env.aegisHome, env.cwd, ["hook", "scan-after-write"], {
      input: "this is not json {{{",
    });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
  });

  it("falls back to tool_input.path for older payload shapes", () => {
    const env = setupAegisHome("legacy-shape");
    const probe = join(tmp, "legacy-probe.txt");
    writeFileSync(probe, "innocuous");
    const r = runCli(env.aegisHome, env.cwd, ["hook", "scan-after-write"], {
      input: JSON.stringify({ tool_input: { path: probe } }),
    });
    const json = r.json as { status: string };
    assert.equal(json.status, "no-deny-set");
  });

  it("emits clean JSON when a real file_path is supplied with no deny set", () => {
    const env = setupAegisHome("clean");
    const probe = join(tmp, "clean-probe.txt");
    writeFileSync(probe, "nothing of interest");
    const r = runCli(env.aegisHome, env.cwd, ["hook", "scan-after-write"], {
      input: JSON.stringify({ tool_input: { file_path: probe } }),
    });
    const json = r.json as { status: string };
    assert.equal(json.status, "no-deny-set");
  });
});
