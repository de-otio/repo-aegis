# repo-aegis

> Engagement-scoped data-leak prevention for multi-customer git repositories.

A CLI for the consultant / contractor pattern: one machine, multiple
concurrent customer engagements, plus personal and OSS work. Stops
customer-A's data landing in customer-B's repo (or in a public OSS
repo) without forcing you to delete customer-A's strings from your
marker list when working on customer-A's own code.

## Status

**Pre-release. v0.1.0 published; Phase 1–3 onboarding work is
implemented on `main` and awaiting the next release tag. CLI and
scanner are feature-complete: all commands, output formats, and
hook integrations implemented. Phase 1 (org-keyed JIT classification)
and Phase 2 (LLM-assisted marker discovery) are complete in the
developer CLI; Phase 3 (semantic audit sweep) is complete in
`@de-otio/repo-aegis-scan` as opt-in.**

If you're driving this from a coding agent (Claude Code, Cursor,
Aider, Cline, …), start at the [agent operator guide](doc/agent-guide.md).
For the design rationale and threat model, see
[doc/design/](doc/design/).

## What it does

### Per-repo flow

- `repo-aegis allow <name>` — declare that the current repo legitimately
  references a given engagement; the deny set is then computed
  excluding that engagement's markers inside this repo.
- `repo-aegis deny <name>` — inverse.
- `repo-aegis status` — show this repo's class, allowed engagements,
  the deny set in effect, and the active pattern count.
- `repo-aegis check --staged` — scan the staged diff (pre-commit hook).
- `repo-aegis check --range <revspec>` — scan additions in a git range
  (pre-push hook).
- `repo-aegis check --path <file>` — scan a single file (Claude Code
  PostToolUse hook).
- `repo-aegis check --history` — sweep full git history with
  `git log -G` per pattern (slow; pair with `--since` for a lower bound).
- `repo-aegis classify --apply` — auto-detect repo class + engagement
  from the git remote URL. Reads org membership directly from the
  engagement registry (`engagements[*].githubOrgs`, `personalOrgs`).
  Falls back to a legacy `classify.yml` rules file with a deprecation
  warning if present.
- `repo-aegis audit` — composite repo health check: marker scan over
  tracked files, optional history sweep, lockfile non-public-registry
  check, fixture-directory scan, remote-vs-class consistency.
  `--org <org>` adds a one-shot GitHub code-search sweep; `--published
  <pkg>` scans a packed npm tarball, VSIX bundle, or installed package.

### Setup and registry

- `repo-aegis init` — bootstrap the home directory and registry stub.
  `--migrate-classify` ports a legacy `classify.yml` to the
  `personalOrgs` / `engagements[*].githubOrgs` shape (Phase 1).
- `repo-aegis install hooks` — write pre-commit and pre-push to
  `~/.config/repo-aegis/hooks` and set `core.hooksPath` for the
  current repo.
- `repo-aegis install gitignore` — append a managed block of secret-file
  patterns to `~/.config/git/ignore`.
- `repo-aegis install ci` — emit (or `--write`) `.github/workflows/leak-scan.yml`.
- `repo-aegis install claude-md` — wire a Claude Code PostToolUse
  hook + a CLAUDE.md snippet into `~/.claude`.
- `repo-aegis engagements list|add|end|show` — manage the registry.
  `add [id] --github-org <org>` (or `--personal-org`) attaches GitHub
  orgs to an engagement so the next git remote in that org auto-classifies.
- `repo-aegis suggest-markers --engagement <id> [--from <path>]
  [--auto-accept-above <0..1> | --dry-run]` — Phase 2: extract prose
  from the repo, ask a local Ollama model to identify customer
  tokens, filter (dictionary, dependency names, existing patterns,
  user-identity guard), synthesise word-boundary regexes, and append
  approved patterns to the engagement's marker list. Without
  `--auto-accept-above` or `--dry-run`, prints the surviving
  candidates and exits without persisting (review-required mode).
  Local-only by default; `--allow-remote-model` opts in to a
  non-loopback Ollama endpoint.
