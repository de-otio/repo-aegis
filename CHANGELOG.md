# Changelog

All notable changes to repo-aegis are documented here.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Egress hygiene now covers the pip and cargo ecosystems.** `Cargo.lock`
  (`source = "registry+…"` / `"sparse+…"`, prefix-stripped before host
  extraction), `poetry.lock` (`[package.source] url`), `Pipfile.lock`
  (`_meta.sources[].url`), and `requirements*.txt` (`--index-url` /
  `--extra-index-url` / `-i` / `--find-links` — the pip analogue of a private
  `.npmrc`). `pypi.org`, `files.pythonhosted.org`, `crates.io`, and
  `static.crates.io` join the default public host set. Credentials embedded in
  an index URL are redacted; only the host is reported. `requirements` is a new
  `RegistryFinding.kind`. Lockfiles are parsed line-wise rather than with a new
  TOML dependency — the fields needed are single-line quoted strings, and a tool
  that exists to protect a supply chain should not widen its own. `go.sum` stays
  out of scope by design: Go's proxy lives in `GOPROXY`, not the file.

- **Configurable public-registry allowlist for the egress-hygiene check.** A new
  optional top-level `publicRegistries:` list in the engagement registry extends
  the built-in public set (npmjs, yarnpkg, `*.github.com`), so a team running a
  legitimate mirror can allow it instead of disabling the check. Entries are bare
  hosts (optionally `:port`), validated against the WHATWG URL parser — a scheme,
  path, credentials, or `*` wildcard is a parse error rather than a silently
  inert entry, since matching is exact equality against `URL.host`. The list is
  org-wide (registry) rather than per-repo, so a checked-in `.repo-aegis.yml`
  cannot whitelist a private host into a public repo. Loading is fail-soft: a
  missing, encrypted, or malformed registry falls back to the defaults, which is
  the *smallest* allowlist and therefore never weakens the check.

### Fixed

- `core/egress.ts` contained a raw NUL byte (a composite-key separator written
  as a literal rather than the `\u0000` escape), which made git classify the
  file as binary — so every diff of it rendered as `Bin … bytes` instead of
  reviewable text. Replaced with the escape; the runtime string is unchanged.
  Diffs of the leak-detection module are reviewable again.
- Replaced the account-scoped CodeArtifact host used as a test fixture in
  `core/egress.test.ts` with a synthetic one. This package ships `src` to npm,
  so fixture values are world-readable; the fixture only needs to be
  non-allowlisted, not real.

## [0.5.0] - 2026-06-22

### Added

- **Public-repo egress hygiene: private-registry URL leak prevention.** A new
  `core` module (`scanRegistryEgress`) flags references to non-public package
  registries — e.g. an account-scoped AWS CodeArtifact host — in
  `package-lock.json` (v1/v3), `yarn.lock`, `pnpm-lock.yaml`, and `.npmrc`. This
  guards against committing a private-registry URL — which leaks the owner's
  account id and breaks `npm ci` for external clones — into a repo that is, or
  can become, public.
- Enforcement is **visibility-gated** (`isPublicFacing`): it applies to
  `public-eligible` repos and to any repo whose cached GitHub visibility is
  `public` (a safety net for a repo left at the `private-strict` default), and is
  a no-op for private repos where such URLs are intended.
- `check` runs the scan independently of the marker deny set, reading the staged
  blob (`--staged`) / range tip (`--range`), so the existing pre-commit and
  pre-push hooks block it automatically.
- `audit` gains a `registry-egress` check (replacing the unconditional lockfile
  check, now class-gated) and a `visibility` reconciliation check that flags a
  GitHub-public repo left at the `private-strict` default.
- `status` probes and caches GitHub visibility (`repo-aegis.visibility`) and
  surfaces whether egress hygiene is enforced.

## [0.4.1] - 2026-06-20

### Fixed

- Bump the deny-set cache schema version (2 → 3) so the 0.4.0 engagement-
  identifier auto-block is not masked by a warm pre-0.4 cache. The computed
  pattern set changed without any marker-file mtime change, so a cache written
  by 0.3.x/0.4.0-pre shares the same fingerprint and must be invalidated for the
  new self-markers to take effect on upgrade.

## [0.4.0] - 2026-06-20

