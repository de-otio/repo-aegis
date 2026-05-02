# repo-aegis — design

> Post-implementation design notes for `@de-otio/repo-aegis`.
>
> The original pre-implementation design lived in
> [`dot-notes/plans/repo-aegis-design.md`](https://github.com/de-otio/dot-notes).
> This document is the source of truth for the *as-built* shape: what
> the tool actually is, why it was built that way, and which choices
> are load-bearing.

## What this tool is

A CLI for the consultant / contractor / multi-tenant developer pattern:
one machine, multiple concurrent customer engagements, plus personal
and OSS work in the same `~/repos`. The tool stops one engagement's
strings (codenames, internal hostnames, customer-derived identifiers)
from leaking into another engagement's repository — or into a public
OSS repository — without forcing the user to delete those strings from
their own engagement registry while they're still working on that
engagement's code.

The dominant new failure mode it addresses is AI-coding-agent recency
pressure: a customer-derived string mentioned ten times in the current
session sits at the top of the agent's attention and gets emitted by
reflex when a "concrete example" is needed, even when a `CLAUDE.md`
rule says otherwise. A deterministic gate (pre-commit hook,
PostToolUse hook) catches what soft instructions cannot filter, and
gives the agent structured feedback it can self-correct on.

## What it does in one paragraph

For each git repo, repo-aegis classifies the repo as one of four
classes (public-eligible, private-strict, customer-coupled, scratch)
and tracks zero-or-more "allowed engagements" per repo. From the
engagement registry (`~/.config/repo-aegis/engagements.yaml`) it
renders one marker file per engagement (`markers/<id>.txt`) plus an
always-block file (`markers/_always.txt`). The deny set for any given
repo is the union of those marker files, scoped: the markers belonging
to the repo's allowed engagements are subtracted (because customer-A's
strings legitimately appear in customer-A's own repo). Hooks call
`repo-aegis check` against that scoped deny set; the CLI emits
structured JSON the agent can read and react to without ever seeing
the literal matched marker.

## Locked decisions

These decisions are baked into the implementation. Changing them is a
semver-major change and requires a design-doc PR.

| Topic                                       | Decision                                                                                                                                                         |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `_always` representation                    | Top-level `always_block: string[]` in the registry YAML; modelled as `Registry { engagements: Engagement[]; alwaysBlock: string[] }`. No special-case engagement. |
| Multi-engagement `allow`                    | Variadic. `allow customer-a customer-b` adds both. Same for `deny`.                                                                                              |
| Universal CLI flags                         | Global. `--cwd`, `--json`, `--registry-path`, `--home`, `--no-color` apply to every subcommand uniformly.                                                        |
| `check` no-flag default                     | Errors with exit 2. Exactly one of `--staged`, `--path`, `--range`, `--history` must be specified.                                                               |
| `check --range`                             | Scans added lines in a commit range. Used by pre-push hook.                                                                                                       |
| Render retention vs offboarding             | `render` writes for `isActive(e, retentionMonths=12)`. Engagements ended >12 months get pruned at next render. `--retention-months` overrides.                    |
| `customer-coupled` without engagement       | Hard error from `check` (exit 2). The Bash hook script never bypasses; the user (or the agent on their behalf) must run `repo-aegis allow <id>` to declare intent. |
| Class engagement honour                     | Engagement field is consulted only when `class=customer-coupled`. `public-eligible`/`private-strict` always use the full deny set (warned-about if engagement is set). |
| Scanner version pinning                     | Workflow YAML pins `@de-otio/repo-aegis-scan@<exact-version>`. `npm ci` from a lockfile.                                                                         |
| Hook output match-string                    | Redact. Hook output and check JSON include position (`path:line:col`) and engagement attribution, but NEVER the literal matched string. Closes the recency-pressure amplifier. |
| Error message engagement enumeration        | Pointer. "no match; run `repo-aegis engagements list` to see options." Never enumerate ids in errors that flow through hook context.                              |
| Concurrent invocation safety                | `proper-lockfile` lock at `~/.config/repo-aegis/state/.lock` for any write under `REPO_AEGIS_HOME`. Git config writes rely on git's own `.git/config.lock`.        |
| `REPO_AEGIS_HOME` override                  | Warn to stderr on every invocation when the env override is in effect (TTY only — suppressed when stderr is a pipe, i.e. hook context).                          |
| Marker regex safety                         | Validate at `render`. Compile with a 100ms timeout in a subprocess; reject patterns failing the timeout. Fail closed: `render` exits 2 if any pattern is unsafe.    |
| Registry file permissions                   | `chmod 600` on registry; `chmod 700` on directory. Applied by `init`, `render`, `engagements add/end/remove`.                                                     |
| `--path` symlinks                           | Canonicalise via `fs.realpathSync`. Reject paths outside the cwd's git working tree (or current cwd if not in a git repo).                                       |
| On-disk cache                               | `~/.config/repo-aegis/state/deny-set-cache.json` keyed by sha256 of `(class, engagements, marker mtimes+sizes)`. Schema-versioned (`schemaVersion: 2`); readers ignore unknown versions and recompute. |
| Per-line `repo-aegis: allow` comment        | A line containing the literal token `repo-aegis: allow` (case-insensitive) suppresses hits on that line. `--ignore-allowlist-comments` (audit-grade) disables.   |
| Schema-versioning policy                    | Readers accept missing version (= 1) and any version ≤ MAX. Higher versions refuse with an "upgrade required" error. Writers must never lower the version.        |
| YAML validation                             | `zod` schemas in `core/src/schemas.ts` (registry + override). Per-package schemas in `cli/commands/classify.ts` and `scan/src/queries.ts`. `formatZodError` re-exported from core. |
| Claude Code PostToolUse hook command        | Bin name (`repo-aegis hook scan-after-write`) registered in `~/.claude/settings.json`. PATH-resolved at hook time. No standalone shell script under `~/.claude/hooks/`. No `jq` dependency. |
| ScanHit attribution                         | Each hit's `engagement` field carries the marker-file stem the matched pattern came from (engagement id, or `_always`). Backed by `DenySet.patternSources` parallel array. |

## Architecture

```
de-otio/repo-aegis/                                  (public, GPL-3.0)
└── packages/
    ├── core/                @de-otio/repo-aegis-core
    │   └── library; no CLI; consumed by cli + scan + future surfaces
    ├── cli/                 @de-otio/repo-aegis
    │   └── developer CLI: allow / deny / status / check / render /
    │       engagements / init / install / classify / audit /
    │       context / markers / hook scan-after-write
    └── scan/                @de-otio/repo-aegis-scan
        └── centralised sweep: run / validate-queries /
            encrypt-query / decrypt-query
```

### Data flow

```
engagements.yaml (registry, source of truth, chmod 600)
        │
        ▼  (rendered by `repo-aegis render`, with regex validation)
markers/<id>.txt + markers/_always.txt
        │
        ├──────────────┬──────────────┬───────────────┐
        ▼              ▼              ▼               ▼
   repo-aegis      repo-aegis     repo-aegis        repo-aegis-scan
   check          (Claude        audit / sweep       run
   (pre-commit    PostToolUse    (cli command)      (scheduled GHA,
   pre-push)      self-catch)                         pinned version)
        │              │              │                 │
        └──────────────┴──────────────┴─────────────────┘
                                │
                        deny-set computation
                        (engagement-scoped, class-aware,
                         on-disk cached by fingerprint)
                                │
                                ▼
                        ScanHit[] (redacted: position +
                                   engagement attribution,
                                   never the literal match
                                   unless --verbose)
```

All four consumers share `core` for: registry parsing, marker-file
IO, deny-set computation, scanner primitives, regex validation, and
output redaction.

## On-disk layout

```
~/.config/repo-aegis/                  ($REPO_AEGIS_HOME if set; default otherwise)
├── engagements.yaml                   registry, source of truth, chmod 600
├── markers/                           generated from registry; rebuilt by `render`, chmod 700 dir
│   ├── _always.txt                    from registry's alwaysBlock list
│   └── <engagement-id>.txt            one per active engagement, chmod 600 each
├── classify.yml                       (optional) classify rules; class+engagement from `git remote`
├── state/                             mutable runtime state, chmod 700 dir
│   ├── leak-context-mode              empty file = strict mode on; absent = off
│   ├── deny-set-cache.json            sha256-keyed denyset cache (schemaVersion: 2)
│   └── .lock                          proper-lockfile target for concurrent-write safety
└── hooks/                             scaffolded by `install hooks`; chmod 700 dir
    ├── pre-commit                     bash, exec `repo-aegis check --staged`
    └── pre-push                       bash, per-ref `repo-aegis check --range`
```

`.git/config` per repo holds `repo-aegis.class` and one or more
`repo-aegis.engagement` keys.

`init` and `render` enforce chmod values; existing files with weaker
permissions are tightened with a stderr note.

The Claude Code PostToolUse hook lives in `~/.claude/settings.json` as
a bare bin command (`repo-aegis hook scan-after-write`). No file is
written under `~/.claude/hooks/`.

## Domain model

### Engagement

```ts
interface Engagement {
  id: string;            // lowercase, hyphen-separated; matches marker filename stem.
                         // reserved id "_always" is invalid (use top-level alwaysBlock).
  name: string;          // human-readable, used for fuzzy matching in CLI.
  started?: string|null; // ISO-8601 date.
  ended?: string|null;   // ISO-8601 date; null = active.
  reposActive?: string[];// known working trees (informational).
  markers: string[];     // regex patterns. POSIX-extended-ish; validated at render.
  notes?: string;        // free-form.
}

interface Registry {
  schemaVersion?: number;  // optional; missing = legacy v1.
  engagements: Engagement[];
  alwaysBlock: string[];   // org-wide markers; rendered to markers/_always.txt
}
```

YAML representation:

```yaml
schemaVersion: 1
always_block:
  - PROJECT-CODENAME-ALPHA
  - fix/remove-.*-refs        # branch-name tells from prior remediation

engagements:
  - id: customer-a-2025-q4
    name: Customer A
    started: 2025-10-01
    markers:
      - acme-?corp[^a-zA-Z0-9]
      - acmeengineering\.com
```

### Repo configuration

Stored in `.git/config`:

| Key                       | Multi-value | Required when                         | Purpose                                          |
| ------------------------- | ----------- | ------------------------------------- | ------------------------------------------------ |
| `repo-aegis.class`        | no          | optional (defaults `private-strict`)  | governs whether enforcement happens              |
| `repo-aegis.engagement`   | yes         | when class = `customer-coupled`       | governs which slice of the marker list applies   |

In TypeScript the field is named `engagements: string[]` (plural array)
consistently across `RepoConfig`, every JSON envelope, every error
message. The git-config key stays `repo-aegis.engagement` (singular,
idiomatic git-config naming).

A checked-in `.repo-aegis.yml` at the repo root provides project
defaults when the maintainer wants the config to travel with the repo:

```yaml
class: customer-coupled
engagements:
  - customer-a
```

Per-clone `git config` always wins over the YAML.

### Class semantics

| Class              | Hook behaviour                                                                                                       | Engagement field                  |
| ------------------ | -------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `public-eligible`  | Strict enforcement against the **full** deny set. Hits → exit 1.                                                     | Ignored; warn if set.             |
| `private-strict`   | Same as `public-eligible` — assume future public.                                                                    | Ignored; warn if set.             |
| `customer-coupled` | Strict enforcement against the **scoped** deny set (every other engagement's markers + `alwaysBlock`). Hits → exit 1. | Required; ≥1; check exits 2 if missing. |
| `scratch`          | Hooks advisory only; never block. Hits printed; exit 0.                                                              | Ignored.                          |

Fail-safe defaults: missing class → `private-strict` (full deny).
`customer-coupled` without engagement → exit 2 from `check`, never
silent.

### ScanHit

```ts
interface ScanHit {
  path?: string;        // file path; undefined when scanning --staged
  line: number;         // 1-indexed
  column: number;       // 1-indexed
  engagement?: string;  // marker-file stem the pattern came from (engagement id or "_always")
  matchPreview: string; // redacted by default: e.g. "ac***N=14" or "[redacted]"
                        // NEVER the literal matched string unless --verbose
}
```

Position + engagement attribution is sufficient for the user to find
and fix the leak. The literal string must not flow back into the
agent's tool-result context (recency pressure).

## Public API surface (core library)

The full `@de-otio/repo-aegis-core` public surface is curated in
[`packages/core/src/index.ts`](../../packages/core/src/index.ts). Items
not re-exported there are internal and may be re-shaped at any time
without a major bump.

Stable, contract-bearing surface:
- Paths: `repoAegisHome`, `registryPath`, `markersDir`, `statePath`,
  `leakContextFlagPath`, `lockFilePath`, `denySetCachePath`,
  `flatMarkersPath`, `isHomeOverridden`.
- Registry: `loadRegistry`, `isActive`, `resolveEngagement`,
  `ALWAYS_BLOCK_RESERVED_ID`, `MAX_SUPPORTED_REGISTRY_SCHEMA_VERSION`,
  types `Engagement`/`Registry`/`ResolveResult`.
- Repo: `readRepoConfig`, `addEngagement`/`addEngagements`/`removeEngagement`,
  `setClass`/`unsetClass`, `REPO_CLASSES`, `RepoOverrideError`,
  `OVERRIDE_FILENAME`, types `RepoClass`/`RepoConfig`/`RepoOverride`.
- Deny set: `computeDenySet`, `ALWAYS_FILE_STEM`, types
  `DenySet`/`DenySetFile`/`DenySetOptions`.
- Scan: `scanText`, `scanFile`, `scanStagedDiff`, `scanRange`,
  `scanHistory`, `ALLOW_COMMENT`, types `ScanHit`/`SkippedFile`/
  `HistoryHit`/`ScanOptions`.
- Render: `renderMarkers`, `MARKER_FORMAT_VERSION`, types
  `RenderOptions`/`RenderedFile`/`RenderResult`.
- Redaction: `redactMatch`, `revealMatch`, type `RedactionMode`.
- Regex safety: `validatePattern`, `validatePatterns`,
  `validateCombinedSize`, types `PatternValidationResult`/
  `ValidatePatternsOptions`.
- Exceptions: `RegistryNotFoundError`, `RegistryParseError`,
  `RegistryEncryptedError`, `NotAGitRepoError`, `AmbiguousQueryError`,
  `EngagementNotFoundError`, `PatternValidationError`,
  `OutsideWorkingTreeError`, `LockTimeoutError`,
  `CustomerCoupledNoEngagementError`.
- Exit codes: `EXIT_OK = 0`, `EXIT_HIT = 1`, `EXIT_USAGE = 2`.
- Locking: `withLock`, `withLockSync`, type `LockOptions`.
- Schema helper: `formatZodError`.

## Output and exit conventions

- **stdout** = result.
- **stderr** = diagnostics.
- **Exit 0**: success / clean.
- **Exit 1**: actionable finding (hits found / new code-search hits).
- **Exit 2**: usage / config / network / "tool couldn't do its job".

Stable across all subcommands. Never reused.

### Redaction policy (applies to all stdout/stderr from CLI and scanner)

1. Marker literal matches are NEVER printed by default. Position +
   engagement-id is the diagnostic.
2. `--verbose` (CLI) or `--reveal-matches` (scanner) opts in to a
   truncated preview (first N chars + length) for human inspection.
3. **Hooks NEVER pass `--verbose`.** Documented; the
   `repo-aegis hook scan-after-write` subcommand calls `check`
   without verbose, so this can't be subverted by hand-edited
   settings.json.
4. Error messages NEVER enumerate registry contents. They redirect to
   `repo-aegis engagements list`.
5. The `engagement` field in JSON output is the engagement id (a
   categorical label). It IS information but is far less sensitive
   than the marker pattern itself, and it's load-bearing for the
   self-correction loop ("you tripped customer-B's marker") — the
   agent would otherwise have to guess.

## Threat model

| Threat                                              | Mitigation                                                                                                                                                                                                                              |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registry contents in error messages                 | Errors redirect to `engagements list`; never enumerate inline.                                                                                                                                                                          |
| Hook output recency-pressure amplifier              | `ScanHit.matchPreview` redacted by default; literal markers never flow into agent tool-result. Hooks never pass `--verbose`.                                                                                                            |
| Supply chain via `@latest`                          | Workflow YAML pins exact version. `npm ci` from lockfile. Trusted publishing (OIDC).                                                                                                                                                    |
| ReDoS via marker patterns                           | `validatePatterns` runs at `render` with a subprocess timeout (100ms). Bad patterns block `render`. `re2` swap is documented as a future hardening.                                                                                     |
| Registry at-rest exposure                           | `chmod 600` registry, `chmod 700` directory. Cloud-sync warning documented. Optional age-encryption: `repo-aegis registry encrypt --recipient <pubkey>` writes `engagements.yaml.age` and removes the plaintext; `repo-aegis registry decrypt --identity <path>` reverses. `loadRegistry` throws `RegistryEncryptedError` (code `REGISTRY_ENCRYPTED`) when the ciphertext is present — no auto-decrypt. |
| `REPO_AEGIS_HOME` silent override                   | Stderr warning on every TTY invocation. Hook context (stderr-is-pipe) suppressed because the warning would itself be a recency-pressure signal.                                                                                          |
| Scanner issue body leaks                            | Default redacted; `--reveal-matches` is explicit opt-in. Documented "use only in private restricted repo."                                                                                                                              |
| TOCTOU races on registry / markers                  | `withLock`/`withLockSync` (proper-lockfile) on `~/.config/repo-aegis/state/.lock` for any write under `REPO_AEGIS_HOME`. Git config writes use git's own `.git/config.lock`.                                                              |
| Scanner PAT scope                                   | Documented: fine-grained PAT, public-repos-read-only, no `contents:read` on private repos.                                                                                                                                              |
| `classify.yml` ReDoS                                | Same `validatePattern` applied to rule matchers in `classify`.                                                                                                                                                                          |
| `--path` symlink attack                             | `realpathSync`; reject paths outside cwd's git working tree.                                                                                                                                                                            |
| GHA workflow injection                              | `permissions:` block restricted (`contents: write` for state, `issues: write` for issue filing, nothing else). PAT not exposed to fork PRs (workflow runs only on schedule + manual dispatch by maintainers).                            |
| Cross-border data transfer (`audit --org`)          | Org seed substrings redact through GitHub Code Search. Required `--accept-cross-border` flag (or `REPO_AEGIS_ACCEPT_ORG_SEED_TRANSFER=1`) before any seed leaves the box. Maximum query cap (default 30, `--max-queries`).               |
| Zip-slip on `audit --published`                     | Post-extraction `realpathSync` check that every entry resolves under the temp dir; refuse otherwise.                                                                                                                                    |
| Flag injection via PostToolUse `file_path`          | The hook subcommand `repo-aegis hook scan-after-write` parses stdin JSON in Node and calls `check({ path })` directly — there is no shell to inject through, and the file_path is never tokenised as a CLI argument.                     |
| Compliance trail                                    | Audit log (when enabled) writes JSONL records of every state-changing action (`allow`, `deny`, `engagements add/end/remove`, `classify --apply`, `init`, `install hooks/claude-md/gitignore/ci`, `render`, `registry encrypt/decrypt`) to `~/.config/repo-aegis/state/audit.log` (chmod 600, append-only, rotates at 10 MiB). Records carry engagement ids and structural metadata only — never literal markers or matched substrings. Off by default; opt in via `repo-aegis audit-log on`. |

## Test strategy

Coverage targets: 80% line + branch on `core` and `cli`; 70% on
`scan` (network-bound branches require disproportionate mock effort).
Current state: see `npm run test:cov`.

Unit tests are colocated with sources (`*.test.ts` next to the module).
Subprocess-driven CLI tests use the helpers in
[`packages/cli/src/_subprocess-utils.ts`](../../packages/cli/src/_subprocess-utils.ts);
they self-skip when `dist/` is absent so a bare `node --test` against
TS source skips gracefully.

The CLI flag-name contract is locked in
[`packages/cli/src/program.test.ts`](../../packages/cli/src/program.test.ts) —
walks the Commander tree and asserts the exact subcommand and option
set against a frozen manifest. Renaming a flag requires an explicit
manifest update in the same commit. Protects external artefacts
(generated GitHub Actions YAML, `~/.claude/settings.json` hook
command, hand-rolled scripts) against silent breakage.

## Future hardening (designed but not implemented)

- **`re2` regex backend** — linear-time evaluation makes ReDoS
  structurally impossible. Tradeoff: native dependency, harder install.
- **Auto-decrypt-on-demand for the encrypted registry** — currently
  `loadRegistry` throws `RegistryEncryptedError` when the ciphertext
  is present and the user must run `registry decrypt` explicitly. A
  future option would be a per-process opt-in (env var or flag) to
  prompt for the identity file inline. Deliberately not the default,
  since at-rest encryption only protects against scenarios where the
  agent itself can be silently coerced into reading the registry.
- **MCP server / VSCode extension / GitHub Action wrapper** — surface
  the same machinery to other coding agents.
- **Network-isolated `audit --published`** — mirror-registry mode
  for organisations that don't want `npm pack` to reach the public
  registry.

## Reference

- CLI command reference: [cli-reference.md](cli-reference.md).
- Operator guide for coding agents: [../agent-guide.md](../agent-guide.md).
