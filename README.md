# repo-aegis

> Engagement-scoped data-leak prevention for multi-customer git repositories.

A CLI for the consultant / contractor pattern: one machine, multiple
concurrent customer engagements, plus personal and OSS work. Stops
customer-A's data landing in customer-B's repo (or in a public OSS
repo) without forcing you to delete customer-A's strings from your
marker list when working on customer-A's own code.

## Status

**Pre-release. v0.2. CLI feature-complete; scanner package
implemented (JSON output only — issue and markdown formats deferred
to v0.3). Not yet published to npm.**

## What it does

### Per-repo flow

- `repo-aegis allow <name>` — declare that the current repo legitimately
  references a given engagement; the deny set is then computed
  excluding that engagement's markers inside this repo.
- `repo-aegis deny <name>` — inverse.
- `repo-aegis status` — show this repo's class, allowed engagements,
  the deny set in effect, and the active pattern count.
- `repo-aegis check --staged` — scan the staged diff against the
  scoped deny set; used by pre-commit / pre-push hooks.
- `repo-aegis check --path <file>` — scan a single file (used by the
  Claude Code PostToolUse hook).
- `repo-aegis classify --apply` — auto-detect repo class + engagement
  from the git remote URL using a rules YAML; sets `git config`.
- `repo-aegis audit` — composite repo health check: marker scan over
  tracked files, optional history sweep, lockfile non-public-registry
  check, fixture-directory scan, remote-vs-class consistency.

### Setup and registry

- `repo-aegis init` — bootstrap the home directory and registry stub.
- `repo-aegis install hooks` — write pre-commit and pre-push to
  `~/.config/repo-aegis/hooks` and set `core.hooksPath` for the
  current repo.
- `repo-aegis install gitignore` — append a managed block of secret-file
  patterns to `~/.config/git/ignore`.
- `repo-aegis install ci` — emit (or `--write`) `.github/workflows/leak-scan.yml`.
- `repo-aegis install claude-md` — wire a Claude Code PostToolUse
  hook + a CLAUDE.md snippet into `~/.claude`.
- `repo-aegis engagements list|add|end|show` — manage the registry.
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
  configured GitHub code-search queries; new hits returned as JSON;
  state file tracks seen hits across runs (atomic writes).

Redacted by default everywhere; `--verbose` / `--reveal-matches` opt-in.
Hooks must never pass these flags.

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
- A Claude Code PostToolUse self-catch hook does the same per-write.
- A central registry (`~/.config/repo-aegis/engagements.yaml`) tracks
  engagement → markers → start/end dates. Per-engagement marker files
  (`~/.config/repo-aegis/markers/<id>.txt`) are generated from it.

## Roadmap

The monorepo has three workspace packages:

- `@de-otio/repo-aegis-core` — the registry/deny-set/scanner library.
- `@de-otio/repo-aegis` — the developer CLI: blocks leaks at commit
  time on the developer machine. Feature-complete for v0.2.
- `@de-otio/repo-aegis-scan` — the centralised Layer-2 sweep:
  reads queries from a YAML file, runs them against GitHub
  code-search, filters out previously-seen hits via an atomic state
  file. Returns new hits as JSON. Issue-filing and markdown output
  are planned for v0.3. Deployment (the scheduled GitHub Action,
  encrypted query list, and state file) lives in a private repo of
  the operator's choosing — see
  [data-leaks-on-github/code-search-solution.md](https://github.com/de-otio/dot-notes/blob/main/doc/topics/data-leaks-on-github/code-search-solution.md).

All three share the same marker list and engagement registry, so a
string is identified as a leak by the same logic at every layer.

### Deferred to v0.3

- `repo-aegis-scan run --output-format=issue|markdown` (currently
  only `json` is implemented).
- `repo-aegis-scan encrypt-query` / `decrypt-query` (age wrappers).
- `repo-aegis audit --org <org>` and `audit --published <pkg>`.
- `repo-aegis check --range` / `check --history` (range-based scans).
- Per-repo `.repo-aegis.yml` overrides.
- Per-line allowlist comments.
- Worker-thread upgrade for the regex-safety check.

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
