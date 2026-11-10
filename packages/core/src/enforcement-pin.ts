// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// The enforcement pin (doc/plan-pin-enforcement-binary.md): the absolute paths
// of the Node executable and the CLI entry that `install hooks` and `install
// shim` write into the generated scripts, so the scripts run THAT code instead
// of whatever `repo-aegis` or `node` comes first on the caller's PATH.
//
// Pure text helpers only. Resolving the paths of the running install is the
// CLI's job (`packages/cli/src/enforcement-pin.ts`); this module renders and
// reads them back, so `hooks-state.ts` and the shim can share one definition
// of "the script as rendered for this pin".

/** Absolute paths, canonicalised by whoever resolves them. */
export interface EnforcementPin {
  /** The Node executable that runs the CLI. */
  node: string;
  /** The CLI entry point (`dist/index.js`). */
  cli: string;
  /**
   * The package version of the pinned CLI, written as `__ra_version=` next to the paths. It is the floor for the
   * PATH fallback: a pinned binary that is gone is replaced by the `repo-aegis` on PATH only if that is at least
   * this new. Absent when the version could not be found; the script then does not fall back at all.
   */
  version?: string;
}

/** What a pinned version must look like: `MAJOR.MINOR.PATCH`, optionally with a `-prerelease` or `+build` suffix. */
export const PIN_VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.+-]*)?$/;

/** Why `pin` cannot be rendered into a shell script, or null when it can. */
export function pinProblem(pin: EnforcementPin): string | null {
  for (const [label, value] of [["node", pin.node], ["cli", pin.cli]] as const) {
    if (value === "") return `the pinned ${label} path is empty`;
    // A newline or NUL cannot be quoted into one assignment line that the
    // doctor check reads back, and no real install path holds one: refuse
    // rather than render something a parser and the shell might read differently.
    if (/[\n\r\0]/.test(value)) return `the pinned ${label} path contains a newline or NUL character`;
  }
  if (pin.version !== undefined && !PIN_VERSION_PATTERN.test(pin.version)) {
    return "the pinned version is not MAJOR.MINOR.PATCH (with an optional -prerelease or +build suffix)";
  }
  return null;
}

/** Throws when {@link pinProblem} says the pin cannot be rendered. */
export function assertPinnable(pin: EnforcementPin): void {
  const problem = pinProblem(pin);
  if (problem !== null) throw new Error(problem);
}

/** POSIX single-quote `value`: safe for any character but NUL. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Inverse of {@link shellQuote}; null when `text` is not exactly one quoted word. */
export function shellUnquote(text: string): string | null {
  if (!/^'(?:[^']|'\\'')*'$/.test(text)) return null;
  return text.slice(1, -1).replace(/'\\''/g, "'");
}

/**
 * The assignment lines every pinned script starts its pin section with.
 * `__ra_node` and `__ra_cli` are the names the scripts call the pinned CLI by
 * (`__ra_fb`, the PATH fallback, is the only other); `__ra_version` is the
 * floor for that fallback, empty when no version was recorded.
 */
export function pinAssignments(pin: EnforcementPin): string {
  assertPinnable(pin);
  return `__ra_node=${shellQuote(pin.node)}\n__ra_cli=${shellQuote(pin.cli)}\n__ra_version=${shellQuote(pin.version ?? "")}`;
}

// ---------------------------------------------------------------------------
// The PATH fallback (P1-D): a pinned binary that is gone is replaced by the
// `repo-aegis` on PATH, but only by one at least as new as the pin.
// ---------------------------------------------------------------------------

/** What {@link fallbackVerdict} says about the `repo-aegis` found on PATH. */
export type FallbackVerdict = "ok" | "older" | "unparsable";

/** The only shape a PATH `repo-aegis --version` may print: three numbers of at most nine digits each. */
const PLAIN_TRIPLE = /^([0-9]{1,9})\.([0-9]{1,9})\.([0-9]{1,9})$/;

