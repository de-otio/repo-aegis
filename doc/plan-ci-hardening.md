# Implementation plan: CI hardening

**Status:** complete — shipped in 0.8.0. Kept as the design record: the
rationale for each decision, and the alternatives rejected, are not
reconstructable from the diff. Revised once after a security review before
implementation began; see [Security review](#security-review) for the findings
and where each is addressed. Deviations during implementation are recorded at
the [end of this document](#deviations-during-implementation).
**Scope:** close the gap between what the CLI can do and what actually runs on
a GitHub-hosted runner, and fix the defects in the CI surface repo-aegis
already ships to consumers.
**Target release:** 0.8.0 (one input default changes behaviour — see
[Decisions to confirm](#decisions-to-confirm)).

The composite Action ([`action.yml`](../action.yml)) is a generic CLI wrapper,
so every subcommand below is *reachable* from CI today. That is not the same as
being *run*: the only workflow repo-aegis generates is a marker-scan-only PR
gate, and the highest-value CI-shaped verbs (`audit --published`,
`audit --org`, `repo-aegis-scan run`, the strict `--ignore-*` modes) have no
recipe, no template, and no presence in this repo's own pipeline. The tool
publishes five npm packages without running its own last-mile artifact scan.

Two framings worth keeping in mind while implementing:

- **The developer-machine gate is advisory by construction.** `--no-verify`
  bypasses it, a fresh clone has no hooks, and
  [`check --push-ref`](cli-reference.md#check---push-ref-new-ref--release-tag-scanning)
  documents a residual under-scan risk whose stated answer is "server-side push
  protection is the only non-advisory backstop." CI *is* that backstop. It is
  the only layer an operator cannot skip in a hurry.
- **A gate that silently no-ops is worse than no gate**, because it produces a
  green check. Item [1.2](#12-fail-closed-deny-set) exists entirely because the
  pattern this repo documents does exactly that.

To which the security review adds a third:

- **CI output is a publication channel.** A PR comment, an issue body, and a
  job log on a public repo are world-readable. A leak-prevention tool that
  prints engagement attribution into any of them has inverted its own purpose.
  This constrains items [1.1](#11-ci-safe-reporting-mode) and
  [2.2](#22-second-generated-workflow-strict-scheduled-audit) and is the reason
  1.1 sequences before anything that reports.

---

## Security review

A review pass over the first draft produced nine findings. Four describe
**already-shipped** behaviour and are independent of whether the rest of this
plan is built; they move to Phase 0.

| # | Sev | Finding | Addressed in |
|---|---|---|---|
| S1 | High | Publish gate scans a different tarball than it publishes | [0.3](#03-gate-publishyml-on-audit---published) |
| S2 | High | Fork-PR recipe was a pwn-request (PR-controlled config; `.npmrc` registry redirect during `npm install -g`) | [0.2](#02-harden-the-shipped-action), [1.3](#13-fork-pr-scanning-guidance) |
| S3 | High | Findings JSON carries engagement ids; the shipped example posts it as a PR comment | [1.1](#11-ci-safe-reporting-mode) |
| S4 | Med | Script injection in the documented consumer snippet (`${{ }}` inside `run:`) | [0.1](#01-actionlint--zizmor-in-ci), [0.2](#02-harden-the-shipped-action) |
| S5 | Med | Action defaults to installing `@latest` | [0.2](#02-harden-the-shipped-action) |
| S6 | Med | A workflow cannot protect itself; only a named required check can | [3.1](#31-guard-changes-to-the-gates-own-configuration) |
| S7 | Med | A visibility env var is a suppression primitive | [2.3](#23-visibility-aware-egress-checks) |
| S8 | Low | Fixed `GITHUB_OUTPUT` heredoc delimiter (latent, not live) | [0.2](#02-harden-the-shipped-action) |
| S9 | Low | Phase 4 framing understated a deliberate security property | [4.1](#41-a-scan-composite-action--scheduled-template) |

Detail on the two that most changed the plan:

**S2.** `npm` reads `./.npmrc` from the current working directory, and the
composite action's install step runs with cwd set to the consumer's checkout.
A PR-supplied `.npmrc` therefore redirects the registry for
`npm install -g @de-otio/repo-aegis`, and the substituted package's install
scripts execute with whatever the job holds. Under plain `pull_request` that is
a read-only token and no secrets — low impact, which is why it is tolerable
today. Under the `pull_request_target` recipe the first draft proposed, it is
the registry secret and a write-scoped token. Compounding it, that recipe read
`.repo-aegis.yml` from the PR's ref, letting a fork add waivers and exemptions
that suppress its own findings. The recipe is withdrawn, not patched.

**S3.** `ScanHit.engagement` is the marker-file stem — an engagement id — and
it is present in `check` and `audit` JSON
([`scan.ts:68-73`](../packages/core/src/scan.ts#L68-L73)).
[`examples/github-action-usage.yml`](../examples/github-action-usage.yml) posts
that JSON verbatim as a PR comment. On a public repo that publishes
customer-derived identifiers to the world, through the tool's own example. Note
the asymmetry with `matchPreview`, which is already redacted: attribution was
never treated as sensitive output because, before CI, it only ever reached a
local terminal.

---

## Out of scope, deliberately

- **`doctor` in CI.** Already argued correctly in
  [cli-reference.md](cli-reference.md#repo-aegis-doctor): a runner never has
  hooks installed, so the check would fail every run and get muted. It stays a
  developer-machine sweep.
- **`hook scan-bash-output` in CI.** No useful analogue — GitHub already masks
  secrets it knows, and the hook's premise (a leak that has already reached an
  agent's context) doesn't apply to a runner.
- **Auto-fixing findings in CI.** The gate reports and blocks; redaction stays
  a human decision, consistent with the waiver design.

---

## Constraints discovered in the code

Read these before estimating. Several change the shape of the work.

1. **`audit --json` does not emit the deny-set size.**
   [`audit.ts:1117-1131`](../packages/cli/src/commands/audit.ts) emits
   `action`, `cwd`, `class`, `engagements`, `checks`, `summary`, `warnings` —
   no `denySet`. `status --json` has `denySet.patternCount`
   ([cli-reference.md](cli-reference.md#repo-aegis-status)) but that is a
   separate invocation. Item 1.2 therefore needs an additive `denySet` field on
   `audit --json`.
2. **The generated workflow is content-hash-tracked for uninstall.**
   `KNOWN_WORKFLOW_HASHES` in
   [`install-ci.ts`](../packages/cli/src/commands/install-ci.ts) is a flat
   list, and `--uninstall` only deletes a file whose body hashes to a known
   entry (else `WORKFLOW_MODIFIED`). Any template edit **must** prepend the old
   hash. Emitting a *second* workflow file (item 2.2) means that list becomes a
   per-path map and `uninstall` has to sweep both paths.
3. **`checkPublished` already handles `.tgz`, `.vsix`, and a bare npm package
   name** ([`audit.ts:754-917`](../packages/cli/src/commands/audit.ts)), with
   post-extraction `realpathSync` zip-slip defence. Item 0.3 needs no new
   scanning code — only wiring.
4. **Egress findings are gated on `isPublicFacing()`**
   ([`egress.ts`](../packages/core/src/egress.ts)), which reads a cached
   `repo-aegis.visibility` git-config value. A fresh CI checkout has no such
   config. CI has the answer for free in `github.event.repository.private` and
   the `public` event. Item 2.3 needs a way to assert visibility for one
   invocation — subject to the one-directional constraint in S7.
5. **`emitJson` pretty-prints** (`JSON.stringify(value, null, 2)`,
   [`format.ts:9-11`](../packages/cli/src/format.ts#L9-L11)). This is what
   makes S8 latent rather than live: every string value is indented, so no
   value can match a `GITHUB_OUTPUT` heredoc delimiter at column 0. Anything
   that changes this — compact output, a new emitter — makes S8 exploitable, so
   fix the delimiter rather than relying on the formatting.
6. **The uninstall surface must stay complete.** Every new install path needs
   its opposite. Two new generated workflows means two new uninstall paths and
   two new tests.
7. **`repo-aegis-scan` is a separate npm package** with its own bin. The
   existing composite action installs `@de-otio/repo-aegis` only, so item 4.1
   is a separate action, not a new input on the existing one.
8. **`scan run` exit codes differ by output mode.** It exits 1 on new hits only
   in `json` mode; a successful issue filing exits 0. Item 4.1's `fail-on-hits`
   semantics must be written against that, not inherited by analogy from the
   other action.

---

## Phase 0 — fix what is already shipped, and self-apply

Items 0.1 and 0.2 fix live defects in artefacts consumers already use. 0.1
sequences first so it catches regressions in everything after it.

### 0.1 `actionlint` + `zizmor` in CI

**Problem.** This repo now ships workflow YAML as a *product artefact*
(generated templates plus examples) and nothing validates it. S4 and S8 are
exactly the class a linter catches, and S2 is exactly the class `zizmor`
catches — it checks specifically for template injection, pwn requests,
credential persistence, and cache poisoning.

**Change.** New job in [`ci.yml`](../.github/workflows/ci.yml) running both
tools over `.github/workflows/`, `examples/`, and — via a small harness — the
template strings emitted by `install ci`. Add to the `ci-success` aggregator's
`needs`. Add a targeted assertion the linters won't make for us: **no `${{ }}`
interpolation inside any `run:` block** in shipped YAML.

**Files.** `.github/workflows/ci.yml`, `tests/`.
**Risk.** Low; expect pre-existing findings to fix or explicitly suppress.
Suppressions get a comment saying why, not a bare ignore.

### 0.2 Harden the shipped Action

**Problem.** Four live issues in [`action.yml`](../action.yml) and
[github-action.md](github-action.md), independent of the rest of this plan:

- **S2:** `npm install -g` runs with cwd set to the consumer's checkout, so a
  PR-supplied `.npmrc` can redirect the registry and get install-script
  execution. Low impact today (read-only token, no secrets under
  `pull_request`); it is the precondition that makes any future secret-bearing
  trigger dangerous.
- **S5:** the `version` input defaults to `latest`, so a compromised npm
  publish subverts every consumer's gate at once.
- **S4:** the "Example consumer" snippet in the docs interpolates
  `hits-json` inside a `run:` block. Repo-derived paths land in that string; a
  `'` closes the quote and the rest is shell. The example *workflow* does this
  correctly via `env:`, so the doc is the outlier.
- **S8:** the fixed `__REPO_AEGIS_EOF__` heredoc delimiter (latent — see
  constraint 5).

**Change.**

1. Install with `--ignore-scripts` and an explicit
   `--registry=https://registry.npmjs.org`, from a directory outside the
   workspace.
2. Default `version` to the Action's own released version; keep `latest` as an
   explicit opt-in, documented as a supply-chain choice.
3. Replace the `hits-json` step output with a **file path** output: write the
   JSON under `$RUNNER_TEMP` and emit the path. This removes the delimiter
   question entirely and removes the primitive that makes S4 possible
   downstream. Keep `hits-json` for one minor version, populated via a
   randomised delimiter, marked deprecated.
4. Fix the doc snippet to read the file (or use `env:`), and say plainly why
   `${{ }}` must never appear inside `run:`.

**Files.** `action.yml`, `doc/github-action.md`,
`examples/github-action-usage.yml`, `tests/action-smoke.sh`.
**Risk.** Output-shape change; hence the one-version deprecation window rather
than a straight removal.

### 0.3 Gate `publish.yml` on `audit --published`

**Problem.** [`publish.yml`](../.github/workflows/publish.yml) runs
`npm publish` across five workspace packages with no artifact scan. A
tracked-file scan does not cover this: `files` / `.npmignore` drift, build
output, and stray fixtures land in the tarball without necessarily being
visible to a `git ls-files` sweep. The tarball is the last artefact anyone can
inspect before it is world-readable and effectively unrecallable.

**Change.** **Pack once, scan that artifact, publish that same artifact.** The
first draft packed for the scan and let the existing loop pack again at publish
time — two tarballs, one scanned (S1). Correct order per package:

1. `npm pack` to an explicit path under `$RUNNER_TEMP`.
2. `repo-aegis audit --published <path> --json` using the **just-built** CLI
   (`node packages/cli/dist/index.js`), not the published one — a released
   regression must not be able to bless its own tarball.
3. `npm publish <path>` — the byte-identical artifact that was scanned.

**Verify before implementing:** that `npm publish <tarball> --provenance`
produces a valid attestation. If it does not, the ordering has to change
(scan-then-publish-from-dir, accepting a narrow TOCTOU, or find another
primitive). Do not assume it works.

**Bootstrap caveat.** The deny set comes from `.repo-aegis.yml` in the same
commit, so a commit that weakens the config passes its own gate. That is item
3.1's problem, and 3.1 must apply to this repo too — noted here so the loop is
not mistaken for closure.

**Files.** `.github/workflows/publish.yml`.
**Tests.** `workflow_dispatch` with `dry-run: true` already exists — exercise
the gate there before the next real release.
**Risk.** Low. Worst case a release blocks pending an `.npmignore` fix, which
is the intended behaviour.

---

## Phase 1 — make CI output safe, then make the gate fail closed

### 1.1 CI-safe reporting mode

**Problem.** S3. `ScanHit.engagement` is an engagement id and appears in
`check` and `audit` JSON; the shipped example posts that JSON as a PR comment.
Any CI surface that reports findings — PR comment, issue body, job summary,
`hits-json` output — is a publication channel, world-readable on a public repo.
`matchPreview` is already redacted; attribution never was, because before CI it
only reached a local terminal.

**Change.** A reporting mode safe to publish, selected by a flag
(`--redact-attribution`, or an output profile) and set by default in every
generated CI template:

- Drop `engagement` from hits; report the count of distinct engagements
  affected, not which.
- Drop `patternId` **for engagement and `_private_infra` stems**. The waiver
  documentation already argues an engagement-derived pattern id is an offline
  oracle for the literal it came from; publishing it to a PR comment is the
  worst case of that. `_always` pattern ids stay — they are derived from
  generic shapes and are what makes a waiver referenceable.
- Keep file, line, column, and counts. Those are what make a finding
  actionable, and they are already in the repo.

Then: fix the example to use it, and state the rule in
[github-action.md](github-action.md) — anything leaving the runner is redacted;
`--verbose` in CI is as prohibited as `--verbose` in a hook, for the same
reason.

**Files.** `packages/core/src/scan.ts` or the CLI's formatting layer,
`packages/cli/src/commands/{check,audit}.ts`, `examples/`,
`doc/{cli-reference,github-action,agent-guide}.md`, tests.
**Risk.** Medium — touches the redaction boundary, which is load-bearing. Add
a test asserting no engagement stem appears anywhere in redacted output, and
sequence this **before** 2.2, which files issues.

### 1.2 Fail-closed deny set

**Problem.** [github-action.md](github-action.md) documents restoring the
registry from `secrets.*`. Secrets are not exposed to `pull_request` runs from
forks, so the restore writes an empty file, the CLI computes an empty deny set,
and `audit` exits 0. Green check, no scan. Same failure for a mistyped secret
name, a rotated-away secret, or a `registry` input pointing at a missing path.

**Change.** Put the assertion **in the CLI**, not in composite bash — the first
draft had the Action parse JSON with shell tooling, which is fragile and helps
only Action users:

1. `--min-patterns <n>` on `check`/`audit`: exit 2 when the computed deny set
   has fewer than `n` patterns. `--require-deny-set` is sugar for
   `--min-patterns 1`.
2. Additive `denySet: { files, patternCount }` on `audit --json`, mirroring
   `status` and `check`, so the number is visible in output as well as
   enforced.
3. Action input `require-deny-set` (default `'true'`) that forwards the flag
   and fails with an unmistakable message. Generated templates set it.

**Files.** `packages/cli/src/commands/{audit,check}.ts`, `action.yml`,
`doc/{cli-reference,github-action}.md`, `tests/action-smoke.sh`.
**Tests.** An empty-deny-set fixture in the action smoke test, so fail-closed
is proven rather than assumed.
**Risk.** **Behaviour change.** A `scratch`-class repo, or an OSS repo with no
markers, currently passes and would now fail. Hence a minor bump, a loud
changelog entry, and the escape hatch documented in the same paragraph as the
default. See [Decisions to confirm](#decisions-to-confirm).

### 1.3 Fork-PR scanning guidance

**Problem.** With 1.2 in place, fork PRs move from silently-clean to loudly-red
— correct, but useless as a gate unless there is a way to scan them. The first
draft's answer was a `pull_request_target` recipe; the review found it to be a
pwn-request (S2), and it is withdrawn.

**Change.** Recommend the layered arrangement instead, which needs no secrets
on an untrusted trigger:

- **Fork PRs** run on `pull_request` with no registry, enforcing the universal
  `_always` patterns only. Real coverage — secret shapes, private keys, tokens
  — and no secret is ever present in a job holding attacker-controlled files.
- **Engagement-scoped enforcement** runs on `push` to protected branches, or in
  the merge queue. Still strictly before anything is published, which is the
  property that matters; "before merge" was never the requirement, "before it
  leaves the repo" is.

Document `pull_request_target` only as an advanced option, and lead with the
constraints rather than the YAML: config read from the base ref (never the
PR's), no execution of PR code at all — no `npm ci`, no build, no test, no
lockfile-keyed cache — install with `--ignore-scripts` and an explicit registry
from outside the workspace, `persist-credentials: false`, minimal
`permissions`. A reader who copies the pattern and adds `npm ci` has handed a
fork their registry secret.

**Files.** `doc/github-action.md`, `examples/`.
**Risk.** Documentation that gets copied wrong is the risk. If the constraint
list cannot be made short enough to survive copy-paste, omit the advanced
option entirely.

---

## Phase 2 — refresh and extend the generated workflows

### 2.1 Modernise the `install ci` template

**Problem.** The template in
[`install-ci.ts:39-46`](../packages/cli/src/commands/install-ci.ts) uses
`actions/checkout@v4`, `actions/setup-node@v4`, `node-version: '20'`, no
`timeout-minutes`, and an unpinned global install. `action.yml` in the same
repo uses `setup-node@v6` and Node 24. The two disagree, and repo-aegis emits
the stale one into every consumer repo.

**Change.** `checkout@v5`+, `setup-node@v6`, Node 24, job-level
`timeout-minutes`, a `concurrency` group, explicit least-privilege
`permissions:`, `persist-credentials: false` on checkout, and a version-pinned
install. Pin actions by commit SHA with a version comment (matching
[`ci.yml`](../.github/workflows/ci.yml)) — a leak gate disabled by an upstream
action compromise is not a gate — and optionally emit a `dependabot.yml`
fragment for `package-ecosystem: github-actions` so the pins don't rot. Add
`on: public:` (item 2.3).

**Files.** `packages/cli/src/commands/install-ci.ts` (+ prepend the current
hash to `KNOWN_WORKFLOW_HASHES`, constraint 2),
`examples/github-action-usage.yml`, `packages/cli/src/commands/install-ci.test.ts`.
**Risk.** Forgetting the hash prepend orphans every previously-installed
workflow from `--uninstall`. Add a test asserting the *old* body still hashes
into the known list.

### 2.2 Second generated workflow: strict scheduled audit

**Problem.** PR CI must honour waivers and `repo-aegis: allow` comments or it
is unusable. That makes the set of suppressions invisible in the only place
anyone looks, and suppression creep is how a deny set quietly stops denying.
`--ignore-waivers` and `--ignore-allowlist-comments` exist for this and nothing
runs them.

**Change.** `repo-aegis install ci --profile strict` writes
`.github/workflows/leak-scan-strict.yml`: weekly cron plus
`workflow_dispatch`, running `audit --json --history --ignore-waivers
--ignore-allowlist-comments` with lockfile/fixture/remote checks enabled (only
`--no-hooks-check` retained). On findings, open or update a single tracking
issue rather than failing a cron job nobody watches — a red schedule badge is
ignorable in a way an assigned issue is not.

**Gated on 1.1.** The issue body is a publication channel; it carries redacted
findings only, and `permissions: issues: write` belongs to this workflow alone
and must not be granted to the PR job. SHA-pin `actions/github-script`.

Fold in expired-waiver reporting: `check`/`audit` already surface
`expiredWaivers`, and a waiver past its `--expires` date is a finding the
operator asked to be reminded about.

This turns `install ci` into a profile-taking command: `pr` (today's file),
`strict`, `all`. Requires the `KNOWN_WORKFLOW_HASHES` map refactor and matching
`uninstall` coverage.

**Files.** `packages/cli/src/commands/{install-ci,uninstall}.ts`, both test
files, `doc/{cli-reference,github-action}.md`.
**Risk.** Medium — the hash-map refactor touches the uninstall path, which has
its own standing completeness constraint.

### 2.3 Visibility-aware egress checks

**Problem.** The generated PR workflow passes `--no-lockfile-check`, so the
egress-hygiene work in [`egress.ts`](../packages/core/src/egress.ts) — private
registry hosts in a lockfile or `.npmrc` — never runs in CI. Locally it is
gated on cached visibility (constraint 4), which a fresh checkout lacks. CI
knows the answer authoritatively, and GitHub fires a `public` event at the
exact moment a repo's threat model changes.

**Change.** Per S7, make the assertion **one-directional**:
`REPO_AEGIS_ASSUME_PUBLIC=1` raises strictness and nothing lowers it. A
symmetric `REPO_AEGIS_VISIBILITY=private|public` would be a suppression
primitive — an env var that turns egress findings off — and a developer
silencing a finding locally is exactly the failure mode the waiver design
exists to avoid. One-directional also means it needs no anti-spoofing story:
nobody gains by asserting the stricter value.

Then drop `--no-lockfile-check` from the generated PR workflow, setting the env
from `github.event.repository.private`, and add `on: public:` so a
private→public flip triggers a full strict audit immediately.

Local relevance: this repo auto-merges patch/minor Dependabot PRs
([`dependabot-auto-merge.yml`](../.github/workflows/dependabot-auto-merge.yml))
on ruleset checks alone, and lockfile churn is what an egress check covers.

**Files.** `packages/core/src/egress.ts` (or its visibility reader),
`packages/cli/src/commands/install-ci.ts`, `action.yml`, tests, docs.
**Risk.** Low once one-directional. Resolves open decision 4 as a side effect —
no git-config write from a workflow step is needed.

---

## Phase 3 — close two structural holes

### 3.1 Guard changes to the gate's own configuration

**Problem.** Three controls stop a coding *agent* minting a waiver
([cli-reference.md](cli-reference.md#repo-aegis-waive)): non-TTY refusal, the
PreToolUse write refusal on `.repo-aegis.yml`, and always-reporting `waived:
N`. None stop a commit that weakens the deny set arriving in the same PR as the
content it unblocks — the usual shape, since the person adding the waiver is
the person blocked by it. Item 0.3 has the same loop.

**Change, with S6's correction.** A workflow **cannot protect itself**: on
`pull_request`, GitHub runs the workflow from the PR's ref, so a PR can delete
the guard job that would trip on it. The load-bearing mechanism is a
**required status check registered by name** in the ruleset — a deleted or
renamed job then reads as "expected but never received" and blocks the merge.
CODEOWNERS on `.github/` and `.repo-aegis.yml` is the second layer, not the
first.

So: ship the job (detect a diff touching `.repo-aegis.yml` or
`.github/workflows/leak-scan*.yml`; re-run with `--ignore-waivers`; report the
delta in findings the change would suppress), **and** ship the ruleset and
CODEOWNERS requirements as documented prerequisites with the explicit statement
that without the named required check the job is advisory only. The same
applies to the leak-scan job itself and to 0.3's publish gate.

**Files.** `packages/cli/src/commands/install-ci.ts`, `doc/github-action.md`.
**Risk.** Low, provided the docs do not overstate what the workflow alone
achieves.

### 3.2 Tag/new-ref backstop

**Problem.** [`check --push-ref`](cli-reference.md#check---push-ref-new-ref--release-tag-scanning)
documents that stale-*ahead* remote-tracking refs can under-scan a new ref, and
names server-side push protection as the only non-advisory answer. Nothing
provides it.

**Change.** A `push: tags: ['**']` trigger running
`check --push-ref "$GITHUB_REF"` on the runner, where remote refs are
authoritative and not stale by construction. One job, one existing flag.

**Files.** `packages/cli/src/commands/install-ci.ts`, docs.
**Risk.** Low. Confirm the boundary logic behaves against the runner's
checkout; `fetch-depth: 0` is already set.

---

## Phase 4 — the Layer-2 sweep as a shipped action

Largest item; independent of Phases 0–3 and can slip without blocking them.

### 4.1 A `scan` composite action + scheduled template

**Problem.** [architecture.md](architecture.md) says the deployment for
`repo-aegis-scan` — "the scheduled GitHub Action, encrypted query list, and
state file" — "lives in a private repo of the operator's choosing." Every
operator hand-rolls the same four moving parts, and in practice the sweep does
not get deployed.

**Change.** A composite action at `actions/scan/action.yml`
(`uses: de-otio/repo-aegis/actions/scan@v1`) that installs
`@de-otio/repo-aegis-scan`, decrypts an age-encrypted queries file from a
secret-held identity, restores `seen-hits.json` via `actions/cache`, runs the
sweep, files an issue on new hits, and saves state. Plus a template workflow in
`examples/`.

**Per S9, keep the private-repo-first framing.** "Deployment lives in a private
repo of the operator's choosing" is a security property, not an unfinished
chore: the queries and the state file are marker-derived, and a code-search
token spanning several orgs is a broad credential. Shipping a template risks
reading as permission to run this from a public repo. So the docs say
private-repo-first and the template enforces it in shape:

- Decrypt to `$RUNNER_TEMP`, never the workspace — no accidental artifact
  upload, no accidental commit.
- `--reveal-matches` stays off, and the template must not expose an input for
  it.
- The issue-filing target must be a private repo; state that as a requirement,
  not a suggestion.
- A fine-grained PAT or GitHub App, not a classic `repo`-scoped token.
- `timeout-minutes`, `concurrency`, least-privilege `permissions`, SHA-pinned
  actions, `--ignore-scripts` on the install — same bar as Phase 0.

Model both exit-code modes explicitly (constraint 8), and rewrite the
architecture.md paragraph to point at the action while keeping the deployment
guidance intact.

**Files.** `actions/scan/action.yml`, `examples/scheduled-sweep.yml`,
`doc/github-action.md` or a new `doc/scan-action.md`, `doc/architecture.md`,
`tests/action-smoke.sh`.
**Risk.** Medium. Cache scoping means a PR branch cannot poison the base
branch's `seen-hits.json`, but state loss re-files every issue — note the
recovery path rather than assuming the cache persists.

### 4.2 `audit --org` recipe

**Change.** Cheaper sibling: a documented scheduled workflow running
`audit --org <org> --accept-cross-border --max-queries N` with a token from
secrets. No new action — the existing wrapper covers it. Ship as an `examples/`
file with the cross-border-transfer consent stated prominently; that flag is a
compliance gate, not a convenience, and it must survive copy-paste.

**Files.** `examples/`, `doc/github-action.md`.
**Risk.** Low, given the framing holds.

---

## Decisions to confirm

1. **`require-deny-set` default.** Proposed `'true'` — fail-closed is right for
   a leak gate, and the failure it prevents is invisible by nature. Cost: an
   immediate break for `scratch`-class and marker-free OSS consumers on
   upgrade. Alternative: `'false'` in 0.8.0 with a deprecation notice, flip in
   0.9.0. **Recommendation: `'true'` in 0.8.0.**
2. **Do generated workflows pin actions by SHA?** Proposed yes (matches
   `ci.yml`, resists upstream compromise), at the cost of pins that rot in
   consumer repos not running Dependabot. Mitigated by the optional Dependabot
   fragment.
3. **`--profile` vs. separate subcommands** for the second workflow. Proposed
   `install ci --profile <pr|strict|all>`; `install ci strict` reads better but
   adds a verb.
4. ~~Where visibility assertion lives.~~ **Resolved by S7:** a one-directional
   `REPO_AEGIS_ASSUME_PUBLIC=1`. No git-config write from a workflow step.
5. **New:** does redacted output (1.1) become the CI *default* or an opt-in
   flag? Proposed: opt-in flag, set by default in every generated template and
   by the Action. Making it the global default would change local terminal
   output, where attribution is the most useful field and the channel is not a
   publication channel.

---

## Sequencing

Phase 0 first, and within it 0.1 before the rest so the linters cover
everything after them. 1.1 before 2.2 — never file an issue before the
reporting mode is safe.

| # | Item | Depends on | Size |
|---|---|---|---|
| 0.1 | `actionlint` + `zizmor` in CI | — | S |
| 0.2 | Harden the shipped Action (S2/S4/S5/S8) | 0.1 | M |
| 0.3 | `audit --published` gate in `publish.yml` | — | S |
| 1.1 | CI-safe reporting mode (S3) | — | M |
| 1.2 | Fail-closed deny set (`--min-patterns` + `denySet` JSON) | — | M |
| 1.3 | Fork-PR guidance (docs) | 1.1, 1.2 | S |
| 2.1 | Modernise generated template + example | 0.1 | S |
| 2.2 | Strict scheduled workflow + hash-map refactor | 1.1, 2.1 | M |
| 2.3 | One-directional visibility + egress in CI | 2.1 | M |
| 3.1 | Config-tamper guard + required-check docs | 2.2 | S |
| 3.2 | Tag/new-ref backstop | 2.1 | S |
| 4.1 | `scan` composite action + template | 1.1 | L |
| 4.2 | `audit --org` recipe | — | S |

Phase 0 plus 1.1 is worth doing on its own even if nothing else lands: those
five items fix live exposure in shipped artefacts rather than adding surface.

## Docs and changelog checklist

- `doc/cli-reference.md` — `audit --json` gains `denySet`; new
  `--min-patterns` / `--require-deny-set` and the redaction flag; `install ci`
  gains `--profile`; `REPO_AEGIS_ASSUME_PUBLIC`.
- `doc/github-action.md` — fail-closed registry section (rewrite), new inputs,
  the `hits-json` → file-path output change and its deprecation window, the
  layered fork-PR guidance, publish-gate recipe, scan action, and the rule that
  anything leaving the runner is redacted.
- `doc/configuration.md` — `REPO_AEGIS_ASSUME_PUBLIC`.
- `doc/architecture.md` — point at both actions; keep the private-repo
  deployment guidance and say *why* it is that way.
- `doc/design/README.md` — the threat-model table gains rows for CI output as a
  publication channel and for registry-redirect during the Action's install.
- `CHANGELOG.md` — 0.8.0, with the `require-deny-set` default and the
  `hits-json` deprecation each called out as behaviour changes under their own
  headings.
- `doc/agent-guide.md` — any new error codes from 1.2.

---

## Deviations during implementation

Where the plan and the code disagree, the code won. These are the differences
worth knowing about.

1. **S3's blast radius was smaller than the plan claimed, and differently
   shaped.** The plan asserted that marker-scan findings carry `engagement`.
   They do not — `audit`'s findings are path/line/column/preview only. The
   actual disclosure was broader in one way and narrower in another: `audit
   --json` emits `engagements: repo.engagements` at the **top level on every
   run**, so a *clean* audit published as a PR comment leaked the full
   engagement list; and `denySet.files` is a list of marker-file stems, which
   are engagement ids under another name. Both are now redacted, and the test
   that guarantees it is an oracle over the whole serialised payload rather
   than per-key assertions.

2. **`historyHits` needed no redaction.** `HistoryHit.pattern` is already run
   through the same `formatMatch` redaction as `matchPreview`, and the type
   carries no engagement or pattern id. Redacting it was a no-op that only
   tripped TypeScript's weak-type check.

3. **The deny-set floor moved into the CLI** (as the review recommended) rather
   than being parsed out of JSON in the Action's bash. `--min-patterns` /
   `--require-deny-set` / `REPO_AEGIS_MIN_PATTERNS` now apply to every caller.

4. **The JSON contract for `install ci` had to be preserved more carefully than
   the plan anticipated.** `removed` and `absent` are documented booleans and
   `target` a string; multi-profile runs required adding `removedPaths` /
   `absentPaths` / `targets` alongside rather than widening the existing keys.

5. **zizmor needed inline suppressions in the generated templates.** Two audits
   fire on shapes that are correct here — `cache-poisoning` on `setup-node`
   (the templates never pass `cache:`) and `adhoc-packages` on the CLI install
   (installing the scanner *is* the step). Both carry `# zizmor: ignore[...]`
   with the reason inline, so a consumer running zizmor does not inherit a
   red build from a template we shipped.

6. **zizmor does not discover workflows outside `.github/workflows`.** Handing
   it the `examples` directory collects nothing and exits 0 — the worst failure
   mode a linter has. CI therefore invokes it directly with a shell-expanded
   glob instead of via `zizmor-action`.

7. **The `examples/` files are deliberately NOT SHA-pinned** where they
   reference this project's own action. A SHA in an example is copied verbatim
   and silently pins the reader to a stale commit; the files say in prose to
   pin in your own repo, and `tests/workflow-hygiene.mjs` exempts first-party
   `uses:` only.

### Verification performed

- Full suite: 1455 tests, all passing (`npm test`).
- `actionlint` 1.7.12 and `zizmor` 1.29.0 run against every checked-in workflow,
  both composite actions, all three examples, **and** the generated templates:
  no findings.
- `tests/workflow-hygiene.mjs` and `tests/action-smoke.sh`: clean.
- The 0.7.x template hash added to `KNOWN_WORKFLOW_HASHES` is verified by a test
  that embeds the verbatim 0.7.1 body, not by trusting a hand-computed digest.

### Not verified — needs a real run

- **`npm publish <tarball> --provenance`.** The publish gate packs once, scans
  that archive, and publishes it by path. Whether provenance attestation works
  when publishing from a tarball path rather than a package directory could not
  be exercised locally. `publish.yml` carries a note at the point of use; run
  `workflow_dispatch` with `dry-run: true` and confirm before the next release.
  If it does not work, restructure the gate — do not drop the by-path publish,
  which is what makes the scan meaningful.
- **The `public:` trigger** and the `config-guard` base-ref diff need a real PR
  and a real visibility flip to exercise end to end.
