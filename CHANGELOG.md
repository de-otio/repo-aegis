# Changelog

All notable changes to repo-aegis are documented here.

The format is based on [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Found by finally installing the generated workflow into this repo and running
it. The project had been shipping a CI gate it did not run on itself, and three
of the four generated jobs had never worked.

### Fixed

- **The generated `pr` workflow passed `--no-history`, which the CLI does not
  declare.** `audit` has `--history` (off by default); Commander only
  auto-generates a `--no-x` negation for options declared with one, so it
  exited 1 with `unknown option` before scanning anything. Both `pr`-profile
  audit jobs were affected, and had been since at least 0.7.x. The flag was
  only ever expressing a default, so it is simply gone.

- **The generated `strict` and `config-guard` jobs passed `--ignore-waivers`
  and `--ignore-allowlist-comments` to `audit`, which declared neither.** Same
  `unknown option` exit. The `strict` profile — whose entire purpose is showing
  what the day-to-day gate suppresses — had therefore never run at all.

- **New: `--ignore-allowlist-comments` on `audit`.** `audit` respects
  `repo-aegis: allow` comments by default, so the strict profile needed this
  implemented rather than deleted. There is deliberately **no**
  `--ignore-waivers` counterpart: `audit` never applies waivers in the first
  place (unlike `check`), so it is already strict there, and a flag to disable
  something never applied would be a lie in `--help`.

- **A test that the generated workflows are commands the CLI would accept.**
  Nothing caught the above because the templates are strings: the flag-name
  contract test pins what the CLI *accepts*, and the workflow-hygiene script
  lints YAML shape, but neither checked that what we *generate* parses. The new
  test extracts every `repo-aegis` invocation from every generated template and
  validates each flag against `buildProgram()`. Verified by reintroducing
  `--no-history` and watching it fail.

### Added

- **`install ci --no-require-deny-set`**, emitting `--min-patterns 0` instead
  of `--require-deny-set`. The default is right whenever the registry is meant
  to be reachable from CI. But a `public-eligible` repo blocks *every*
  engagement, so its deny set is the full customer-marker set — exactly what
  must never reach a public runner. There the fail-closed flag does not catch a
  misconfiguration, it fails every run, which is why the generated workflow was
  unusable for that whole class of repo (this one included). With the opt-out
  the marker scan reports `skipped: empty deny set` and the deny-set-independent
  checks still do real work.

### Note for anyone changing a template

**A generated template may only use flags present in the version it pins.**
`install ci` embeds the generating CLI's own version in the install step, which
is what stops a compromised publish from reaching every consumer's gate. For a
consumer that is always self-consistent: they generate with a released CLI, and
the template uses that release's flags.

It is *not* self-consistent when generating from an unreleased working tree —
i.e. in this repo. Installing the workflows in the same change that added
`--ignore-allowlist-comments` produced a file pinning the last release and
calling a flag that release does not have, and `config-guard` failed with
`unknown option`. The order therefore has to be: land the CLI change, release
it, then regenerate. That is why the self-hosted workflows are not in this
entry — they follow once these flags exist in a published version.

## [0.8.1] - 2026-08-08

Follow-up to 0.8.0, from watching its own publish run. The tarball gate
0.8.0 added reported `ok: true` after matching **zero** patterns — the exact
failure mode that release set out to remove, in the release's own new gate.

### Fixed

- **`audit --published` reported a vacuous scan as a clean one.** The check
  matches archive contents against the engagement deny set, and the engagement
  registry is machine-local by design — it holds customer markers, which is
  precisely what must never reach a public CI runner. A publish workflow
  scanning its own tarball therefore has **zero** deny-set patterns, and the
  marker pass matched nothing while the check still reported `ok: true` with no
  findings. `--min-patterns` is the wrong instrument here (raising the floor
  would fail every publish, since an empty deny set is legitimate in CI), so
  the check now emits an **informational** `PUBLISHED_EMPTY_DENY_SET` finding.
  It does not fail the check; it makes "matched against nothing" and "matched
  clean" render differently, which is the same principle the deny-set floor
  enforces elsewhere.

- **The secret-shape detector matched its own documentation.** A comment in
  `secret-markers.ts` spelled out the hex encoding of a PEM header as one
  contiguous literal, which its own `PEM_AS_HEX` pattern then matched — so
  `repo-aegis-core`'s tarball flagged itself under the new scan below. The
  byte values are now written spaced. Caught by scanning the real 0.8.0
  tarballs before wiring the check in, not after.

### Added

- **A universal secret-shape pass over `--published` archive contents**
  (PEM private-key headers, the hex-encoded form, JWTs, forge tokens), on by
  default, opt out with `--no-secret-scan`. This needs no registry, so unlike
  the marker pass it still does real work in CI — it covers the threat that
  actually applies to a registry tarball: a key or token that reached the
  archive through build output or `files`/`.npmignore` drift rather than
  through a tracked source file the hooks already cover.

  **This may newly fail a publish** for packages that legitimately ship
  secret-shaped example strings (a documented JWT in a README, a sample PEM in
  a fixture that is not excluded from the tarball). Pass `--no-secret-scan` to
  opt out, or exclude the file from the package.

  Findings report kind, path and count and **never the matched bytes** —
  `scanForSecrets` returns only kind/offset/length by construction — so they
  are safe to print in a public job log. Asserted by a test that greps the
  whole serialised payload rather than selected fields.

## [0.8.0] - 2026-08-08

CI hardening. The client-side gate is advisory by construction — `--no-verify`
bypasses it, a fresh clone has no hooks, and `check --push-ref` reads
remote-tracking refs a hook can never refresh. This release builds out the
server-side half, and fixes four defects found in artefacts repo-aegis was
already shipping.

Design record, including the security review that reshaped the plan before
implementation: [`doc/plan-ci-hardening.md`](doc/plan-ci-hardening.md).

### Changed — behaviour

- **The GitHub Action now fails closed on an empty deny set.** The new
  `require-deny-set` input defaults to `'true'`. Previously, a registry that
  failed to load produced a deny set with zero patterns, a scan that matched
  nothing, and exit 0 — a green check indistinguishable from a real pass. That
  happens on a fork PR (secrets are not exposed to `pull_request` runs from
  forks), a renamed or rotated secret, and a `registry` input pointing at a
  path that does not exist.

  **This will newly fail** for `scratch`-class repos and OSS repos with no
  markers of their own. Set `require-deny-set: 'false'` (or `--min-patterns 0`)
  if you intend a repo to be scanned with no deny set. Exit code is **2**, not
  1: "the gate could not run" is a different fact from "the gate found
  something", and conflating them is what let a broken gate look like a passing
  one.

- **The GitHub Action now redacts engagement attribution by default**
  (`redact-attribution`, default `'true'`). Output keeps file, line, column,
  the redacted preview, `_always` pattern ids, and an `engagementsAffected`
  count; it drops engagement ids and engagement-derived pattern ids. Anything
  the action emits can reach a job log, a step output, or a PR comment, all of
  which are world-readable on a public repo — and an engagement id is usually
  the customer's name.

- **The Action's `version` input no longer defaults to `latest`.** It defaults
  to the version the action shipped with. A compromised npm publish would
  otherwise reach every consumer's gate on their next run. Pass `latest`
  explicitly to opt back into floating.

### Deprecated

- **The Action's `hits-json` output** — use `results-file` instead, which is a
  path to the JSON under `RUNNER_TEMP`. Removal in 0.9.0. Scan output contains
  repo-derived file paths, and interpolating it into a `run:` block lets a path
  containing a quote close the quoting and execute the remainder. Reading a
  file has no such property. `hits-json` remains populated for one minor
  version, now with a randomised heredoc delimiter.

### Added

- **`--min-patterns <n>` / `--require-deny-set` on `check` and `audit`**
  (env: `REPO_AEGIS_MIN_PATTERNS`). Exit 2 when the computed deny set is
  smaller than the floor. Enforced in the CLI where the size is computed, so
  local runs, the MCP server, and scheduled sweeps inherit it — and checked
  before `check`'s `no-deny-set` early return, which is the exact outcome it
  exists to reject.
- **`--redact-attribution` on `check` and `audit`** (env:
  `REPO_AEGIS_REDACT_ATTRIBUTION`). Off locally, where attribution is the most
  useful field on the line and the terminal is not a publication channel.
- **`denySet` in `audit --json`**, mirroring `status` and `check`. Without it a
  consumer could not distinguish "audit passed" from "audit had nothing to
  scan".
- **`repo-aegis install ci --profile <pr|strict|all>`.** `pr` is the previous
  workflow, substantially hardened and extended with two jobs: `new-ref-scan`
  (`check --push-ref` on tag pushes, where remote refs are authoritative rather
  than possibly-stale as in a local hook) and `config-guard` (re-runs with
  `--ignore-waivers` when a PR modifies `.repo-aegis.yml` or the workflow
  itself). `strict` is new: a weekly audit with waivers and allow-comments
  ignored, filing findings as a tracked issue — the PR gate must honour
  suppressions to be usable, which is what makes suppression creep invisible.
- **`REPO_AEGIS_ASSUME_PUBLIC=1`** — assert public visibility so the
  private-registry egress check works on a fresh CI checkout, which has no
  cached `repo-aegis.visibility`. Deliberately one-directional: there is no
  counterpart that asserts "private", because an env var that switches findings
  *off* is a waiver nobody reviewed.
- **`de-otio/repo-aegis/actions/scan`** — the Layer-2 sweep as a composite
  Action (age-decrypt queries into `RUNNER_TEMP`, run, file an issue), with
  reference workflows in `examples/scheduled-sweep.yml` and
  `examples/org-sweep.yml`. Deployment guidance stays private-repo-first: the
  query strings *are* the customer markers.
- **`audit --published` gate in this repo's own `publish.yml`** — packs once,
  scans that artifact with the just-built CLI, and publishes the same bytes. A
  tracked-file scan does not cover `files`/`.npmignore` drift, build output, or
  stray fixtures.
- **Workflow linting in CI** — actionlint, zizmor, and
  `tests/workflow-hygiene.mjs` (no `${{ }}` inside `run:`, every job has
  `timeout-minutes`, every third-party `uses:` is SHA-pinned), applied to the
  generated templates as well as the checked-in files.

### Fixed

- **Script injection in the documented consumer snippet.** `doc/github-action.md`
  showed `echo '${{ steps.scan.outputs.hits-json }}'` inside a `run:` block.
  GitHub splices the expression in before the shell parses it, so a
  repo-derived path containing a quote closes the quoting and the rest is
  executed. The example workflow did it correctly via `env:`; the doc did not.
- **The Action installed the CLI from inside the consumer's checkout.** npm
  reads `./.npmrc` from the working directory, so a PR-supplied `.npmrc` could
  repoint the registry and substitute the package, whose install scripts would
  then run in the job. Now installed from `${{ runner.temp }}` with
  `--ignore-scripts` and an explicit `--registry`. Low impact under
  `pull_request` (read-only token, no secrets) — but it was the precondition
  that would have made any secret-bearing trigger dangerous.
- **The generated CI workflow was two years stale.** It emitted
  `actions/checkout@v4`, `actions/setup-node@v4`, Node 20, no
  `timeout-minutes`, and an unpinned global install, while `action.yml` in the
  same repo used Node 24 — and repo-aegis shipped the stale one into every
  consumer repo. Now SHA-pinned to node24 runtimes, timeout-bounded, with a
  `dependabot.yml` fragment printed so the pins do not rot.
- **The lockfile/egress check was disabled in the generated workflow.** It is
  now on, paired with `REPO_AEGIS_ASSUME_PUBLIC` so it decides correctly on a
  fresh checkout. The generated workflow also triggers on `public:`, which
  GitHub fires the moment a repo flips private → public.
- **Fixed `GITHUB_OUTPUT` heredoc delimiter** in the Action. Not exploitable —
  `emitJson` pretty-prints, so every string value is indented and cannot match
  the delimiter at column 0 — but that is a property of the formatter, not a
  guarantee. Now randomised.
- **`persist-credentials: false`** on every checkout in this repo's workflows,
  and `security-events: write` in `codeql.yml` narrowed from the workflow to
  the job that uses it.

## [0.7.1] - 2026-07-27

### Fixed

- **`doctor` reported a healthy repo as failing, forever.** A repo-local
  `pre-commit` or `pre-push` displaced by `core.hooksPath` was counted as
  bypassed — but since 0.7.0 the generated scripts *chain* to exactly those
  hooks, so they do still run. On a fleet whose only repo-local hook was a
  `pre-commit`, `doctor` exited 1 on every sweep with nothing wrong. It now
  distinguishes the two: `HookState.shadowedRepoHooks` remains the raw
  observation (every displaced script), and the new
  `HookState.bypassedRepoHooks` is the actionable subset — hook types
  repo-aegis does not install and therefore cannot chain (`commit-msg`,
  `post-merge`, …). `doctor` and `status` report and fail on the latter only.
  A guard that fires when nothing is wrong is the failure mode 0.7.0 set out
  to remove; this was an instance of it shipped in the same release.

### Added

- **Self-hygiene now checks for vendor-shaped credentials in this project's
  own source.** 0.7.0's release push was rejected by GitHub secret scanning
  over a Stripe-shaped literal in a test fixture — synthetic, but live-shaped,
  and repo-aegis's own guards had no opinion about it: the deny set covers
  customer markers, and `scanForSecrets` runs only over Bash tool output.
  Neither polices this repo. `self-hygiene.test.ts` now scans tracked source
  for Stripe / GitHub / AWS / Slack / Google / npm key shapes and PEM blocks
  *with key material*, so the next one fails at commit time rather than at a
  push that has already been attempted. Bare PEM headers and regex sources
  describing these shapes are deliberately not flagged — both appear
  legitimately in this repo, and a check that cries wolf gets disabled.

## [0.7.0] - 2026-07-27

### Fixed

- **Renamed files bypassed the scanner — read this if you maintain a repo
  older than this release.** `check --staged` and `check --range` passed
  `--diff-filter=ACM` to git, which excludes rename (`R`) diff entries. Git
  turns on rename detection by default, so `git mv` a file and add a marker
  to it in the same commit or push, and the pre-commit/pre-push hook reported
  "clean" — the content change was real but the diff filter never handed it
  to the scanner. Filter is now `ACMR`. **This means any history committed
  before this release may contain a rename-carried marker that was never
  scanned**, regardless of how clean prior `check`/`audit` runs looked.
  Remediate with a one-off full sweep: `repo-aegis audit --history`.
- **`scanHistory` and the `check` git helpers now fail closed.**
  `scanHistory` previously caught any git failure and returned `[]` — i.e.
  reported "clean" — which is a scanner failure disguised as a clean scan,
  the worst possible failure mode for a tool whose entire job is catching a
  leak before it lands. It now throws the new `GitCommandError`, which
  `check` surfaces as exit 2 rather than exit 0. The same fail-closed
  treatment now applies to the `--staged`/`--range` git helpers and to
  `check.ts`'s egress-scan git plumbing: a failed `git show` can no longer
  silently drop a file from the scan.

### Added

- **`check --push-ref <ref> --remote <name>`.** New scan mode for a ref the
  remote has never seen — the pre-push hook's zero-remote-sha case, which
  covers release tags and new branches. Previously this degraded to a
  full-history scan, which blocked releases on historical, already-pushed,
  benign matches (the tag-push false-positive). It now derives a diff base
  from the remote-tracking refs: nothing new to scan → no scan at all and no
  diff spawned (`repo-aegis: nothing new to scan (ref already reachable from
  <remote>)`); exactly one new boundary → an incremental diff from that
  point; several boundaries (e.g. a merge of two already-pushed lines) →
  widened via an octopus merge-base, which over-scans rather than
  under-scans; no remote-tracking refs at all → the old full-history
  behaviour, unchanged. Escape hatch: `REPO_AEGIS_NEW_REF_FULL_SCAN=1` forces
  full-history unconditionally. The generated pre-push hook now uses this
  mode automatically. **Residual risk, stated plainly:** the base is derived
  from remote-tracking refs, which a hook never refreshes (no network in a
  hook, by design). A stale-*behind* tracking ref causes over-scanning
  (safe); a stale-*ahead* tracking ref — possible after a server-side
  force-push or branch deletion — could under-scan. Server-side push
  protection remains the only non-advisory backstop for that case.
- **Path-scoped exemptions for `_always`-class findings, and `_always`
  only.** A secret *shape* (an `_always` pattern) can have a genuinely benign
  home — a test fixture, a fixture directory — and firing there is pure
  noise that trains people to reach for `--no-verify`. New optional
  `alwaysBlockExemptPaths: string[]` key, settable in the registry
  (`engagements.yaml`, machine-wide) and additively in a repo's
  `.repo-aegis.yml`. Built-in default when the registry omits the key:
  `**/test/**`, `**/tests/**`, `**/__tests__/**`, `**/__fixtures__/**`,
  `**/fixtures/**`, `**/testdata/**`, `**/*.test.*`, `**/*.spec.*`,
  `**/*.fixture.*`. A glob that matches everything (`*`, `**`, `**/*`) is
  rejected at load as a config error. **Engagement markers and
  `_private_infra` are never path-exempt, under any configuration** — a
  customer name typed into a test fixture is still a leak; only generic
  secret shapes are ever exemptible. `audit --fixture-check` still runs the
  full, unexempted pattern set and demotes an exempt-path `_always` hit to
  an informational finding rather than dropping it, so an exemption stays
  visible on audit even though `check` doesn't block on it.
- **`repo-aegis waive`.** A reviewed-benign escape hatch for a genuine
  `_always` false positive, scoped far more narrowly than `--no-verify`:
  `waive --pattern <id> --blob <sha> --reason <text> --approver <name>
  [--expires YYYY-MM-DD]`, plus `waive --list` and `waive --remove --pattern
  <id> --blob <sha>`. Waivers live under a new `waivers:` key in
  `.repo-aegis.yml` — committed, reviewable, diffable. A waiver is keyed on
  `(pattern id, blob sha)`, not path or line: it survives history rewrites
  and covers exactly the bytes that were reviewed, so a new key landing in a
  new blob is not silently covered by an old approval. Pattern ids
  (`<stem>/<12-hex>`, a truncated sha256 of the pattern) are shown in every
  `check` finding, so a waiver command is copy-pasteable straight out of a
  failure. Only `_always` patterns are waivable — `waive` on any other
  pattern is refused — for two reasons: it must never become a way to
  weaken the customer-marker deny set, and a pattern's digest, once
  committed to a public repo, is an offline oracle for guessing the literal
  it was derived from; a generic secret-shape digest gives an attacker
  nothing, an engagement-marker digest would give them a starting point.
  Because `.repo-aegis.yml` is a file inside the repo, an agent blocked by a
  real finding could otherwise write itself a waiver and retry —
  reconstructing `--no-verify` with extra steps. Three independent controls
  close that off, and all three are required: the existing PreToolUse
  `hook check-write` gate now refuses an agent `Write`/`Edit`/`MultiEdit` to
  `.repo-aegis.yml` outright; `waive` itself refuses to run when stdin is
  not a TTY unless `REPO_AEGIS_WAIVE_NONINTERACTIVE=1` is set; and `check`
  always reports `waived: N` (JSON: the full list), on every run, so a
  waiver can never disappear a finding silently. `check --ignore-waivers`
  re-enables audit-grade strictness for a run that must not honour any
  waiver.
- **Built-in recognition of documented example/placeholder credentials.**
  An `_always`-class match is no longer treated as a finding when it's
  shaped like a documented example — an AWS-access-key-shaped token whose
  body ends in `EXAMPLE`, or a value ending in `REDACTED`/`CHANGEME`/
  `XXXXXXXX`, or matching the `YOUR-…-HERE` scaffolding placeholder shape.
  Scoped to `_always` only — never to engagement or `_private_infra`
  markers, and never to a match that merely *contains* one of these words
  mid-string. Suppressions are counted and reported, never silent. Scope
  limit, stated deliberately: the scanner is line-oriented, so multi-line
  PEM-body recognition (e.g. the RFC example keys) is out of scope for now
  and would need block-aware matching this release doesn't add.
- **Hook liveness checking (`status`, `audit`, `doctor`).** Nothing
  previously verified that an installed hook was actually wired up — a
  stale or shadowed `core.hooksPath` fails exactly like a clean repo: no
  hook fires, no error, no signal. `status` gains a `hooks:` line (and a
  `hooks` object in `--json`); `audit` gains a `hooks` check, skippable with
  `--no-hooks-check` (the generated CI workflow now always sets this, since
  a GitHub-hosted runner never has hooks installed and the check would fail
  and get muted on every run). Stable codes for scripting: `HOOKS_OK`,
  `HOOKS_PATH_UNSET`, `HOOKS_PATH_FOREIGN`, `HOOKS_PATH_LOCAL_OVERRIDE`,
  `HOOKS_SCRIPT_MISSING`, `HOOKS_SCRIPT_NOT_EXECUTABLE`,
  `HOOKS_SCRIPT_STALE`. Motivation stated plainly: a tool whose entire value
  proposition is a pre-commit gate had never verified that the gate was
  connected, and an absent guard looks identical to a clean run.
- **`repo-aegis doctor [--scan-root <dir>...] [--fix] [--yes]`.**
  Fleet-wide hook-liveness sweep: walks every repo under the given roots
  (or the default scan roots) and reports every one whose effective hooks
  path isn't repo-aegis's, plus every repo whose own `.git/hooks` scripts
  are being shadowed by a `core.hooksPath`. Exits 1 if any repo fails.
  `--fix` is dry-run by default, matching `uninstall sweep-repos`'s
  convention; `--yes` applies it. Before mutating anything, `doctor` records
  the prior `core.hooksPath` value and the config file's mtime to the audit
  log, because a repair that runs before the forensics are captured erases
  the only evidence of when the drift happened.
- **"Already public" findings on a full-history scan of a public-facing
  repo now warn instead of block.** A history hit is marked `alreadyPublic`
  when its commit is already reachable from a remote-tracking ref, and is
  downgraded from a blocking hit to a surfaced, logged warning (exit 0)
  — but *only* for a genuine full-history scan (`--history`, or
  `--push-ref`'s full-history fallback) on a public-facing repo. A
  first-time addition of the same shape via `--staged` or `--range` still
  blocks, unconditionally; this downgrade never applies there. Mostly
  subsumed by the new `--push-ref` incremental scanning above — once a new
  ref scans incrementally, "I already pushed this to `main`, now I'm
  tagging it" never reaches a full-history scan in the first place.
- `status`, `audit`, and `doctor` now append an `observe-hooks` record
  (state + code, no paths beyond the hooks directory) to the operator audit
  log on every run, when the log is enabled. Cheap, and it's what gives a
  future hook-state regression a timestamp — the audit log is off by
  default, so `repo-aegis audit-log on` is what actually buys the timeline.

### Changed

- **`install hooks` now writes the GLOBAL `core.hooksPath` by default**
  (was: repo-local). Coverage used to be per-repo and opt-in at install
  time, with a stale local value silently beating a correct global one and
  no way to tell. `--local` restores the previous per-repo-only behaviour.
  New `--unset-local` clears a repo-local value that would otherwise shadow
  the global one just installed, in one step. `install hooks --uninstall`
  now clears **both** scopes and reports each — it previously cleared
  whichever scope git found first, which is the same silent-shadowing
  failure mode this release closes elsewhere. `init` inherits the new
  default, so a fresh `init` now enables hook coverage machine-wide, not
  just for the repo it ran in. **Because git consults exactly one hooks
  directory**, the generated `pre-commit`/`pre-push` scripts now chain to a
  repo's own pre-existing `.git/hooks/<name>` after the repo-aegis check
  runs (if one exists and is executable) — otherwise a global
  `core.hooksPath` would silently disable any hook another tool installed
  directly into a repo's `.git/hooks`. A repo-aegis hit still blocks
  regardless of what the chained hook returns.

## [0.6.0] - 2026-07-22

### Added

- **`repo-aegis scan-env`: turn this machine's toolchain config into markers.**
  Parses `~/.npmrc`, `pip.conf`, `~/.docker/config.json`, `~/.m2/settings.xml`,
  `~/.cargo/config.toml`, and `~/.yarnrc.yml` (plus project-level equivalents)
  for private package-registry hosts and offers them as marker patterns. Where
  the egress check catches a private host that already reached a lockfile, this
  addresses the upstream cause — the config that puts it there — so the deny set
  becomes self-maintaining with no per-customer enumeration.
  - **Dry-run by default.** Nothing is written without an explicit
    `--accept <placement>`.
  - Three placements: `private-infra` (recommended), `always-block`, or
    `engagement --engagement <id>`.
  - **Hosts only, never secrets.** These files are full of auth tokens; every
    parser extracts a hostname and nothing else, and no code path persists a
    credential. Public registries (npmjs, PyPI, crates.io, …) are filtered out —
    blocking them would break every project.
  - Hosts become escaped, case-insensitive literals; hosts shorter than
    `MIN_ENV_HOST_LENGTH` are skipped to avoid false positives.
- **New `privateInfra:` registry list and the class-gated `_private_infra`
  marker stem.** Unlike every other marker file, it joins the deny set only in
  **public-facing** repos: a private-registry host is legitimate — often
  required — in a private repo, so blocking it everywhere would make the tool
  unusable exactly where those hosts belong. This is why it is neither
  `always_block` (everywhere) nor engagement-scoped (a machine's infra usually
  maps to no single customer). It is deliberately excluded from the flat
  back-compat `markers.txt`, whose consumers have no notion of repo class.
- The deny-set cache key now includes the public-facing determination, so a repo
  becoming public cannot be served a stale, under-blocking cached set. Cache
  schema version bumped 3 → 4 to invalidate 0.5.x caches on upgrade.

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

- **Tests no longer inherit the developer's global git config.** The ~34 test
  files that run `git init` picked up the machine's real `core.hooksPath`, so
  anyone with repo-aegis installed saw `install-hooks` tests fail (the tool
  correctly detecting a conflicting hooks path) and `audit` tests fail (the real
  pre-commit hook blocking the temp repos' commits). The npm test scripts now
  null `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM`; a new `test:file` script runs
  a single file with the same isolation. This mattered beyond convenience: a
  suite that cannot run clean is a suite whose failures get skimmed, which is
  how a real account id and a NUL byte reached a public repo.
- Registered `scan-env` in the CLI flag-name contract test.

### Changed

- **Published tarballs no longer contain test files** (`!**/*.test.*`). A
  `.test.ts` fixture is what shipped a real account id to the registry in
  0.5.0; `core`/`llm` still ship `src` so consumer "go to definition" keeps
  working through the declaration maps, but the tests — and their fixtures —
  stay out. Nothing is lost for consumers: `exports` only ever exposed `dist`,
  so no published entry point could reach these files.

### Security

- **New self-hygiene guard (`core/self-hygiene.test.ts`).** Fails the build if
  repo-aegis's own tracked source contains an account-id-shaped string, an
  account-scoped CodeArtifact/ECR host, or a raw NUL byte. This closes a
  structural blind spot: the egress check dispatches on *filename*, so a `.ts`
  test fixture is invisible to it no matter what it contains — which is exactly
  how a real CodeArtifact host lived in a fixture, shipped in the npm tarball,
  and survived a release. Placeholders are recognised by shape (a repeated digit
  or a counting run), not by an allowlist of literals. The guard asserts a
  non-empty file list so it cannot pass vacuously, and its detector is tested
  against a reconstructed sample so it is known to be able to fail.

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

[Unreleased]: https://github.com/de-otio/repo-aegis/compare/v0.7.1...HEAD
[0.7.1]: https://github.com/de-otio/repo-aegis/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/de-otio/repo-aegis/compare/v0.6.0...v0.7.0
[0.1.0]: https://github.com/de-otio/repo-aegis/releases/tag/v0.1.0

See the full release history at
<https://github.com/de-otio/repo-aegis/releases>.
