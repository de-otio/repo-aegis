// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// The privileged step of the managed drop-in (doc/plan-pin-enforcement-binary.md
// D8.3, P1 to P4, P6): T20 (a `sudo` that is not root-owned, or is writable by
// others, is refused), T21 (the argv handed to root is fixed, no shell, nothing
// variable beyond the uid), T22 (a group-writable or symlinked directory is
// refused), plus the tee-failure, environment and read-back cases. The privileged
// runner is a simulator over a temp directory: no test runs `sudo`.
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { makeDir, makeFakeSystem, putFile, toolPaths, type FakeSystem } from "../_managed-test-utils.js";
import { managedPaths, digestOf } from "./managed-dropin.js";
import {
  sudoEnvironment,
  verifyDirectoryChain,
  verifyPrivilegedTools,
  writeDropIn,
} from "./managed-privileged.js";

const systems: FakeSystem[] = [];
afterEach(() => {
  for (const s of systems.splice(0)) rmSync(s.root, { recursive: true, force: true });
});
function fake(platform: NodeJS.Platform, uid = 501, over: Parameters<typeof makeFakeSystem>[0] extends infer O ? Partial<O> : never = {}): FakeSystem {
  const s = makeFakeSystem({ platform, uid, ...over });
  systems.push(s);
  return s;
}

const TEXT = '{\n  "hooks": {}\n}\n';

describe("T20: P1 refuses a sudo or tool that root does not own (verifyPrivilegedTools)", () => {
  it("a stock layout passes, on both platforms", () => {
    for (const platform of ["darwin", "linux"] as const) {
      assert.deepEqual(verifyPrivilegedTools(fake(platform).env), [], platform);
    }
  });

  it("sudo owned by the user is refused", () => {
    const s = fake("linux", 1000);
    s.owners.set("/usr/bin/sudo", { uid: 1000, gid: 1000 });
    const problems = verifyPrivilegedTools(s.env);
    assert.equal(problems.length, 1);
    assert.equal(problems[0]!.tool, "sudo");
    assert.match(problems[0]!.reason, /owned by uid 1000|not owned by root/);
  });

  it("sudo writable by group or others is refused (4775, 4757)", () => {
    for (const mode of [0o4775, 0o4757, 0o4777]) {
      const s = fake("linux");
      chmodSync(s.at("/usr/bin/sudo"), mode);
      const problems = verifyPrivilegedTools(s.env);
      assert.equal(problems[0]?.tool, "sudo", mode.toString(8));
      assert.match(problems[0]!.reason, /writable by group or others/);
    }
  });

  it("a sudo without its setuid bit is refused", () => {
    const s = fake("darwin");
    s.setuid.set("/usr/bin/sudo", false);
    const problems = verifyPrivilegedTools(s.env);
    assert.equal(problems.length, 1);
    assert.match(problems[0]!.reason, /setuid/);
  });

  it("every other tool is held to the same rule: owned by root, not writable by others", () => {
    for (const virtual of toolPaths("linux").filter(p => p !== "/usr/bin/sudo")) {
      const owned = fake("linux");
      owned.owners.set(virtual, { uid: 501, gid: 20 });
      assert.equal(verifyPrivilegedTools(owned.env).length, 1, `owner of ${virtual}`);
      const writable = fake("linux");
      chmodSync(writable.at(virtual), 0o757);
      assert.equal(verifyPrivilegedTools(writable.env).length, 1, `mode of ${virtual}`);
    }
  });

  it("a tool that is a symlink is followed with realpath: /bin -> usr/bin passes, a link to a user file does not", () => {
    // Debian and Ubuntu: /bin is a symlink to /usr/bin.
    const merged = fake("linux", 1000, { omitTools: ["/bin/chmod", "/bin/chown", "/bin/mv", "/bin/rm", "/bin/rmdir"] });
    rmSync(merged.at("/bin"), { recursive: true });
    symlinkSync("usr/bin", merged.at("/bin"));
    for (const name of ["chmod", "chown", "mv", "rm", "rmdir"]) writeFileSync(merged.at(`/usr/bin/${name}`), "#!/bin/sh\n", { mode: 0o755 });
    assert.deepEqual(verifyPrivilegedTools(merged.env), []);

    const evil = fake("linux", 1000);
    writeFileSync(evil.at("/usr/bin/mv-evil"), "#!/bin/sh\n", { mode: 0o755 });
    rmSync(evil.at("/bin/mv"));
    symlinkSync("../usr/bin/mv-evil", evil.at("/bin/mv"));
    evil.owners.set("/usr/bin/mv-evil", { uid: 1000, gid: 1000 });
    const problems = verifyPrivilegedTools(evil.env);
    assert.equal(problems.length, 1);
    assert.equal(problems[0]!.tool, "mv");
  });

  it("a tool that is a directory, not a regular file, is refused", () => {
    const s = fake("linux");
    rmSync(s.at("/bin/rm"));
    mkdirSync(s.at("/bin/rm"));
    assert.equal(verifyPrivilegedTools(s.env)[0]?.tool, "rm");
  });

  it("a missing /usr/bin/id is reported as missing, not as unsafe", () => {
    const s = fake("linux", 1000, { omitTools: ["/usr/bin/id"] });
    const problems = verifyPrivilegedTools(s.env);
    assert.equal(problems.length, 1);
    assert.equal(problems[0]!.tool, "id");
    assert.equal(problems[0]!.missing, true);
  });

  it("writeDropIn with an unsafe sudo spawns nothing at all", () => {
    const s = fake("linux", 1000);
    s.owners.set("/usr/bin/sudo", { uid: 1000, gid: 1000 });
    const r = writeDropIn(s.env, managedPaths("linux", 1000)!, TEXT);
    assert.equal(r.ok, false);
    assert.equal(s.calls.length, 0, "a sudo that root does not own must never be run");
  });
});