/**
 * May the `repo-aegis` on PATH stand in for a pinned one that is gone?
 *
 * `pathVersion` is what `repo-aegis --version` printed; only its first line
 * counts, and that must be exactly `MAJOR.MINOR.PATCH` (so a prerelease,
 * `v0.14.0`, an empty line or a crash is `unparsable` and refused).
 * `pinned` is the recorded version with any `-prerelease` / `+build` suffix
 * dropped, which can only raise the floor, so it errs on the safe side.
 * `ok` iff the PATH triple is at least the pinned one, compared numerically
 * (0.9.0 is older than 0.14.0).
 *
 * The rendered `sh` ({@link fallbackVerdictShell}) must agree with this on
 * every input; `enforcement-pin.test.ts` runs both over one table.
 */
export function fallbackVerdict(pathVersion: string, pinned: string): FallbackVerdict {
  const have = PLAIN_TRIPLE.exec(pathVersion.split("\n", 1)[0] ?? "");
  const want = PLAIN_TRIPLE.exec(pinned.replace(/[-+].*$/s, ""));
  if (have === null || want === null) return "unparsable";
  for (let i = 1; i <= 3; i++) {
    const d = Number(have[i]) - Number(want[i]);
    if (d !== 0) return d > 0 ? "ok" : "older";
  }
  return "ok";
}

/** `sh` statements (one line each) that set `<p>ok`, `<p>a`, `<p>b`, `<p>c` from the variable `v`, as {@link PLAIN_TRIPLE} does. */
function tripleShell(v: string, p: string): string[] {
  const long = "??????????*"; // ten or more characters: more than nine digits
  return [
    `${p}ok=0`,
    `case "$${v}" in ''|*[!0-9.]*|.*|*.|*..*|*.*.*.*) ;; *.*.*) ` +
      `${p}a=\${${v}%%.*}; ${p}r=\${${v}#*.}; ${p}b=\${${p}r%%.*}; ${p}c=\${${p}r#*.}; ` +
      `case "$${p}a" in ${long}) ;; *) case "$${p}b" in ${long}) ;; *) case "$${p}c" in ${long}) ;; *) ${p}ok=1 ;; esac ;; esac ;; esac ;; esac`,
  ];
}

/**
 * POSIX `sh` statements (one line each, safe to join with newlines or `; `)
 * that read `__ra_fv` (the first line `repo-aegis --version` printed) and
 * `__ra_version` (the pinned version) and set `__ra_fverdict` to `ok`,
 * `older` or `unparsable`: {@link fallbackVerdict}, in shell. Numeric
 * comparison goes through `[ -gt ]`, never a string comparison.
 */
export function fallbackVerdictShell(): string[] {
  return [
    `__ra_pv=\${__ra_version%%[-+]*}`,
    ...tripleShell("__ra_fv", "__ra_h"),
    ...tripleShell("__ra_pv", "__ra_p"),
    `__ra_fverdict=unparsable`,
    `if [ "$__ra_hok" = 1 ] && [ "$__ra_pok" = 1 ]; then ` +
      `if [ "$__ra_ha" -gt "$__ra_pa" ] || { [ "$__ra_ha" -eq "$__ra_pa" ] && { [ "$__ra_hb" -gt "$__ra_pb" ] || ` +
      `{ [ "$__ra_hb" -eq "$__ra_pb" ] && [ "$__ra_hc" -ge "$__ra_pc" ]; }; }; }; ` +
      `then __ra_fverdict=ok; else __ra_fverdict=older; fi; fi`,
  ];
}

interface FallbackSelect {
  /** Start of the refusal line, for example `pre-commit blocked`. */
  blocked: string;
  /** The command that re-pins, for example `repo-aegis install hooks`. */
  fix: string;
  /** Exit status for the refusals. */
  exitCode: number;
  /** Text appended to every message (the managed drop-in names the file to remove). */
  tail?: string;
}

/**
 * `sh` statements (one line each) that run once the pin is NOT usable and
 * `__ra_missing` (what is missing) and `__ra_version` (the pin's version) are
 * set. They either exit with `exitCode` after saying why, or leave `__ra_fb`
 * set to the absolute path of a `repo-aegis` that is at least as new as the
 * pin, after a WARNING. `--version` runs with stdin closed: a hook's stdin is
 * the payload (or git's ref list) and must not be eaten. Nothing the PATH
 * binary printed is echoed.
 */
