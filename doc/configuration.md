# Configuration

> Per-repo overrides, per-line allowlists, environment variables.
> The full per-flag reference for each subcommand lives in
> [cli-reference.md](cli-reference.md); this doc covers the
> *file-shaped* configuration surface.

## Per-line allowlist comments

Add `repo-aegis: allow` to a line (in any comment style) to suppress
hits on that line. The token is intentionally explicit so unrelated
comments don't accidentally suppress.

```ts
const fixture = "acme-corp.example"; // repo-aegis: allow synthetic test data
```

Run `repo-aegis check --ignore-allowlist-comments` (or `audit
--history --ignore-allowlist-comments`) for an audit-grade strict
mode that does not honour them.

**Don't add these comments speculatively.** A line-allow is a
compliance decision: it asserts the literal value on that line is a
synthetic fixture, a regression test for a remediated leak, or
similar. Add one only with explicit user intent.

## Per-repo `.repo-aegis.yml` override

A `.repo-aegis.yml` at the repo root declares class and engagements
when the maintainer wants the config checked in:

```yaml
class: customer-coupled
engagements:
  - customer-a
```

Per-clone `git config repo-aegis.class` / `repo-aegis.engagement`
still wins; the YAML is the project default.

The same file also carries two additive, optional keys — path
exemptions and waivers — described below.

## Path exemptions for `_always` findings (`alwaysBlockExemptPaths`)

A secret *shape* (an `_always`-class pattern — the org-wide always-
block list, not an engagement or `_private_infra` marker) can have a
genuinely benign home: a test fixture, a `__fixtures__` directory. An
`alwaysBlockExemptPaths: string[]` key, set as a list of `*`/`?`/`**`
path globs (repo-relative, POSIX `/`-separated), tells `check` not to
enforce `_always` patterns inside matching paths.

**Two levels, both optional, both additive:**

- **Registry** (`engagements.yaml`, machine-wide):
  `alwaysBlockExemptPaths: [...]`. When absent, the built-in default
  applies: `**/test/**`, `**/tests/**`, `**/__tests__/**`,
  `**/__fixtures__/**`, `**/fixtures/**`, `**/testdata/**`,
  `**/*.test.*`, `**/*.spec.*`, `**/*.fixture.*`.
- **Per-repo** (`.repo-aegis.yml`): `alwaysBlockExemptPaths: [...]`,
  merged **additively** on top of the registry's list — a repo can
  only widen its own exemptions, never narrow or remove one the
  registry declared.

A glob that matches everything (`*`, `**`, `**/*`) is rejected at load
as a config error: an exemption that exempts the whole repo is a
mistake, not a preference.

```yaml
# .repo-aegis.yml
alwaysBlockExemptPaths:
  - "**/golden/**"
```

**This is `_always`-only, and the asymmetry is load-bearing.**
Engagement markers and `_private_infra` are **never** path-exempt,
under any configuration, at either level — a customer name typed into
a test fixture is still a leak. Only generic secret *shapes* are ever
exemptible, because those (and only those) have well-known benign
homes. `audit --fixture-check` still runs the full, unexempted pattern
set over the directories this key exempts, and demotes an exempt-path
`_always` hit to an informational finding rather than dropping it, so
an exemption stays visible on audit even when `check` doesn't block on
it. See [cli-reference.md](cli-reference.md#repo-aegis-audit) and the
design doc's threat-model table.

## Reviewed-benign waivers (`waivers:`)

`.repo-aegis.yml` also carries a `waivers:` list — the auditable
alternative to `--no-verify` for a genuine `_always` false positive
that isn't (or can't be) covered by a path exemption:

```yaml
waivers:
  - pattern: _always/9f2c1a4b7de0
    blob: 3f7a1e2c9b8d0f4a6e5c7b1d2a3f4e5d6c7b8a9f  # post-image blob sha, 40 hex
    reason: fixture keypair used only in scan.test.ts
    approver: jdoe
    date: 2026-07-26
    expires: 2027-07-26   # optional
```