- `repo-aegis hook first-touch` — JIT classification hook that fires
  the first time an agent touches a previously-unclassified repo.
  Emitted as a Claude Code SessionStart hook by `install claude-md`
  (and `init`).
- `repo-aegis render` — regenerate per-engagement marker files from
  the registry.
- `repo-aegis context on|off|status` — toggle leak-context strict mode.

### Inspection

- `repo-aegis markers list` — list registered patterns by source file
  (redacted by default; `--verbose` to reveal literals).
- `repo-aegis markers test <string>` — report which patterns would
  match the input in this repo's scoped deny set.

### Scanner (separate package)

- `repo-aegis-scan validate-queries <file>` — schema-check a queries
  YAML file.
- `repo-aegis-scan run --queries <file> --state <file>` — run the
  configured GitHub code-search queries; output as `--output-format
  json|markdown|issue` (with `--report-issue-repo owner/repo` for
  issue mode); state file tracks seen hits across runs (atomic
  writes).
- `repo-aegis-scan run --semantic` — Phase 3: in addition to the
  regex sweep, fetch each new candidate's blob from GitHub, embed it
  via Ollama, and surface engagements whose reference docs are
  similar above their per-profile threshold. Output gains a `semantic`
  section (JSON) or "Semantic hits" table (markdown). Best-effort —
  Ollama failures do not abort the regex sweep.
- `repo-aegis-scan rebuild-profiles` — Phase 3: read each active
  engagement's `reposActive`, extract representative prose, embed,
  and write a profile to `~/.config/repo-aegis/profiles/<id>.json`.
  `--diff` reports stored-vs-current manifest drift without
  embedding (`[SEC H-3]`).
- `repo-aegis-scan encrypt-query <file> --recipient <pubkey>` —
  encrypt a queries YAML file with `age`. Used for committing
  encrypted query lists in a public deployment repo.
- `repo-aegis-scan decrypt-query <file> --identity <key>` — inverse.

Redacted by default everywhere; `--verbose` / `--reveal-matches` opt-in.
Hooks must never pass these flags.

### Uninstalling

If repo-aegis isn't right for you, `repo-aegis uninstall` reverses every
`install …` step in one shot:

```sh
repo-aegis uninstall                                # dry-run; shows what would change
repo-aegis uninstall --yes                          # apply: hooks, gitignore, claude-md, ci
repo-aegis uninstall --yes --purge-repos            # also unset repo-aegis.* in every classified repo
repo-aegis uninstall --yes --purge-home             # also delete ~/.config/repo-aegis/ (registry, audit log, profiles)
repo-aegis uninstall --yes --purge-repos --purge-home  # full reset
```

Defaults to dry-run; nothing destructive happens until you pass `--yes`.

`--purge-repos` walks `~/repos`, `~/code`, `~/src`, `~/projects` by
default (override with `--scan-root <path>`). `--purge-home` removes
the registry, audit log, marker files, deny-set cache, embedding
profiles — back the audit log up first if you need a compliance
record (the dry-run report flags it). To remove the npm package
itself, run `npm uninstall -g @de-otio/repo-aegis` afterwards.

### Per-line allowlist comments

Add `repo-aegis: allow` to a line (in any comment style) to suppress
hits on that line. The token is intentionally explicit so unrelated
comments don't accidentally suppress.

```ts
const fixture = "acme-corp.example"; // repo-aegis: allow synthetic test data
```

Run `check --ignore-allowlist-comments` for an audit-grade strict
mode that doesn't honour them.

### Per-repo `.repo-aegis.yml` overrides

A `.repo-aegis.yml` at the repo root declares class and engagements
when the maintainer wants the config checked in:

```yaml
class: customer-coupled
engagements:
  - customer-a
```

Per-clone `git config repo-aegis.class` / `repo-aegis.engagement`
still wins; the YAML is the project default.

## Why this matters for AI-assisted coding

