# Architecture

> Workspace packages, how they compose, and what's shipped vs. what's
> still on the roadmap. The deeper as-built design + threat model
> lives in [design/README.md](design/README.md).

## Workspace packages

The monorepo has five packages plus a thin Action wrapper.

- **`@de-otio/repo-aegis-core`** — the registry / deny-set / scanner
  library. Hot-path code only — deterministic, offline, and free of
  LLM dependencies (the LLM package was removed in 0.15.0). The import-graph guard test in
  [`packages/core/src/import-graph.test.ts`](../packages/core/src/import-graph.test.ts)
  enforces this property.
- **`@de-otio/repo-aegis`** — the developer CLI: blocks leaks at
  commit time on the developer machine. Feature-complete.
- **`@de-otio/repo-aegis-scan`** — the centralised Layer-2 sweep:
  reads queries from a YAML file, runs them against GitHub
  code-search, filters out previously-seen hits via an atomic state
  file. Output formats: JSON, markdown report, or filed GitHub
  issue. It also owns `repo-aegis-scan audit --org | --published` (the one-shot
  org sweep and the packed-archive scan), which moved out of `repo-aegis audit`
  so the CLI's gate path imports no HTTP client and never runs `npm pack`;
  an import-graph test in core keeps the gate modules free of it. Deployment is packaged as the `actions/scan` composite
  Action, with a reference workflow in
  [`examples/scheduled-sweep.yml`](../examples/scheduled-sweep.yml). It should
  still be **deployed from a private repo** — that is a security property, not
  an unfinished chore: the query strings ARE the customer markers, the state
  file records where matches were found, and a code-search token spans every
  org the operator can read. See
  [data-leaks-on-github/code-search-solution.md](https://github.com/de-otio/dot-notes/blob/main/doc/topics/data-leaks-on-github/code-search-solution.md).
- **`repo-aegis-vscode`** — VSCode extension: surfaces the CLI's
  status and scan output in the editor (status bar, diagnostics,
  commands). View-only — the deterministic gate stays in the git
  hooks and the Claude Code PostToolUse hook.

Plus two composite Actions:

- **`de-otio/repo-aegis`** — `uses: de-otio/repo-aegis@<sha>` (pin a release's
  commit SHA; there is no floating `v1` tag) installs the CLI
  and runs `audit` (or any subcommand) against the consuming repo. Fails
  closed on an empty deny set and redacts engagement attribution by default.
  Known issue: its `registry` input does not yet render markers, so it yields an
  empty deny set; see [github-action.md](github-action.md#registry-availability).
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
- **Claude Code PreToolUse hook** (`repo-aegis hook check-write`) is the
  primary write gate. It runs before each Write/Edit/MultiEdit, looks only
  at the path, and refuses a write whose destination crosses an org
  boundary with `CROSS_ORG_WRITE` (and an agent write to `.repo-aegis.yml`
  with `WAIVER_FILE_WRITE_REFUSED`) before anything lands on disk. See
  [agent-guide.md](agent-guide.md) for how agents react to those codes.
- **Claude Code PostToolUse hook** (`repo-aegis hook scan-after-write`)
  scans the content of the file that was just written. It is path-aware: it
  resolves the destination working tree from the written path (not from the
  launcher's `cwd`) and applies *that* repo's rules, so cross-repo
  writes inside the same trust boundary just work. It still carries a
  `CROSS_ORG_WRITE` branch, but that is legacy detection for installs that
  predate the PreToolUse hook: the file is already on disk by then.
  Whether the agent sees a hit from this hook is unverified (it exits 1 on a
  hit; Claude Code surfaces PostToolUse output to the model on exit 2). See
  [cli-reference.md](cli-reference.md#hook-coding-agent-entry-points).
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
- **LLM-assisted marker discovery and the semantic sweep (removed in
  0.15.0).** `suggest-markers`, `repo-aegis-scan --semantic` and
  `rebuild-profiles` were deleted: the deterministic gate is regex-only
  and the LLM paths added a network dependency and a data-egress surface
  for little accuracy gain.
- **Path-aware write hooks.** Cross-tree writes inside a shared
  trust boundary scan against the destination's rules; the PreToolUse
  `check-write` hook refuses cross-org writes before they happen.
- **One-command uninstall** (`repo-aegis uninstall`) with `--purge-repos`
  and `--purge-home` opt-ins.
- **In-process regex validation** (accident prevention for a catastrophic
  marker pattern typed by mistake): a static check for nested unbounded
  quantifiers, then a CPU-time check, when a marker is added or rendered.
  The earlier optional `re2` backend and the subprocess validator were
  removed. Scanning itself uses the native `RegExp` engine.
- **Encrypted-registry migration** — `repo-aegis registry decrypt --identity
  <path>` restores a registry an earlier version encrypted. `registry encrypt`
  was removed; `age` remains for the sweep query blobs only.
- **Operator audit log** — `repo-aegis audit-log on/off/show/path`
  (off by default).
- **VSCode extension, GitHub Actions** — all in this monorepo.
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
- **Publish-gate follow-up (0.8.1).** Found by reading 0.8.0's own publish
  log: the tarball gate reported `ok: true` after matching zero patterns.
  The engagement deny set is machine-local by design, so on CI it is
  *always* empty and the marker pass is inert — legitimate, but it must not
  render identically to a clean scan.
  - **Inert scans are visible** — an informational `PUBLISHED_EMPTY_DENY_SET`
    finding. Not a failure: raising `--min-patterns` here would fail every
    publish, because empty is the correct state on CI.
  - **A registry-independent pass** — universal secret shapes (PEM, JWT,
    forge tokens) over archive contents, so the gate does real work where
    the deny set cannot reach. Opt out with `--no-secret-scan`.
  - **Version-independent template recognition** — the generated workflow
    embeds the CLI version, so hashing it raw orphaned every prior release's
    installs from `--uninstall`. The version pin is now normalised before
    hashing, making the historical-hash list grow only on *structural*
    change.

- **Generated workflows validated against the real command tree.** Installing
  the generated workflow into this repo and running it surfaced that three of
  the four generated jobs had never worked: two passed `--no-history` and two
  passed `--ignore-waivers`, none of which `audit` declares. The templates are
  strings, so neither the flag-name contract test nor the YAML hygiene script
  had any reason to notice. A test now extracts every `repo-aegis` invocation
  from every generated template and validates each flag against
  `buildProgram()`.

- **Self-hosted gate.** repo-aegis runs its own generated workflows
  (`.github/workflows/leak-scan.yml`, `leak-scan-strict.yml`), installed
  byte-for-byte with `--no-require-deny-set` and pinned to the first release
  declaring every flag they use. Because the templates pin the *generating*
  CLI's version, the install must follow the release that contains the flags —
  see the CHANGELOG note on template evolution.

- **Egress guard** — destination-aware publishing controls. Every layer
  above inspects *content*; none inspected *where it is going*, and
  right-bytes-wrong-boundary slips landed in that gap (observed by the
  author; incident details are not published). One
  decision function in core (`egress-intent` parses a command line into its
  publishing operations; `egress-policy` decides `allow` / `ask` / `deny`)
  is enforced at three points: the git pre-push hook (`check --remote-url`,
  fed the `$2` git always passed and the hook ignored), a `gh` shim on
  `PATH` (`install shim`, `egress-check`, and a post-publish body read-back),
  and the pre-command hook of Claude Code (`hook guard-egress`, with a `hook
  egress-receipt` line after any publish); hand-configured Codex CLI and Gemini
  CLI snippets exist but are unverified (Gemini CLI has since been replaced by
  Antigravity CLI). Shape
  rules refuse the implicit forms (`git push` with no refspec, egress after
  `cd`, `;`-chained egress, a payload path under `$TMPDIR`) with no context
  at all; context rules refuse a cross-org destination, scan a payload
  against the *destination's* deny set, and `ask` for a public destination
  or an irreversible verb — degrading to `deny`, never `allow`, where the
  framework has no ask. Decision-only by construction: no layer ever
  rewrites a command. `selfIdentity` is the marker stem for the inverse
  direction (own material entering a customer-coupled repo), gated on that
  class exactly as `_private_infra` is gated on public-facing. `doctor`
  reports the preconditions (`push.default`, shim on PATH, guard hook
  registered, class + visibility resolved per repo), because a
  destination-aware control on an unclassified estate is silent. See
  [design/egress-guard.md](design/egress-guard.md); the server-side
  `audit --pr-body` Action mode (its Phase 4) is not built.

### Designed but not yet implemented

- **Network-isolated mode** for `repo-aegis-scan audit --published` (mirror registry).
