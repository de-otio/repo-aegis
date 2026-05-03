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
