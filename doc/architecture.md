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
  verb. Deployment is packaged as the `actions/scan` composite
  Action, with a reference workflow in
  [`examples/scheduled-sweep.yml`](../examples/scheduled-sweep.yml). It should
  still be **deployed from a private repo** — that is a security property, not
  an unfinished chore: the query strings ARE the customer markers, the state
  file records where matches were found, and a code-search token spans every
  org the operator can read. See
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

Plus two composite Actions:

- **`de-otio/repo-aegis`** — `uses: de-otio/repo-aegis@v1` installs the CLI
  and runs `audit` (or any subcommand) against the consuming repo. Fails
  closed on an empty deny set and redacts engagement attribution by default.
- **`de-otio/repo-aegis/actions/scan`** — the scheduled Layer-2 sweep:
  age-decrypts a queries file into `RUNNER_TEMP`, runs
  `repo-aegis-scan run`, files new hits as an issue.

Both are documented in [github-action.md](github-action.md), with reference
workflows in [`examples/`](../examples/).

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
- **MCP server, VSCode extension, GitHub Actions** — all in this
  monorepo.
- **CI hardening (0.8.0).** The server-side half of the gate, since the
  client-side one is advisory by construction (`--no-verify`, fresh clones
  without hooks, stale remote-tracking refs):
  - **Fail closed** — `--min-patterns` / `--require-deny-set`, enforced in the
    CLI where the deny-set size is computed, so a registry that never loaded
    stops producing a green check.
  - **CI-safe output** — `--redact-attribution`, because a PR comment, an issue
    body, and a public job log are publication channels and an engagement id is
    usually the customer's name.
  - **Generated workflow profiles** — `install ci --profile pr|strict|all`,
    SHA-pinned and timeout-bounded, adding a tag/new-ref backstop and a
    config-tamper guard.
  - **One-directional visibility assertion** — `REPO_AEGIS_ASSUME_PUBLIC`, so
    egress checks work on a fresh checkout without adding a way to switch
    findings off.
  - **Publish gate** — `audit --published` over a packed tarball, publishing
    the exact archive that was scanned.
  See [plan-ci-hardening.md](plan-ci-hardening.md) for the design record,
  including the security review that reshaped it.

### Designed but not yet implemented

- **Network-isolated mode** for `audit --published` (mirror registry).
- **Auto-decrypt-on-demand** for `repo-aegis registry decrypt` so
  single commands that need the registry can fetch credentials inline
  rather than requiring an explicit decrypt step.