describe("T21: P2 the argv handed to root is fixed", () => {
  const cases = [
    { platform: "darwin", uid: 501, chown: "/usr/sbin/chown" },
    { platform: "linux", uid: 1000, chown: "/bin/chown" },
  ] as const;

  for (const { platform, uid, chown } of cases) {
    it(`${platform}: a fresh install runs exactly these calls and no others`, () => {
      const s = fake(platform, uid);
      const paths = managedPaths(platform, uid)!;
      const r = writeDropIn(s.env, paths, TEXT);
      assert.deepEqual(r, { ok: true, created: { system: true, dropin: true } });
      assert.deepEqual(
        s.calls.map(c => [c.file, ...c.args]),
        [
          ["/usr/bin/sudo", "-k"],
          ["/usr/bin/sudo", "/usr/bin/install", "-d", "-m", "0755", paths.systemDir],
          ["/usr/bin/sudo", "/usr/bin/install", "-d", "-m", "0755", paths.dropinDir],
          ["/usr/bin/sudo", "/usr/bin/tee", paths.tmp],
          ["/usr/bin/sudo", chown, "0:0", paths.tmp],
          ["/usr/bin/sudo", "/bin/chmod", "0644", paths.tmp],
          ["/usr/bin/sudo", "/bin/mv", "-f", paths.tmp, paths.file],
          ["/usr/bin/sudo", "-k"],
        ],
      );
      // The only variable parts are the directory constants and the uid in the file name.
      for (const c of s.calls) for (const a of c.args) assert.doesNotMatch(a, /[;&|`$<>\n\\'"*?]/, a);
      assert.ok(paths.file.endsWith(`50-repo-aegis-${uid}.json`));
    });
  }

  it("never uses a shell, and only `tee` gets stdin", () => {
    const s = fake("linux", 1000);
    writeDropIn(s.env, managedPaths("linux", 1000)!, TEXT);
    for (const c of s.calls) {
      assert.equal(c.options.shell, false);
      const isTee = c.args[0] === "/usr/bin/tee";
      assert.equal(c.options.input !== undefined, isTee, `${c.args.join(" ")}`);
      if (isTee) assert.equal(c.options.input, TEXT);
    }
  });

  it("the first call is `sudo -k` (P7) and so is the last", () => {
    const s = fake("linux", 1000);
    writeDropIn(s.env, managedPaths("linux", 1000)!, TEXT);
    assert.deepEqual([s.calls[0]!.file, ...s.calls[0]!.args], ["/usr/bin/sudo", "-k"]);
    assert.deepEqual([s.calls.at(-1)!.file, ...s.calls.at(-1)!.args], ["/usr/bin/sudo", "-k"]);
  });

  it("a run that fails still ends with `sudo -k`", () => {
    const s = fake("linux", 1000);
    s.intercept = c => (c.args[0] === "/usr/bin/tee" ? { status: 1, stdout: "", stderr: "disk full" } : undefined);
    writeDropIn(s.env, managedPaths("linux", 1000)!, TEXT);
    assert.deepEqual([s.calls.at(-1)!.file, ...s.calls.at(-1)!.args], ["/usr/bin/sudo", "-k"]);
  });

  it("directories that already exist are not created again, and are reported as not created by us", () => {
    const s = fake("linux", 1000);
    const paths = managedPaths("linux", 1000)!;
    makeDir(s, paths.dropinDir);
    const r = writeDropIn(s.env, paths, TEXT);
    assert.deepEqual(r, { ok: true, created: { system: false, dropin: false } });
    assert.ok(!s.calls.some(c => c.args[0] === "/usr/bin/install"));
  });
});

describe("P2: sudo gets exactly PATH, TERM and LANG", () => {
  it("sudoEnvironment drops everything else, including SUDO_PROMPT, SUDO_ASKPASS, LD_PRELOAD and a hostile PATH", () => {
    const env = sudoEnvironment({
      PATH: "/home/evil/bin:/usr/bin",
      TERM: "xterm-256color",
      LANG: "en_US.UTF-8",
      SUDO_PROMPT: "Password for the bank: ",
      SUDO_ASKPASS: "/tmp/askpass",
      LD_PRELOAD: "/tmp/x.so",
      HOME: "/home/evil",
      LC_ALL: "C",
    });
    assert.deepEqual(env, { PATH: "/usr/bin:/bin", TERM: "xterm-256color", LANG: "en_US.UTF-8" });
  });

  it("TERM and LANG are omitted when unset, not empty", () => {
    assert.deepEqual(sudoEnvironment({ PATH: "/x" }), { PATH: "/usr/bin:/bin" });
  });

  it("every spawned call carries that environment, whatever the process environment holds", () => {
    const s = fake("linux", 1000, {
      processEnv: { PATH: "/evil", TERM: "vt100", LANG: "C", SUDO_PROMPT: "x", SUDO_ASKPASS: "/tmp/a", BASH_ENV: "/tmp/e", ENV: "/tmp/e" },
    });
    writeDropIn(s.env, managedPaths("linux", 1000)!, TEXT);
    assert.ok(s.calls.length > 0);
    for (const c of s.calls) assert.deepEqual(c.options.env, { PATH: "/usr/bin:/bin", TERM: "vt100", LANG: "C" });
  });
});

describe("T22: P4 refuses a system directory that a non-root user controls", () => {
  const paths = managedPaths("linux", 1000)!;

  it("accepts the stock tree, and macOS's root:admin Application Support", () => {
    assert.equal(verifyDirectoryChain(fake("linux", 1000).env, paths), null);
    const mac = fake("darwin", 501);
    mac.owners.set("/Library/Application Support", { uid: 0, gid: 80 });
    assert.equal(verifyDirectoryChain(mac.env, managedPaths("darwin", 501)!), null);
  });

  it("refuses a group-writable system directory and spawns nothing", () => {
    const s = fake("linux", 1000);
    makeDir(s, paths.systemDir, 0o775);
    assert.match(verifyDirectoryChain(s.env, paths) ?? "", /writable by group or others/);
    const r = writeDropIn(s.env, paths, TEXT);
    assert.equal(r.ok, false);
    assert.equal(s.calls.length, 0);
  });

  it("refuses a world-writable parent anywhere up to /", () => {
    const s = fake("linux", 1000);
    makeDir(s, paths.systemDir);
    chmodSync(s.at("/etc"), 0o777);
    assert.match(verifyDirectoryChain(s.env, paths) ?? "", /\/etc/);
    const root = fake("linux", 1000);
    chmodSync(root.root, 0o775);
    assert.match(verifyDirectoryChain(root.env, paths) ?? "", /writable by group or others/);
  });

  it("refuses a directory that is not owned by root", () => {
    const s = fake("linux", 1000);
    makeDir(s, paths.dropinDir);
    s.owners.set(paths.dropinDir, { uid: 1000, gid: 1000 });
    assert.match(verifyDirectoryChain(s.env, paths) ?? "", /not owned by root/);
    const parent = fake("linux", 1000);
    parent.owners.set("/etc", { uid: 1000, gid: 1000 });
    assert.match(verifyDirectoryChain(parent.env, paths) ?? "", /\/etc/);
  });

  it("refuses a symlinked system directory or drop-in directory (install -d and tee follow symlinks)", () => {
    const s = fake("linux", 1000);
    makeDir(s, "/home/u/elsewhere");
    symlinkSync("/home/u/elsewhere", s.at(paths.systemDir));
    assert.match(verifyDirectoryChain(s.env, paths) ?? "", /symlink/);
    const r = writeDropIn(s.env, paths, TEXT);
    assert.equal(r.ok, false);
    assert.equal(s.calls.length, 0);
    assert.equal(existsSync(s.at("/home/u/elsewhere/managed-settings.d")), false);

    const inner = fake("linux", 1000);
    makeDir(inner, paths.systemDir);
    makeDir(inner, "/home/u/elsewhere");
    symlinkSync("/home/u/elsewhere", inner.at(paths.dropinDir));
    assert.match(verifyDirectoryChain(inner.env, paths) ?? "", /symlink/);
  });

  it("refuses a symlinked PARENT of the system directory", () => {
    const s = fake("linux", 1000);
    rmSync(s.at("/etc"), { recursive: true });
    makeDir(s, "/somewhere/etc");
    symlinkSync("/somewhere/etc", s.at("/etc"));
    assert.match(verifyDirectoryChain(s.env, paths) ?? "", /symlink/);
  });

  it("an absent system directory is fine when its parents are", () => {
    const s = fake("linux", 1000);
    assert.equal(existsSync(s.at(paths.systemDir)), false);
    assert.equal(verifyDirectoryChain(s.env, paths), null);
  });
});

describe("P3: a failed write never reaches mv and cleans up", () => {
  const paths = managedPaths("linux", 1000)!;
  const rmTmp = ["/usr/bin/sudo", "/bin/rm", "-f", paths.tmp];
  const verbs = (s: FakeSystem): string[] => s.calls.map(c => c.args[0]!).filter(a => a !== "-k");

  it("tee exiting non-zero: no mv, the temp file is removed, ok:false", () => {
    const s = fake("linux", 1000);
    s.intercept = c => (c.args[0] === "/usr/bin/tee" ? { status: 1, stdout: "", stderr: "No space left on device" } : undefined);
    const r = writeDropIn(s.env, paths, TEXT);
    assert.equal(r.ok, false);
    assert.ok(!verbs(s).includes("/bin/mv"), "mv must not run after a failed tee");
    assert.ok(s.calls.some(c => [c.file, ...c.args].join("\0") === rmTmp.join("\0")), "the temp file must be removed");
    assert.equal(existsSync(s.at(paths.tmp)), false);
    assert.equal(existsSync(s.at(paths.file)), false);
  });

  it("a truncated write that exits 0 is caught by the digest compare before mv", () => {
    const s = fake("linux", 1000);
    s.intercept = c => {
      if (c.args[0] !== "/usr/bin/tee") return undefined;
      mkdirSync(s.at(paths.dropinDir), { recursive: true });
      writeFileSync(s.at(paths.tmp), TEXT.slice(0, 5));
      return { status: 0, stdout: "", stderr: "" };
    };
    const r = writeDropIn(s.env, paths, TEXT);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.message, /does not match|digest/);
    assert.ok(!verbs(s).includes("/bin/mv"));
    assert.equal(existsSync(s.at(paths.file)), false);
    assert.equal(existsSync(s.at(paths.tmp)), false, "the truncated temp file must be removed");
  });

  it("a chown or chmod that fails stops before mv", () => {
    for (const failing of ["/bin/chown", "/bin/chmod"]) {
      const s = fake("linux", 1000);
      s.intercept = c => (c.args[0] === failing ? { status: 1, stdout: "", stderr: "denied" } : undefined);
      const r = writeDropIn(s.env, paths, TEXT);
      assert.equal(r.ok, false, failing);
      assert.ok(!verbs(s).includes("/bin/mv"), failing);
      assert.equal(existsSync(s.at(paths.tmp)), false, failing);
    }
  });

  it("a chmod that reports success but did nothing (mode stays 0600) stops before mv", () => {
    const s = fake("linux", 1000);
    s.intercept = c => (c.args[0] === "/bin/chmod" ? { status: 0, stdout: "", stderr: "" } : undefined);
    const r = writeDropIn(s.env, paths, TEXT);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.message, /0644|mode/);
    assert.ok(!verbs(s).includes("/bin/mv"));
  });

  it("an mv that fails removes the temp file", () => {
    const s = fake("linux", 1000);
    s.intercept = c => (c.args[0] === "/bin/mv" ? { status: 1, stdout: "", stderr: "denied" } : undefined);
    const r = writeDropIn(s.env, paths, TEXT);
    assert.equal(r.ok, false);
    assert.equal(existsSync(s.at(paths.tmp)), false);
    assert.equal(existsSync(s.at(paths.file)), false);
  });

  it("a leftover hidden .tmp from an earlier run is replaced, and a stale final file is replaced atomically", () => {
    const s = fake("linux", 1000);
    putFile(s, paths.tmp, "old junk\n", 0o600);
    putFile(s, paths.file, '{"hooks":{}}\n', 0o644);
    const r = writeDropIn(s.env, paths, TEXT);
    assert.equal(r.ok, true);
    assert.equal(readFileSync(s.at(paths.file), "utf8"), TEXT);
    assert.equal(existsSync(s.at(paths.tmp)), false);
  });
});

// Security review L7: `tee` and `mv` follow a symlink at the target, so a symlink,
// directory or other non-file at either name is refused before root does anything.
describe("L7: the file and the temp name must be regular files (or absent) before tee", () => {
  const paths = managedPaths("linux", 1000)!;
  const cases: Array<[string, "file" | "tmp", (s: FakeSystem, at: string) => void]> = [
    ["a symlink at the temp name", "tmp", (s, at) => symlinkSync(s.at("/victim"), s.at(at))],
    ["a directory at the temp name", "tmp", (s, at) => mkdirSync(s.at(at))],
    ["a symlink at the drop-in path", "file", (s, at) => symlinkSync(s.at("/victim"), s.at(at))],
    ["a dangling symlink at the drop-in path", "file", (s, at) => symlinkSync(s.at("/nowhere/at/all"), s.at(at))],
    ["a directory at the drop-in path", "file", (s, at) => mkdirSync(s.at(at))],
  ];
  for (const [name, which, make] of cases) {
    it(`${name} is refused with no sudo call at all`, () => {
      const s = fake("linux", 1000);
      makeDir(s, paths.systemDir);
      makeDir(s, paths.dropinDir);
      make(s, which === "file" ? paths.file : paths.tmp);
      const r = writeDropIn(s.env, paths, TEXT);
      assert.equal(r.ok, false);
      assert.equal(r.ok ? "" : r.step, "target");
      assert.match(r.ok ? "" : r.message, new RegExp(`${(which === "file" ? paths.file : paths.tmp).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*not a regular file`));
      assert.match(r.ok ? "" : r.message, /nothing was run as root/);
      assert.equal(s.calls.length, 0, "not even sudo -k");
    });
  }

  it("a regular file at either name is fine: it is replaced", () => {
    const s = fake("linux", 1000);
    putFile(s, paths.tmp, "old junk\n", 0o600);
    putFile(s, paths.file, '{"hooks":{}}\n', 0o644);
    assert.equal(writeDropIn(s.env, paths, TEXT).ok, true);
    assert.equal(readFileSync(s.at(paths.file), "utf8"), TEXT);
  });

  it("absent names are fine", () => {
    assert.equal(writeDropIn(fake("linux", 1000).env, paths, TEXT).ok, true);
  });
});

describe("P6: read-back after writing", () => {
  const paths = managedPaths("linux", 1000)!;

  it("success: owner 0:0, mode 0644, digest equal", () => {
    const s = fake("linux", 1000);
    const r = writeDropIn(s.env, paths, TEXT);
    assert.equal(r.ok, true);
    const st = s.env.fs.lstat(paths.file)!;
    assert.deepEqual([st.uid, st.gid, st.mode & 0o7777], [0, 0, 0o644]);
    assert.equal(digestOf(s.env.fs.read(paths.file)!), digestOf(TEXT));
  });

  it("a file that ends up with another owner fails and the message carries the sudo rm line", () => {
    const s = fake("linux", 1000);
    s.intercept = c => {
      if (c.args[0] !== "/bin/mv") return undefined;
      renameSync(s.at(paths.tmp), s.at(paths.file));
      s.owners.set(paths.file, { uid: 1000, gid: 1000 });
      return { status: 0, stdout: "", stderr: "" };
    };
    const r = writeDropIn(s.env, paths, TEXT);
    assert.equal(r.ok, false);
    assert.ok((r.ok ? "" : r.message).includes(`sudo rm '${paths.file}'`), JSON.stringify(r));
  });

  it("a final file whose content changed under us fails", () => {
    const s = fake("linux", 1000);
    s.intercept = c => {
      if (c.args[0] !== "/bin/mv") return undefined;
      writeFileSync(s.at(paths.file), "{}\n");
      chmodSync(s.at(paths.file), 0o644);
      return { status: 0, stdout: "", stderr: "" };
    };
    const r = writeDropIn(s.env, paths, TEXT);
    assert.equal(r.ok, false);
    assert.ok((r.ok ? "" : r.message).includes("sudo rm"));
  });
});

