# repo-aegis (VSCode extension)

> A VSCode surface for [repo-aegis](https://github.com/de-otio/repo-aegis):
> see your current repo's class and engagements in the status bar, get
> diagnostics for marker hits in open editors, and run scans without
> leaving the editor.

This extension is a **view onto repo-aegis**. The deterministic gate
against leaks is the git pre-commit / pre-push hook plus the Claude
Code PostToolUse hook installed by the CLI. The extension does **not**
block writes — it only surfaces information the CLI already produces.

## What it does

- Status bar: shows this repo's class and engagement count
  (e.g. `customer-coupled • 1`). Click for full status.
- Diagnostics: marker hits in saved files appear as warnings in the
  Problems panel and as inline squiggles. Source = `repo-aegis`.
- Commands: ad-hoc scans, status inspection, and a one-string deny-set
  probe.

The extension shells out to the `repo-aegis` CLI (configurable). It
never reads marker patterns or registry entries directly — same
redaction guarantees as the CLI.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `repo-aegis.cli` | `repo-aegis` | Path to the CLI binary (resolves through `$PATH`) |
| `repo-aegis.scanOnSave` | `true` | Run `check --path` when a file is saved |
| `repo-aegis.statusBar` | `true` | Show the status bar item |

## Commands

| Command | What it does |
|---|---|
| `repo-aegis: Check current file` | Runs `check --path` on the active editor; updates diagnostics + a notification |
| `repo-aegis: Show status` | Runs `status --json`; renders the result as a notification |
| `repo-aegis: Test a string against deny set` | Prompts for a string; runs `markers test`; reports how many patterns matched (no literals) |

## Status bar

Format: `<class> • <#engagements>`. Click → invokes
`repo-aegis: Show status`. Hidden when `repo-aegis.statusBar` is
`false` or the CLI isn't on PATH.

## Requirements

- The `repo-aegis` CLI must be installed and on PATH (or its full
  path configured via `repo-aegis.cli`). See the
  [main README](https://github.com/de-otio/repo-aegis) for install
  instructions.

## Redaction

The extension never passes `--verbose` to the CLI. Matched marker
literals are not displayed in diagnostics, notifications, or the
status bar. The same redaction policy that protects the agent
PostToolUse hook applies here.

## Why this is "view-only"

repo-aegis is a deterministic gate. The git hooks block commits with
hits; the Claude Code PostToolUse hook surfaces hits to the agent
between writes. Both are the source of truth for "did a leak slip
through". An editor extension that *also* blocked writes would either
duplicate that gate (and risk drifting from it) or replace it (and
lose coverage when the editor is closed). So this surface is
deliberately view-only — the gate stays where the leaks actually
land: the filesystem and git history.

## License

GPL-3.0-or-later. Copyright (C) 2026 Richard Myers and contributors.