Managed exclusively through `repo-aegis waive` (see
[cli-reference.md](cli-reference.md#repo-aegis-waive)) — hand-editing
this key works but skips the audit-log record `waive` appends. A
waiver is keyed on `(pattern, blob)`, not path or line: it survives
history rewrites and covers exactly the reviewed bytes, so a new key
landing in a new blob is never silently covered by an old approval.
Only `_always`-stem pattern ids are ever waivable — never engagement
or `_private_infra` patterns.

Because this file lives inside the repo, it is exactly the kind of
file a blocked coding agent would look to edit to unblock itself —
which would reconstruct `--no-verify` with extra steps. Three
independent controls close that off (see the design doc's threat-model
table for the full rationale): the PreToolUse `hook check-write` gate
refuses an agent write to `.repo-aegis.yml` outright; `repo-aegis
waive` itself refuses to run outside a TTY unless
`REPO_AEGIS_WAIVE_NONINTERACTIVE=1` is set; and `check` always reports
`waived: N`, never silently.

**Precedence (first wins):**

1. CLI flag (`--cwd`, etc).
2. `.git/config` (per-clone `repo-aegis.class` / `repo-aegis.engagement`).
3. `.repo-aegis.yml` at the repo root.
4. Default (`private-strict`, no engagements).

`repo-aegis status --json` reports `classFromOverride: true` /
`engagementsFromOverride: true` when the value came from the
`.repo-aegis.yml` rather than git config.

## Environment variables

| Var | Effect |
|---|---|
| `REPO_AEGIS_HOME` | Override `~/.config/repo-aegis` as the config home. Stderr warning printed on every TTY invocation when set; suppressed in hook context. |
| `REPO_AEGIS_REGISTRY` | Override the registry path independently from home. Set by the `--registry-path` global flag. |
| `REPO_AEGIS_ACCEPT_ORG_SEED_TRANSFER` | Equivalent to passing `--accept-cross-border` to `audit --org`. The user must set this themselves; agents do not auto-set. |
| `REPO_AEGIS_NEW_REF_FULL_SCAN` | Set to `1` to force `check --push-ref` to fall back to a full-history scan unconditionally, bypassing the boundary-based incremental logic. Escape hatch for the rare case where the boundary derivation itself is suspect. |
| `REPO_AEGIS_WAIVE_NONINTERACTIVE` | Set to `1` to let `repo-aegis waive` run with stdin that isn't a TTY. `waive` refuses otherwise, specifically so a hook, script, or coding agent cannot mint a waiver on its own behalf. A human deliberately scripting a waiver still has to set this themselves. |
| `REPO_AEGIS_MIN_PATTERNS` | Minimum deny-set size; `check` and `audit` exit 2 below it. Equivalent to `--min-patterns <n>`. The composite Action sets it from its `require-deny-set` / `min-patterns` inputs rather than splicing a flag into a user-supplied `args` string, where a consumer could overwrite it. |
| `REPO_AEGIS_REDACT_ATTRIBUTION` | Set to `1` to strip engagement attribution from output. Equivalent to `--redact-attribution`. Set by the Action and by every generated CI workflow, because a job log, a PR comment, and an issue body are publication channels. |
| `REPO_AEGIS_ASSUME_PUBLIC` | Set to `1` to assert this repo is public-facing, which turns private-registry egress enforcement **on**. Exists for CI: a fresh clone has no cached `repo-aegis.visibility`, while a workflow knows the answer from `github.event.repository.private`. **One-directional by design** — there is no counterpart that asserts "private". An env var that switches findings *off* would be a waiver nobody reviewed, reachable from a shell profile or a workflow edit, with none of the audit trail `waive` insists on. One-directional also needs no anti-spoofing story: nobody gains by asserting the stricter value. |

`REPO_AEGIS_REVEAL_MATCHES` is **not** an env var. The previous
env-var path was deliberately removed because env vars propagate to
subprocess hooks unintentionally and could cause literal markers to
flow into agent tool-result context. The only path to literal-reveal
is a `--verbose` CLI flag passed by a human at a terminal.

## Output redaction policy

Hooks NEVER pass `--verbose`. The `repo-aegis hook scan-after-write`
subcommand calls `check` without `--verbose`, so this can't be
subverted by hand-edited `~/.claude/settings.json`. Error messages
NEVER enumerate registry contents — they redirect to `repo-aegis
engagements list` (which the user runs at a terminal, in `--json`
form for an agent).

For the agent-side rules (don't echo literal markers back to the
user, don't retry a write with the marker still present, etc.) see
[agent-guide.md](agent-guide.md).

### Attribution redaction (a second, separate axis)

The policy above is about the matched **literal**. It says nothing about
**attribution** — which engagement a hit belongs to, which engagements the repo
carries, which marker files the deny set was built from. Those are emitted in
full by default, because before CI the only consumers were a local terminal and
an agent tool result, both inside the trust boundary.

CI is not. `--redact-attribution` / `REPO_AEGIS_REDACT_ATTRIBUTION=1` strips it,
and is set by default in the composite Action and every generated workflow. See
[cli-reference.md](cli-reference.md#ci-safe-output---redact-attribution) for the
field-by-field effect.

Note the asymmetry worth remembering: `--verbose` is a thing a human opts *into*
at a terminal; redaction is a thing CI opts *into* on the way out. They are
independent, and a hook must never pass either.

## Compatibility of `alwaysBlockExemptPaths` and `waivers`

Both keys are **optional and additive**, in both the registry and
`.repo-aegis.yml` — neither requires a `schemaVersion` bump. Both
schemas are `.passthrough()`, so an **older** repo-aegis reading a
registry with `alwaysBlockExemptPaths` or a `.repo-aegis.yml` with
`waivers` simply ignores the unknown key: it enforces the full
`_always` set everywhere (no exemptions applied) and honours no
waivers (nothing filtered out). In both directions that's the
*stricter* reading, never the laxer one — an older client can end up
over-blocking relative to a newer one, but it can never under-block
because it doesn't understand a key. Stated explicitly here so the
next person doesn't have to re-derive it from the schema code.
