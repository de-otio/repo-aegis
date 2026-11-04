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

| D8 | **Claude Code enforcement goes into a managed-settings drop-in, not the user's settings file** (added 2026-11-04). See §2.1 |

### 2.1 D8: managed drop-in

Why: D4 and D7 make the user's `~/.claude/settings.json` machine-specific, but people share that file across machines (dotfiles, symlinks into a repo). Claude Code merges hook entries and `permissions` lists across all scopes. User and project settings cannot remove or disable a managed hook (`disableAllHooks` outside managed settings does not reach them). Everything repo-aegis writes can therefore live in one file that belongs to the machine. The user's file then holds only portable preferences. The drop-in is root-owned, so an agent cannot edit it, which is stronger than a deny rule in a file the same user owns.

| # | Rule |
|---|---|
| D8.1 | Target per platform: macOS `/Library/Application Support/ClaudeCode/managed-settings.d/50-repo-aegis.json`, Linux (and WSL) `/etc/claude-code/managed-settings.d/50-repo-aegis.json`. Other platforms: D8.6 |
| D8.2 | The content is what D4 and D7 render today: the hook commands, the registry deny rules, the pin deny rules. Deny paths use `//` absolute form (a `/` rule in a managed file is not anchored at the filesystem root) |
| D8.3 | Writing needs root. `install claude-md` refuses without a TTY (person present). It renders the JSON in-process and runs `sudo install -d -m 0755 <dir>` and `sudo tee <file>` with the JSON on stdin; `sudo` never runs node or repo-aegis code, and no staged file exists that an agent could swap between rendering and writing. Mode `0644`, owner uid 0, group gid 0 (numeric: `wheel` on macOS, `root` on Linux). It reads the file back and compares digests |
| D8.4 | **Multi-user machines.** A managed file applies to every account on the machine, but the pin points at one user's Node and CLI. Each hook command starts with a uid guard: `[ "$(id -u)" = <uid> ] \|\| exit 0`, so other accounts are unaffected (they have no repo-aegis registry). One drop-in per uid: `50-repo-aegis-<uid>.json` |
| D8.5 | Migration: after a successful managed write, `install claude-md` removes its own earlier entries (hooks and deny rules, by ledger) from `~/.claude/settings.json` |
| D8.9 | **Uninstall leaves nothing behind.** `install claude-md --uninstall` (TTY required) removes, in this order: this uid's drop-in; `managed-settings.d/` only if it is now empty **and** the ledger says repo-aegis created it; the `ClaudeCode` / `claude-code` system directory under the same two conditions; then its entries in the user file. It never touches `managed-settings.json`, other drop-ins, or other uids' drop-ins. It reads back afterwards: the drop-in path must not exist, else exit 1 naming the path. The ledger entry (`state/claude-md-managed.json`: path, digest, dirs created) is written before the privileged write and removed only after a verified removal |
| D8.10 | **No lockout.** A fail-closed managed hook whose pin is gone (CLI removed with `npm rm -g` without uninstalling first, Node removed) would block that user's agent on every call, and the user cannot edit a root-owned file. So the exit-2 message names both fixes: re-pin (`repo-aegis install claude-md`) **or** remove it (`sudo rm '<drop-in path>'`, the literal path). `doc/configuration.md` has the same recovery. Uninstall order is documented: `repo-aegis install claude-md --uninstall` before `npm rm -g repo-aegis`. npm lifecycle scripts are not relied on (they do not run reliably on `npm rm -g` and cannot prompt for `sudo`) |
| D8.11 | Doctor `MANAGED_DROPIN_ORPHANED`: a `50-repo-aegis-<uid>.json` exists for this uid but the ledger has no entry, or its pins point at missing files; prints the `sudo rm` line |

### 2.2 D8: the privileged step

The only root action repo-aegis takes. It runs once per machine, and again after each re-pin or uninstall. Each of the rules below is a must-pass item for the security review.

| # | Rule | Threat it closes |
|---|---|---|
| P1 | `sudo` and every command it runs are resolved by **absolute path** (`/usr/bin/sudo`; `/bin/mkdir`, `/usr/bin/tee`, `/bin/chmod`, `/usr/sbin/chown` or `/bin/chown`, `/bin/rm`, `/bin/mv`, chosen per platform). Each must be a regular file owned by uid 0 that is not group- or world-writable. Otherwise refuse | A `sudo` planted earlier on `PATH` by an agent would capture the person's password |
| P2 | Root runs only those fixed commands, with fixed arguments. The only computed parts are the destination directory (a platform constant), the uid (an integer from `process.getuid()`) and a temp name in the same directory. No shell under `sudo` (`sh -c` is never used), no `SUDO_ASKPASS`, and no inherited environment beyond what `sudo`'s `env_reset` keeps | Argument or shell injection into a root process |
| P3 | Content goes in through stdin: `sudo tee <dir>/.50-repo-aegis-<uid>.json.tmp` (a hidden name, which Claude Code ignores), then `chown 0:0`, `chmod 0644`, and `mv` into place. That's an atomic replace inside a root-owned directory. Nothing is staged in a user-writable location | An agent swapping a staged file between render and copy (TOCTOU) |
| P4 | Before `sudo`: the existing system directory, if present, must be root-owned and not group- or world-writable, as must every parent up to `/`. Otherwise refuse | Writing into a directory a non-root user controls |
| P5 | The JSON is rendered in-process and validated before writing: it parses; its only keys are `hooks` and `permissions.deny`; every hook command matches the D7 template exactly; every path passes D6. The person sees the target path, a byte count, a digest, and a diff against the current drop-in, then confirms (`y/N`, TTY) before `sudo` prompts | A bug or tampered input writing arbitrary managed policy (managed settings can also set `allowManagedHooksOnly`, `env`, and so on) |
| P6 | Read-back after writing: owner 0:0, mode 0644, digest equal. On mismatch, exit 1 and print the `sudo rm` line | A partial or interfered write going unnoticed |
| P7 | `sudo -n` is tried first only to detect "no password needed". The person is always asked to confirm (P5) before any privileged call | Silent escalation under cached sudo credentials from an agent shell. The TTY gate and P5 confirmation make that a person's act |
| P8 | Documented limit: the privileged step is only as trustworthy as the `repo-aegis` the person runs. `doc/configuration.md` tells them to check `command -v repo-aegis` and `npm ls -g repo-aegis` before running it on a machine where agents have had shell access | A planted fake `repo-aegis` asking for `sudo`. No tool can close this from inside itself |

