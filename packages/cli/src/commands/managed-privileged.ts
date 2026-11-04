// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// The privileged step of the managed drop-in (doc/plan-pin-enforcement-binary.md
// D8.3, D8.9 and P1 to P6): the ONLY root action repo-aegis takes.
//
// What the rules buy, in the order the code applies them:
//   P1  `sudo` and every command it runs are called by absolute path and are
//       checked first: a regular file owned by uid 0 that group and others cannot
//       write, and a `sudo` that is still setuid root. A `sudo` an agent planted
//       earlier on PATH would capture the person's password.
//   P4  the system directory and every parent up to `/` are root-owned, not
//       group- or world-writable and not symlinks: `install -d` and `tee` follow
//       symlinks, so a directory a user controls is a way to write elsewhere.
//   P2  root runs only fixed commands with fixed arguments; `sudo` is spawned with
//       `shell: false` and an environment of PATH, TERM and LANG, so shell startup
//       files cannot spoof the password prompt (`SUDO_PROMPT`, `SUDO_ASKPASS`).
//   P3  the content goes in on stdin to a hidden temp name in the root-owned
//       directory, is checked as the user, and only then renamed into place.
//   P6  the result is read back.
//   P7  `sudo -k` first and last: the password prompt is the control.
//
// `env` is injected (platform, uid, file system view, spawn, environment) so the
// darwin and linux layouts run on any host and tests never escalate. The real
// `spawn` refuses to run under the Node test runner.
import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync, type Stats } from "node:fs";
import { join, sep } from "node:path";
import { shellQuote, testSeamsEnabled } from "@de-otio/repo-aegis-core";
import { digestOf, type ManagedPaths } from "./managed-dropin.js";

// ---------------------------------------------------------------------------
// The injected environment
// ---------------------------------------------------------------------------

export interface FsStat {
  uid: number;
  gid: number;
  /** `st_mode`, including the file type bits. */
  mode: number;
  isFile: boolean;
  isDirectory: boolean;
  isSymlink: boolean;
}

/** The read-only view of the file system that the checks use. Paths are absolute and virtual: a test root is added inside. */
export interface FsProbe {
  /** Does not follow a symlink at the end; null when absent. */
  lstat(path: string): FsStat | null;
  /** Follows symlinks; null when absent. */
  stat(path: string): FsStat | null;
  /** The canonical path, or null when it does not exist. */
  realpath(path: string): string | null;
  /** Names in a directory, or null when it cannot be listed. */
  readdir(path: string): string[] | null;
  /** The file as UTF-8, or null when it cannot be read. */
  read(path: string): string | null;
}

function toFsStat(st: Stats): FsStat {
  return { uid: st.uid, gid: st.gid, mode: st.mode, isFile: st.isFile(), isDirectory: st.isDirectory(), isSymlink: st.isSymbolicLink() };
}

/** The real file system, below `root` (default `/`). */
export function realFs(root = ""): FsProbe {
  const realRoot = root === "" ? "" : realpathSync(root);
  const abs = (p: string): string => (root === "" ? p : join(root, p));
  return {
    lstat: p => {
      try {
        return toFsStat(lstatSync(abs(p)));
      } catch {
        return null;
      }
    },
    stat: p => {
      try {
        return toFsStat(statSync(abs(p)));
      } catch {
        return null;
      }
    },
    realpath: p => {
      try {
        const r = realpathSync(abs(p));
        if (realRoot === "") return r;
        if (r === realRoot) return "/";
        return r.startsWith(realRoot + sep) ? r.slice(realRoot.length) : r;
      } catch {
        return null;
      }
    },
    readdir: p => {
      try {
        return readdirSync(abs(p));
      } catch {
        return null;
      }
    },
    read: p => {
      try {
        return readFileSync(abs(p), "utf8");
      } catch {
        return null;
      }
    },
  };
}

export interface SpawnOptions {
  /** The complete environment of the child. */
  env: Record<string, string>;
  /** Bytes for the child's stdin; the child's stdin is the terminal when absent. */
  input?: string;
  /** Always false: nothing is ever run through a shell. */
  shell: false;
}

export interface SpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type SpawnFn = (file: string, args: readonly string[], options: SpawnOptions) => SpawnResult;

