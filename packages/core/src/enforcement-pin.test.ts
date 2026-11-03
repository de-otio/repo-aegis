// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { renderHookScript } from "./hook-scripts.js";
import { parsePinFromScript, pinProblem, shellQuote, shellUnquote, type EnforcementPin } from "./enforcement-pin.js";

const AWKWARD = [
  "/plain/path/node",
  "/with space/node",
  "/it's/node",
  `/dq"/node`,
  "/dollar $HOME `x` $(y)/node",
  "/back\\slash/node",
  "/glob *?[a]/node",
  "/trailing'",
  "'",
  "''",
  "/ünï/çödé/node",
];

describe("shellQuote / shellUnquote", () => {
  it("what the shell reads back is exactly the input, for awkward paths", () => {
    for (const value of AWKWARD) {
      const r = spawnSync("bash", ["-c", `printf %s ${shellQuote(value)}`], { encoding: "utf8" });
      assert.equal(r.stdout, value, `bash read back ${JSON.stringify(r.stdout)} for ${JSON.stringify(value)}`);
    }
  });

  it("shellUnquote inverts shellQuote, and rejects anything that is not one quoted word", () => {
    for (const value of AWKWARD) assert.equal(shellUnquote(shellQuote(value)), value);
    for (const bad of ["", "bare", "'open", "'a' 'b'", `'a'b'`, "$'x'"]) {
      assert.equal(shellUnquote(bad), null, bad);
    }
  });
});

describe("pinProblem", () => {
  const ok: EnforcementPin = { node: "/opt/node", cli: "/opt/cli.js" };
  it("accepts ordinary and awkward-but-quotable paths", () => {
    assert.equal(pinProblem(ok), null);
    assert.equal(pinProblem({ node: "/a b/it's", cli: `/c"d/e` }), null);
  });
  it("refuses newline, carriage return, NUL and empty, naming which path", () => {
    assert.match(pinProblem({ ...ok, node: "/a\nb" })!, /node.*newline/);
    assert.match(pinProblem({ ...ok, cli: "/a\rb" })!, /cli.*newline/);
    assert.match(pinProblem({ ...ok, cli: "/a\0b" })!, /cli.*NUL/);
    assert.match(pinProblem({ ...ok, node: "" })!, /node.*empty/);
  });
});

describe("parsePinFromScript", () => {
  it("reads back the pin a hook was rendered for, awkward paths included", () => {
    for (const value of AWKWARD) {
      const pin = { node: value, cli: `${value}.js` };
      for (const name of ["pre-commit", "pre-push"] as const) {
        assert.deepEqual(parsePinFromScript(renderHookScript(name, pin)), pin);
      }
    }
  });

  it("returns null for an old unpinned script", () => {
    const legacy = "#!/usr/bin/env bash\nif ! command -v repo-aegis >/dev/null 2>&1; then\n  exit 0\nfi\nrepo-aegis check --staged\n";
    assert.equal(parsePinFromScript(legacy), null);
  });

  it("returns null when a pin line is not a single quoted word", () => {
    assert.equal(parsePinFromScript("__ra_node=/bare/node\n__ra_cli='/c.js'\n"), null);
  });
});
