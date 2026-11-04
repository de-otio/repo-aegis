// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
// Test-only: a fake system for the managed drop-in's privileged step
// (doc/plan-pin-enforcement-binary.md D8). Filename underscore-prefixed so it is
// clearly not a runtime module.
//
// `makeFakeSystem` builds a temp directory that stands for `/`, lays out the tools
// and directories the real system has for `platform`, and gives back a
// `ManagedEnv` whose `spawn` is a simulator of `sudo`: it understands exactly the
// fixed commands the installer may run, applies them under the temp root, and
// records every call. Nothing here runs `sudo`, writes outside the temp root or
// escalates; ownership is a map the simulator and the stat view share, because a
// test cannot `chown` to root.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { realFs, type FsProbe, type FsStat, type ManagedEnv, type SpawnFn, type SpawnOptions, type SpawnResult } from "./commands/managed-privileged.js";

export interface RecordedCall {
  file: string;
  args: readonly string[];
  options: SpawnOptions;
}

export interface FakeSystem {
  /** The temp directory that stands for `/`. */
  root: string;
  /** Ownership overrides by absolute (virtual) path; a path with no entry is owned by 0:0. */
  owners: Map<string, { uid: number; gid: number }>;
  calls: RecordedCall[];
  /** The setuid bit by virtual path: a non-root test cannot reliably set it on a file (some filesystems drop it). `/usr/bin/sudo` has it unless set to false. */
  setuid: Map<string, boolean>;
  /** Return a result to answer a call instead of simulating it. */
  intercept: ((call: RecordedCall) => SpawnResult | undefined) | undefined;
  env: ManagedEnv;
  /** `root` + a virtual absolute path. */
  at(virtual: string): string;
  /** The simulated calls that ran a tool (everything but `sudo -k`). */
  toolCalls(): RecordedCall[];
}

const OK: SpawnResult = { status: 0, stdout: "", stderr: "" };

export interface FakeSystemOptions {
  platform: NodeJS.Platform;
  uid: number;
  /** Leave these virtual tool paths out (for example `/usr/bin/id`). */
  omitTools?: string[];
  processEnv?: NodeJS.ProcessEnv;
  /** Do not create the system directory (the usual starting state). Default true. */
  noSystemDir?: boolean;
}

/** Every tool the installer may name, by platform, as virtual paths (P1). */
export function toolPaths(platform: NodeJS.Platform): string[] {
  return [
    "/usr/bin/sudo",
    "/usr/bin/install",
    "/usr/bin/tee",
    "/bin/chmod",
    platform === "darwin" ? "/usr/sbin/chown" : "/bin/chown",
    "/bin/mv",
    "/bin/rm",
    "/bin/rmdir",
    "/usr/bin/id",
  ];
}

