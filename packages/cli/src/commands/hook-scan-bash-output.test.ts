// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliBuilt, runCli } from "../_subprocess-utils.js";

let tmp: string;

before(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "repo-aegis-hook-bash-test-")));
});

after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function aegisHome(name: string): string {
  const home = join(tmp, name);
  mkdirSync(join(home, "markers"), { recursive: true });
  mkdirSync(join(home, "state"), { recursive: true });
  return home;
}

// All fixtures are dummy shapes — see secret-markers.test.ts for the
// rationale. These are not real credentials.
const DUMMY_PEM_HEADER = "-----BEGIN RSA PRIVATE KEY-----";
const DUMMY_GHS = "ghs_" + "A".repeat(36);

const SUBPROCESS_TESTS_AVAILABLE = cliBuilt();

describe("hook scan-bash-output", { skip: !SUBPROCESS_TESTS_AVAILABLE }, () => {
  it("exits 0 silently on empty stdin", () => {
    const home = aegisHome("empty");
    const r = runCli(home, tmp, ["hook", "scan-bash-output"], { input: "" });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
  });

  it("exits 0 silently on malformed JSON", () => {
    const home = aegisHome("malformed");
    const r = runCli(home, tmp, ["hook", "scan-bash-output"], {
      input: "not json at all",
    });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
  });

  it("exits 0 when tool is not Bash", () => {
    const home = aegisHome("not-bash");
    const payload = JSON.stringify({
      tool_name: "Write",
      tool_response: { content: DUMMY_PEM_HEADER },
    });
    const r = runCli(home, tmp, ["hook", "scan-bash-output"], { input: payload });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
  });

  it("exits 0 on clean Bash output", () => {
    const home = aegisHome("clean");
    const payload = JSON.stringify({
      tool_name: "Bash",
      tool_response: {
        stdout: "Hello world\nFiles changed: 3\n",
        stderr: "",
      },
    });
    const r = runCli(home, tmp, ["hook", "scan-bash-output"], { input: payload });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
  });

  it("exits 1 with structured payload when PEM header detected in stdout", () => {
    const home = aegisHome("pem-stdout");
    const payload = JSON.stringify({
      tool_name: "Bash",
      tool_response: {
        stdout: `prefix\n${DUMMY_PEM_HEADER}\nbody\nsuffix`,
      },
    });
    const r = runCli(home, tmp, ["hook", "scan-bash-output"], { input: payload });
    assert.equal(r.code, 1, `expected EXIT_HIT, got ${r.code}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.code, "SECRET_LEAK");
    assert.deepEqual(out.details.kinds, ["PEM_HEADER"]);
    assert.equal(out.details.count, 1);
    // Critical: the literal must not appear anywhere in the output.
    assert.ok(!r.stdout.includes(DUMMY_PEM_HEADER), "stdout leaked the literal");
    assert.ok(!r.stderr.includes(DUMMY_PEM_HEADER), "stderr leaked the literal");
  });

  it("exits 1 when secret is in stderr", () => {
    const home = aegisHome("token-stderr");
    const payload = JSON.stringify({
      tool_name: "Bash",
      tool_response: { stdout: "", stderr: `error: token=${DUMMY_GHS}` },
    });
    const r = runCli(home, tmp, ["hook", "scan-bash-output"], { input: payload });
    assert.equal(r.code, 1);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out.details.kinds, ["GITHUB_TOKEN"]);
    assert.ok(!r.stdout.includes(DUMMY_GHS), "literal token leaked");
  });

  it("--advisory exits 0 on hit but still emits payload", () => {
    const home = aegisHome("advisory");
    const payload = JSON.stringify({
      tool_name: "Bash",
      tool_response: { stdout: DUMMY_PEM_HEADER },
    });
    const r = runCli(home, tmp, ["hook", "scan-bash-output", "--advisory"], {
      input: payload,
    });
    assert.equal(r.code, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.code, "SECRET_LEAK");
  });

  it("handles tool_response.result string field", () => {
    const home = aegisHome("result-field");
    const payload = JSON.stringify({
      tool_name: "Bash",
      tool_response: { result: `header: ${DUMMY_PEM_HEADER} end` },
    });
    const r = runCli(home, tmp, ["hook", "scan-bash-output"], { input: payload });
    assert.equal(r.code, 1);
  });

  it("handles tool_result_text root field (legacy shape)", () => {
    const home = aegisHome("legacy-shape");
    const payload = JSON.stringify({
      tool_name: "Bash",
      tool_result_text: `out: ${DUMMY_GHS}`,
    });
    const r = runCli(home, tmp, ["hook", "scan-bash-output"], { input: payload });
    assert.equal(r.code, 1);
  });

  it("payload includes remediation guidance pointing to rotation", () => {
    const home = aegisHome("remediation");
    const payload = JSON.stringify({
      tool_name: "Bash",
      tool_response: { stdout: DUMMY_PEM_HEADER },
    });
    const r = runCli(home, tmp, ["hook", "scan-bash-output"], { input: payload });
    const out = JSON.parse(r.stdout);
    assert.ok(Array.isArray(out.remediation));
    assert.ok(out.remediation.some((s: string) => s.toLowerCase().includes("rotat")));
  });
});
