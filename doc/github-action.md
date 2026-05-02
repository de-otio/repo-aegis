# repo-aegis GitHub Action

A composite GitHub Action that runs an engagement-scoped data-leak
prevention scan against the consuming repository. It wraps the
`@de-otio/repo-aegis` CLI so workflows can pin a single
`uses: de-otio/repo-aegis@v1` step instead of installing the CLI by
hand.

## What it does

On each invocation the action:

1. Sets up Node.js 24 (required for the published CLI).
2. Installs `@de-otio/repo-aegis` globally (latest by default; pinned
   via the `version` input).
3. Runs the chosen subcommand (default `audit`) with `--json` always
   appended so the structured output is captured into the
   `hits-json` step output.
4. By default fails the workflow if the CLI exits non-zero (i.e. on
   any marker hit or audit finding); set `fail-on-hits: false` to
   collect findings without failing.

## Minimal usage

```yaml
name: leak-scan
on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  leak-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: de-otio/repo-aegis@v1
```

That's it. With no inputs the action runs `repo-aegis audit --json`
and fails the job on any hit. The consuming repo's class and allowed
engagements come from a `.repo-aegis.yml` checked in at the repo
root.

## Advanced: custom registry path

If your workflow restores the engagement registry from a secret /
encrypted artifact / cache, point the action at the file via the
`registry` input:

```yaml
jobs:
  leak-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Restore engagements registry
        run: |
          mkdir -p "${RUNNER_TEMP}/repo-aegis"
          printf '%s' "${{ secrets.REPO_AEGIS_ENGAGEMENTS_YAML }}" \
            > "${RUNNER_TEMP}/repo-aegis/engagements.yaml"

      - uses: de-otio/repo-aegis@v1
        with:
          command: audit
          args: --no-history --no-lockfile-check
          registry: ${{ runner.temp }}/repo-aegis/engagements.yaml
          fail-on-hits: 'true'
          version: '0.2.0'
```

Under the hood the action exports `REPO_AEGIS_REGISTRY=<path>` for
the CLI invocation; that env var is the same hook the CLI honours
locally.

## Inputs

| Name | Required | Default | Description |
|------|----------|---------|-------------|
| `command` | no | `audit` | Subcommand to invoke (e.g. `audit`, `check`, `status`). |
| `args` | no | `''` | Extra CLI args, space-separated. Passed verbatim after the subcommand. |
| `registry` | no | `''` | Path to a custom `engagements.yaml`. If empty, the CLI falls back to its usual lookup. |
| `fail-on-hits` | no | `'true'` | When `'true'`, fail the workflow on any non-zero exit from the CLI. Set to `'false'` to surface findings without failing. |
| `version` | no | `latest` | Version specifier passed to `npm install -g @de-otio/repo-aegis@<version>`. |

`--json` is always appended to the CLI invocation so the structured
output can be captured into the step output.

## Outputs

| Name | Description |
|------|-------------|
| `exit-code` | Numeric exit code from the CLI (`0` clean, `1` hit, `2` error). |
| `hits-json` | The CLI's JSON output as a string. Parse with `fromJSON()` in subsequent steps. |

Example consumer:

```yaml
- id: scan
  uses: de-otio/repo-aegis@v1
  with:
    fail-on-hits: 'false'

- name: Use the result
  if: steps.scan.outputs.exit-code != '0'
  run: |
    echo "scan exit: ${{ steps.scan.outputs.exit-code }}"
    echo '${{ steps.scan.outputs.hits-json }}'
```

## Registry availability

The action does **not** ship an engagement registry. The registry is
private to the operator and must be made available to the workflow
in one of these ways:

- **Checked into the consuming repo** at
  `.repo-aegis-registry/engagements.yaml`, then passed via the
  `registry` input. Suitable only when the registry is
  non-confidential (e.g. a single-engagement OSS project).
- **Restored from secrets** at workflow time — see the advanced
  example above. Use a single multi-line secret containing the YAML.
- **Restored from an encrypted artifact** (age-encrypted blob in the
  repo, decrypted with a key from `secrets.*`). This avoids storing
  the plaintext as a GitHub secret.
- **Cache-restored** from a previous job that decrypted it
  (`actions/cache` keyed on a checksum).

If no registry is provided and there's no `.repo-aegis.yml` checked
into the repo, the CLI runs with whatever fallback its current
defaults dictate — typically a meaningful failure on `audit` because
no deny set is computed.

## Repo classification

The action does **not** auto-classify the repo. The consuming repo
is expected to declare its class and allowed engagements via a
`.repo-aegis.yml` at the repo root, e.g.:

```yaml
class: customer-coupled
engagements:
  - customer-a
```

Per-clone `git config repo-aegis.class` settings won't be present
in a fresh CI checkout, so the YAML is the right surface for
CI. A public/OSS repo should set `class: public-osint` (or your
project's equivalent) and list no engagements, so customer markers
are enforced unconditionally.

If you need to override per-workflow, pass the relevant flag via
`args:` — e.g. `args: --cwd subproject` to scope to a subdirectory.

## See also

- [`packages/cli` README](../packages/cli) — full CLI reference.
- [Agent operator guide](agent-guide.md) — driving repo-aegis from
  a coding agent.
- [`examples/github-action-usage.yml`](../examples/github-action-usage.yml)
  — copy-paste reference workflow.
