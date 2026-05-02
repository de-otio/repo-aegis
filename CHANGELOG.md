# Changelog

All notable changes to repo-aegis are documented here.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-05-02

First published release. Engagement-scoped leak prevention for multi-customer
git repos: classify a repo, declare which engagements it serves, and refuse
to commit, push, or surface anything that names an unrelated engagement.

### Added

- Core CLI scaffold: `repo-aegis init`, `classify`, `context`.
- `repo-aegis install` for git hooks, `.gitignore` entries, CI workflow, and
  `CLAUDE.md` integration snippets.
- `repo-aegis markers list` and `repo-aegis markers test` for inspecting and
  probing the active deny set.
- `repo-aegis engagements add`, `engagements end`, and `engagements show` for
  managing the scoped engagement registry.
- `repo-aegis audit` composite repo-health command.
- `repo-aegis check --range` and `repo-aegis check --history` for batched
  pre-push and CI-time scans across commit ranges.
- `repo-aegis check --since` for explicit history lower-bound scans.
- `.repo-aegis.yml` per-repo overrides and per-line `repo-aegis-allow`
  comments for documented exceptions.
- `repo-aegis audit --org` and `repo-aegis audit --published` for scanning
  org membership and published artefacts (npm tarballs, VSIX bundles).
- `@de-otio/repo-aegis-scan` package: org-wide GitHub code-search sweep with
  markdown and GitHub-issue output formats.
- `repo-aegis scan run --output-format markdown` and `--output-format issue`.
- `repo-aegis scan encrypt-query` and `scan decrypt-query` (age-based
  wrappers) for shareable encrypted scan inputs.
- `@de-otio/repo-aegis-mcp` server for Model Context Protocol coding-agent
  integration (Claude Code, Cursor, etc.).
- `repo-aegis-vscode` extension for editor-side diagnostic display.
- GitHub Action (`uses: de-otio/repo-aegis@v1`) for drop-in CI integration.
- Optional age-encrypted engagement registry via `repo-aegis registry encrypt`
  and `repo-aegis registry decrypt`.
- Optional operator audit log via `repo-aegis audit-log on|off|show|path`
  (compliance trail of who ran what when).
- Optional `re2` regex backend for linear-time pattern matching on adversarial
  inputs (graceful fallback to native RegExp when `re2` is not installed).
- `repo-aegis hook scan-after-write` subcommand for Claude Code PostToolUse
  integration.
- Universal CLI flags (`--quiet`, `--json`, `--no-color`) across subcommands.
- `repo-aegis engagements remove --hard` for permanent removal, complementing
  the default soft-end.
- `repo-aegis render --retention-months` for time-bounded report rendering.
- Concurrent-write safety via `withLock` around all on-disk state mutations.
- On-disk deny-set cache for fast repeated scans.
- Strict regex validation (subprocess-isolated) to reject patterns that risk
  catastrophic backtracking before they reach the hot path.
- Schema-versioned on-disk state with forward-compatible migrations.
- Zod-validated registry and state schemas at every read boundary.
- Streaming `scanRange` and single-pass `scanHistory` for large commit ranges.
- Diff-based scanning (`parse-diff`) so only touched lines are re-scanned in
  hook and CI contexts.
- 429 / rate-limit handling for GitHub API calls in `scan` and `audit --org`.
- Pruning of stale entries from on-disk seen-marker state.
- CI matrix covering Node 20, 22, and 24, with coverage gating on Node 24.

### Changed

- `repo-aegis init` now wires `installHooks` and `installClaudeMd` end-to-end
  by default, so a fresh init produces a fully-armed repo.
- Audit output renders a structured scan summary; markdown and issue formats
  share a common renderer.
- `repo-aegis install` refactored so the CI installer is reusable from
  `audit` and from external integrations.

### Fixed

- Pre-push hook no longer silently no-ops when the test glob doesn't match.
- Comment-strip pre-pass no longer discards lines that happen to contain a
  substring matching a comment marker.
- `ScanHit.engagement` now correctly attributes hits to the engagement that
  owns the matched marker (was previously empty in some multi-engagement
  layouts).
- `bin` name in package metadata now matches the documented hook command.
- Test-glob silent-skip behaviour replaced with an explicit error.

### Security

- Hardened `audit --published` against zip-slip attacks on extracted
  archives (npm tarballs and VSIX bundles).
- Subprocess-backed regex validation prevents user-supplied patterns from
  hanging the main process via catastrophic backtracking.
- Redaction pre-pass is now applied before any pattern is logged, including
  in error paths and audit-log entries.
- Hook templates avoid shell-injection by passing arguments via argv arrays
  rather than interpolating into a `sh -c` string.
- `init` takes a per-repo lock so concurrent `init` invocations cannot race
  and produce a half-written registry.

[Unreleased]: https://github.com/de-otio/repo-aegis/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/de-otio/repo-aegis/releases/tag/v0.1.0

See the full release history at
<https://github.com/de-otio/repo-aegis/releases>.
