# Plan: pin the enforcement binary in hooks and the shim

Status: spec, ready to build. Branch `fix/pin-enforcement-binary`.

## 1. Problem

The generated git hooks (`packages/core/src/hook-scripts.ts`: `PRE_COMMIT_SCRIPT`, `PRE_PUSH_SCRIPT`) and the `gh` shim (`packages/cli/src/commands/shim-script.ts`: `GH_SHIM_SCRIPT`) run the CLI by **name**: `command -v repo-aegis`, then `repo-aegis check …` / `repo-aegis egress-check …`. Three consequences:

1. **Shadowing.** Whatever `repo-aegis` comes first on the caller's `PATH` decides. An agent can usually write somewhere in the user's home, and a home directory such as `~/bin` is often on `PATH`. A file `~/bin/repo-aegis` that exits 0 (or prints an allow verdict) switches off the pre-commit scan, the pre-push scan and the shim's egress check for every shell where that directory comes first. The CLI's own shebang is `#!/usr/bin/env node`, so a shadowing `node` has the same effect.
2. **Version skew.** Two installs (for example one under a Node version manager and one under a package manager's global prefix) mean the person's terminal and the agent's shell enforce different versions. Seen in practice: the person's terminal ran an older version without rule h and without the `install claude-md` deny-rule step, so `install claude-md` reported success and protected nothing, while `doctor` (newer) kept reporting `REGISTRY_AGENT_WRITABLE`.
3. **Fail open.** If no `repo-aegis` is found, the hooks `exit 0` and the shim `exec`s the real `gh`. Removing the CLI from `PATH` removes enforcement.

## 2. Decisions

| # | Decision |
|---|---|
| D1 | At install time, `install hooks` and `install shim` resolve two absolute paths and write them into the generated script: the Node executable (`process.execPath`, realpath) and the CLI entry (realpath of the running `dist/index.js`). Every call in the script becomes `"$__ra_node" "$__ra_cli" …`. No call by name remains |
| D2 | **Fail closed.** If either pinned file is missing or not executable/readable, the pre-commit and pre-push hooks exit 1 and the shim refuses publishing verbs (exit 2); non-publishing `gh` verbs still pass through. The message names the missing path and the fix: `repo-aegis install hooks` / `repo-aegis install shim`. There is no environment variable to turn this off (an agent could set it); a person re-runs the installer |
| D3 | Staleness: the digest that `hooks-state.ts` compares is the digest of the script **as rendered for the current pin**. A hook rendered for another path, or an old unpinned hook, is reported as installed-but-stale, so `doctor` and `status` show it |
| D4 | `install claude-md` adds `Edit(//…)` deny rules for the pinned CLI **package directory** and the pinned Node executable, alongside the existing registry rules, so an agent cannot overwrite the code the pin points at. Same ledger, same uninstall path |
| D5 | `doctor` gains three checks: `ENFORCEMENT_UNPINNED` (an installed hook or shim calls `repo-aegis` by name), `ENFORCEMENT_PIN_MISSING` (a pinned path does not exist), and `MULTIPLE_INSTALLS` (more than one `repo-aegis` reachable on `PATH`, listed with each version; also warns when the first one on `PATH` is not the pinned one) |
| D6 | The pinned path is shell-quoted when rendered. A path containing a newline or NUL refuses the install (`install hooks` **and** `install shim`) |
| D7 | **The Claude Code hook commands are pinned too** (added after review). `install claude-md` writes each hook as a pinned command that fails closed: if the pinned node or CLI is missing it prints the fix and **exits 2** (a missing command would otherwise exit 127, which Claude Code treats as a non-blocking hook error, i.e. fail open). Existing `repo-aegis hook …` entries are replaced, not duplicated, and recognised by `--uninstall`. Reason: the first `PATH` entry of the agent process on a real machine is `~/.config/repo-aegis/bin`, so a `repo-aegis` file placed there replaces the `guard-egress` hook that judges every agent command |

Out of scope: the shim's existing "a guard fault (exit other than 0/2) does not block `gh`" behaviour, and anything about which `gh` binary is trusted.

## 3. Tests (write first; each must fail on `origin/main`)

| # | Test | Fails today because |
|---|---|---|
| T1 | Rendered pre-commit, pre-push and shim contain the pinned node and CLI paths, and no bare `repo-aegis ` command (static check over the rendered text) | templates call by name |
| T2 | Subprocess: a staged file with a marker hit; a fake `repo-aegis` that exits 0 first on `PATH`; run the installed pre-commit hook → still exits non-zero (the pinned CLI ran) | the fake wins |
| T3 | Same as T2 for pre-push over a commit range | the fake wins |
| T4 | Shim: fake `repo-aegis` first on `PATH` printing an allow verdict; publishing verb → the pinned `egress-check` decides | the fake wins |
| T5 | A fake `node` first on `PATH` does not change T2–T4 | `env node` resolution |
| T6 | Pinned CLI path deleted → pre-commit and pre-push exit 1 with a message naming the path and `repo-aegis install hooks` | `exit 0` |
| T7 | Pinned CLI path deleted → shim refuses `gh pr create` (exit 2) and still passes `gh --version` through | `exec` real gh |
| T8 | `hooks-state`: a hook rendered for a different pin, and an old unpinned hook, are both `current: false` | digest of the constant template |
| T9 | `doctor` with two `repo-aegis` executables on a test `PATH` reports `MULTIPLE_INSTALLS` naming both | no such check |
| T10 | `doctor` with an installed unpinned hook reports `ENFORCEMENT_UNPINNED` | no such check |
| T11 | `install claude-md --dry-run` lists deny rules for the pinned package directory and Node executable | not added |
| T12 | A pin path containing a newline makes `install hooks` and `install shim` refuse; a path with spaces and quotes round-trips | no pin |
| T13 | `install claude-md` into a temp settings file: every hook command is the pinned form; no `repo-aegis hook` by-name entry remains; re-running adds nothing; an old by-name entry is replaced; `--uninstall` removes both forms | by-name commands |
| T14 | Run the rendered `guard-egress` hook command with the pinned CLI deleted → exit 2 with the fix on stderr; with an impostor `repo-aegis` first on `PATH` → the pinned CLI still decides | exit 127 / impostor runs |

Existing tests that assert the old fail-open text or the constant-template digest are updated in the same commit as the behaviour they describe, with a note in the commit message.

## 4. Work breakdown

1. `core`: `renderHookScript(name, pin)` and `hookScriptDigest(name, pin)`; keep the template text, replacing the name calls and the fail-open branch. T1 (hooks part), T6, T8, T12.
2. `cli`: `install hooks` passes the pin; `install shim` renders the shim with it. T1 (shim), T7.
3. Subprocess tests T2–T5 (`tests/` or `*.test.ts` using a temp dir and a temp `PATH`).
4. `doctor` checks (D5): T9, T10.
5. `install claude-md` deny rules (D4): T11.
6. Docs: `doc/configuration.md` (what is pinned and why), `doc/agent-guide.md` (new doctor codes), `CHANGELOG.md` under Unreleased: hooks and shim now fail closed; after moving or upgrading Node, re-run `repo-aegis install hooks` and `repo-aegis install shim`.

## 5. Rollout note

Existing installs keep their unpinned scripts until a person re-runs the installers; `doctor` reports them (`ENFORCEMENT_UNPINNED`). A Node upgrade through a version manager changes `process.execPath`, which now blocks commits and pushes until the installers are re-run; the refusal says exactly what to run.

The Claude Code settings file that `install claude-md` writes now holds machine-specific absolute paths (D4, D7). It must be a per-machine file. A settings file synced or symlinked from a shared repository breaks every other machine (each hook exits 2) and is rewritten by whichever machine ran the installer last. `doc/configuration.md` says so.
