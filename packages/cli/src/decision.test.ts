// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// The entry points' recorder (P1-I): what it fills in for every entry point (version, clock, sandbox guess, proxy variable
// NAMES, TTY, whether `ps` was readable) and how it maps the loaders' states to the log's closed lists. The clock is the
// test-only `REPO_AEGIS_TEST_NOW` seam and the home and `$TMPDIR` are fresh temp directories.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withEnv } from "./_test-utils.js";
import { readDecisionRecords } from "@de-otio/repo-aegis-core";
import { cliVersion, hostOfAdapter, proxyVarsSet, recordAndTrail, recordDecision, registryStateFact, sandboxGuess, verbWords } from "./decision.js";
import { psReadableFact } from "./human-presence.js";

let root: string;
before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "repo-aegis-decision-recorder-")));
});
after(() => rmSync(root, { recursive: true, force: true }));

function world(name: string): { home: string; tmp: string } {
  const home = join(root, name, "home");
  const tmp = join(root, name, "tmp");
  mkdirSync(home, { recursive: true });
  mkdirSync(tmp, { recursive: true });
  return { home, tmp };
}

describe("facts every entry point reads the same way", () => {
  it("sandboxGuess: SANDBOX_RUNTIME → claude-sandbox; an agent session without it → agent-no-sandbox; else none", () => {
    assert.equal(sandboxGuess({ SANDBOX_RUNTIME: "1", CLAUDECODE: "1" }), "claude-sandbox");
    assert.equal(sandboxGuess({ CLAUDECODE: "1" }), "agent-no-sandbox");
    assert.equal(sandboxGuess({ CLAUDE_CODE_ENTRYPOINT: "cli" }), "agent-no-sandbox");
    assert.equal(sandboxGuess({ SANDBOX_RUNTIME: "" }), "none");
    assert.equal(sandboxGuess({}), "none");
  });

  it("proxyVarsSet: names only, only the fixed list, only when set to something", () => {
    const names = proxyVarsSet({ HTTPS_PROXY: "http://u:p@proxy.example:3128", no_proxy: "localhost", HTTP_PROXY: "", MY_PROXY: "x", ALL_PROXY: "socks5://x" });
    assert.deepEqual([...names].sort(), ["ALL_PROXY", "HTTPS_PROXY", "no_proxy"]);
    assert.doesNotMatch(JSON.stringify(names), /proxy\.example|u:p|localhost|socks5/);
  });

  it("psReadable: false when the process table could not be read (the ps stub fails), true when it was walked, unknown when never read", () => {
    assert.equal(psReadableFact({ present: true, ancestry: "undeterminable" }), false);
    assert.equal(psReadableFact({ present: false, ancestry: "agent", ancestor: "claude" }), true);
    assert.equal(psReadableFact({ present: true, ancestry: "clear" }), true);
    assert.equal(psReadableFact({ present: false, ancestry: "skipped" }), undefined, "no TTY: nothing was walked");
    assert.equal(psReadableFact(null), undefined);
  });

  it("host, registry state and verb mappers use only the closed lists", () => {
    assert.equal(hostOfAdapter("Claude"), "claude-code");
    assert.equal(hostOfAdapter("antigravity"), "antigravity");
    assert.equal(hostOfAdapter("codex"), "unknown");
    assert.equal(registryStateFact("loaded"), "plain");
    assert.equal(registryStateFact("encrypted"), "encrypted-locked");
    assert.equal(registryStateFact("missing"), "missing");
    assert.equal(registryStateFact("newer-schema"), "unreadable");
    assert.equal(registryStateFact("unparseable"), "unreadable");
    assert.equal(verbWords("gh-pr-create"), "gh pr create");
    assert.equal(cliVersion().match(/^\d+\.\d+\.\d+/) !== null, true);
  });
});

describe("recordDecision", () => {
  it("fills version, the pinned clock, the proxy NAMES and the sandbox guess; the caller's own facts win", () => {
    const w = world("a");
    const result = withEnv("REPO_AEGIS_TEST_NOW", "2026-11-10T12:00:00.000Z", () =>
      withEnv("HTTPS_PROXY", "http://proxy.example:3128", () =>
        withEnv("SANDBOX_RUNTIME", "1", () =>
          recordDecision({ home: w.home, layer: "shim", outcome: "refuse", code: "GH_IDENTITY_UNAVAILABLE", facts: { tty: true, sandboxGuess: "none" } }),
        ),
      ),
    );
    assert.equal(result.written, "primary");
    const [d] = readDecisionRecords(w.home, { tmp: w.tmp });
    assert.equal(d!.record.ts, "2026-11-10T12:00:00.000Z");
    assert.equal(d!.record.version, cliVersion());
    assert.ok(d!.record.facts?.proxyVarSet?.includes("HTTPS_PROXY"));
    assert.equal(d!.record.facts?.sandboxGuess, "none", "an explicit fact overrides the default");
    assert.equal(d!.record.facts?.tty, true);
    assert.doesNotMatch(JSON.stringify(d), /proxy\.example/);
  });

  it("recordAndTrail ends the text with the trailer for what the write did", () => {
    const w = world("b");
    const logged = withEnv("REPO_AEGIS_HOME", w.home, () => recordAndTrail({ layer: "pre-push", outcome: "refuse", code: "SOME_CODE" }, "refused."));
    assert.equal(logged, "refused. (logged: repo-aegis log --last 1)");
    const off = world("c");
    const unlogged = withEnv("REPO_AEGIS_HOME", join(off.home, "x", "y"), () =>
      withEnv("TMPDIR", join(off.home, "no-such-parent-file"), () => recordAndTrail({ layer: "pre-push", outcome: "refuse", code: "SOME_CODE" }, "refused.")),
    );
    assert.match(unlogged, /^refused\. \((?:logged: repo-aegis log --last 1|not logged)\)$/, "never throws, and the trailer is one of the two");
  });

  it("never throws on a malformed input", () => {
    const w = world("d");
    assert.doesNotThrow(() => recordDecision({ home: w.home, layer: "nope" as never, outcome: "refuse", code: 5 as never, verb: {} as never }));
  });
});
