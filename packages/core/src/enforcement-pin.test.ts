// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { renderHookScript } from "./hook-scripts.js";
import {
  fallbackVerdict,
  fallbackVerdictShell,
  parsePinFromScript,
  pinProblem,
  shellQuote,
  shellUnquote,
  type EnforcementPin,
  type FallbackVerdict,
} from "./enforcement-pin.js";

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

describe("pinProblem and parsePinFromScript: the recorded version", () => {
  const ok: EnforcementPin = { node: "/opt/node", cli: "/opt/cli.js" };

  it("accepts MAJOR.MINOR.PATCH with an optional -prerelease or +build suffix, and no version at all", () => {
    for (const version of ["0.14.0", "10.20.30", "0.14.0-rc.1", "1.0.0+build.5", "1.0.0-beta.2+exp.sha"]) {
      assert.equal(pinProblem({ ...ok, version }), null, version);
    }
    assert.equal(pinProblem(ok), null);
  });

  it("rejects a version that is not MAJOR.MINOR.PATCH (a script could not compare it)", () => {
    for (const version of ["", "v0.14.0", "0.14", "1", "0.14.0.1", "0.14.0 ", "0.14.0\nrm -rf", "0.14.0-rc 1", "abc", "0.14.0'; exit 0; '"]) {
      assert.match(pinProblem({ ...ok, version })!, /version/, JSON.stringify(version));
    }
    assert.throws(() => renderHookScript("pre-push", { ...ok, version: "not-a-version" }), /version/);
  });

  it("round-trips: the version is rendered as __ra_version and read back, and an absent one reads back absent", () => {
    for (const name of ["pre-commit", "pre-push"] as const) {
      for (const version of ["0.14.0", "0.14.0-rc.1"]) {
        const pin = { ...ok, version };
        const text = renderHookScript(name, pin);
        assert.match(text, new RegExp(`^__ra_version='${version.replace(/\./g, "\\.")}'$`, "m"));
        assert.deepEqual(parsePinFromScript(text), pin);
      }
      const bare = renderHookScript(name, ok);
      assert.match(bare, /^__ra_version=''$/m, "no recorded version renders as an empty assignment");
      assert.deepEqual(parsePinFromScript(bare), ok);
    }
  });

  it("a mangled or junk __ra_version line reads back as no version, not as the junk", () => {
    const base = "__ra_node='/n'\n__ra_cli='/c.js'\n";
    for (const line of ["__ra_version=bare", "__ra_version='not a version'", "__ra_version='v1.0.0'", "__ra_version=''"]) {
      assert.deepEqual(parsePinFromScript(`${base}${line}\n`), { node: "/n", cli: "/c.js" }, line);
    }
  });
});

// One table, two implementations: the TypeScript verdict and the POSIX `sh` the scripts embed must agree on every row.
// (pathVersion, pinned, verdict). A lexical comparison would call (0.9.0, 0.14.0) ok; a laxer parse would accept v0.14.0.
const VERDICTS: ReadonlyArray<readonly [string, string, FallbackVerdict]> = [
  ["0.14.0", "0.14.0", "ok"],
  ["0.14.1", "0.14.0", "ok"],
  ["1.0.0", "0.14.0", "ok"],
  ["0.13.9", "0.14.0", "older"],
  ["0.9.0", "0.14.0", "older"],
  ["0.14.0", "0.14.0-rc.1", "ok"],
  ["0.14.0", "0.14.0+build.7", "ok"],
  ["0.13.9", "0.14.0-rc.1", "older"],
  ["0.14.0-rc.1", "0.14.0", "unparsable"],
  ["v0.14.0", "0.14.0", "unparsable"],
  ["0.14", "0.14.0", "unparsable"],
  ["", "0.14.0", "unparsable"],
  ["1234567890.0.0", "0.14.0", "unparsable"],
  ["0.1234567890.0", "0.14.0", "unparsable"],
  ["999999999.999999999.999999999", "0.14.0", "ok"],
  ["1.2.3.4", "0.14.0", "unparsable"],
  ["1..3", "0.14.0", "unparsable"],
  [".1.2", "0.14.0", "unparsable"],
  ["1.2.", "0.14.0", "unparsable"],
  ["1.2.x", "0.14.0", "unparsable"],
  [" 1.2.3", "0.14.0", "unparsable"],
  ["1.2.3 ", "0.14.0", "unparsable"],
  ["0.14.0", "", "unparsable"],
  ["0.14.0", "garbage", "unparsable"],
  ["0.14.0", "1234567890.0.0", "unparsable"],
  ["0.09.0", "0.14.0", "older"],
  ["0.014.0", "0.14.0", "ok"],
  ["0.14.10", "0.14.9", "ok"],
  ["0.14.9", "0.14.10", "older"],
  ["2.0.0", "10.0.0", "older"],
  ["10.0.0", "2.0.0", "ok"],
];

function shellVerdict(shell: string, pathVersion: string, pinned: string): string {
  const r = spawnSync(shell, ["-c", `__ra_fv=$FV; __ra_version=$PV; ${fallbackVerdictShell().join("\n")}\nprintf %s "$__ra_fverdict"`], {
    encoding: "utf8",
    env: { ...process.env, FV: pathVersion, PV: pinned },
  });
  assert.equal(r.status, 0, `${shell}: ${r.stderr}`);
  return r.stdout;
}

describe("fallbackVerdict (TypeScript) and fallbackVerdictShell (sh) agree on one table", () => {
  const shells = ["/bin/sh", "bash", ...(existsSync("/bin/dash") ? ["/bin/dash"] : [])];

  for (const [pathVersion, pinned, want] of VERDICTS) {
    it(`path ${JSON.stringify(pathVersion)} vs pinned ${JSON.stringify(pinned)} is ${want}`, () => {
      assert.equal(fallbackVerdict(pathVersion, pinned), want, "TypeScript");
      for (const shell of shells) assert.equal(shellVerdict(shell, pathVersion, pinned), want, shell);
    });
  }

  it("only the first line of what --version printed counts", () => {
    assert.equal(fallbackVerdict("0.14.0\nanything else", "0.14.0"), "ok");
    assert.equal(fallbackVerdict("\n0.14.0", "0.14.0"), "unparsable");
  });
});