function fallbackSelect(o: FallbackSelect): string[] {
  const q = shellQuote;
  const say = (...words: string[]): string => `printf '${"%s".repeat(words.length)}\\n' ${words.join(" ")} >&2`;
  const head = q(`repo-aegis: ${o.blocked}: the pinned enforcement binary is missing or not usable (`);
  const tail = `${o.fix}${o.tail ?? ""}`;
  const missing = `"$__ra_missing"`;
  const fb = `"$__ra_fb"`;
  const fv = `"$__ra_fv"`;
  const ver = `"$__ra_version"`;
  const stop = `; exit ${o.exitCode}`;
  return [
    `__ra_fb=$(command -v repo-aegis 2>/dev/null) || __ra_fb=""`,
    // An absolute path only: `command -v` can also print a function or builtin name.
    `case "$__ra_fb" in /*) ;; *) __ra_fb="" ;; esac`,
    `if [ -z "$__ra_fb" ]; then ${say(head, missing, q(`) and no repo-aegis is on PATH. Re-pin it by running: ${tail}`))}${stop}; fi`,
    `if [ -z "$__ra_version" ]; then ${say(
      head,
      missing,
      q(`), and this hook was installed without a recorded version, so it does not fall back to the repo-aegis on PATH. Re-pin it by running: ${tail}`),
    )}${stop}; fi`,
    // No pipe, so a non-zero exit from `--version` reads as no version on sh, dash and bash alike (a pipeline's
    // status is its last command's). Then the first line, by parameter expansion on a newline built without a
    // literal one, so the statement stays one line.
    `__ra_fv=$(${fb} --version 2>/dev/null </dev/null) || __ra_fv=""`,
    `__ra_nl=$(printf '\\nx'); __ra_nl=\${__ra_nl%x}; __ra_fv=\${__ra_fv%%"$__ra_nl"*}`,
    ...fallbackVerdictShell(),
    `if [ "$__ra_fverdict" = older ]; then ${say(
      head,
      missing,
      q(`), and the repo-aegis on PATH (`),
      fb,
      q(") is "),
      fv,
      q(", older than the pinned "),
      ver,
      q("; an older repo-aegis may not read this machine's registry. Install "),
      ver,
      q(` or later, then run: ${tail}`),
    )}${stop}; fi`,
    `if [ "$__ra_fverdict" != ok ]; then ${say(
      head,
      missing,
      q(`), and the repo-aegis on PATH (`),
      fb,
      q(") did not report a plain MAJOR.MINOR.PATCH version (pinned "),
      ver,
      q(`). Re-pin it by running: ${tail}`),
    )}${stop}; fi`,
    say(
      q("repo-aegis: WARNING: the pinned enforcement binary is missing or not usable ("),
      missing,
      q("); running "),
      fb,
      q(" ("),
      fv,
      q(", pinned "),
      ver,
      q(`) instead. Re-pin it by running: ${tail}`),
    ),
  ];
}

/** What to say and do when a pinned file is missing. */
export interface PinGuardOptions {
  /** Start of the refusal line, for example `pre-commit blocked`. */
  blocked: string;
  /** The command that re-pins, for example `repo-aegis install hooks`. */
  fix: string;
  /** Exit status for the refusals. */
  exitCode: number;
}

/**
 * Shell text for a script that has run {@link pinAssignments}. When the pinned
 * node is an executable file and the pinned CLI a readable file it does nothing
 * and the script runs the pin, never looking at PATH. Otherwise it falls back to
 * the `repo-aegis` on PATH only if that is at least as new as the pinned
 * version (`__ra_version`), after a WARNING that names both versions, and
 * refuses (`exitCode`) in every other case: nothing on PATH, a version that is
 * older or not a plain MAJOR.MINOR.PATCH, or a pin with no recorded version.
 * The script then calls the CLI as
 * `if [ -n "$__ra_fb" ]; then "$__ra_fb" …; else "$__ra_node" "$__ra_cli" …; fi`.
 * There is deliberately no environment variable that skips any of this: an
 * agent could set one. A person re-runs the installer.
 */
