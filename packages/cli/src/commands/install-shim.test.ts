// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { captureOutput, fakeGh, lastJsonLine, withEnv } from "../_test-utils.js";
import { checkShim, ghShimIsFirstOnPath, installShim, shimPathFor, type ShimResult } from "./install-shim.js";
import { GH_SHIM_SCRIPT, SHIM_HEADER_LINE } from "./shim-script.js";

let root: string;

before(() => {
  root = mkdtempSync(join(tmpdir(), "repo-aegis-install-shim-test-"));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A fresh REPO_AEGIS_HOME per case; every call runs with it in the env. */
function makeHome(name: string): { home: string; run: <T>(fn: () => T) => T } {
  const home = join(root, name, "repo-aegis");
  mkdirSync(home, { recursive: true });
  return { home, run: <T>(fn: () => T): T => withEnv("REPO_AEGIS_HOME", home, fn) };
}

describe("GH_SHIM_SCRIPT", () => {
  it("is a bash script carrying the generated-by header on its own line", () => {
    const lines = GH_SHIM_SCRIPT.split("\n");
    assert.equal(lines[0], "#!/usr/bin/env bash");
    assert.equal(lines[1], SHIM_HEADER_LINE);
  });

  it("uses no bash-4 or GNU-only constructs", () => {
    // macOS ships bash 3.2 and that is where this shim spends most of its
    // life. `readlink -f` is GNU-only; `mapfile` and `declare -A` are bash 4+.
    for (const banned of ["readlink -f", "mapfile", "declare -A", "${var,,}"]) {
      assert.ok(!GH_SHIM_SCRIPT.includes(banned), `shim must not use ${banned}`);
    }
  });

  it("never hard-codes a path to the real gh", () => {
    assert.ok(!/\/usr\/(local\/)?bin\/gh/.test(GH_SHIM_SCRIPT));
  });
});

describe("install shim", () => {
  it("writes an executable shim with the header and prints the PATH instruction", () => {
    const { home, run } = makeHome("install");
    const out = run(() => captureOutput(() => installShim(undefined, {})));
    const path = join(home, "bin", "gh");

    assert.equal(out.exitCode, undefined);
    assert.ok(existsSync(path));
    assert.equal(readFileSync(path, "utf8"), GH_SHIM_SCRIPT);
    assert.equal(statSync(path).mode & 0o777, 0o755);
    assert.ok(out.stdout.includes(`export PATH="${join(home, "bin")}:$PATH"`));
  });

  it("is idempotent: a second run reports already installed and rewrites nothing", () => {
    const { home, run } = makeHome("idempotent");
    run(() => captureOutput(() => installShim(undefined, {})));
    const path = join(home, "bin", "gh");
    const firstMtime = statSync(path).mtimeMs;

    const out = run(() => captureOutput(() => installShim(undefined, {})));
    assert.ok(out.stdout.includes("already installed"));
    assert.equal(statSync(path).mtimeMs, firstMtime);
  });

  it("refreshes an out-of-date shim it wrote itself, without --force", () => {
    const { home, run } = makeHome("refresh");
    const path = join(home, "bin", "gh");
    mkdirSync(join(home, "bin"), { recursive: true });
    writeFileSync(path, `#!/usr/bin/env bash\n${SHIM_HEADER_LINE}\n# an older version\n`, { mode: 0o755 });

    const out = run(() => captureOutput(() => installShim(undefined, {})));
    assert.equal(out.exitCode, undefined);
    assert.equal(readFileSync(path, "utf8"), GH_SHIM_SCRIPT);
  });

  it("refuses a file it did not write, and says how to override", () => {
    const { home, run } = makeHome("occupied");
    const path = join(home, "bin", "gh");
    mkdirSync(join(home, "bin"), { recursive: true });
    writeFileSync(path, "#!/bin/sh\n# somebody else's gh wrapper\n", { mode: 0o755 });

    const out = run(() => captureOutput(() => installShim(undefined, { json: true })));
    assert.equal(out.exitCode, 2);
    const payload = lastJsonLine<{ code: string; details: string }>(out.stderr);
    assert.equal(payload.code, "SHIM_PATH_OCCUPIED");
    assert.ok(payload.details.includes("--force"));
    // Untouched.
    assert.ok(readFileSync(path, "utf8").includes("somebody else's gh wrapper"));
  });

  it("--force overwrites a foreign file", () => {
    const { home, run } = makeHome("force");
    const path = join(home, "bin", "gh");
    mkdirSync(join(home, "bin"), { recursive: true });
    writeFileSync(path, "#!/bin/sh\n# somebody else's gh wrapper\n", { mode: 0o755 });

    const out = run(() => captureOutput(() => installShim(undefined, { force: true })));
    assert.equal(out.exitCode, undefined);
    assert.equal(readFileSync(path, "utf8"), GH_SHIM_SCRIPT);
  });

  it("refuses any tool but gh with USAGE", () => {
    const { run } = makeHome("usage");
    const out = run(() => captureOutput(() => installShim("git", { json: true })));
    assert.equal(out.exitCode, 2);
    assert.equal(lastJsonLine<{ code: string }>(out.stderr).code, "USAGE");
  });

  it("--json reports the path, the bin dir and the PATH instruction", () => {
    const { home, run } = makeHome("json");
    const out = run(() => captureOutput(() => installShim("gh", { json: true })));
    const payload = JSON.parse(out.stdout) as {
      action: string;
      path: string;
      changed: boolean;
      tool: string;
      binDir: string;
      pathInstruction: string;
    };
    assert.deepEqual(payload, {
      action: "install-shim",
      path: join(home, "bin", "gh"),
      changed: true,
      tool: "gh",
      binDir: join(home, "bin"),
      pathInstruction: `export PATH="${join(home, "bin")}:$PATH"`,
    });
  });

  it("shimPathFor honours REPO_AEGIS_HOME", () => {
    const { home, run } = makeHome("path-for");
    assert.equal(run(() => shimPathFor()), join(home, "bin", "gh"));
  });
});

describe("install shim --uninstall", () => {
  it("removes the shim and is idempotent on a missing one", () => {
    const { home, run } = makeHome("uninstall");
    run(() => captureOutput(() => installShim(undefined, {})));
    const path = join(home, "bin", "gh");

    const first = run(() => captureOutput(() => installShim(undefined, { uninstall: true })));
    assert.equal(first.exitCode, undefined);
    assert.ok(!existsSync(path));
    assert.ok(first.stdout.includes("removed"));

    const second = run(() => captureOutput(() => installShim(undefined, { uninstall: true })));
    assert.equal(second.exitCode, undefined);
    assert.ok(second.stdout.includes("no shim installed"));
  });

  it("leaves a file it did not write in place", () => {
    const { home, run } = makeHome("uninstall-foreign");
    const path = join(home, "bin", "gh");
    mkdirSync(join(home, "bin"), { recursive: true });
    writeFileSync(path, "#!/bin/sh\n# somebody else's gh wrapper\n", { mode: 0o755 });

    let result: ShimResult | undefined;
    const out = run(() =>
      captureOutput(() => {
        result = installShim(undefined, { uninstall: true });
      }),
    );
    assert.equal(out.exitCode, undefined);
    assert.ok(existsSync(path));
    assert.equal(result?.changed, false);
    assert.ok(result?.reason?.includes("not written by repo-aegis"));
  });
});

describe("checkShim", () => {
  it("SHIM_MISSING when no shim is installed", () => {
    const { home } = makeHome("check-missing");
    const checks = checkShim({ REPO_AEGIS_HOME: home, PATH: "" });
    assert.equal(checks.length, 1);
    assert.equal(checks[0]?.code, "SHIM_MISSING");
    assert.equal(checks[0]?.ok, false);
    assert.equal(checks[0]?.fix, "repo-aegis install shim");
  });

  it("SHIM_NOT_FIRST when another gh precedes the shim on PATH", () => {
    const { home, run } = makeHome("check-shadowed");
    run(() => captureOutput(() => installShim(undefined, {})));
    const other = fakeGh(join(root, "check-shadowed-bin"), "echo real gh");

    const checks = checkShim({
      REPO_AEGIS_HOME: home,
      PATH: [other, join(home, "bin")].join(delimiter),
    });
    assert.equal(checks[0]?.code, "SHIM_NOT_FIRST");
    assert.equal(checks[0]?.ok, false);
    assert.ok(checks[0]?.fix?.includes(join(home, "bin")));
  });

  it("SHIM_NOT_FIRST when nothing on PATH reaches the shim at all", () => {
    const { home, run } = makeHome("check-unreachable");
    run(() => captureOutput(() => installShim(undefined, {})));
    const empty = join(root, "check-unreachable-empty");
    mkdirSync(empty, { recursive: true });

    const checks = checkShim({ REPO_AEGIS_HOME: home, PATH: empty });
    assert.equal(checks[0]?.code, "SHIM_NOT_FIRST");
    assert.equal(checks[0]?.ok, false);
  });

  it("ok when the shim is installed and first on PATH", () => {
    const { home, run } = makeHome("check-first");
    run(() => captureOutput(() => installShim(undefined, {})));
    const other = fakeGh(join(root, "check-first-bin"), "echo real gh");

    const checks = checkShim({
      REPO_AEGIS_HOME: home,
      PATH: [join(home, "bin"), other].join(delimiter),
    });
    assert.equal(checks.length, 1);
    assert.equal(checks[0]?.ok, true);
    assert.equal(checks[0]?.detail, "shim installed, current, and first on PATH");
    assert.equal(checks[0]?.fix, undefined);
  });

  it("SHIM_STALE when the shim on PATH is an earlier release's script", () => {
    const { home, run } = makeHome("check-stale");
    run(() => captureOutput(() => installShim(undefined, {})));
    // An older generated shim: same header line, different body.
    writeFileSync(join(home, "bin", "gh"), `#!/usr/bin/env bash\n${SHIM_HEADER_LINE}\nexec gh "$@"\n`);
    const other = fakeGh(join(root, "check-stale-bin"), "echo real gh");

    const checks = checkShim({
      REPO_AEGIS_HOME: home,
      PATH: [join(home, "bin"), other].join(delimiter),
    });
    assert.equal(checks[0]?.code, "SHIM_STALE");
    assert.equal(checks[0]?.ok, false);
    assert.equal(checks[0]?.fix, "repo-aegis install shim");
    // And `install shim` is the fix: it rewrites the stale file and the check clears.
    run(() => captureOutput(() => installShim(undefined, {})));
    assert.equal(checkShim({ REPO_AEGIS_HOME: home, PATH: [join(home, "bin"), other].join(delimiter) })[0]?.ok, true);
  });

  it("ignores a non-executable gh earlier on PATH", () => {
    const { home, run } = makeHome("check-nonexec");
    run(() => captureOutput(() => installShim(undefined, {})));
    const dir = join(root, "check-nonexec-bin");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "gh"), "not executable\n");
    chmodSync(join(dir, "gh"), 0o644);

    const checks = checkShim({
      REPO_AEGIS_HOME: home,
      PATH: [dir, join(home, "bin")].join(delimiter),
    });
    assert.equal(checks[0]?.ok, true);
  });
});

