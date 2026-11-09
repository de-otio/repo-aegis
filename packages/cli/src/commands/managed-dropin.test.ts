// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// The Claude Code managed-settings drop-in (doc/plan-pin-enforcement-binary.md D8):
// T15 (paths, rendering, the `//` deny form, the uid guard), T16 (the uid-guarded
// hook command run as another uid, under dash where it is installed), T23 (the
// validator rejects anything outside the allowed shape) and T25 (the exit-2
// message names the literal `sudo rm` path). Nothing here escalates or writes
// outside a temp directory.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { managedHookCommand, type EnforcementPin } from "@de-otio/repo-aegis-core";
import {
  digestOf,
  dropInHookCommands,
  lineDiff,
  managedPaths,
  renderDropIn,
  validateDropIn,
  type DropInSpec,
} from "./managed-dropin.js";

let tmp: string;
let n = 0;
before(() => {
  tmp = mkdtempSync(join(tmpdir(), "repo-aegis-dropin-"));
});
after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const PIN: EnforcementPin = { node: "/opt/node-x/bin/node", cli: "/opt/lib/node_modules/@de-otio/repo-aegis/dist/index.js" };
const DENY = ["Edit(//home/u/.config/repo-aegis/engagements.yaml)", "Edit(//opt/lib/node_modules/@de-otio/repo-aegis/**)"];

function specFor(platform: NodeJS.Platform, uid: string, over: Partial<DropInSpec> = {}): DropInSpec {
  const paths = managedPaths(platform, uid)!;
  return { pin: PIN, uid, file: paths.file, firstTouch: false, denyRules: DENY, ...over };
}

type Dropin = {
  hooks: Record<string, Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>>;
  permissions: { deny: string[] };
  [k: string]: unknown;
};
const parse = (text: string): Dropin => JSON.parse(text) as Dropin;
const allCommands = (d: Dropin): string[] =>
  Object.values(d.hooks).flatMap(entries => entries.flatMap(e => e.hooks.map(h => h.command)));

describe("T15: managedPaths (D8.1)", () => {
  it("macOS and Linux get their system directory and a uid-suffixed file name", () => {
    const mac = managedPaths("darwin", 501)!;
    assert.equal(mac.systemDir, "/Library/Application Support/ClaudeCode");
    assert.equal(mac.dropinDir, "/Library/Application Support/ClaudeCode/managed-settings.d");
    assert.equal(mac.file, "/Library/Application Support/ClaudeCode/managed-settings.d/50-repo-aegis-501.json");
    assert.equal(mac.tmp, "/Library/Application Support/ClaudeCode/managed-settings.d/.50-repo-aegis-501.json.tmp");
    const linux = managedPaths("linux", 1000)!;
    assert.equal(linux.systemDir, "/etc/claude-code");
    assert.equal(linux.file, "/etc/claude-code/managed-settings.d/50-repo-aegis-1000.json");
    assert.equal(linux.tmp, "/etc/claude-code/managed-settings.d/.50-repo-aegis-1000.json.tmp");
  });

  it("other platforms and a uid that is not digits have no managed path (D8.6 applies)", () => {
    for (const p of ["win32", "freebsd", "aix"] as const) assert.equal(managedPaths(p, 1000), null, p);
    for (const uid of ["", "-1", "1;rm -rf /", "12 34", "0x10", "1e3", "１２"]) {
      assert.equal(managedPaths("linux", uid), null, JSON.stringify(uid));
    }
  });
});