export function pinGuard(opts: PinGuardOptions): string {
  const select = fallbackSelect(opts)
    .map(line => `  ${line}`)
    .join("\n");
  return `\
__ra_fb=""
__ra_missing=""
if [ ! -f "$__ra_node" ] || [ ! -x "$__ra_node" ]; then
  __ra_missing="$__ra_node"
fi
if [ ! -f "$__ra_cli" ] || [ ! -r "$__ra_cli" ]; then
  __ra_missing="\${__ra_missing:+$__ra_missing, }$__ra_cli"
fi
if [ -n "$__ra_missing" ]; then
${select}
fi`;
}

/**
 * The pin a generated script was rendered for, read back from its
 * `__ra_node=` / `__ra_cli=` / `__ra_version=` lines; null for a script with no
 * pin (an older, unpinned install) or lines that are not a single quoted word.
 * The version is optional: absent when the line is missing, empty or not a
 * version (the script then does not fall back to PATH).
 */
export function parsePinFromScript(text: string): EnforcementPin | null {
  const node = /^__ra_node=(.*)$/m.exec(text);
  const cli = /^__ra_cli=(.*)$/m.exec(text);
  if (node === null || cli === null) return null;
  const n = shellUnquote(node[1]!);
  const c = shellUnquote(cli[1]!);
  if (n === null || c === null) return null;
  const versionLine = /^__ra_version=(.*)$/m.exec(text);
  const version = versionLine === null ? null : shellUnquote(versionLine[1]!);
  return version !== null && PIN_VERSION_PATTERN.test(version) ? { node: n, cli: c, version } : { node: n, cli: c };
}

/**
 * A Claude Code hook `command` that runs `hookArgs` (for example
 * `hook guard-egress --agent claude`) on the pinned CLI, written for a POSIX
 * `sh -c`: shell-quoted absolute paths, no bash-only syntax.
 *
 * It fails CLOSED with exit 2 when the pinned node or CLI is gone and no
 * `repo-aegis` at least as new as the pin is on PATH (see {@link pinGuard}). A
 * missing command would otherwise exit 127, which Claude Code treats as a
 * non-blocking hook error: the hook would simply not run and the tool call would
 * proceed. Exit 2 blocks. `exec` hands stdin (the tool call) straight to the CLI.
 * The fallback comes after the `fi;` of the pinned `exec`, so the command still
 * starts with `if [ -f ` and ends with `; exit 2` ({@link isPinnedHookCommand}).
 *
 * `failOpen` is for the one hook that must NEVER block: the UserPromptSubmit hook that revokes prompt approvals (exit 2
 * there would swallow the person's own message, leaving them unable to ask for the fix). It exits 0 instead (the
 * command then ends with `; exit 0`). Nothing is lost: with the pin gone the guard hook blocks, so no approval is written.
 */
export function pinnedHookCommand(pin: EnforcementPin, hookArgs: string, opts: { failOpen?: boolean } = {}): string {
  assertPinnable(pin);
  const n = shellQuote(pin.node);
  const c = shellQuote(pin.cli);
  return (
    `if [ -f ${n} ] && [ -x ${n} ] && [ -f ${c} ] && [ -r ${c} ]; then exec ${n} ${c} ${hookArgs}; fi; ` +
    `__ra_version=${shellQuote(pin.version ?? "")}; __ra_missing=${shellQuote(`${pin.node}, ${pin.cli}`)}; ` +
    `${fallbackSelect({ blocked: "hook blocked", fix: "repo-aegis install claude-md", exitCode: opts.failOpen === true ? 0 : 2 }).join("; ")}; ` +
    // Tells the fallback it is one (the hook then shows the person a notice: exit-0 stderr is dropped).
    `REPO_AEGIS_PIN_FALLBACK=1; export REPO_AEGIS_PIN_FALLBACK; exec "$__ra_fb" ${hookArgs}; exit ${opts.failOpen === true ? 0 : 2}`
  );
}

/** True when `command` is a {@link pinnedHookCommand} that runs `hookName` (for example `guard-egress`). */
export function isPinnedHookCommand(command: string, hookName: string): boolean {
  return (
    command.startsWith("if [ -f ") &&
    command.includes("; then exec ") &&
    command.includes(` hook ${hookName}`) &&
    (command.endsWith("; exit 2") || command.endsWith("; exit 0"))
  );
}