describe("ghShimIsFirstOnPath", () => {
  // The predicate the agent hook acts on. It must agree with `checkShim`
  // on every case: `doctor` reporting a healthy shim while the guard
  // silently believed otherwise would be worse than no check at all.
  function both(env: NodeJS.ProcessEnv): { ok: boolean; predicate: boolean } {
    return { ok: checkShim(env)[0]?.ok === true, predicate: ghShimIsFirstOnPath(env) };
  }

  it("false when no shim is installed, whatever is on PATH", () => {
    const { home } = makeHome("pred-missing");
    const other = fakeGh(join(root, "pred-missing-bin"), "echo real gh");
    const r = both({ REPO_AEGIS_HOME: home, PATH: other });
    assert.deepEqual(r, { ok: false, predicate: false });
  });

  it("false when another gh precedes the shim, or when nothing on PATH reaches it", () => {
    const { home, run } = makeHome("pred-shadowed");
    run(() => captureOutput(() => installShim(undefined, {})));
    const other = fakeGh(join(root, "pred-shadowed-bin"), "echo real gh");
    assert.deepEqual(both({ REPO_AEGIS_HOME: home, PATH: [other, join(home, "bin")].join(delimiter) }), {
      ok: false,
      predicate: false,
    });
    assert.deepEqual(both({ REPO_AEGIS_HOME: home, PATH: other }), { ok: false, predicate: false });
    assert.equal(ghShimIsFirstOnPath({ REPO_AEGIS_HOME: home, PATH: "" }), false);
    assert.equal(ghShimIsFirstOnPath({ REPO_AEGIS_HOME: home }), false);
  });

  it("true when the shim is installed and first on PATH", () => {
    const { home, run } = makeHome("pred-first");
    run(() => captureOutput(() => installShim(undefined, {})));
    const other = fakeGh(join(root, "pred-first-bin"), "echo real gh");
    assert.deepEqual(both({ REPO_AEGIS_HOME: home, PATH: [join(home, "bin"), other].join(delimiter) }), {
      ok: true,
      predicate: true,
    });
  });

  it("true for a stale shim: it is reachable, which is the question asked here", () => {
    // `checkShim` reports SHIM_STALE and the predicate says true — the one
    // deliberate disagreement. A stale shim still runs and still refuses;
    // the fix for staleness is `install shim`, not a denied command.
    const { home, run } = makeHome("pred-stale");
    run(() => captureOutput(() => installShim(undefined, {})));
    writeFileSync(join(home, "bin", "gh"), `#!/usr/bin/env bash\n${SHIM_HEADER_LINE}\nexec gh "$@"\n`);
    const env = { REPO_AEGIS_HOME: home, PATH: join(home, "bin") };
    assert.equal(checkShim(env)[0]?.code, "SHIM_STALE");
    assert.equal(ghShimIsFirstOnPath(env), true);
  });
});