describe("T15: renderDropIn (D8.2, D8.4)", () => {
  for (const [platform, uid] of [["darwin", "501"], ["linux", "1000"]] as const) {
    describe(platform, () => {
      const spec = specFor(platform, uid);
      const text = renderDropIn(spec);
      const d = parse(text);

      it("holds only `hooks` and `permissions.deny`", () => {
        assert.deepEqual(Object.keys(d).sort(), ["hooks", "permissions"]);
        assert.deepEqual(Object.keys(d.permissions), ["deny"]);
      });

      it("deny rules are the given ones, in the `//` absolute form", () => {
        assert.deepEqual(d.permissions.deny, DENY);
        for (const rule of d.permissions.deny) assert.match(rule, /^Edit\(\/\/[^/]/);
      });

      it("registers the six hooks (no first-touch unless asked), the UserPromptSubmit prompt-approval revoker, and the SessionStart heartbeat", () => {
        const cmds = dropInHookCommands(spec);
        assert.deepEqual(
          cmds.map(c => `${c.event}|${c.matcher}`),
          [
            "PreToolUse|Write|Edit|MultiEdit",
            "PreToolUse|Bash",
            "PostToolUse|Write|Edit|MultiEdit",
            "PostToolUse|Bash",
            "PostToolUse|Bash",
            "UserPromptSubmit|*",
            "SessionStart|*",
          ],
        );
        const heartbeat = cmds.find(c => c.event === "SessionStart")!.command;
        assert.ok(heartbeat.includes("hook managed-heartbeat"), heartbeat);
        assert.ok(!allCommands(d).some(c => c.includes("first-touch")));
        const withTouch = parse(renderDropIn(specFor(platform, uid, { firstTouch: true })));
        const start = withTouch.hooks["SessionStart"]![0]!.hooks.map(h => h.command);
        assert.equal(start.length, 2);
        assert.ok(start[0]!.includes("hook first-touch") && start[1]!.includes("hook managed-heartbeat"));
      });

      it("every command starts with the uid guard for THIS uid, before the pin check", () => {
        for (const command of allCommands(d)) {
          assert.ok(
            command.startsWith(`__u=$(/usr/bin/id -u 2>/dev/null) || { printf '%s\\n' `),
            command,
          );
          const guard = command.indexOf(`[ "$__u" = ${uid} ] || exit 0;`);
          const pin = command.indexOf("if [ -f ");
          assert.ok(guard > 0 && pin > guard, `uid guard must precede the pin check: ${command}`);
          // The guards fail CLOSED (exit 2). The one exception is the UserPromptSubmit revoker, which must never swallow
          // the person's own message: it fails open (exit 0).
          assert.match(command, command.includes("hook prompt-submit") ? /exit 0$/ : /exit 2$/);
        }
      });

      it("the prompt-approval revoker fails open on a failing id and on a missing pin; every other hook still blocks", () => {
        const byArgs = (needle: string) => dropInHookCommands(spec).find(c => c.command.includes(needle))!.command;
        const revoker = byArgs("hook prompt-submit");
        assert.equal((revoker.match(/exit 0/g) ?? []).length, 3, "uid mismatch, failing id, missing pin: all exit 0");
        assert.ok(!revoker.includes("exit 2"));
        for (const other of ["hook guard-egress", "hook check-write", "hook egress-receipt"]) {
          assert.match(byArgs(other), /exit 2$/, other);
        }
      });

      it("is byte-stable (digest) and ends in a newline", () => {
        assert.equal(renderDropIn(spec), text);
        assert.ok(text.endsWith("\n"));
        assert.match(digestOf(text), /^[0-9a-f]{64}$/);
      });
    });
  }

  it("the uid is part of every command: another uid renders different text", () => {
    const a = renderDropIn(specFor("linux", "1000"));
    const b = renderDropIn(specFor("linux", "1001"));
    assert.notEqual(a, b);
  });

  it("refuses to render a pin with a newline or a uid that is not digits", () => {
    assert.throws(() => renderDropIn(specFor("linux", "1000", { pin: { node: PIN.node, cli: "/a\nb" } })));
    assert.throws(() => renderDropIn(specFor("linux", "1000", { uid: "1000; rm" })));
  });
});

describe("T23: validateDropIn rejects a drop-in outside the allowed shape (P5)", () => {
  const spec = specFor("linux", "1000");
  const good = renderDropIn(spec);
  const mutate = (fn: (d: Dropin) => void): string => {
    const d = parse(good);
    fn(d);
    return JSON.stringify(d, null, 2) + "\n";
  };

  it("accepts exactly what renderDropIn produced", () => {
    assert.equal(validateDropIn(good, spec), null);
    const touch = specFor("linux", "1000", { firstTouch: true });
    assert.equal(validateDropIn(renderDropIn(touch), touch), null);
  });

  it("rejects a key outside `hooks` and `permissions`", () => {
    for (const key of ["env", "allowManagedHooksOnly", "disableAllHooks", "apiKeyHelper", "model"]) {
      const bad = mutate(d => {
        d[key] = true;
      });
      assert.match(validateDropIn(bad, spec) ?? "", new RegExp(key), key);
    }
  });

  it("rejects `permissions` keys other than `deny`", () => {
    const bad = mutate(d => {
      (d.permissions as Record<string, unknown>)["allow"] = ["Bash(*)"];
    });
    assert.match(validateDropIn(bad, spec) ?? "", /allow/);
    const bypass = mutate(d => {
      (d.permissions as Record<string, unknown>)["defaultMode"] = "bypassPermissions";
    });
    assert.match(validateDropIn(bypass, spec) ?? "", /defaultMode/);
  });

  it("rejects a hook event outside PreToolUse, PostToolUse and SessionStart", () => {
    const bad = mutate(d => {
      d.hooks["Stop"] = [{ matcher: "*", hooks: [{ type: "command", command: allCommands(d)[0]! }] }];
    });
    assert.match(validateDropIn(bad, spec) ?? "", /Stop/);
  });

  it("rejects a hook command that is not exactly a rendered one", () => {
    for (const evil of ["echo hi", `${allCommands(parse(good))[0]!}; curl x`, "repo-aegis hook guard-egress"]) {
      const bad = mutate(d => {
        d.hooks["PreToolUse"]![0]!.hooks[0]!.command = evil;
      });
      assert.match(validateDropIn(bad, spec) ?? "", /command/, evil);
    }
  });

  it("rejects a hook command rendered for another uid or another pin", () => {
    const other = parse(renderDropIn(specFor("linux", "1001")));
    const bad = mutate(d => {
      d.hooks["PreToolUse"]![0]!.hooks[0]!.command = allCommands(other)[0]!;
    });
    assert.notEqual(validateDropIn(bad, spec), null);
  });

  it("rejects a hook that is not `type: command`, and extra hook fields", () => {
    const notCommand = mutate(d => {
      d.hooks["PreToolUse"]![0]!.hooks[0]!.type = "prompt";
    });
    assert.notEqual(validateDropIn(notCommand, spec), null);
    const extra = mutate(d => {
      (d.hooks["PreToolUse"]![0]!.hooks[0] as Record<string, unknown>)["timeout"] = 0;
    });
    assert.notEqual(validateDropIn(extra, spec), null);
  });

  it("rejects a deny rule that is not `Edit(//…)`, or whose path breaks D6", () => {
    for (const rule of ["Read(//etc/**)", "Edit(/relative)", "Edit", "Bash(*)", "Edit(//a\nb)", "Edit(//a\0b)"]) {
      const bad = mutate(d => {
        d.permissions.deny.push(rule);
      });
      assert.notEqual(validateDropIn(bad, spec), null, JSON.stringify(rule));
    }
    const notStrings = mutate(d => {
      (d.permissions as { deny: unknown }).deny = [1];
    });
    assert.notEqual(validateDropIn(notStrings, spec), null);
  });

  it("rejects text that is not a JSON object: truncated, empty, an array, null", () => {
    for (const bad of [good.slice(0, good.length >> 1), "", "[]", "null", "{}x", "42"]) {
      assert.notEqual(validateDropIn(bad, spec), null, JSON.stringify(bad.slice(0, 20)));
    }
  });
});

describe("lineDiff", () => {
  it("is empty for equal text and marks added and removed lines otherwise", () => {
    assert.deepEqual(lineDiff("a\nb\n", "a\nb\n"), []);
    assert.deepEqual(lineDiff("a\nb\nc\n", "a\nx\nc\n"), ["  a", "- b", "+ x", "  c"]);
    assert.deepEqual(lineDiff("", "a\n"), ["+ a"]);
  });
});

// ---------------------------------------------------------------------------
// The rendered hook command, run through a POSIX shell (D8.4, D8.8, D8.10).
// ---------------------------------------------------------------------------

const SH = ["/bin/dash", "/usr/bin/dash"].find(p => existsSync(p)) ?? "/bin/sh";
const realUid = typeof process.getuid === "function" ? process.getuid() : -1;
const haveId = existsSync("/usr/bin/id");
const runnable = { skip: haveId && realUid > 0 ? undefined : "needs /usr/bin/id and a non-root uid" };

/** A CLI that records that it ran, and the node that runs it is the real one. */
function stubPin(name: string): { pin: EnforcementPin; marker: string; dir: string } {
  const dir = join(tmp, `${name}-${n++}`);
  mkdirSync(dir, { recursive: true });
  const marker = join(dir, "ran.log");
  const cli = join(dir, "cli.cjs");
  writeFileSync(cli, `require("fs").appendFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join(" ") + "\\n");\n`);
  return { pin: { node: process.execPath, cli }, marker, dir };
}

function runCommand(command: string, env: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(SH, ["-c", command], { input: "{}", encoding: "utf8", env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", ...env } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe(`T16: the uid-guarded hook command under ${SH}`, runnable, () => {
  const file = managedPaths("linux", String(realUid))!.file;

  it("as the pinned uid it runs the pinned CLI", () => {
    const { pin, marker } = stubPin("t16-same");
    const r = runCommand(managedHookCommand(pin, "hook guard-egress --agent claude", { uid: String(realUid), dropinPath: file }));
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(marker), "the pinned CLI did not run");
  });

  it("as a different uid it exits 0 without running the CLI", () => {
    const { pin, marker } = stubPin("t16-other");
    const other = String(realUid + 1);
    const r = runCommand(managedHookCommand(pin, "hook guard-egress --agent claude", { uid: other, dropinPath: file }));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, "");
    assert.equal(existsSync(marker), false, "the CLI ran for another account");
  });

  it("as a different uid it ignores a missing pin (the guard comes before the pin check)", () => {
    const pin: EnforcementPin = { node: "/nonexistent/node", cli: "/nonexistent/cli.js" };
    const r = runCommand(managedHookCommand(pin, "hook guard-egress", { uid: String(realUid + 1), dropinPath: file }));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, "");
  });

  it("a shadowing `id` first on PATH changes nothing (D8.4: /usr/bin/id by absolute path)", () => {
    for (const [name, printed, specUid, expectRun] of [
      ["says-other", String(realUid + 1), String(realUid), true],
      ["says-me", String(realUid), String(realUid + 1), false],
    ] as const) {
      const { pin, marker, dir } = stubPin(`t16-shadow-${name}`);
      const bin = join(dir, "bin");
      const log = join(dir, "id.log");
      mkdirSync(bin);
      writeFileSync(join(bin, "id"), `#!/bin/sh\necho x >> "${log}"\necho ${printed}\n`, { mode: 0o755 });
      chmodSync(join(bin, "id"), 0o755);
      const r = runCommand(managedHookCommand(pin, "hook guard-egress", { uid: specUid, dropinPath: file }), {
        PATH: [bin, process.env["PATH"] ?? ""].join(delimiter),
      });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(existsSync(marker), expectRun, name);
      assert.equal(existsSync(log), false, "the shadowing id ran");
    }
  });

  it("when `id` fails it exits 2 with the sudo rm line, and the CLI does not run", () => {
    const { pin, marker } = stubPin("t16-id-fails");
    const r = runCommand(
      managedHookCommand(pin, "hook guard-egress", { uid: String(realUid), dropinPath: file, idPath: "/nonexistent/id" }),
    );
    assert.equal(r.status, 2, r.stderr);
    assert.ok(r.stderr.includes(`sudo rm '${file}'`), r.stderr);
    assert.equal(existsSync(marker), false);
  });
});