export function makeFakeSystem(opts: FakeSystemOptions): FakeSystem {
  const root = mkdtempSync(join(tmpdir(), "repo-aegis-fakesys-"));
  const at = (virtual: string): string => join(root, virtual);
  const mk = (virtual: string): void => {
    mkdirSync(at(virtual), { recursive: true });
  };
  const owners = new Map<string, { uid: number; gid: number }>();

  // The base directories: `/` and the one above the system directory.
  mk(opts.platform === "darwin" ? "/Library/Application Support" : "/etc");
  mk("/usr/bin");
  mk("/usr/sbin");
  mk("/bin");
  for (const tool of toolPaths(opts.platform)) {
    if (opts.omitTools?.includes(tool)) continue;
    writeFileSync(at(tool), "#!/bin/sh\n", { mode: 0o755 });
  }

  const base = realFs(root);
  const setuid = new Map<string, boolean>([["/usr/bin/sudo", true]]);
  const owned = (virtual: string, st: FsStat | null): FsStat | null =>
    st === null
      ? null
      : {
          ...st,
          ...(owners.get(virtual) ?? { uid: 0, gid: 0 }),
          mode: (st.mode & ~0o4000) | (setuid.get(virtual) === true ? 0o4000 : 0),
        };
  const fs: FsProbe = {
    ...base,
    lstat: p => owned(p, base.lstat(p)),
    stat: p => owned(p, base.stat(p)),
  };

  const calls: RecordedCall[] = [];
  const sys: FakeSystem = {
    root,
    owners,
    setuid,
    calls,
    intercept: undefined,
    at,
    toolCalls: () => calls.filter(c => !(c.args.length === 1 && c.args[0] === "-k")),
    env: undefined as unknown as ManagedEnv,
  };

  const spawn: SpawnFn = (file, args, options) => {
    const call: RecordedCall = { file, args: [...args], options };
    calls.push(call);
    const forced = sys.intercept?.(call);
    if (forced !== undefined) return forced;
    if (file !== "/usr/bin/sudo") return { status: 127, stdout: "", stderr: `fake system: ${file} is not simulated` };
    const [cmd, ...rest] = args;
    if (cmd === "-k") return OK;
    try {
      switch (cmd) {
        case "/usr/bin/install": {
          // install -d -m 0755 <dir>
          const dir = rest[3]!;
          mkdirSync(at(dir));
          chmodSync(at(dir), 0o755);
          owners.set(dir, { uid: 0, gid: 0 });
          return OK;
        }
        case "/usr/bin/tee": {
          // A root-created file under umask 077, in a group that is not root's.
          const path = rest[0]!;
          writeFileSync(at(path), options.input ?? "");
          chmodSync(at(path), 0o600);
          owners.set(path, { uid: 0, gid: 20 });
          return { status: 0, stdout: options.input ?? "", stderr: "" };
        }
        case "/usr/sbin/chown":
        case "/bin/chown": {
          const [spec, path] = rest as [string, string];
          const [u, g] = spec.split(":").map(Number) as [number, number];
          owners.set(path, { uid: u, gid: g });
          return OK;
        }
        case "/bin/chmod":
          chmodSync(at(rest[1]!), parseInt(rest[0]!, 8));
          return OK;
        case "/bin/mv": {
          // mv -f <from> <to>
          const [, from, to] = rest as [string, string, string];
          renameSync(at(from), at(to));
          owners.set(to, owners.get(from) ?? { uid: 0, gid: 0 });
          owners.delete(from);
          return OK;
        }
        case "/bin/rm": {
          // rm -f <path>
          const path = rest[1]!;
          if (existsSync(at(path))) unlinkSync(at(path));
          owners.delete(path);
          return OK;
        }
        case "/bin/rmdir":
          rmdirSync(at(rest[0]!));
          return OK;
        default:
          return { status: 127, stdout: "", stderr: `fake system: ${String(cmd)} is not simulated` };
      }
    } catch (err) {
      return { status: 1, stdout: "", stderr: (err as Error).message };
    }
  };

  sys.env = {
    platform: opts.platform,
    uid: opts.uid,
    fs,
    spawn,
    processEnv: opts.processEnv ?? { TERM: "xterm", LANG: "C.UTF-8" },
  };
  return sys;
}

/** Make `dir` (virtual) in the fake system, as root-owned 0755 unless `mode` says otherwise. */
export function makeDir(sys: FakeSystem, virtual: string, mode = 0o755): void {
  mkdirSync(sys.at(virtual), { recursive: true });
  chmodSync(sys.at(virtual), mode);
}

/** Write a file at a virtual path, creating its directory. */
export function putFile(sys: FakeSystem, virtual: string, text: string, mode = 0o644): void {
  mkdirSync(dirname(sys.at(virtual)), { recursive: true });
  writeFileSync(sys.at(virtual), text);
  chmodSync(sys.at(virtual), mode);
}

/** Virtual names in a virtual directory, or null when it is absent. */
export function listDir(sys: FakeSystem, virtual: string): string[] | null {
  return existsSync(sys.at(virtual)) ? readdirSync(sys.at(virtual)).sort() : null;
}