/**
 * The real `spawn`. Refused under the Node test runner: a test that forgot to
 * inject one would otherwise ask for a password. `sudo` prompts on the controlling
 * terminal, so stdin may stay the terminal (or a pipe for `tee`).
 */
export const realSpawn: SpawnFn = (file, args, options) => {
  if (testSeamsEnabled()) {
    throw new Error(`refusing to run ${file} from the test runner: inject a spawn`);
  }
  const r = spawnSync(file, [...args], {
    env: options.env,
    shell: false,
    ...(options.input !== undefined && { input: options.input }),
    encoding: "utf8",
    stdio: [options.input !== undefined ? "pipe" : "inherit", "pipe", "inherit"],
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

export interface ManagedEnv {
  platform: NodeJS.Platform;
  uid: number;
  fs: FsProbe;
  spawn: SpawnFn;
  /** Where TERM and LANG come from for `sudo`. */
  processEnv: NodeJS.ProcessEnv;
}

/** A file system with nothing in it: the default view under the Node test runner, so a test never reads the developer's real managed settings. */
export const EMPTY_FS: FsProbe = {
  lstat: () => null,
  stat: () => null,
  realpath: () => null,
  readdir: () => null,
  read: () => null,
};

/**
 * The environment for this process. `seams` replaces parts of it ONLY under the
 * Node test runner, and there an absent `fs` seam means an EMPTY file system, so a
 * test that forgot to inject one cannot see (or touch) the real managed settings.
 */
export function resolveManagedEnv(seams: Partial<ManagedEnv> = {}): ManagedEnv {
  const t = testSeamsEnabled();
  return {
    platform: t && seams.platform !== undefined ? seams.platform : process.platform,
    uid: t && seams.uid !== undefined ? seams.uid : typeof process.getuid === "function" ? process.getuid() : -1,
    fs: t ? (seams.fs ?? EMPTY_FS) : realFs(""),
    spawn: t && seams.spawn !== undefined ? seams.spawn : realSpawn,
    processEnv: t && seams.processEnv !== undefined ? seams.processEnv : process.env,
  };
}

// ---------------------------------------------------------------------------
// P1: the tools
// ---------------------------------------------------------------------------

export interface PrivilegedTools {
  sudo: string;
  install: string;
  tee: string;
  chmod: string;
  chown: string;
  mv: string;
  rm: string;
  rmdir: string;
  id: string;
}

/** Absolute paths of every command the installer may run, per platform (P1). */
export function privilegedTools(platform: NodeJS.Platform): PrivilegedTools {
  return {
    sudo: "/usr/bin/sudo",
    install: "/usr/bin/install",
    tee: "/usr/bin/tee",
    chmod: "/bin/chmod",
    chown: platform === "darwin" ? "/usr/sbin/chown" : "/bin/chown",
    mv: "/bin/mv",
    rm: "/bin/rm",
    rmdir: "/bin/rmdir",
    id: "/usr/bin/id",
  };
}

export interface ToolProblem {
  tool: keyof PrivilegedTools;
  path: string;
  reason: string;
  /** True when the file does not exist at all (as opposed to existing and being unsafe). */
  missing: boolean;
}

const OTHER_OR_GROUP_WRITE = 0o022;
const SETUID = 0o4000;

/**
 * P1: every tool must resolve (through realpath: on Debian and Ubuntu `/bin` is a
 * symlink to `/usr/bin`) to a regular file owned by uid 0 that group and others
 * cannot write, and `sudo` must still be setuid root. One problem per bad tool.
 */
export function verifyPrivilegedTools(env: ManagedEnv): ToolProblem[] {
  const problems: ToolProblem[] = [];
  const tools = privilegedTools(env.platform);
  for (const tool of Object.keys(tools) as Array<keyof PrivilegedTools>) {
    const path = tools[tool];
    const problem = rootFileProblem(env, path, tool === "sudo");
    if (problem !== null) problems.push({ tool, path, ...problem });
  }
  return problems;
}

/**
 * The P1 predicate for one file: it resolves (through realpath) to a regular file
 * owned by uid 0 that group and others cannot write, and, when `setuid`, still has
 * its setuid bit. `reason` says which; `missing` is true when it does not exist.
 * Used for every tool root runs, and for the `/usr/bin/true` that doctor hands to
 * `sudo -n -k`.
 */
export function rootFileProblem(env: ManagedEnv, path: string, setuid = false): { reason: string; missing: boolean } | null {
  const real = env.fs.realpath(path);
  const st = real === null ? null : env.fs.stat(real);
  if (real === null || st === null) return { reason: "does not exist", missing: true };
  if (!st.isFile) return { reason: `${real} is not a regular file`, missing: false };
  if (st.uid !== 0) return { reason: `${real} is not owned by root (owner uid ${st.uid})`, missing: false };
  if ((st.mode & OTHER_OR_GROUP_WRITE) !== 0) {
    return { reason: `${real} is writable by group or others (mode ${(st.mode & 0o7777).toString(8)})`, missing: false };
  }
  if (setuid && (st.mode & SETUID) === 0) return { reason: `${real} does not have its setuid bit, so it is not the real sudo`, missing: false };
  return null;
}

/** Why the tools cannot be used to write or remove the drop-in, or null. A missing `id` does not matter here: it is only the hooks' dependency. */
function toolsRefusal(env: ManagedEnv): string | null {
  const problems = verifyPrivilegedTools(env).filter(p => !(p.tool === "id" && p.missing));
  if (problems.length === 0) return null;
  return `${problems.map(p => `${p.path}: ${p.reason}`).join("; ")}; nothing was run as root`;
}

// ---------------------------------------------------------------------------
// P4: the directory chain
// ---------------------------------------------------------------------------

function ancestors(path: string): string[] {
  const out: string[] = [];
  for (let d = path.slice(0, path.lastIndexOf("/")); d !== ""; d = d.slice(0, d.lastIndexOf("/"))) out.push(d);
  out.push("/");
  return out;
}

/**
 * P4: why the system directory is not safe to write through, or null. Checks the
 * drop-in directory and the system directory where present, and every parent up
 * to `/`: none may be a symlink, owned by anyone but root, or writable by group or
 * others. (`install -d` and `tee` follow symlinks.) On macOS
 * `/Library/Application Support` is `root:admin 0755`, which passes.
 */
export function verifyDirectoryChain(env: ManagedEnv, paths: ManagedPaths): string | null {
  for (const p of [paths.dropinDir, paths.systemDir, ...ancestors(paths.systemDir)]) {
    const st = env.fs.lstat(p);
    if (st === null) continue;
    if (st.isSymlink) return `${p} is a symlink`;
    if (!st.isDirectory) return `${p} is not a directory`;
    if (st.uid !== 0) return `${p} is not owned by root (owner uid ${st.uid})`;
    if ((st.mode & OTHER_OR_GROUP_WRITE) !== 0) return `${p} is writable by group or others (mode ${(st.mode & 0o7777).toString(8)})`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// P2: running a fixed command as root
// ---------------------------------------------------------------------------

/** The whole environment `sudo` is given: PATH, and TERM and LANG when set. Nothing else, whatever sudoers' `env_reset`/`env_keep` say. */
export function sudoEnvironment(processEnv: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = { PATH: "/usr/bin:/bin" };
  const term = processEnv["TERM"];
  const lang = processEnv["LANG"];
  if (typeof term === "string" && term !== "") env["TERM"] = term;
  if (typeof lang === "string" && lang !== "") env["LANG"] = lang;
  return env;
}

class Sudo {
  readonly tools: PrivilegedTools;
  constructor(private readonly env: ManagedEnv) {
    this.tools = privilegedTools(env.platform);
  }
  /** `sudo <args>`; `args[0]` is an absolute tool path or `-k`. Only `tee` passes `input`. */
  run(args: readonly string[], input?: string): SpawnResult {
    return this.env.spawn(this.tools.sudo, args, {
      env: sudoEnvironment(this.env.processEnv),
      shell: false,
      ...(input !== undefined && { input }),
    });
  }
  /** P7: drop any cached ticket, including one from another terminal under `timestamp_type=global`. */
  forget(): void {
    this.run(["-k"]);
  }
}

const DROPIN_MODE = 0o644;

export interface CreatedDirs {
  system: boolean;
  dropin: boolean;
}

export type PrivilegedResult =
  | { ok: true; created: CreatedDirs }
  | { ok: false; step: string; message: string; created: CreatedDirs };

/** The one line that removes the drop-in by hand. */
export function sudoRmLine(file: string): string {
  return `sudo rm ${shellQuote(file)}`;
}

function describeFailure(r: SpawnResult): string {
  const detail = r.stderr.trim();
  return `exit ${r.status === null ? "(killed)" : r.status}${detail === "" ? "" : `: ${detail.split("\n")[0]}`}`;
}

/**
 * Write `text` as the drop-in at `paths.file` (D8.3, P1 to P4, P6, P7). Spawns
 * nothing at all if P1 or P4 fails. On any failure after the first privileged call
 * the staged temp file is removed, `sudo -k` runs, and the result says which step
 * failed; `created` names the directories this run made, for the ledger.
 */
export function writeDropIn(env: ManagedEnv, paths: ManagedPaths, text: string): PrivilegedResult {
  const created: CreatedDirs = { system: false, dropin: false };
  const refuse = (step: string, message: string): PrivilegedResult => ({ ok: false, step, message, created });

  const toolIssue = toolsRefusal(env);
  if (toolIssue !== null) return refuse("tools", toolIssue);
  const dirIssue = verifyDirectoryChain(env, paths);
  if (dirIssue !== null) return refuse("directories", `${dirIssue}; nothing was run as root`);

  const sudo = new Sudo(env);
  const t = sudo.tools;
  const digest = digestOf(text);
  const sysExisted = env.fs.lstat(paths.systemDir) !== null;
  const dropExisted = env.fs.lstat(paths.dropinDir) !== null;
  let staged = false;

  const fail = (step: string, message: string): PrivilegedResult => {
    if (staged) sudo.run([t.rm, "-f", paths.tmp]);
    sudo.forget();
    return refuse(step, message);
  };

  sudo.forget();
  if (!sysExisted) {
    const r = sudo.run([t.install, "-d", "-m", "0755", paths.systemDir]);
    if (r.status !== 0) return fail("mkdir", `could not create ${paths.systemDir} (${describeFailure(r)})`);
    created.system = true;
  }
  if (!dropExisted) {
    const r = sudo.run([t.install, "-d", "-m", "0755", paths.dropinDir]);
    if (r.status !== 0) return fail("mkdir", `could not create ${paths.dropinDir} (${describeFailure(r)})`);
    created.dropin = true;
  }

  staged = true;
  const tee = sudo.run([t.tee, paths.tmp], text);
  if (tee.status !== 0) return fail("tee", `could not stage ${paths.tmp} (${describeFailure(tee)})`);
  const chown = sudo.run([t.chown, "0:0", paths.tmp]);
  if (chown.status !== 0) return fail("chown", `could not set the owner of ${paths.tmp} (${describeFailure(chown)})`);
  const chmod = sudo.run([t.chmod, "0644", paths.tmp]);
  if (chmod.status !== 0) return fail("chmod", `could not set the mode of ${paths.tmp} (${describeFailure(chmod)})`);

  // Read the staged file back as the user before it goes anywhere (P3).
  const stagedProblem = fileProblem(env, paths.tmp, digest);
  if (stagedProblem !== null) return fail("verify-staged", `the staged file is wrong (${stagedProblem}); it was not moved into place`);

  const mv = sudo.run([t.mv, "-f", paths.tmp, paths.file]);
  if (mv.status !== 0) return fail("mv", `could not move ${paths.tmp} into place (${describeFailure(mv)})`);
  staged = false;

  // P6.
  const placedProblem = fileProblem(env, paths.file, digest);
  if (placedProblem !== null) {
    sudo.forget();
    return refuse("read-back", `the installed file is wrong (${placedProblem}); to remove it run: ${sudoRmLine(paths.file)}`);
  }
  sudo.forget();
  return { ok: true, created };
}

/** Why `path` is not a root-owned 0644 regular file holding exactly the text with `digest`, or null. */
export function fileProblem(env: ManagedEnv, path: string, digest: string): string | null {
  const st = env.fs.lstat(path);
  if (st === null) return `${path} does not exist`;
  if (st.isSymlink || !st.isFile) return `${path} is not a regular file`;
  if (st.uid !== 0 || st.gid !== 0) return `${path} is owned by ${st.uid}:${st.gid}, expected 0:0`;
  if ((st.mode & 0o7777) !== DROPIN_MODE) return `${path} has mode ${(st.mode & 0o7777).toString(8).padStart(4, "0")}, expected 0644`;
  const body = env.fs.read(path);
  if (body === null) return `${path} cannot be read`;
  if (digestOf(body) !== digest) return `the content of ${path} does not match what was rendered (digest ${digestOf(body).slice(0, 12)}, expected ${digest.slice(0, 12)})`;
  return null;
}

// ---------------------------------------------------------------------------
// D8.9: removal
// ---------------------------------------------------------------------------

export interface RemovePlan {
  /** Also remove the uid-less `50-repo-aegis.json` of an earlier build (only when the ledger names it). */
  removeLegacy: boolean;
  /** The ledger says repo-aegis created `managed-settings.d`: remove it if it is empty. */
  dropinDirCreated: boolean;
  /** The ledger says repo-aegis created the system directory: remove it if it is empty. */
  systemDirCreated: boolean;
}

export type RemoveResult =
  | { ok: true; removed: { file: boolean; legacy: boolean; dropinDir: boolean; systemDir: boolean } }
  | { ok: false; step: string; message: string };

/** True when removing needs root at all: the file (or the named legacy file) is there, or a created directory is empty. */
export function removalNeeded(env: ManagedEnv, paths: ManagedPaths, plan: RemovePlan): boolean {
  if (env.fs.lstat(paths.file) !== null) return true;
  if (plan.removeLegacy && env.fs.lstat(paths.legacyFile) !== null) return true;
  const dropin = env.fs.readdir(paths.dropinDir);
  if (plan.dropinDirCreated && dropin !== null && dropin.length === 0) return true;
  const system = env.fs.readdir(paths.systemDir);
  return plan.systemDirCreated && dropin === null && system !== null && system.length === 0;
}

/**
 * Remove the drop-in (D8.9): `rm -f` of the uid-derived path, the legacy file only
 * if `plan` says the ledger names it, then `/bin/rmdir` (never `rm -r`) on
 * `managed-settings.d` and then the system directory, each only if it is empty and
 * created by repo-aegis. Reads back: the drop-in path must be gone. Nothing else is
 * touched: not `managed-settings.json`, not other drop-ins, not other uids' files.
 */
export function removeDropIn(env: ManagedEnv, paths: ManagedPaths, plan: RemovePlan): RemoveResult {
  const refuse = (step: string, message: string): RemoveResult => ({ ok: false, step, message });
  const toolIssue = toolsRefusal(env);
  if (toolIssue !== null) return refuse("tools", toolIssue);
  const dirIssue = verifyDirectoryChain(env, paths);
  if (dirIssue !== null) return refuse("directories", `${dirIssue}; nothing was run as root`);

  const sudo = new Sudo(env);
  const t = sudo.tools;
  const removed = { file: false, legacy: false, dropinDir: false, systemDir: false };
  sudo.forget();
  const rmFile = (path: string): RemoveResult | null => {
    if (env.fs.lstat(path) === null) return null;
    const r = sudo.run([t.rm, "-f", path]);
    if (r.status !== 0) {
      sudo.forget();
      return refuse("rm", `could not remove ${path} (${describeFailure(r)})`);
    }
    return null;
  };
  const failed = rmFile(paths.file);
  if (failed !== null) return failed;
  removed.file = true;
  if (plan.removeLegacy) {
    const legacyFailed = rmFile(paths.legacyFile);
    if (legacyFailed !== null) return legacyFailed;
    removed.legacy = true;
  }

  const rmdirIfEmpty = (dir: string): boolean => {
    const names = env.fs.readdir(dir);
    if (names === null || names.length !== 0) return false;
    return sudo.run([t.rmdir, dir]).status === 0;
  };
  if (plan.dropinDirCreated) removed.dropinDir = rmdirIfEmpty(paths.dropinDir);
  if (plan.systemDirCreated && env.fs.lstat(paths.dropinDir) === null) removed.systemDir = rmdirIfEmpty(paths.systemDir);
  sudo.forget();

  if (env.fs.lstat(paths.file) !== null) {
    return refuse("read-back", `${paths.file} still exists after removal; remove it with: ${sudoRmLine(paths.file)}`);
  }
  return { ok: true, removed };
}