AI coding agents (Claude Code, Cursor, Copilot, Aider, Cline, Continue)
absorb whatever context they're given — file paths, tool output, prior
conversation turns. Customer names that appear in any of those get
reached for as concrete examples in subsequent writes, even when a
`CLAUDE.md` / `.cursorrules` rule says otherwise. **Recency in
conversation outweighs prose rules.** A token mentioned ten times in
the current session — typically because the user is *handling* a leak
of that value, or just working on that customer's code — sits at the
top of the agent's attention and gets emitted by reflex when a
"concrete example" is needed.

This is the dominant new leak vector for anyone using AI tooling on
multi-customer work. It compounds three other AI-specific dynamics:

- **Agents write fast.** A leak that lands between "agent generates"
  and "human notices" has a much shorter window than for hand-written
  code. Catching the slip on the way to disk matters more than careful
  review afterwards.
- **Agents are now driving git.** Claude Code, Aider, Cursor's
  compose, etc. don't just write files — they stage, commit, sometimes
  push. The traditional "human reviews diff before commit" loop is
  partially automated. The gate has to be readable by the agent, not
  just the human.
- **Multi-customer machines confuse agents.** An agent has no innate
  sense of "which customer is this repo." It has to be told,
  per-repo, in a form it can read at write time.

repo-aegis is designed around that failure mode:

- **Deterministic gate, not a rule.** Pre-commit hook running
  `repo-aegis check --staged` catches what soft instructions cannot
  filter. Same for a Claude Code PostToolUse hook on every
  Write/Edit/MultiEdit — empirically the highest-leverage single
  leak-prevention mechanism for AI coding workflows.
