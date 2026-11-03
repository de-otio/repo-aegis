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
}

/** Why `pin` cannot be rendered into a shell script, or null when it can. */
export function pinProblem(pin: EnforcementPin): string | null {
  for (const [label, value] of [["node", pin.node], ["cli", pin.cli]] as const) {
    if (value === "") return `the pinned ${label} path is empty`;
    // A newline or NUL cannot be quoted into one assignment line that the
    // doctor check reads back, and no real install path holds one: refuse
    // rather than render something a parser and the shell might read differently.
    if (/[\n\r\0]/.test(value)) return `the pinned ${label} path contains a newline or NUL character`;
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
 * The two assignment lines every pinned script starts its pin section with.
 * `__ra_node` and `__ra_cli` are the ONLY names the scripts call the CLI by.
 */
export function pinAssignments(pin: EnforcementPin): string {
  assertPinnable(pin);
  return `__ra_node=${shellQuote(pin.node)}\n__ra_cli=${shellQuote(pin.cli)}`;
}

/** What to say and do when a pinned file is missing. */
export interface PinGuardOptions {
  /** Start of the refusal line, for example `pre-commit blocked`. */
  blocked: string;
  /** The command that re-pins, for example `repo-aegis install hooks`. */
  fix: string;
  /** Exit status for the refusal. */
  exitCode: number;
}

/**
 * Shell text that refuses (fail closed) when the pinned node is not an
 * executable file or the pinned CLI is not a readable file, naming each
 * missing path. There is deliberately no environment variable that skips it:
 * an agent could set one. A person re-runs the installer.
 */
export function pinGuard(opts: PinGuardOptions): string {
  return `\
__ra_missing=""
if [ ! -f "$__ra_node" ] || [ ! -x "$__ra_node" ]; then
  __ra_missing="$__ra_node"
fi
if [ ! -f "$__ra_cli" ] || [ ! -r "$__ra_cli" ]; then
  __ra_missing="\${__ra_missing:+$__ra_missing, }$__ra_cli"
fi
if [ -n "$__ra_missing" ]; then
  printf 'repo-aegis: ${opts.blocked}: the pinned enforcement binary is missing or not usable: %s\\n' "$__ra_missing" >&2
  printf 'repo-aegis: re-pin it by running: ${opts.fix}\\n' >&2
  exit ${opts.exitCode}
fi`;
}

/**
 * The pin a generated script was rendered for, read back from its
 * `__ra_node=` / `__ra_cli=` lines; null for a script with no pin (an older,
 * unpinned install) or lines that are not a single quoted word.
 */
export function parsePinFromScript(text: string): EnforcementPin | null {
  const node = /^__ra_node=(.*)$/m.exec(text);
  const cli = /^__ra_cli=(.*)$/m.exec(text);
  if (node === null || cli === null) return null;
  const n = shellUnquote(node[1]!);
  const c = shellUnquote(cli[1]!);
  return n === null || c === null ? null : { node: n, cli: c };
}

/**
 * A Claude Code hook `command` that runs `hookArgs` (for example
 * `hook guard-egress --agent claude`) on the pinned CLI, written for a POSIX
 * `sh -c`: shell-quoted absolute paths, no bash-only syntax.
 *
 * It fails CLOSED with exit 2 when the pinned node or CLI is gone. A missing
 * command would otherwise exit 127, which Claude Code treats as a non-blocking
 * hook error: the hook would simply not run and the tool call would proceed.
 * Exit 2 blocks. `exec` hands stdin (the tool call) straight to the CLI.
 */
export function pinnedHookCommand(pin: EnforcementPin, hookArgs: string): string {
  assertPinnable(pin);
  const n = shellQuote(pin.node);
  const c = shellQuote(pin.cli);
  return (
    `if [ -f ${n} ] && [ -x ${n} ] && [ -f ${c} ] && [ -r ${c} ]; then exec ${n} ${c} ${hookArgs}; fi; ` +
    `printf 'repo-aegis: the pinned enforcement binary is missing or not usable (%s, %s); ` +
    `re-pin it by running: repo-aegis install claude-md\\n' ${n} ${c} >&2; exit 2`
  );
}

/** True when `command` is a {@link pinnedHookCommand} that runs `hookName` (for example `guard-egress`). */
export function isPinnedHookCommand(command: string, hookName: string): boolean {
  return (
    command.startsWith("if [ -f ") &&
    command.includes("; then exec ") &&
    command.includes(` hook ${hookName}`) &&
    command.endsWith("; exit 2")
  );
}
