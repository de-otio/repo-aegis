// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `repo-aegis install shim [tool]` — writes `<home>/bin/<tool>` ahead of
// the real binary on PATH (doc/design/egress-guard.md §3). `checkShim`
// feeds `doctor`.
//
// Nothing chokes `gh` the way the pre-push hook chokes `git`, so the shim
// IS the choke point: one file, on PATH, in front of every agent and every
// terminal on the machine. That makes two properties non-negotiable here:
//
//   1. **It never clobbers a file it did not write.** The generated script
//      carries a header line; a file at the shim path without that line is
//      somebody else's `gh` wrapper and `SHIM_PATH_OCCUPIED` refuses it
//      until `--force`. The same test gates removal, so `uninstall` cannot
//      delete a stranger's wrapper either.
//   2. **Installing is not enabling.** The shim only guards once its
//      directory precedes the real `gh` on PATH, which this command can
//      print but cannot do. `checkShim` is what turns "installed but
//      shadowed" — the "hooks installed but not running" failure in a new
//      costume — into a `doctor` finding instead of silence.
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { appendAuditRecord, pinProblem, repoAegisHome, type EnforcementPin } from "@de-otio/repo-aegis-core";
import { emitJson, emitText, emitError, type OutputOptions } from "../format.js";
import type { DoctorCheck } from "./doctor-checks.js";
import { currentEnforcementPin } from "../enforcement-pin.js";
import { parseHomeFromScript, parseTaaadPinFromScript, renderShimScript, SHIM_HEADER_LINE } from "./shim-script.js";
import { resolveTaaadPin, taaadTrustProblem, type TaaadPin } from "./taaad-pin.js";

export interface InstallShimOptions extends OutputOptions {
  uninstall?: boolean;
  force?: boolean;
  /** Do the work, emit nothing. `uninstall` composes this command that way. */
  silent?: boolean;
  /** Test seam: the pin to render into the shim. Not reachable from the CLI. */
  pin?: EnforcementPin;
  /**
   * Test seam: the taaad to pin (null: none). Default: the first `taaad` on this process's PATH, which `install
   * shim` run by a person finds the way they would run it. Not reachable from the CLI.
   */
  taaad?: TaaadPin | null;
}

/** What the command did, for `uninstall`'s step report. */
export interface ShimResult {
  action: "install-shim" | "uninstall-shim";
  path: string;
  /** True when the file on disk changed (written, updated, or removed). */
  changed: boolean;
  /** Present when nothing changed, or when a foreign file was left alone. */
  reason?: string;
}

/** The only tool with a shim today. Anything else is a `USAGE` error, not a silent default. */
const SUPPORTED_TOOLS = ["gh"] as const;

/** `<home>/bin` — the directory the operator puts first on PATH. */
export function shimBinDir(): string {
  return join(repoAegisHome(), "bin");
}

/** `<home>/bin/<tool>`. */
export function shimPathFor(tool: string = "gh"): string {
  return join(shimBinDir(), tool);
}

/**
 * The current content of the file at `path`, or `null` when there is none
 * (or it cannot be read). One read, and every decision below is made on
 * what that read returned — never an `existsSync` followed by a second
 * look, which is a check-then-act race (CodeQL js/file-system-race).
 */