- **Self-correction loop, not just a block.** `repo-aegis check`
  returns structured hit data with `--json` and stable exit codes
  (0 = clean, 1 = hit, 2 = error). The agent reads the output,
  identifies which engagement's marker was tripped, and revises on
  the next turn. Self-catch is empirically more reliable than
  pre-write blocking — the agent gets concrete feedback ("you
  wrote `betaco` in a customer-A repo") rather than an abstract
  refusal.
- **Engagement-scoped deny sets.** Inside customer-A's own repo,
  customer-A's strings legitimately appear in code, tests, configs.
  A flat marker list would false-positive on every legitimate
  reference, training the agent (and the user) to ignore the hook.
  repo-aegis computes a per-repo deny set from `repo-aegis.engagement`
  in `.git/config`: customer-A's markers are excluded inside
  customer-A's repo, but customer-B's markers, your other clients'
  markers, and your org-wide always-block markers are still enforced.
  Zero false positives in the legitimate case; full coverage in
  every other.
- **One verb the agent can invoke.** "Allow references to customer A
  in this repo" maps to `repo-aegis allow "customer A"` — fuzzy name
  match against the engagement registry, then a single `git config`
  call. The agent doesn't need to remember git-config syntax,
  engagement ids, or which file to edit. Same for `deny`, `status`,
  `check`.

The same machinery works for human-only commits through the standard
pre-commit hook. The AI-specific contribution is the agent-readable
structured output, the per-repo scoping that prevents agents from
learning to ignore false positives, and the verb-shaped CLI that an
agent can drive without specialised knowledge.

For the broader threat model and the layered defences this tool sits
inside (identity separation, ambient-coupling elimination, periodic
audits), see the data-leak prevention guide referenced under
[Background](#background).

## How it composes with other tools

- Pre-commit / pre-push hooks shell out to `repo-aegis check --staged`
  and translate exit code into the user-facing block.
- A Claude Code PostToolUse self-catch hook (registered as
  `repo-aegis hook scan-after-write` in `~/.claude/settings.json`)
  does the same per-write. The hook is path-aware: it resolves the
  destination working tree from the written path (not from the
  launcher's `cwd`) and applies *that* repo's rules, so cross-repo
  writes inside the same trust boundary just work. Writes whose
  destination crosses an org boundary are refused with
  `CROSS_ORG_WRITE`.
- A central registry (`~/.config/repo-aegis/engagements.yaml`) tracks
  engagement → markers → start/end dates. Per-engagement marker files
  (`~/.config/repo-aegis/markers/<id>.txt`) are generated from it.

## Roadmap

The monorepo has six workspace packages:

- `@de-otio/repo-aegis-core` — the registry/deny-set/scanner library.
  Hot-path code only — deterministic, free of LLM dependencies. The
  import-graph guard test in `packages/core/src/import-graph.test.ts`
  enforces this property.
- `@de-otio/repo-aegis` — the developer CLI: blocks leaks at commit
  time on the developer machine. Feature-complete.
- `@de-otio/repo-aegis-scan` — the centralised Layer-2 sweep:
  reads queries from a YAML file, runs them against GitHub
  code-search, filters out previously-seen hits via an atomic state
  file. Output formats: JSON, markdown report, or a filed GitHub
  issue. Phase 3 adds an opt-in `--semantic` mode and
  `rebuild-profiles` verb. Deployment (the scheduled GitHub Action,
  encrypted query list, and state file) lives in a private repo of
  the operator's choosing — see
  [data-leaks-on-github/code-search-solution.md](https://github.com/de-otio/dot-notes/blob/main/doc/topics/data-leaks-on-github/code-search-solution.md).
- `@de-otio/repo-aegis-llm` — LLM-assisted helpers (Ollama HTTP
  client, prose extraction, token synthesis, embedding profiles).
  Off the deterministic gate path: only consumed by the CLI's
  `suggest-markers` verb and the scanner's `--semantic` /
  `rebuild-profiles` verbs. See [packages/llm/README.md](packages/llm/README.md).
- `repo-aegis-vscode` — VSCode extension: surfaces the CLI's status
  and scan output in the editor (status bar, diagnostics, commands).
  View-only — the deterministic gate stays in the git hooks and the
  Claude Code PostToolUse hook.
- `@de-otio/repo-aegis-mcp` — Model Context Protocol server
  exposing the core library as agent-readable tools (status, check,
  audit, markers test, engagements list/show, classify-first-touch).
  Same JSON shapes as the CLI, no `--verbose` path, redaction policy
  enforced at the tool boundary. See [packages/mcp/README.md](packages/mcp/README.md).

There is also a thin wrapper:

- `de-otio/repo-aegis` GitHub Action (composite) — `uses:
  de-otio/repo-aegis@v1` in a workflow installs the CLI and runs
  `audit` (or any subcommand) against the consuming repo. See
  [doc/github-action.md](doc/github-action.md).

All five packages share the same marker list and engagement
registry, so a string is identified as a leak by the same logic at
every layer.

### Beyond v0.1

Designed but not yet implemented:

- Network-isolated mode for `audit --published` (mirror registry).
- Auto-decrypt-on-demand for `repo-aegis registry decrypt` so single
  commands that need the registry can fetch credentials inline rather
  than requiring an explicit decrypt step.

Already shipped (optional or default):

- `re2` regex backend for hard ReDoS resistance — install the optional
  `re2` dependency and `getRegexBackend()` reports `"re2"`. Falls back
  to the in-process time-budget heuristic when re2 is unavailable.
- Age-encrypted registry — `repo-aegis registry encrypt --recipient
  <pubkey>` / `decrypt --identity <path>`.
- Operator audit log — `repo-aegis audit-log on/off/show/path` (off by
  default).
- MCP server, VSCode extension, GitHub Action — all in this monorepo.
- Phase 1 — zero-config onboarding: org-keyed JIT classification on
  first agent touch (`hook first-touch` + `engagements add --github-org`).
- Phase 2 — LLM-assisted marker discovery: `suggest-markers` proposes
  customer tokens via a local Ollama model. The deterministic gate
  remains regex-only.
- Phase 3 — semantic audit sweep: `repo-aegis-scan --semantic` /
  `rebuild-profiles`. Off-machine, asynchronous, advisory. Hot-path
  determinism is preserved — see
  [doc/design/zero-config-onboarding.md](doc/design/zero-config-onboarding.md).

## Background

The design pattern this tool implements is described in detail in the
data-leak prevention guide it derives from. Once that guide is
published, this README will link to it.

## Development

```sh
npm install
npm run build
node packages/cli/dist/index.js status
```

## License

GPL-3.0-or-later. Copyright (C) 2026 Richard Myers and contributors.

A De Otio tool — https://de-otio.org.
