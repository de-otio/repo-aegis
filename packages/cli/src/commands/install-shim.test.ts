// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { captureOutput, fakeGh, lastJsonLine, withEnv } from "../_test-utils.js";
import { checkShim, ghShimIsFirstOnPath, installShim as installShimReal, shimPathFor, type InstallShimOptions, type ShimResult } from "./install-shim.js";
import type { EnforcementPin } from "@de-otio/repo-aegis-core";
import { currentEnforcementPin } from "../enforcement-pin.js";
import { parseHomeFromScript, parseTaaadPinFromScript, renderShimScript, SHIM_HEADER_LINE } from "./shim-script.js";

let root: string;

/**
 * `installShim` with no taaad pinned unless a case says otherwise: the developer's machine may have a real
 * taaad on PATH, and the shim these cases compare against must not depend on it.
 */
function installShim(tool: string | undefined, opts: InstallShimOptions): ShimResult {
  return installShimReal(tool, { taaad: null, ...opts });
}

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

const PIN: EnforcementPin = { node: "/opt/node/bin/node", cli: "/opt/ra/dist/index.js" };
const SHIM_SCRIPT = renderShimScript(PIN, { home: "/opt/ra-home", taaad: null });

describe("the rendered shim script", () => {
  it("is a bash script carrying the generated-by header on its own line", () => {
    const lines = SHIM_SCRIPT.split("\n");
    assert.equal(lines[0], "#!/usr/bin/env bash");
    assert.equal(lines[1], SHIM_HEADER_LINE);
  });

  it("uses no bash-4 or GNU-only constructs", () => {
    // macOS ships bash 3.2 and that is where this shim spends most of its
    // life. `readlink -f` is GNU-only; `mapfile` and `declare -A` are bash 4+.
    for (const banned of ["readlink -f", "mapfile", "declare -A", "${var,,}"]) {
      assert.ok(!SHIM_SCRIPT.includes(banned), `shim must not use ${banned}`);
    }
  });

  it("never hard-codes a path to the real gh", () => {
    assert.ok(!/\/usr\/(local\/)?bin\/gh/.test(SHIM_SCRIPT));
  });

  it("T1: contains the pinned node and CLI paths and no command-position `repo-aegis`", () => {
    assert.ok(SHIM_SCRIPT.includes("/opt/node/bin/node"), "pinned node path missing");
    assert.ok(SHIM_SCRIPT.includes("/opt/ra/dist/index.js"), "pinned CLI path missing");
    const code = SHIM_SCRIPT.split("\n")
      .filter(l => !/^\s*#/.test(l))
      .join("\n");
    assert.ok(!/command -v repo-aegis/.test(code), "still resolves repo-aegis by name");
    assert.ok(
      !/(^|[;&|(!`]|\bthen\b|\bdo\b|\$\()\s*repo-aegis(\s|$)/m.test(code),
      "still calls repo-aegis by name",
    );
    // D1: the one call the shim makes goes through the pin, with the pinned home, and nothing follows it.
    assert.ok(code.includes('exec "$__ra_node" "$__ra_cli" gh --home "$__ra_home" -- "$@"'));
    assert.ok(code.includes("__ra_home='/opt/ra-home'"));
    assert.ok(!code.includes("egress-check"), "the shim no longer makes its own decision call");
    assert.ok(!code.includes("egress-readback"), "the read-back runs inside `repo-aegis gh`");
  });

  it("D1: execs the CLI for every verb but --version, help and completion; no shell code follows the exec", () => {
    const lines = SHIM_SCRIPT.split("\n");
    const execIdx = lines.findIndex(l => l.startsWith('exec "$__ra_node"'));
    assert.ok(execIdx > 0, "no exec of the pinned CLI");
    assert.deepEqual(
      lines.slice(execIdx + 1).filter(l => l.trim() !== "" && !l.trim().startsWith("#")),
      [],
      "code after the exec",
    );
    assert.ok(SHIM_SCRIPT.includes("--version|help|completion) exec"), "the skip list");
    // The old verb pre-filter is gone: a read group is no longer passed through by the shell.
    assert.ok(!SHIM_SCRIPT.includes("pr|issue|release"), "the bash verb pre-filter must be gone");
    // The token cannot be seen by shell code: the script never mentions one.
    assert.ok(!/GH_TOKEN|GITHUB_TOKEN/.test(SHIM_SCRIPT));
  });

  it("pins taaad (launcher, interpreter, package directory) and reads it back", () => {
    const taaad = { launcher: "/opt/pipx/venvs/taaad/bin/taaad", interpreter: "/usr/bin/python3", packageDir: "/opt/pipx/venvs/taaad" };
    const text = renderShimScript(PIN, { home: "/opt/ra-home", taaad });
    assert.deepEqual(parseTaaadPinFromScript(text), taaad);
    assert.equal(parseTaaadPinFromScript(SHIM_SCRIPT), null);
    assert.equal(parseHomeFromScript(text), "/opt/ra-home");
    assert.throws(() => renderShimScript(PIN, { home: "/opt/ra-home", taaad: { ...taaad, packageDir: "/opt/a\nb" } }), /newline|NUL/i);
  });

  it("T12: a pin path with a newline or NUL is refused at render time", () => {
    assert.throws(() => renderShimScript({ ...PIN, cli: "/opt/a\nb/index.js" }, { home: "/opt/ra-home" }), /newline|NUL/i);
    assert.throws(() => renderShimScript({ ...PIN, node: "/opt/a\0b/node" }, { home: "/opt/ra-home" }), /newline|NUL/i);
  });
});

describe("the shim with a pinned binary that is gone (T7: fails closed on publishing verbs)", () => {
  /** Installs a shim pinned to a CLI path that does not exist, with a fake `gh` after it on PATH. */
  function setup(name: string): { shim: string; env: NodeJS.ProcessEnv; ghLog: string; missing: string } {
    const { home, run } = makeHome(name);
    const missing = join(root, name, "no-such-dist", "index.js");
    run(() => captureOutput(() => installShim(undefined, { pin: { node: process.execPath, cli: missing } })));
    const ghLog = join(root, name, "gh-ran.log");
    const ghDir = fakeGh(join(root, name, "real-gh"), `echo "gh argv: $*"; echo ran >> "${ghLog}"`);
    return {
      shim: join(home, "bin", "gh"),
      missing,
      ghLog,
      env: { ...process.env, REPO_AEGIS_HOME: home, PATH: [join(home, "bin"), ghDir, process.env["PATH"] ?? ""].join(delimiter) },
    };
  }

  it("refuses `gh pr create` with exit 2, naming the missing path and the installer; the real gh never runs", () => {
    const { shim, env, ghLog, missing } = setup("t7-refuse");
    const r = spawnSync("bash", [shim, "pr", "create", "--title", "t"], { env, encoding: "utf8" });
    assert.equal(r.status, 2, `stdout=${r.stdout} stderr=${r.stderr}`);
    assert.ok(r.stderr.includes(missing), r.stderr);
    assert.ok(r.stderr.includes("repo-aegis install shim"), r.stderr);
    assert.equal(existsSync(ghLog), false, "the real gh ran despite the refusal");
  });

  it("still passes a non-publishing verb through untouched (`gh --version`)", () => {
    const { shim, env, ghLog } = setup("t7-passthrough");
    const r = spawnSync("bash", [shim, "--version"], { env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "gh argv: --version\n");
    assert.ok(existsSync(ghLog));
  });

  it("T18: every verb but --version, help and completion reaches the pinned CLI, not the real gh (no bash pre-filter)", () => {
    const { home, run } = makeHome("t18");
    const cli = join(root, "t18", "stub-cli.cjs");
    mkdirSync(join(root, "t18"), { recursive: true });
    writeFileSync(cli, `process.stdout.write("pinned-cli-ran:" + process.argv.slice(2).join(" ") + "\\n");\n`);
    run(() => captureOutput(() => installShim(undefined, { pin: { node: process.execPath, cli } })));
    const ghDir = fakeGh(join(root, "t18", "real-gh"), 'echo "real gh: $*"');
    const env = { ...process.env, REPO_AEGIS_HOME: home, PATH: [join(home, "bin"), ghDir, process.env["PATH"] ?? ""].join(delimiter) };
    const shim = join(home, "bin", "gh");
    for (const args of [["project", "item-add", "1", "--owner", "o"], ["ssh-key", "add", "k.pub"], ["auth", "token"], ["pr", "view", "1"], ["-R", "o/r", "issue", "list"]]) {
      const r = spawnSync("bash", [shim, ...args], { env, encoding: "utf8" });
      assert.equal(r.stdout, `pinned-cli-ran:gh --home ${home} -- ${args.join(" ")}\n`, args.join(" "));
    }
    for (const args of [["--version"], ["help", "pr"], ["completion", "-s", "zsh"]]) {
      const r = spawnSync("bash", [shim, ...args], { env, encoding: "utf8" });
      assert.equal(r.stdout, `real gh: ${args.join(" ")}\n`, args.join(" "));
    }
  });

  it("refuses when the pinned node is gone, too", () => {
    const { home, run } = makeHome("t7-node");
    const missingNode = join(root, "t7-node", "no-such-node");
    run(() => captureOutput(() => installShim(undefined, { pin: { node: missingNode, cli: process.execPath } })));
    const ghDir = fakeGh(join(root, "t7-node", "real-gh"), "echo ran");
    const env = { ...process.env, REPO_AEGIS_HOME: home, PATH: [join(home, "bin"), ghDir, process.env["PATH"] ?? ""].join(delimiter) };
    const r = spawnSync("bash", [join(home, "bin", "gh"), "release", "create", "v1"], { env, encoding: "utf8" });
    assert.equal(r.status, 2, r.stderr);
    assert.ok(r.stderr.includes(missingNode), r.stderr);
  });
});

describe("install shim", () => {
  it("writes an executable shim with the header and prints the PATH instruction", () => {
    const { home, run } = makeHome("install");
    const out = run(() => captureOutput(() => installShim(undefined, {})));
    const path = join(home, "bin", "gh");

    assert.equal(out.exitCode, undefined);
    assert.ok(existsSync(path));
    assert.equal(readFileSync(path, "utf8"), renderShimScript(currentEnforcementPin(), { home, taaad: null }));
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
    assert.equal(readFileSync(path, "utf8"), renderShimScript(currentEnforcementPin(), { home, taaad: null }));
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
    assert.equal(readFileSync(path, "utf8"), renderShimScript(currentEnforcementPin(), { home, taaad: null }));
  });

  it("refuses any tool but gh with USAGE", () => {
    const { run } = makeHome("usage");
    const out = run(() => captureOutput(() => installShim("git", { json: true })));
    assert.equal(out.exitCode, 2);
    assert.equal(lastJsonLine<{ code: string }>(out.stderr).code, "USAGE");
  });

  it("T12: refuses a pin path with a newline (PIN_PATH_UNSUPPORTED) and writes nothing", () => {
    const { home, run } = makeHome("pin-newline");
    const out = run(() =>
      captureOutput(() => installShim(undefined, { json: true, pin: { node: "/opt/node/bin/node", cli: "/opt/a\nb/index.js" } })),
    );
    assert.equal(out.exitCode, 2);
    assert.equal(lastJsonLine<{ code: string }>(out.stderr).code, "PIN_PATH_UNSUPPORTED");
    assert.equal(existsSync(join(home, "bin", "gh")), false);
  });

  it("T12: a pin path with spaces and quotes is written and read back by the shell as given", () => {
    const { home, run } = makeHome("pin-quotes");
    const odd = join(root, "pin-quotes", `it's "odd" dir`);
    mkdirSync(odd, { recursive: true });
    const cli = join(odd, "stub cli.cjs");
    writeFileSync(cli, `process.stdout.write("pinned-cli-ran:" + process.argv.slice(2).join(" "));\n`);
    run(() => captureOutput(() => installShim(undefined, { pin: { node: process.execPath, cli } })));
    // D1: every call but the skip list goes to the pinned CLI, which the stub stands in for. It prints what it was
    // asked; the real gh is never reached by the shell.
    const ghDir = fakeGh(join(root, "pin-quotes", "real-gh"), 'echo "gh argv: $*"');
    const env = { ...process.env, REPO_AEGIS_HOME: home, PATH: [join(home, "bin"), ghDir, process.env["PATH"] ?? ""].join(delimiter) };
    const r = spawnSync("bash", [join(home, "bin", "gh"), "pr", "list"], { env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `pinned-cli-ran:gh --home ${home} -- pr list`);
    assert.equal(r.stderr, "", "the pinned stub CLI at a quoted path must have run without a pin error");
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
      taaad: { pinned: false },
    });
  });

  it("pins the taaad it is given and reports that a user-owned one is not root-only-writable (D4)", () => {
    const { home, run } = makeHome("taaad");
    const pkg = join(root, "taaad", "venv");
    mkdirSync(join(pkg, "bin"), { recursive: true });
    const launcher = join(pkg, "bin", "taaad");
    writeFileSync(launcher, "#!/bin/sh\n", { mode: 0o755 });
    const taaad = { launcher, interpreter: "/bin/sh", packageDir: pkg };
    const out = run(() => captureOutput(() => installShim(undefined, { json: true, taaad })));
    const payload = JSON.parse(out.stdout) as { taaad: { pinned: boolean; rootOwned: boolean; problem?: string; launcher: string } };
    assert.equal(payload.taaad.pinned, true);
    assert.equal(payload.taaad.launcher, launcher);
    // The test's own user owns it: never root-owned.
    assert.equal(payload.taaad.rootOwned, false);
    assert.ok(payload.taaad.problem !== undefined && payload.taaad.problem.includes("not owned by root"));
    const text = readFileSync(join(home, "bin", "gh"), "utf8");
    assert.deepEqual(parseTaaadPinFromScript(text), taaad);
    const plain = run(() => captureOutput(() => installShim(undefined, { taaad })));
    assert.ok(plain.stdout.includes("TAAAD_AGENT_WRITABLE"), plain.stdout);
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

  it("SHIM_STALE when the shim was rendered for a different pin (D3)", () => {
    const { home, run } = makeHome("check-other-pin");
    run(() => captureOutput(() => installShim(undefined, { pin: { node: "/opt/old-node/bin/node", cli: currentEnforcementPin().cli } })));
    const other = fakeGh(join(root, "check-other-pin-bin"), "echo real gh");
    const env = { REPO_AEGIS_HOME: home, PATH: [join(home, "bin"), other].join(delimiter) };
    assert.equal(checkShim(env)[0]?.code, "SHIM_STALE");
    // Re-pinning to the current install clears it.
    run(() => captureOutput(() => installShim(undefined, {})));
    assert.equal(checkShim(env)[0]?.ok, true);
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