function readShim(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** True when `content` is a script this command generated. */
function isOurShimContent(content: string): boolean {
  return content.includes(SHIM_HEADER_LINE);
}

function pathInstruction(): string {
  return `export PATH="${shimBinDir()}:$PATH"`;
}

function uninstallShim(path: string, opts: InstallShimOptions): ShimResult {
  let result: ShimResult;
  const current = readShim(path);
  if (current === null) {
    result = { action: "uninstall-shim", path, changed: false, reason: "no shim installed" };
  } else if (!isOurShimContent(current)) {
    // Symmetric with the install-side refusal: a `gh` wrapper repo-aegis did
    // not write is not repo-aegis's to delete.
    result = {
      action: "uninstall-shim",
      path,
      changed: false,
      reason: "a file at the shim path was not written by repo-aegis; left in place",
    };
  } else {
    try {
      unlinkSync(path);
      result = { action: "uninstall-shim", path, changed: true };
    } catch (err) {
      return emitError(
        { code: "FS_ERROR", error: `failed to remove ${path}: ${(err as Error).message}` },
        opts,
      );
    }
  }

  try {
    appendAuditRecord({ action: "install-shim-uninstall", details: { path, removed: result.changed } });
  } catch {
    /* audit log must not break user-facing ops */
  }

  if (opts.silent) return result;
  if (opts.json) {
    emitJson(result);
    return result;
  }
  if (result.changed) emitText(`removed ${path}`);
  else emitText(`${path}: ${result.reason}`);
  return result;
}

export function installShim(tool: string | undefined, opts: InstallShimOptions): ShimResult {
  const name = tool ?? "gh";
  if (!(SUPPORTED_TOOLS as readonly string[]).includes(name)) {
    return emitError(
      {
        code: "USAGE",
        error: `no shim is available for '${name}'`,
        details: `supported tools: ${SUPPORTED_TOOLS.join(", ")}`,
      },
      opts,
    );
  }

  const dir = shimBinDir();
  const path = shimPathFor(name);

  if (opts.uninstall) return uninstallShim(path, opts);

  const current = readShim(path);
  const exists = current !== null;
  const wasForeign = current !== null && !isOurShimContent(current);
  if (wasForeign && !opts.force) {
    return emitError(
      {
        code: "SHIM_PATH_OCCUPIED",
        error: `a file that repo-aegis did not write already exists at the shim path`,
        details:
          `path: ${path}\n` +
          `  This is where \`install shim\` writes its \`gh\` wrapper, and overwriting someone ` +
          `else's file there would silently replace whatever it does.\n` +
          `  --force will OVERWRITE (destroy) it; save a copy first if it is still needed.`,
      },
      opts,
    );
  }

  // Idempotence is the point, not a nicety: this command is meant to be safe
  // to re-run from a shell profile or a provisioning script.
  const pin = opts.pin ?? currentEnforcementPin();
  const problem = pinProblem(pin);
  if (problem !== null) {
    return emitError(
      {
        code: "PIN_PATH_UNSUPPORTED",
        error: `cannot pin the enforcement binary: ${problem}`,
        details: "install repo-aegis, and the Node it runs on, at a path without newline characters, then re-run `repo-aegis install shim`",
      },
      opts,
    );
  }
  const taaad = opts.taaad !== undefined ? opts.taaad : resolveTaaadPin(process.env["PATH"], dir);
  let script: string;
  try {
    script = renderShimScript(pin, { home: repoAegisHome(), taaad });
  } catch (err) {
    return emitError(
      {
        code: "PIN_PATH_UNSUPPORTED",
        error: `cannot pin the enforcement binary: ${(err as Error).message}`,
        details: "install repo-aegis, taaad and the Node they run on at paths without newline characters, then re-run `repo-aegis install shim`",
      },
      opts,
    );
  }
  const unchanged = current === script;

  if (!unchanged) {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      try {
        chmodSync(dir, 0o700);
      } catch {
        /* platform-restricted */
      }
      writeFileSync(path, script, { mode: 0o755 });
      // writeFileSync's `mode` is masked by the process umask; chmod
      // unconditionally so the shim is always executable.
      chmodSync(path, 0o755);
    } catch (err) {
      return emitError(
        { code: "FS_ERROR", error: `failed to write the shim: ${(err as Error).message}` },
        opts,
      );
    }

    try {
      appendAuditRecord({
        action: "install-shim",
        details: { path, tool: name, overwrote: wasForeign ? "foreign" : exists ? "own" : null },
      });
    } catch {
      /* audit log must not break user-facing ops */
    }
  }

  // D4: github-app identities need a taaad that only root can change. Said now, because the person
  // running the installer is the one who can fix it (`doctor` repeats it as a finding).
  const taaadProblem = taaad === null ? null : taaadTrustProblem(taaad);
  const result: ShimResult = {
    action: "install-shim",
    path,
    changed: !unchanged,
    ...(unchanged && { reason: "already installed" }),
  };

  if (opts.silent) return result;
  if (opts.json) {
    emitJson({
      ...result,
      tool: name,
      binDir: dir,
      pathInstruction: pathInstruction(),
      taaad: taaad === null ? { pinned: false } : { pinned: true, ...taaad, rootOwned: taaadProblem === null, ...(taaadProblem !== null && { problem: taaadProblem }) },
    });
    return result;
  }
  emitText(unchanged ? `already installed: ${path}` : `installed shim at ${path}`);
  emitText(`The shim only guards once ${dir} comes FIRST on PATH. Add to your shell profile:`);
  emitText(`  ${pathInstruction()}`);
  if (taaad === null) {
    emitText("No taaad was found on PATH, so github-app identities are unavailable until you install it and re-run this command.");
  } else if (taaadProblem !== null) {
    emitText(`taaad is pinned (${taaad.launcher}). Note (TAAAD_AGENT_WRITABLE, a warning): ${taaadProblem}.`);
    emitText("App identities work as is; for extra protection, install taaad into a root-owned prefix (see doc/configuration.md, \"identities in practice\").");
  } else {
    emitText(`taaad pinned: ${taaad.launcher} (root-owned).`);
  }
  emitText(`Then check it with: repo-aegis doctor`);
  return result;
}