### Security

- **Engagement identifiers are now auto-blocked, closing a "configured but
  inert" gap.** The deny set was built solely from marker-file *contents*, so an
  engagement with zero populated markers protected nothing — even though its
  identifier is operator-chosen, typically customer-derived, and the single
  string most prone to leaking (it appears in `status` output and the registry,
  so it readily enters an author's context and is emitted by reflex). A real
  near-miss: a customer-derived engagement id reached an untracked doc and was
  caught only by a manual pre-push grep, not by repo-aegis. `computeDenySet` now
  adds each non-`_always` engagement id as an escaped, case-insensitive literal
  self-marker, so a zero-marker engagement still blocks its own identifier.
  Class scoping is preserved (a `customer-coupled` repo still may mention its own
  id; only *other* engagements' ids are blocked). Identifiers shorter than
  `MIN_AUTO_BLOCK_IDENTIFIER_LENGTH` (4) are skipped to avoid false positives;
  those engagements should carry explicit markers.

## [0.3.3] - 2026-05-27

### Fixed

- **`check-write` PreToolUse hook no longer spuriously blocks clean
  edits, and always explains a block.** Two defects, root-caused in
  `doc/bugs/repo-aegis-check-write-flake.md`:
  - The block diagnostic was written to **stdout**, but Claude Code
    forwards **stderr** to the agent when a PreToolUse hook exits
    non-zero. Every block — including a legitimate `CROSS_ORG_WRITE`
    refusal — surfaced as the bare
    `[repo-aegis hook check-write]: No stderr output` wrapper, with no
    reason and no guidance. Non-zero exits now emit on stderr (matching
    `scan-after-write`). This completes the "No stderr output" story
    begun in 0.3.2, which fixed one *trigger* (linked worktrees) but
    not the missing diagnostic.
  - The launcher trust boundary was derived from the hook process's
    `process.cwd()` — the directory Claude Code happened to spawn the
    hook in, which in a multi-root session can be an unrelated tree
    (`/tmp`, `$HOME`, a sibling repo). When that tree's org differed
    from the edited file's repo, the policy refused a clean same-repo
    edit; retrying when the spawn cwd happened to match succeeded,
    producing an intermittent false positive. The launcher boundary is
    now read from the payload's `cwd` field, and an **empty/unknowable
    source boundary fails open** (scan) instead of refusing — a
    guardrail must not block on its own inability to determine context.
    `scan-after-write` reads the payload `cwd` too, for consistency.

### Changed

- `check-write` now distinguishes exit codes: `2` blocks the tool on a
  `CROSS_ORG_WRITE` policy refusal, while an unrecoverable registry
  error exits `1` (non-blocking) so an unreadable/encrypted registry
  can no longer block every write behind the hook's own failure.
  Diagnostics for both now land on stderr.

## [0.3.2] - 2026-05-22

### Fixed

- **Linked git worktrees inherit the parent repo's trust boundary.**
  `getRemoteOrg` looked for `<gitdir>/config`, but a worktree's
  gitdir (`<parent>/.git/worktrees/<id>/`) does not carry a `config`
  file — config is shared with the parent via the `commondir`
  pointer. The result: every worktree computed as having an empty
  trust boundary, which silently mis-classified `decideHookAction`.
  When the destination tree had a non-empty boundary (any classified
  repo with a remote), the policy refused with `CROSS_ORG_WRITE`
  even though the worktree was literally backed by a repo in the
  same org. Symptom in Claude Code: every Write/Edit from inside a
  `isolation: "worktree"` subagent failed with
  `PreToolUse:Write hook error: [repo-aegis hook check-write]: No
  stderr output`. The fix follows the `commondir` pointer to locate
  the shared config.

### Changed

- Refreshed the lockfile to pick up within-range dependency bumps
  merged via dependabot since 0.3.1 (`re2` 1.24.0→1.24.1, `yaml`
  2.8.3→2.9.0, `zod` 4.4.2→4.4.3, `hono` 4.12.16→4.12.18, plus
  several dev-tooling group bumps and a GitHub Action bump).

## [0.3.1] - 2026-05-09

### Fixed

- **`@de-otio/repo-aegis-llm` is now included in the publish loop.**
  The 0.3.0 release published `core`, `scan`, `cli`, and `mcp` but
  silently skipped `llm`, so consumers resolving `^0.3.0` for the
  llm package fell back to `0.2.0` from npm. The publish workflow
  now iterates over `core llm scan cli mcp` so every workspace
  package whose `version` matches the release tag is shipped.

## [0.3.0] - 2026-05-07

### Security

- **Cross-org-write refusal is now genuine prevention, not
  post-write detection.** The 0.2.0 `repo-aegis hook
  scan-after-write` (PostToolUse) docstring and README claimed the
  hook *refuses* writes whose destination working tree's trust
  boundary did not overlap the launcher's. That claim was
  incorrect: PostToolUse fires *after* the tool's effect lands, so
  a non-zero exit cannot un-write the file. A new PreToolUse hook,
  `repo-aegis hook check-write`, runs the same `decideHookAction`
  policy *before* the tool runs and exits 2 on a cross-boundary
  write — at which point Claude Code blocks the tool from running.
  `install claude-md` registers the new hook automatically;
  existing installs need to re-run `repo-aegis install claude-md`
  to pick up the PreToolUse entry. Not exploitable in a
  privilege-escalation sense; recategorised as a correctness fix
  to a published prevention claim. The PostToolUse refuse-path is
  retained as defence-in-depth for installs that have not yet
  upgraded; its error message now acknowledges the file is already
  on disk and points at remediation.

### Added

- **`repo-aegis hook check-write` (PreToolUse).** New CLI
  subcommand wired into `Write|Edit|MultiEdit` PreToolUse. Reads
  `tool_input.file_path` from stdin, runs the path-aware trust-
  boundary policy, and exits 2 with `CROSS_ORG_WRITE` when the
  destination tree's trust boundary does not overlap the
  launcher's. Same payload shape as the existing PostToolUse
  surface (`code`, `details.srcOrgs`, `details.destOrgs`,
  `details.destTree`).
- **`install claude-md` registers the PreToolUse hook by default.**
  Idempotent on the (event, matcher, command) triple. Re-running
  the installer on an existing v0.2.0 setup adds the new entry
  without touching the existing PostToolUse / SessionStart entries
  or the `CLAUDE.md` managed block. `install claude-md --uninstall`
  strips PreToolUse entries alongside the PostToolUse and
  SessionStart cleanups; the cleanup result counters distinguish
  the three event types.
- **`doc/agent-install.md` — agent install guide.** New top-level
  doc walking a coding agent through the install + interactive
  engagement-configuration flow when a developer says "install and
  configure repo-aegis". Complements the existing
  `doc/agent-guide.md` (operator guide for ongoing use).

### Fixed

- **`[SEC C-1]` containment guard now fires on non-existent forbidden
  paths.** `extractProse` ran `realpathSync(root)` before the
  forbidden-prefix check, so a non-existent path under a forbidden
  prefix (e.g. `~/.gnupg/...` on a system without gnupg installed)
  threw a generic `Error` from realpath's ENOENT and bypassed the
  containment guard entirely. Added a pre-canonicalisation literal-
  prefix check that throws `RootContainmentError` regardless of
  filesystem state. The post-realpath check is preserved for symlink-
  escape protection. Surfaced by Linux CI runs where the runner's
  home doesn't contain `.gnupg` / `.config/git`; previously masked on
  developer macOS boxes where those paths happen to exist.

- **Hook diagnostic JSON now reaches the agent on non-zero exit.**
  `repo-aegis hook scan-after-write` (and any future hook subcommand
  that uses `emitJsonAndExit`) wrote its structured payload to stdout
  for every exit code. Claude Code's hook contract forwards stderr
  and discards stdout when a hook exits non-zero, so on exit 1
  (`EXIT_HIT`) and exit 2 (`CROSS_ORG_WRITE`, `REGISTRY_ERROR`,
  `RegistryEncryptedError`, scan errors) the agent saw
  `[hook]: No stderr output` with no diagnostic. Stream is now
  selected by exit code: stdout for exit 0 (preserves consumers
  piping the normal output), stderr for non-zero (makes the
  structured payload reach the agent so it can surface the
  refusal/hit and propose a remediation rather than silently retry).
  The test helper `runCli` looks at both streams when extracting
  JSON, so existing assertions on `r.json` across exit-1 and exit-2
  paths continue to pass.

## [0.2.0] - 2026-05-07

### Added

- **Secret-shape scanning for Bash tool output.** New PostToolUse hook
  `repo-aegis hook scan-bash-output` reads the Claude Code tool-result
  JSON from stdin, extracts the Bash stdout/stderr, and scans for
  universal secret-shaped patterns: PEM private-key headers (RSA / EC
  / OPENSSH / encrypted variants), the macOS keychain hex-encoded form
  of `-----BEGIN ` (the failure mode where `security ... -w` round-
  trips a PEM as ASCII hex), GitHub token prefixes (`ghs_`, `ghp_`,
  `gho_`, `ghu_`, `ghr_`, `github_pat_`), and three-segment JWT
  shapes anchored on the `eyJ` header. On a hit, exits 1 with a
  structured `SECRET_LEAK` payload that names the kinds and offsets
  detected (no matched bytes — by construction). `--advisory` keeps
  the payload but exits 0 for soft-rollout scenarios.
  - `install claude-md` automatically registers the new hook with a
    `Bash` matcher alongside the existing `Write|Edit|MultiEdit`
    matcher; merge is idempotent on the (matcher, command) pair so
    existing users picking up the upgrade re-run safely.
  - `install claude-md --uninstall` strips the new hook entries.
  - The pattern set is universal — not engagement-scoped, not
    configurable. New `core` exports: `scanForSecrets`,
    `summariseHits`, `SecretMarkerKind`, `SecretMarkerHit`.
  - PostToolUse fires *after* the tool runs, so the leak has already
    reached the agent context by the time the hook detects it. The
    hook is therefore framed as detection-and-alert, not prevention:
    its `remediation` block points the agent at credential rotation
    (e.g. `de-otio/treat-agent-as-a-dev` Step 9) rather than
    pretending the leak can be unsent.

- **One-command uninstall.** New top-level `repo-aegis uninstall`
  reverses every `install …` step in one shot. Defaults to a dry-run;
  `--yes` applies. Opt-in `--purge-repos` walks `~/repos`, `~/code`,
  `~/src`, `~/projects` (override via `--scan-root`) and unsets
  `repo-aegis.*` keys from every git working tree it finds. Opt-in
  `--purge-home` deletes `~/.config/repo-aegis/` (with an
  anti-fat-finger `PURGE_HOME_REFUSED` guard) and surfaces audit-log
  presence in the dry-run report so the user can back it up first.
- **`install claude-md --uninstall`.** Strips the managed `CLAUDE.md`
  block and removes every PostToolUse / SessionStart hook entry
  attributable to repo-aegis (matches the canonical `repo-aegis hook
  scan-after-write` / `repo-aegis hook first-touch` commands plus a
  legacy absolute-path-to-shell-script form). Preserves third-party
  hooks in the same matcher entry. Idempotent.
- **`install ci --uninstall`.** Deletes
  `.github/workflows/leak-scan.yml` if its body matches a known
  emitted template. Surfaces `WORKFLOW_MODIFIED` (and refuses
  deletion) when the user has edited it.
- **`uninstall sweep-repos`** verb. Walks one or more `--scan-root`
  paths and unsets `repo-aegis.class` / `repo-aegis.engagement` keys
  from every git working tree underneath. Dry-run by default;
  `--yes` to apply. Idempotent.
- **`install gitignore` honours `silent`** so the top-level
  uninstall can call it without polluting its own output.

### Changed

- **PostToolUse hook is now path-aware.** `repo-aegis hook
  scan-after-write` resolves the destination working tree from the
  written `file_path` (walking up to the nearest `.git`) instead of
  from the launcher's `cwd`. The destination repo's classification
  and deny set apply, so cross-repo writes inside the same trust
  boundary now scan cleanly instead of fail-closing on
  `OUTSIDE_WORKING_TREE`. New `core` exports: `findEnclosingWorkingTree`,
  `resolveGitDir`, `getRemoteOrg`, `computeTrustBoundary`,
  `trustBoundariesOverlap`.

### Added

- **`CROSS_ORG_WRITE` error code** (PostToolUse hook). When the
  destination working tree's trust boundary (engagement
  `githubOrgs` ∪ `personalOrgs` ∪ remote-org fallback) does not
  overlap the launcher's, the hook refuses with this code and exits
  2. The file is already on disk (PostToolUse fires after the
  write); the hook surfaces the offending path and asks the agent
  to revert. Trust boundaries inferred from classification beat the
  remote URL — forks don't accidentally widen scope.
- **`DEST_UNCLASSIFIED` warning code** (PostToolUse hook). Emitted
  alongside a normal scan result when the destination repo has no
  class, no engagements, and no parseable remote. The scan still
  runs against `_always`; the warning prompts the agent to suggest
  classifying the destination.
- **Phase 1 — zero-config onboarding (org-keyed JIT classification).**
  - Registry schema v2: `personalOrgs` (top-level) and
    `engagements[*].githubOrgs` (per-engagement). v1 files continue to
    parse with `personalOrgs: []` defaults.
  - `repo-aegis hook first-touch` — Claude Code SessionStart hook that
    classifies a previously-unclassified repo from its git remote +
    registry org membership, with a redacted "needs confirmation"
    output for ambiguous cases (`[SEC H-5]`).
  - `repo-aegis engagements add [id] --github-org <org>` /
    `--personal-org <org>` — attach orgs to engagements; mutual
    exclusion + cross-engagement uniqueness validation.
  - `repo-aegis init --migrate-classify` — port a legacy `classify.yml`
    to the registry schema (idempotent, atomic write).
  - `repo-aegis classify` falls back to legacy `classify.yml` with a
    one-time deprecation warning naming the matched rule
    (`[SEC M-7]`).
  - `aegis_classify_first_touch` MCP tool exposing the same pipeline
    to other agent runtimes.
- **Phase 2 — LLM-assisted marker discovery.**
  - New workspace package `@de-otio/repo-aegis-llm` (Ollama HTTP
    client, prose extraction, token synthesis, filters,
    token-extraction prompt).
  - `repo-aegis suggest-markers --engagement <id>
    [--auto-accept-above <n> | --dry-run]` — extract prose, ask a
    local Ollama model to identify customer tokens, synthesise
    word-boundary regexes, filter (dictionary, dependencies,
    existing patterns, user-identity guard), and either auto-accept
    above a confidence threshold or print a review-required
    candidate list for the user to inspect before re-running.
  - `[SEC H-1]` Ollama endpoint validation (loopback-only by default,
    `--allow-remote-model` opt-in, `localhost` DNS lookup guarded
    against `/etc/hosts` redirection).
  - `[SEC C-3]` LLM prompt-injection defence: anti-injection preamble
    + fence delimiters around user-provided prose; structured response
    parsed via Zod.
  - `[SEC H-2]` user-identity cross-check: tokens that match
    `personalOrgs`, `$USER`, or `$HOME` basename are filtered out
    before the candidate list is surfaced.
  - `[SEC H-6]` audit-log redaction for `suggest-markers` runs.
- **Phase 3 — semantic audit sweep (off-machine, advisory).**
  - Per-engagement embedding profiles stored at
    `~/.config/repo-aegis/profiles/<engagement-id>.json` (chmod 0600,
    atomic tmp+fsync+rename, schema-versioned).
  - `[SEC H-3]` source-document manifest with sha256 hashes; rebuild
    surfaces a stored-vs-current diff before re-embedding.
  - `repo-aegis-scan run --semantic` — for each new regex hit,
    fetches the candidate blob, embeds it, scores it against all
    active engagement profiles, and surfaces engagements over the
    per-profile cosine threshold. Output gains a `semantic` section
    (JSON) or "Semantic hits" table (markdown). Best-effort —
    Ollama failures do not abort the regex sweep.
  - `repo-aegis-scan rebuild-profiles [--diff] [--engagement <id>...]` —
    build / refresh profiles from each engagement's `reposActive`.
- **Hot-path determinism guard.** New test
  `packages/core/src/import-graph.test.ts` walks the static import
  graph from each gate-path entry point (PostToolUse hook,
  pre-commit, pre-push, `check`) and fails if any node resolves under
  `packages/llm/` or imports `@de-otio/repo-aegis-llm`. `[SEC M-1]`
  also greps for forbidden literals in case of dynamic imports.

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
