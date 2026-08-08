# repo-aegis GitHub Actions

Two composite Actions plus a set of generated workflows.

| What | Where | Purpose |
|---|---|---|
| `de-otio/repo-aegis@v1` | [`action.yml`](../action.yml) | Run any repo-aegis subcommand against the consuming repo. Defaults to `audit`. |
| `de-otio/repo-aegis/actions/scan@v1` | [`actions/scan/action.yml`](../actions/scan/action.yml) | The scheduled Layer-2 sweep: GitHub code-search for markers already published. |
| `repo-aegis install ci` | generated | Writes complete, hardened workflows into a consuming repo. **Start here.** |

The client-side gate is advisory by construction: `--no-verify` bypasses it, a
fresh clone has no hooks, and
[`check --push-ref`](cli-reference.md#check---push-ref-new-ref--release-tag-scanning)
documents a residual under-scan risk whose only non-advisory answer is
server-side enforcement. CI is that enforcement. It is the layer nobody can
skip in a hurry.

---

## Two rules for any workflow that runs a scanner

Both have been violated in this project's own shipped examples. They are not
theoretical.

### 1. Never interpolate scanner output into a `run:` block

GitHub expands `${{ ... }}` into the shell script **before** the shell parses
it. The scan payload contains repo-derived strings — file paths above all — so
a path containing a quote ends your quoting and the remainder is executed.

```yaml
# WRONG — a file path can close the quote and run commands
- run: echo '${{ steps.scan.outputs.hits-json }}'

# RIGHT — read the file the action wrote
- uses: actions/github-script@<sha>
  env:
    RESULTS_FILE: ${{ steps.scan.outputs.results-file }}
  with:
    script: |
      const raw = require('fs').readFileSync(process.env.RESULTS_FILE, 'utf8');
```

`results-file` exists for this. `hits-json` is deprecated and will be removed
in 0.9.0.

### 2. Never publish un-redacted findings

A PR comment, an issue body, and a job log are all world-readable on a public
repo. An engagement id is usually the customer's name — the exact string this
tool exists to keep out of public places. Note that a **clean** run leaks too:
`audit --json` emits the repo's engagement list whether or not anything
matched.

The action sets `redact-attribution: 'true'` by default. Redacted output keeps
file, line, column, redacted match preview, `_always` pattern ids, and an
`engagementsAffected` count — everything needed to act, nothing that names a
customer. Re-run locally without `--redact-attribution` to see attribution.

`--verbose` in CI is as prohibited as `--verbose` in a hook, and for the same
reason.

---

## Quick start

```sh
repo-aegis install ci --profile all --write
```

That writes two workflows and prints a `dependabot.yml` fragment to keep their
action pins current:

- **`.github/workflows/leak-scan.yml`** (profile `pr`) — the blocking gate. PRs,
  pushes to a default branch, tags, and the `public` event. Three jobs:
  `leak-scan` (the audit), `new-ref-scan` (tags), `config-guard` (PRs that
  modify the gate's own configuration).
- **`.github/workflows/leak-scan-strict.yml`** (profile `strict`) — a weekly
  audit with waivers and allow-comments ignored, filing findings as an issue.

Prefer to write your own? [`examples/github-action-usage.yml`](../examples/github-action-usage.yml)
is a minimal, commented starting point.

### Required status checks

`config-guard` **cannot protect itself**. On `pull_request`, GitHub runs the
workflow from the PR's own ref, so a PR can delete the job that would trip on
it. What makes it enforceable is a **required status check registered by name**
in the repository ruleset — a deleted or renamed job then reads as "expected
but never received" and blocks the merge.

Add `leak-scan` and `config-guard` to your required checks, and put
`.repo-aegis.yml` and `.github/` under CODEOWNERS. Without that, both jobs are
advisory.

---

## Inputs — `de-otio/repo-aegis@v1`

| Name | Default | Description |
|------|---------|-------------|
| `command` | `audit` | Subcommand to invoke (`audit`, `check`, `status`, …). |
| `args` | `''` | Extra CLI args, space-separated, passed verbatim after the subcommand. |
| `registry` | `''` | Path to a custom `engagements.yaml`. Exported as `REPO_AEGIS_REGISTRY`. |
| `fail-on-hits` | `'true'` | Fail the workflow on a non-zero CLI exit. |
| `require-deny-set` | `'true'` | Fail when the computed deny set is empty. See below. |
| `min-patterns` | `'0'` | Stronger floor: fail unless the deny set has at least N patterns. Overrides `require-deny-set` when > 0. |
| `redact-attribution` | `'true'` | Strip engagement ids from output. See rule 2. |
| `version` | the action's own version | npm version of `@de-otio/repo-aegis` to install. **Not `latest`** — a compromised publish would otherwise reach every consumer's gate on the next run. Pass `latest` explicitly to opt into floating. |

`--json` is always appended so the outputs are populated.

## Outputs

| Name | Description |
|------|-------------|
| `exit-code` | `0` clean, `1` hit, `2` the scan could not run (usage error, or the deny-set floor was not met). |
| `results-file` | Path under `RUNNER_TEMP` holding the JSON output. **Use this.** |
| `hits-json` | DEPRECATED (removal in 0.9.0) — the JSON as a string. See rule 1. |

---

## Fail closed: `require-deny-set`

**This defaults to `true` as of 0.8.0, and it is a behaviour change.**

Without it, a registry that failed to load produces a deny set with zero
patterns, a scan that matches nothing, and exit 0 — a green check
indistinguishable from a real pass. That happens on:

- a fork PR (secrets are not exposed to `pull_request` runs from forks);
- a renamed, rotated, or mistyped secret;
- a `registry` input pointing at a path that does not exist;
- a registry that loaded but whose engagements no longer resolve to any active
  marker file (use `min-patterns` for this one).

The floor is enforced **in the CLI**, where the number is computed, so it
applies to local runs, the MCP server, and scheduled sweeps identically — not
only to this action. Exit code is **2**, not 1: "the gate could not run" is a
different fact from "the gate found something", and conflating them is what
lets a broken gate look like a passing one.

Turn it off (`require-deny-set: 'false'`, or `--min-patterns 0`) only if you
genuinely intend a repo to be scanned with no deny set — a `scratch`-class repo,
or an OSS repo with no markers of its own.

---

## Registry availability

The action does **not** ship an engagement registry. It is private to the
operator and must be made available to the workflow:

- **Checked into the consuming repo** at `.repo-aegis-registry/engagements.yaml`,
  passed via the `registry` input. Only appropriate when the registry is
  non-confidential — e.g. a single-engagement OSS project.
- **Restored from secrets** at workflow time (see below). One multi-line secret
  containing the YAML.
- **Restored from an age-encrypted blob** committed to the repo and decrypted
  with a key from `secrets.*`. Avoids storing plaintext as a GitHub secret; see
  `repo-aegis registry encrypt`.
- **Cache-restored** from a job that decrypted it.

```yaml
- name: Restore engagements registry
  env:
    REGISTRY_YAML: ${{ secrets.REPO_AEGIS_ENGAGEMENTS_YAML }}
  run: |
    mkdir -p "${RUNNER_TEMP}/repo-aegis"
    # Via env, never `printf '%s' '${{ secrets.* }}'` — see rule 1. A secret
    # spliced into a script is both an injection vector and a log-leak risk.
    printf '%s' "$REGISTRY_YAML" > "${RUNNER_TEMP}/repo-aegis/engagements.yaml"

- uses: de-otio/repo-aegis@v1
  with:
    registry: ${{ runner.temp }}/repo-aegis/engagements.yaml
```

With `require-deny-set` on (the default), a failure of any of the above is now
a red job rather than a silent pass.

---

## Fork PRs

With the fail-closed default, a fork PR that cannot read your registry secret
**fails** rather than silently passing. That is correct — but it needs a plan,
or you have converted a silent hole into a permanently red check.

### Recommended: layer the enforcement

- **Fork PRs** run on `pull_request` with no registry, enforcing the universal
  `_always` patterns only — private keys, token shapes, JWTs. Real coverage, and
  no secret is ever present in a job holding attacker-controlled files. Set
  `require-deny-set: 'false'` on this job, or scope the workflow so the
  registry-backed job is skipped for forks.
- **Engagement-scoped enforcement** runs on `push` to protected branches, or in
  the merge queue. Still strictly before anything leaves the repo, which is the
  property that matters. "Before merge" was never the requirement; "before it
  is published" is.

### Advanced: `pull_request_target`

You can scan a fork PR's merge result with secrets available — but
`pull_request_target` grants a write-scoped token and your secrets to a job
whose input is untrusted, and getting this wrong is the classic "pwn request".
**Read every constraint before using it. If you cannot honour all of them, use
the layered approach above.**

1. **Read `.repo-aegis.yml` from the BASE ref, never the PR's.** Otherwise a
   fork can add waivers and path exemptions that suppress its own findings.
2. **Execute no code from the PR.** No `npm ci`, no build, no test, no
   lockfile-keyed cache. The scan reads file *content*; it never needs to run
   anything from the tree.
3. **Install the CLI from outside the checkout**, with `--ignore-scripts` and an
   explicit `--registry`. npm reads `./.npmrc` from the working directory, so an
   install run inside the checkout can be repointed by a file the PR author
   wrote — and the substituted package's install scripts would then execute with
   your registry secret in the environment. (This is why the shipped actions do
   it that way; copy the pattern.)
4. `persist-credentials: false` on checkout, and the narrowest `permissions:`
   block that works.

---

## The scan action — `de-otio/repo-aegis/actions/scan@v1`

The Layer-2 sweep: GitHub code-search queries derived from your markers,
de-duplicated against a state file, filed as an issue when something new turns
up. See [`examples/scheduled-sweep.yml`](../examples/scheduled-sweep.yml).

**Run it from a private repo.** That is a security property, not an unfinished
chore:

- the queries file's strings **are** your customer markers (encrypt it with
  `repo-aegis-scan encrypt-query` even so — a future visibility flip should not
  become a disclosure);
- the state file records where matches were found;
- a code-search token spans every org you can read, so it is a broad credential
  — use a fine-grained PAT or a GitHub App token, never a classic `repo` PAT;
- the issue-filing target must be private: a filed hit names the repo and path
  where your marker turned up.

The action decrypts the queries file into `RUNNER_TEMP`, never the workspace —
a plaintext copy inside the checkout can be swept up by an artifact upload, a
`git add`, or a build step that globs. It is removed after the run.
`--reveal-matches` is deliberately not exposed as an input.

**Exit codes differ by output mode**, which is easy to get wrong: in `json` mode
`1` means "new hits found" and the caller must react; in `issue` mode a
successful filing exits `0` and the issue *is* the reaction. `2` is always an
error.

For a cheaper alternative with no state file and no second package, see
[`examples/org-sweep.yml`](../examples/org-sweep.yml), which runs `audit --org`
on a schedule. Note that `--accept-cross-border` there is a compliance gate, not
a convenience flag — it sends marker-derived substrings to GitHub.

---

## Publishing artifacts: gate on `audit --published`

A tracked-file scan does not cover what you ship. `files` / `.npmignore` drift,
build output, and stray fixtures land in a tarball without necessarily being
visible to `git ls-files`, and the tarball is the last artefact anyone can
inspect before it is world-readable and effectively unrecallable.

Pack once, scan that artifact, publish **that same artifact**:

```yaml
- name: Pack and scan
  env:
    PACK_DIR: ${{ runner.temp }}/packed
  run: |
    set -euo pipefail
    mkdir -p "$PACK_DIR"
    tgz=$(npm pack --silent --pack-destination "$PACK_DIR")
    repo-aegis audit --published "${PACK_DIR}/${tgz}" --json \
      --no-marker-scan --no-lockfile-check --no-fixture-check \
      --no-remote-check --no-hooks-check
    echo "TARBALL=${PACK_DIR}/${tgz}" >> "$GITHUB_ENV"

- name: Publish
  run: npm publish "$TARBALL" --access public
```

Packing again at publish time would mean the bytes you scanned and the bytes you
ship are two different archives. This repo's own
[`publish.yml`](../.github/workflows/publish.yml) does exactly the above, and
scans with the just-built CLI rather than the published one — a released
regression must not be able to bless its own tarball.

`audit --published` accepts a `.tgz`, a `.vsix`, or a bare npm package name.

---

## Repo classification

The action does **not** auto-classify. A fresh CI checkout has no
`git config repo-aegis.class`, so declare it in `.repo-aegis.yml` at the repo
root:

```yaml
class: customer-coupled
engagements:
  - customer-a
```

A public/OSS repo should set a class with no engagements, so the universal
markers are enforced unconditionally.

### Visibility and egress checks

The lockfile / `.npmrc` egress check (private-registry URLs, which leak an
account id and break `npm ci` for external clones) only applies to public-facing
repos, and it normally reads a cached `repo-aegis.visibility` git-config value
that a fresh clone does not have. CI knows the answer, so the generated
workflows pass it:

```yaml
env:
  REPO_AEGIS_ASSUME_PUBLIC: ${{ github.event.repository.private == false && '1' || '0' }}
```

`REPO_AEGIS_ASSUME_PUBLIC` is **one-directional**: it can assert "public",
which turns enforcement *on*. There is deliberately no counterpart that asserts
"private" — an environment variable that switches findings off is a waiver
nobody reviewed, reachable from a shell profile or a workflow edit, with none of
the audit trail `repo-aegis waive` insists on.

The generated PR workflow also triggers on `public:`, which GitHub fires the
moment a repo flips private → public — the one point at which the threat model
changes wholesale.

---

## Linting your workflows

This repo lints every piece of Actions YAML it ships, including the templates
`install ci` generates, with
[actionlint](https://github.com/rhysd/actionlint),
[zizmor](https://docs.zizmor.sh), and
[`tests/workflow-hygiene.mjs`](../tests/workflow-hygiene.mjs) for three rules
neither tool enforces: no `${{ }}` inside `run:`, every job has
`timeout-minutes`, every third-party `uses:` is SHA-pinned. Worth copying — a
defect in a security gate's workflow is a defect in the gate.

## See also

- [CLI reference](cli-reference.md) — flags, exit codes, JSON shapes.
- [Agent operator guide](agent-guide.md) — driving repo-aegis from a coding agent.
- [`examples/`](../examples/) — copy-paste reference workflows.