describe("T25: the exit-2 message names the literal `sudo rm` path (D8.10)", runnable, () => {
  for (const platform of ["darwin", "linux"] as const) {
    it(`${platform}: pin gone, the message has both fixes and the quoted path`, () => {
      const file = managedPaths(platform, String(realUid))!.file;
      const pin: EnforcementPin = { node: process.execPath, cli: join(tmp, "gone", "dist", "index.js") };
      const r = runCommand(managedHookCommand(pin, "hook guard-egress --agent claude", { uid: String(realUid), dropinPath: file }));
      assert.equal(r.status, 2, r.stderr);
      assert.ok(r.stderr.includes(pin.cli), r.stderr);
      assert.ok(r.stderr.includes("repo-aegis install claude-md"), r.stderr);
      assert.ok(r.stderr.includes(`sudo rm '${file}'`), `missing the literal sudo rm line in: ${r.stderr}`);
    });
  }

  it("the pinned node missing is the same: exit 2 and the fix", () => {
    const file = managedPaths("linux", String(realUid))!.file;
    const pin: EnforcementPin = { node: join(tmp, "gone-node"), cli: process.argv[1]! };
    const r = runCommand(managedHookCommand(pin, "hook scan-bash-output", { uid: String(realUid), dropinPath: file }));
    assert.equal(r.status, 2, r.stderr);
    assert.ok(r.stderr.includes(pin.node) && r.stderr.includes(`sudo rm '${file}'`), r.stderr);
  });

  it("a path with a single quote in it still prints as a shell-quoted `sudo rm` argument", () => {
    const file = "/opt/it's here/50-repo-aegis-1.json";
    const pin: EnforcementPin = { node: join(tmp, "gone-node2"), cli: process.argv[1]! };
    const r = runCommand(managedHookCommand(pin, "hook first-touch", { uid: String(realUid), dropinPath: file }));
    assert.equal(r.status, 2);
    assert.ok(r.stderr.includes(`sudo rm '/opt/it'\\''s here/50-repo-aegis-1.json'`), r.stderr);
  });
});