Verification before release:
1. An independent security review of this spec (P1–P8, D8.9–D8.11) before any code is written, and again of the code against the spec.
2. Unit tests with an injected privileged runner: T20 refuses a `sudo` that isn't root-owned or is writable by others (P1); T21 confirms the argv passed to root has no shell and nothing variable beyond the uid (P2); T22 refuses a group-writable system directory (P4); T23 rejects a drop-in with a key outside the allowed set (P5); T24 confirms uninstall removes only what the ledger lists and fails if the file remains (D8.9); T25 confirms the exit-2 message contains the literal `sudo rm` path (D8.10).
3. A manual check on a real macOS machine and on a real Linux machine (Ubuntu with dash as `sh`), recorded in the PR:
   - after install: `ls -l` shows the file is root-owned; `/status` in Claude Code lists the drop-in; an agent's Edit on it is refused;
   - a second account on the Linux machine is unaffected;
   - after uninstall: no file is left, and the directories are gone if repo-aegis created them.
| D8.6 | Fallback `--user-settings`: no root, no `sudo` (containers, devcontainers), or an unsupported platform. Writes to `~/.claude/settings.json` exactly as D7, and doctor warns `ENFORCEMENT_IN_USER_SETTINGS` (the file must then stay per machine) |
| D8.7 | Doctor checks: `MANAGED_DROPIN_STALE` (file differs from what would render now), `MANAGED_DROPIN_NOT_ROOT_OWNED` (owner not 0, or group/other writable, or a parent dir not root-owned), `MANAGED_SOURCE_SHADOWED` (another managed source outranks files: on macOS a `com.anthropic.claudecode` profile under `/Library/Managed Preferences/`; Claude Code's default `first-wins` then ignores the file and drop-ins). Server-managed settings also outrank files and cannot be seen locally; `doc/configuration.md` says so |
| D8.8 | Shell: the hook command is POSIX `sh` (dash on Debian/Ubuntu, bash-as-sh on macOS). No bashisms; T14 runs under `dash` where available |

Tests (D8): T15 renders the drop-in for darwin and linux (paths, `//` deny form, uid guard). T16 runs the uid-guarded hook command as a different uid (or with the guard's uid changed): exit 0, CLI not run. T17 migration removes old user-file entries and keeps everything else in that file byte-for-byte. T18 doctor's `MANAGED_DROPIN_NOT_ROOT_OWNED` over a temp tree with a group-writable parent. T19 `--user-settings` reproduces T13. `sudo` is injected, so tests never escalate.

### 2.3 D8: tests in CI

Every D8 test (T15–T25) runs in CI, not only on a developer machine.

- **Unit tests, in `npm test` on the existing Ubuntu matrix (Node 20, 22, 24).** The platform, uid, `sudo` runner and filesystem root are injected, so the macOS and the Linux renderings, paths and ownership checks both run on the Ubuntu runner. Nothing in them escalates.
- **New job `managed-dropin-e2e`, on `ubuntu-latest` and `macos-latest`.** GitHub's runners have passwordless `sudo`, so this job does the real thing against the real system directory:
  1. `install claude-md`, driven through a pty (`script`), because the installer requires a terminal (D8.3);
  2. assert the file is owned by 0:0 with mode 0644, the digest matches, and the uid guard is present;
  3. run the rendered hook as the runner user, with the pin present (it decides) and with the pin removed (exit 2, and the message contains the literal `sudo rm` line);
  4. on Linux, run the hook as a second user (`useradd`): exit 0;
  5. `install claude-md --uninstall`: the file is gone, the directories repo-aegis created are gone, a `managed-settings.json` or another drop-in placed beforehand is untouched;
  6. `doctor` reports nothing for D8 afterwards.

  Each step has `timeout-minutes`.
- The Linux run also executes T14 and T16 under `dash` (Ubuntu's `/bin/sh`), and the macOS run under its `/bin/sh`.
- Adding the job changes `.github/workflows/ci.yml`. That is control plane, so a founder writes or approves it, and its PR goes through the admin merge path. Today CI has no macOS job, and this adds the first.

Verified 2026-11-04: before D8, the branch passes on Linux. In `node:24-bookworm` as a non-root user, `npm test` ran 3730 tests with 5 failures. `origin/main` in the same container shows the same 5 failures, all caused by the container: the source was a `git archive` with no `.git` history, and some checks need a root-owned `lsof` and real root paths. `test:shim` passes on both.

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