// ---------------------------------------------------------------------------
// The managed drop-in's hook commands (doc/plan-pin-enforcement-binary.md D8)
// ---------------------------------------------------------------------------

/** The `id` the managed hook commands ask for the account's uid. By absolute path: a `PATH` lookup could be shadowed. */
export const MANAGED_ID_PATH = "/usr/bin/id";

/** Where a managed hook command runs, and what it names when it blocks. */
export interface ManagedHookContext {
  /** The uid of the account the drop-in is for, digits only. */
  uid: string;
  /** Absolute path of the drop-in file: the exit-2 message tells the person to `sudo rm` it. */
  dropinPath: string;
  /** Test seam: the `id` to run, default {@link MANAGED_ID_PATH}. */
  idPath?: string;
  /** The hook must never block (see {@link pinnedHookCommand}): a failing `id` or a missing pin exits 0, not 2. */
  failOpen?: boolean;
}

/**
 * A hook `command` for the managed-settings drop-in: {@link pinnedHookCommand}
 * behind a uid guard, in POSIX `sh` (dash on Debian and Ubuntu). Its PATH
 * fallback and refusals say the same things, plus the command that removes it.
 *
 * A managed file applies to every account on the machine but the pin names one
 * account's node and CLI, so a hook must do nothing for the others. The guard
 * asks `/usr/bin/id` by absolute path (D8.4): a `PATH` lookup, or a failing
 * `id`, must not turn into a pass, so a failing `id` blocks (exit 2) and a
 * different uid exits 0. The guard comes BEFORE the pin check: another account
 * often cannot even see the pin (home directories are 0750).
 *
 * The blocking message names both ways out (D8.10): re-pin, or remove the
 * root-owned file, whose literal path it prints. The user cannot edit that file.
 */
export function managedHookCommand(pin: EnforcementPin, hookArgs: string, ctx: ManagedHookContext): string {
  assertPinnable(pin);
  if (!/^[0-9]+$/.test(ctx.uid)) throw new Error("the uid is not a number");
  if (/[\n\r\0]/.test(ctx.dropinPath)) throw new Error("the drop-in path contains a newline or NUL character");
  const n = shellQuote(pin.node);
  const c = shellQuote(pin.cli);
  const remove = `sudo rm ${shellQuote(ctx.dropinPath)}`;
  const idFailed = shellQuote(
    `repo-aegis: cannot tell which user this is (${ctx.idPath ?? MANAGED_ID_PATH} failed), so this managed hook blocks the tool call; ` +
      `to remove it run: ${remove}`,
  );
  const code = ctx.failOpen === true ? 0 : 2;
  return (
    `__u=$(${ctx.idPath ?? MANAGED_ID_PATH} -u 2>/dev/null) || { printf '%s\\n' ${idFailed} >&2; exit ${code}; }; ` +
    `[ "$__u" = ${ctx.uid} ] || exit 0; ` +
    `if [ -f ${n} ] && [ -x ${n} ] && [ -f ${c} ] && [ -r ${c} ]; then exec ${n} ${c} ${hookArgs}; fi; ` +
    `__ra_version=${shellQuote(pin.version ?? "")}; __ra_missing=${shellQuote(`${pin.node}, ${pin.cli}`)}; ` +
    `${fallbackSelect({
      blocked: "hook blocked",
      fix: "repo-aegis install claude-md",
      exitCode: code,
      tail: `   or remove this managed hook: ${remove}`,
    }).join("; ")}; ` +
    // Tells the fallback it is one (the hook then shows the person a notice: exit-0 stderr is dropped).
    `REPO_AEGIS_PIN_FALLBACK=1; export REPO_AEGIS_PIN_FALLBACK; exec "$__ra_fb" ${hookArgs}; exit ${code}`
  );
}

/** True when `command` is a {@link managedHookCommand} that runs `hookName` (for example `guard-egress`). */
export function isManagedHookCommand(command: string, hookName: string): boolean {
  return (
    command.startsWith("__u=$(") &&
    command.includes(" -u 2>/dev/null) || { printf '%s\\n' ") &&
    command.includes("; then exec ") &&
    command.includes(` hook ${hookName}`) &&
    (command.endsWith("; exit 2") || command.endsWith("; exit 0"))
  );
}
