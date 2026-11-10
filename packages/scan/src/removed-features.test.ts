// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// The semantic sweep and Ollama flags were removed in 0.15.0. Passing one must
// fail with a message that says so (not commander's generic unknown-option
// error), so a cron job that still carries the flag gets a pointer, and so a
// removed flag can never be silently ignored while the run reports a result.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { removedRunOptionMessage } from "./removed-features.js";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "index.js");

describe("removedRunOptionMessage", () => {
  it("returns null when no removed option is set", () => {
    assert.equal(removedRunOptionMessage({ queries: ["q.yml"], state: "s.json" }), null);
  });

  it("names --semantic and says it was removed in 0.15.0", () => {
    const msg = removedRunOptionMessage({ semantic: true });
    assert.ok(msg !== null);
    assert.match(msg, /--semantic/);
    assert.match(msg, /removed in 0\.15\.0/);
  });

  for (const [key, flag] of [
    ["ollamaEndpoint", "--ollama-endpoint"],
    ["ollamaModel", "--ollama-model"],
    ["ollamaTimeoutMs", "--ollama-timeout-ms"],
    ["allowRemoteOllama", "--allow-remote-ollama"],
    ["semanticMaxBytesPerCandidate", "--semantic-max-bytes-per-candidate"],
  ] as const) {
    it(`rejects ${flag}`, () => {
      const msg = removedRunOptionMessage({ [key]: "x" });
      assert.ok(msg !== null);
      assert.ok(msg.startsWith(flag));
    });
  }
});

describe("repo-aegis-scan CLI: removed features", () => {
  function runCli(args: string[]) {
    return spawnSync(process.execPath, [cli, ...args], {
      encoding: "utf8",
      // No token: the removed-flag check must fire before any token or network use.
      env: { PATH: process.env["PATH"] ?? "" },
    });
  }

  it("`run --semantic` exits 2 with a REMOVED error, not an unknown-option error", () => {
    const r = runCli(["run", "--queries", "q.yml", "--state", "s.json", "--semantic"]);
    assert.equal(r.status, 2);
    assert.doesNotMatch(r.stderr, /unknown option/i);
    const payload = JSON.parse(r.stderr.trim().split("\n").pop()!) as { code: string; error: string };
    assert.equal(payload.code, "REMOVED");
    assert.match(payload.error, /--semantic .*removed in 0\.15\.0/);
  });

  it("`run --ollama-model x` exits 2 with a REMOVED error", () => {
    const r = runCli(["run", "--queries", "q.yml", "--state", "s.json", "--ollama-model", "x"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /"code":"REMOVED"/);
  });

  it("`rebuild-profiles` exits 2 with a REMOVED error, even with its old flags", () => {
    const r = runCli(["rebuild-profiles", "--diff", "--ollama-endpoint", "http://127.0.0.1:11434"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /"code":"REMOVED"/);
    assert.match(r.stderr, /rebuild-profiles/);
  });

  it("the removed flags are hidden from `run --help`", () => {
    const r = runCli(["run", "--help"]);
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stdout, /semantic|ollama/i);
  });
});