/** Canonical path, or the input when it cannot be resolved. */
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** First executable `gh` on `pathValue`, or null. Mirrors the shim's own scan. */
function firstGhOnPath(pathValue: string | undefined): string | null {
  if (pathValue === undefined || pathValue === "") return null;
  for (const entry of pathValue.split(delimiter)) {
    const dir = entry === "" ? "." : entry;
    const candidate = join(dir, "gh");
    try {
      const st = statSync(candidate);
      // POSIX mode bits are a bitmask; `& 0o111` is "executable by someone".
      if (st.isFile() && (st.mode & 0o111) !== 0) return candidate;
    } catch {
      /* not there */
    }
  }
  return null;
}

/**
 * Is the installed `gh` shim the FIRST `gh` on `env.PATH`?
 *
 * The same question `checkShim` answers as a `doctor` finding, as a plain
 * predicate for callers that must act on it rather than report it — the
 * agent hook, which reads its own environment because that is the one the
 * host will hand the shell it is about to permit. False when the shim is
 * not installed, when nothing on `PATH` reaches it, or when another `gh`
 * precedes it: in all three the shim does not run.
 *
 * Reuses `firstGhOnPath`/`canonical` on purpose. A second PATH resolver
 * that disagreed with `doctor`'s would be worse than no check at all — the
 * operator would be told the shim is fine by the command whose job is to
 * say so, while the guard silently believed otherwise.
 */
export function ghShimIsFirstOnPath(env: NodeJS.ProcessEnv = process.env): boolean {
  const shim = join(env["REPO_AEGIS_HOME"] ?? repoAegisHome(), "bin", "gh");
  if (!existsSync(shim)) return false;
  const first = firstGhOnPath(env["PATH"]);
  return first !== null && canonical(first) === canonical(shim);
}

/**
 * `doctor` checks for the shim: `SHIM_MISSING` when `<home>/bin/gh` does not
 * exist, `SHIM_NOT_FIRST` when it exists but another `gh` precedes it on
 * `PATH` (or nothing on PATH reaches it at all), `SHIM_STALE` when the file
 * on PATH is not the script this release generates. A shim that exists but is
 * shadowed is the "hooks installed but not running" failure in a new costume,
 * which is exactly why the shadowed case is a finding and not a detail.
 */
export function checkShim(env: NodeJS.ProcessEnv = process.env): DoctorCheck[] {
  const home = env["REPO_AEGIS_HOME"] ?? repoAegisHome();
  const binDir = join(home, "bin");
  const shim = join(binDir, "gh");

  if (!existsSync(shim)) {
    return [
      {
        code: "SHIM_MISSING",
        ok: false,
        detail: "no `gh` shim is installed, so nothing checks a `gh` publishing verb before it runs",
        fix: "repo-aegis install shim",
      },
    ];
  }

  const first = firstGhOnPath(env["PATH"]);
  if (first === null) {
    return [
      {
        code: "SHIM_NOT_FIRST",
        ok: false,
        // FAIL, stated explicitly: the shim is the only guard for a `gh` call the hook does not parse
        // (`find -exec gh …`, an interpreter, a pty wrapper), so a shadowed shim must fail `doctor`.
        severity: "fail",
        detail: "the `gh` shim is installed but no `gh` is reachable on PATH, so it never runs",
        fix: `put ${binDir} first on PATH`,
      },
    ];
  }
  if (canonical(first) !== canonical(shim)) {
    return [
      {
        code: "SHIM_NOT_FIRST",
        ok: false,
        severity: "fail",
        detail: "the `gh` shim is installed but another `gh` comes first on PATH, so the shim never runs",
        fix: `put ${binDir} first on PATH`,
      },
    ];
  }
  // The shim is a generated script that changes between releases — the
  // hooks' `HOOKS_SCRIPT_STALE` in a new costume. `install shim` rewrites a
  // differing file, but nothing runs it on upgrade unless something says to.
  let current: string | null = null;
  try {
    current = readFileSync(shim, "utf8");
  } catch {
    current = null;
  }
  // The home and the taaad pin are read back from the file itself: they are what this install pinned, and
  // `doctor` judges the taaad pin on its own (TAAAD_AGENT_WRITABLE). A shim with no readable home is stale.
  const pinnedHome = current === null ? null : parseHomeFromScript(current);
  const rerendered = (() => {
    if (current === null || pinnedHome === null) return null;
    try {
      return renderShimScript(currentEnforcementPin(), { home: pinnedHome, taaad: parseTaaadPinFromScript(current) });
    } catch {
      return null;
    }
  })();
  if (current !== null && (rerendered === null || current !== rerendered || pinnedHome !== home)) {
    return [
      {
        code: "SHIM_STALE",
        ok: false,
        detail: "the `gh` shim on PATH was written by an earlier repo-aegis release and differs from this one's",
        fix: "repo-aegis install shim",
      },
    ];
  }
  return [{ code: "SHIM_MISSING", ok: true, detail: "shim installed, current, and first on PATH" }];
}