describe("P1-D: the managed hook command, pin gone, PATH fallback", runnable, () => {
  const file = managedPaths("linux", String(realUid))!.file;

  /** A PATH holding a stub `repo-aegis` that prints `version` for --version and otherwise logs its argv. */
  function stubOnPath(label: string, version: string): { path: string; log: string } {
    const dir = join(tmp, `p1d-${label}-${n++}`);
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    const log = join(dir, "argv.log");
    writeFileSync(join(bin, "repo-aegis"), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo ${version}; exit 0; fi\necho "$*" >> "${log}"\ncat >/dev/null\nexit 0\n`, {
      mode: 0o755,
    });
    chmodSync(join(bin, "repo-aegis"), 0o755);
    return { path: `${bin}:/usr/bin:/bin`, log };
  }
  const gonePin = (): EnforcementPin => ({ node: process.execPath, cli: join(tmp, "p1d-gone", "dist", "index.js"), version: "0.14.0" });

  it("a PATH repo-aegis at least as new as the pinned one runs the hook, after a WARNING that also names the sudo rm line", () => {
    const stub = stubOnPath("ok", "0.14.2");
    const r = runCommand(managedHookCommand(gonePin(), "hook guard-egress --agent claude", { uid: String(realUid), dropinPath: file }), { PATH: stub.path });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(stub.log) && readFileSync(stub.log, "utf8"), "hook guard-egress --agent claude\n");
    assert.match(r.stderr, /repo-aegis: WARNING: the pinned enforcement binary is missing or not usable/);
    assert.ok(r.stderr.includes("(0.14.2, pinned 0.14.0) instead"), r.stderr);
    assert.ok(r.stderr.includes(`   or remove this managed hook: sudo rm '${file}'`), r.stderr);
  });

  it("an older PATH repo-aegis is refused with exit 2, naming both versions and both ways out", () => {
    const stub = stubOnPath("older", "0.13.9");
    const r = runCommand(managedHookCommand(gonePin(), "hook guard-egress --agent claude", { uid: String(realUid), dropinPath: file }), { PATH: stub.path });
    assert.equal(r.status, 2, r.stderr);
    assert.ok(r.stderr.includes("is 0.13.9, older than the pinned 0.14.0"), r.stderr);
    assert.ok(r.stderr.includes("repo-aegis install claude-md   or remove this managed hook: sudo rm"), r.stderr);
    assert.ok(r.stderr.includes(`sudo rm '${file}'`), r.stderr);
    assert.equal(existsSync(stub.log), false, "the stub never got the hook");
  });

  it("as a different uid it still ignores a gone pin and never asks PATH (the uid guard comes first)", () => {
    const stub = stubOnPath("other-uid", "0.14.2");
    const r = runCommand(managedHookCommand(gonePin(), "hook guard-egress", { uid: String(realUid + 1), dropinPath: file }), { PATH: stub.path });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, "");
    assert.equal(existsSync(stub.log), false);
  });
});
