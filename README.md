# repo-aegis

> Engagement-scoped data-leak prevention for multi-customer git repositories.

A CLI for the consultant / contractor pattern: one machine, multiple
concurrent customer engagements, plus personal and OSS work. Stops
customer-A's data landing in customer-B's repo (or in a public OSS
repo) without forcing you to delete customer-A's strings from your
marker list when working on customer-A's own code.

## Status

**Pre-release. v0.1.0 published; Phase 1–3 onboarding work is
implemented on `main` and awaiting the next release tag.** CLI and
scanner are feature-complete: all commands, output formats, and
hook integrations implemented. Phase 1 (org-keyed JIT classification)
and Phase 2 (LLM-assisted marker discovery) are complete in the
developer CLI; Phase 3 (semantic audit sweep) is complete in
`@de-otio/repo-aegis-scan` as opt-in.

## What it does

- **Per-repo engagement-scoped deny set.** A pattern catalog of
  customer-identifying strings, scoped per-repo so customer-A's
  markers don't false-positive inside customer-A's own repo.
- **Deterministic gate at every write path.** Pre-commit, pre-push,
  and a Claude Code PostToolUse hook all run the same scanner; same
  JSON output, same exit codes (0 = clean, 1 = hit, 2 = error).
- **Path-aware cross-repo writes.** The PostToolUse hook resolves
  the destination working tree from the written path, scans against
  *that* repo's rules, and refuses with `CROSS_ORG_WRITE` when the
  trust boundaries don't overlap.
- **Zero-config onboarding.** First time an agent touches an
  unclassified repo, `repo-aegis hook first-touch` matches the git
  remote against the engagement registry's `githubOrgs` /
  `personalOrgs` and classifies it without prompting (or prompts
  exactly once on an unknown org).
- **Engagement-scoped CLI verbs.** `allow`, `deny`, `status`,
  `check`, `classify`, `audit`, `engagements add | end | show`,
  `markers test`, `suggest-markers`. Stable JSON shapes everywhere.
- **Off-gate-path LLM helpers.** `suggest-markers` proposes regex
  candidates from a local Ollama model; `repo-aegis-scan
  --semantic` runs an embedding-based audit sweep off-machine. The
  deterministic gate stays regex-only and free of LLM dependencies
  (enforced by an import-graph guard test).

## Quick start

```sh
npm install -g @de-otio/repo-aegis
repo-aegis init                                  # bootstrap registry, hooks, Claude Code wiring
repo-aegis engagements add customer-a \
  --github-org acme-corp                         # attach a GitHub org so future repos auto-classify
cd /path/to/customer-a-repo
repo-aegis classify --apply                      # set repo-aegis.class + repo-aegis.engagement
repo-aegis status                                # confirm class and deny set
```

**If a developer told you (a coding agent) to "install and configure
repo-aegis"**, follow [doc/agent-install.md](doc/agent-install.md)
end-to-end — it covers the install, the interactive engagement
configuration, and the hand-off to the operator guide. For ongoing
operation after install, the [agent operator
guide](doc/agent-guide.md) takes over. For the full command catalog
with flags, exit codes, and JSON shapes, see the [CLI
reference](doc/cli-reference.md).

## Why it matters

**Recency in conversation outweighs prose rules.** A customer name
mentioned ten times in the current AI-assisted session — typically
because the user is *handling* a leak, or just working on that
customer's code — sits at the top of the agent's attention and gets
emitted by reflex when a "concrete example" is needed. Soft
instructions in `CLAUDE.md` / `.cursorrules` cannot filter this;
deterministic gates can. Engagement-scoped deny sets prevent the
"flat marker list false-positives in customer-A's own repo →
everybody learns to ignore the hook" failure mode.

For the longer argument and the full set of design decisions, see
[doc/why-ai-coding.md](doc/why-ai-coding.md).

## Documentation

| Doc | Audience |
|---|---|
| [doc/agent-install.md](doc/agent-install.md) | Coding agents installing + configuring repo-aegis on the user's machine |
| [doc/agent-guide.md](doc/agent-guide.md) | Coding agents driving repo-aegis (Claude Code, Cursor, …) post-install |
| [doc/cli-reference.md](doc/cli-reference.md) | Per-subcommand flags, behaviour, exit codes, JSON shapes |
| [doc/configuration.md](doc/configuration.md) | Per-line allowlist comments, `.repo-aegis.yml` override, env vars |
| [doc/architecture.md](doc/architecture.md) | Workspace packages, how it composes, roadmap |
| [doc/why-ai-coding.md](doc/why-ai-coding.md) | Why the deterministic gate is shaped the way it is |
| [doc/github-action.md](doc/github-action.md) | The composite GitHub Action wrapper |
| [doc/design/](doc/design/) | As-built design + threat model + zero-config onboarding spec |

Per-package READMEs:
[packages/llm/README.md](packages/llm/README.md),
[packages/mcp/README.md](packages/mcp/README.md).

## Uninstalling

`repo-aegis uninstall` reverses every `install …` step in one shot
(dry-run by default; `--yes` to apply). Opt-in `--purge-repos`
walks `~/repos` / `~/code` / `~/src` / `~/projects` and unsets
`repo-aegis.*` git config in every classified repo. Opt-in
`--purge-home` deletes `~/.config/repo-aegis/` (registry, audit log,
profiles). Run `repo-aegis uninstall --help` for the full flag set,
or see the agent-side checklist in
[doc/agent-guide.md](doc/agent-guide.md#uninstalling).

To remove the npm package itself afterwards:

```sh
npm uninstall -g @de-otio/repo-aegis
```

## Background

The design pattern this tool implements is described in detail in
the data-leak prevention guide it derives from. Once that guide is
published, this README will link to it.

## Development

```sh
npm install
npm run build
node packages/cli/dist/index.js status
```

Contribution guidelines: [CONTRIBUTING.md](CONTRIBUTING.md).

## License

GPL-3.0-or-later. Copyright (C) 2026 Richard Myers and contributors.

A De Otio tool — https://de-otio.org.
