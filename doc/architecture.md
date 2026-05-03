# Architecture

> Workspace packages, how they compose, and what's shipped vs. what's
> still on the roadmap. The deeper as-built design + threat model
> lives in [design/README.md](design/README.md).

## Workspace packages

The monorepo has six packages plus a thin Action wrapper.

- **`@de-otio/repo-aegis-core`** — the registry / deny-set / scanner
  library. Hot-path code only — deterministic, free of LLM
  dependencies. The import-graph guard test in
  [`packages/core/src/import-graph.test.ts`](../packages/core/src/import-graph.test.ts)
  enforces this property.
- **`@de-otio/repo-aegis`** — the developer CLI: blocks leaks at
  commit time on the developer machine. Feature-complete.
- **`@de-otio/repo-aegis-scan`** — the centralised Layer-2 sweep:
  reads queries from a YAML file, runs them against GitHub
  code-search, filters out previously-seen hits via an atomic state
  file. Output formats: JSON, markdown report, or filed GitHub
  issue. Phase 3 adds opt-in `--semantic` mode and `rebuild-profiles`
  verb. Deployment (the scheduled GitHub Action, encrypted query
  list, and state file) lives in a private repo of the operator's
  choosing — see
  [data-leaks-on-github/code-search-solution.md](https://github.com/de-otio/dot-notes/blob/main/doc/topics/data-leaks-on-github/code-search-solution.md).
- **`@de-otio/repo-aegis-llm`** — LLM-assisted helpers (Ollama HTTP
  client, prose extraction, token synthesis, embedding profiles).
  Off the deterministic gate path: only consumed by the CLI's
  `suggest-markers` verb and the scanner's `--semantic` /
  `rebuild-profiles` verbs. See
  [packages/llm/README.md](../packages/llm/README.md).
- **`repo-aegis-vscode`** — VSCode extension: surfaces the CLI's
  status and scan output in the editor (status bar, diagnostics,
  commands). View-only — the deterministic gate stays in the git
  hooks and the Claude Code PostToolUse hook.
- **`@de-otio/repo-aegis-mcp`** — Model Context Protocol server
  exposing the core library as agent-readable tools (status, check,
  audit, markers test, engagements list/show, classify-first-touch).
  Same JSON shapes as the CLI, no `--verbose` path, redaction policy
  enforced at the tool boundary. See
  [packages/mcp/README.md](../packages/mcp/README.md).

Plus a thin wrapper:

- **`de-otio/repo-aegis` GitHub Action (composite)** — `uses:
  de-otio/repo-aegis@v1` in a workflow installs the CLI and runs
  `audit` (or any subcommand) against the consuming repo. See
  [github-action.md](github-action.md).

All packages share the same marker list and engagement registry, so
a string is identified as a leak by the same logic at every layer.

## How it composes

- **Pre-commit / pre-push hooks** shell out to `repo-aegis check
  --staged` and `--range` and translate exit code into the user-facing
  block.
- **Claude Code PostToolUse hook** (registered as `repo-aegis hook
  scan-after-write` in `~/.claude/settings.json`) does the same per
  Write/Edit/MultiEdit. The hook is path-aware: it resolves the
  destination working tree from the written path (not from the
  launcher's `cwd`) and applies *that* repo's rules, so cross-repo
  writes inside the same trust boundary just work. Writes whose
  destination crosses an org boundary are refused with
  `CROSS_ORG_WRITE`. See [agent-guide.md](agent-guide.md) for how
  agents react to that error code.
- **Claude Code SessionStart hook** (`repo-aegis hook first-touch`)
  classifies a previously-unclassified repo from its git remote +
  registry org membership, prompting the user only when the org is
  unknown.
- **Central registry** (`~/.config/repo-aegis/engagements.yaml`)
  tracks engagement → markers → start/end dates → orgs.
  Per-engagement marker files
  (`~/.config/repo-aegis/markers/<id>.txt`) are generated from it.

## Roadmap

### Already shipped

- **Phase 1 — zero-config onboarding.** Org-keyed JIT classification
  on first agent touch (`hook first-touch` + `engagements add
  --github-org`).
- **Phase 2 — LLM-assisted marker discovery.** `suggest-markers`
  proposes customer tokens via a local Ollama model. The
  deterministic gate remains regex-only.
- **Phase 3 — semantic audit sweep.** `repo-aegis-scan --semantic` /
  `rebuild-profiles`. Off-machine, asynchronous, advisory. Hot-path
  determinism is preserved — see
  [design/zero-config-onboarding.md](design/zero-config-onboarding.md).
- **Path-aware PostToolUse hook.** Cross-tree writes inside a shared
  trust boundary scan against the destination's rules; cross-org
  writes are refused.
- **One-command uninstall** (`repo-aegis uninstall`) with `--purge-repos`
  and `--purge-home` opt-ins.
- **`re2` regex backend** for hard ReDoS resistance — install the
  optional `re2` dependency and `getRegexBackend()` reports `"re2"`.
  Falls back to the in-process time-budget heuristic when re2 is
  unavailable.
- **Age-encrypted registry** — `repo-aegis registry encrypt
  --recipient <pubkey>` / `decrypt --identity <path>`.
- **Operator audit log** — `repo-aegis audit-log on/off/show/path`
  (off by default).
- **MCP server, VSCode extension, GitHub Action** — all in this
  monorepo.

### Designed but not yet implemented

- **Network-isolated mode** for `audit --published` (mirror registry).
- **Auto-decrypt-on-demand** for `repo-aegis registry decrypt` so
  single commands that need the registry can fetch credentials inline
  rather than requiring an explicit decrypt step.
