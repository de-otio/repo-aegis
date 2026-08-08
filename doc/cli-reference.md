# repo-aegis — CLI reference

> Every subcommand's flags, behaviour, exit codes, and JSON shape.
> The flag set is contract-tested in
> [`packages/cli/src/program.test.ts`](../packages/cli/src/program.test.ts);
> renaming any flag here is a coordinated change across that test, this
> file, and any downstream artefact (settings.json hook command,
> generated GHA workflow, agent guide).

## Universal flags

These apply to every subcommand. Specified once, not duplicated below.

| Flag | Default | Meaning |
|---|---|---|
| `--cwd <dir>` | `process.cwd()` | Override working directory for git operations |
| `--json` | off | Emit structured JSON instead of human-readable text |
| `--registry-path <path>` | `$REPO_AEGIS_HOME/engagements.yaml` | Override registry path |
| `--home <dir>` | `$REPO_AEGIS_HOME` or `~/.config/repo-aegis` | Override config home |
| `--no-color` | off | Disable ANSI colour output (reserved; currently no colour is used) |
| `--version` | — | Print version and exit |

`--cwd` is read globally and threaded into per-command handlers.
`--home` and `--registry-path` set the corresponding env vars
(`REPO_AEGIS_HOME` / `REPO_AEGIS_REGISTRY`) before the subcommand
runs, so any deeply-nested call into `core` picks them up
transparently.

## Exit codes

Stable across every subcommand:
- **0**: success / clean.
- **1**: actionable finding (hits found / new code-search hits).
- **2**: usage / config / "tool couldn't do its job".

## Canonical JSON objects

```ts
type RepoJson = {
  cwd: string;
  isGitRepo: boolean;
  class: "public-eligible" | "private-strict" | "customer-coupled" | "scratch";
  classExplicit: boolean;
  engagements: string[];   // ids only
};

type EngagementJson = {
  id: string;
  name: string;
  active: boolean;
};

type ScanHitJson = {
  path?: string;        // omitted when scanning --staged
  line: number;         // 1-indexed
  column: number;       // 1-indexed
  matchPreview: string; // redacted by default
  engagement?: string;  // marker-file stem the matched pattern came from
  patternId?: string;   // "<stem>/<12-hex>" — sha256(pattern).slice(0,12); copy-paste into `waive`
  blob?: string;        // post-image git blob sha (40 hex), diff modes only
};
```

**Under `--redact-attribution`** (see below), `engagement` is dropped and
`patternId` survives only for `_always` stems. Everything else — path, line,
column, `matchPreview`, `blob` — is unchanged.

## CI-safe output (`--redact-attribution`)

`redaction.ts` governs the matched *literal*. This governs *attribution*: which
engagement a hit belongs to, which engagements the repo carries, which marker
files the deny set was built from. That was never treated as sensitive because
before CI it only ever reached a local terminal — which is inside the trust
boundary. A PR comment, an issue body, and a job log on a public repo are not,
and an engagement id is usually the customer's name.

Set by `--redact-attribution` or `REPO_AEGIS_REDACT_ATTRIBUTION=1`. Both `check`
and `audit` support it; the composite Action and every generated CI workflow set
it by default. It is deliberately **not** the default locally, where attribution
is the most useful field on the line.

What it changes:

| Field | Redacted form |
|---|---|
| hit `engagement` | dropped |
| hit `patternId` | kept for `_always/…`, dropped otherwise |
| `repo.engagements` / top-level `engagements` | `[]`, plus `engagementCount` on findings that carried a list |
| `denySet.files` | non-`_always` stems replaced with `<redacted>`; length preserved |
| `expiredWaivers[].pattern` | dropped unless `_always/…` |
| text output `[engagement]` suffix | dropped; replaced by an `N engagement(s) affected` line |
| `engagementsAffected` | added — the distinct-engagement count |
| `attributionRedacted` | added — `true`, so a consumer can tell redacted output apart |

A **clean** run is redacted too: `engagements` is emitted whether or not
anything matched, so a redaction keyed on "did we find something" would leak on
the common case. This is verified by an oracle test that greps the entire
serialised payload for the fixture's engagement ids
([`packages/cli/src/ci-output.test.ts`](../packages/cli/src/ci-output.test.ts)).

## Failing closed on an empty deny set

`--min-patterns <n>` (or `--require-deny-set`, or `REPO_AEGIS_MIN_PATTERNS`)
makes `check` and `audit` **exit 2** when the computed deny set has fewer than
`n` patterns.

The failure it prevents is silent: a CI workflow restores the registry from a
secret, secrets are not exposed to `pull_request` runs from forks, the restore
writes an empty file, the deny set computes to zero patterns, nothing matches,
and the job exits 0. A green check that scanned nothing looks exactly like a
green check that scanned everything. The same shape occurs on a mistyped secret
name, a rotated-away secret, and a `registry` path that does not exist;
`--min-patterns <n>` above 1 additionally catches a registry that loaded but
silently lost an engagement.

Exit **2**, not 1: "the gate could not run" is a different fact from "the gate
found something". The floor is checked before any early return, including
`check`'s `no-deny-set` result — which is precisely the outcome it exists to
reject.

---

## Per-repo workflow

### `repo-aegis allow <engagement>...`

Adds one or more engagements to the current repo's
`repo-aegis.engagement` git config (multi-value).

- Variadic: `allow customer-a customer-b` adds both.
- Fuzzy resolution against the registry (id substring or name).
- Idempotent: already-allowed engagements are reported as such, not
  re-added.
- Errors out if the registry is missing or a query is ambiguous.

JSON shape:
```json
{
  "action": "allow",
  "results": [
    { "engagement": { "id": "customer-a", "name": "Customer A", "active": true }, "added": true }
  ],
  "repo": { /* RepoJson */ }
}
```

### `repo-aegis deny <engagement>...`

Inverse of `allow`. Same shape with `"action": "deny"` and
`wasAllowed` per result.

### `repo-aegis status`

Prints the current repo's class, allowed engagements, deny-set
summary, and leak-context-mode flag.

JSON:
```json
{
  "repo": { /* RepoJson */ },
  "allowedEngagements": [{ "id": "customer-a", "name": "Customer A", "active": true }],
  "denySet": { "files": ["_always", "customer-b"], "patternCount": 27 },
  "alwaysBlock": { "patternCount": 3 },
  "regexBackend": "re2",
  "warnings": []
}
```

`regexBackend` is `"re2"` when the optional `re2` dependency is
installed and active for pattern validation, or `"in-process"`
otherwise. See the design doc's locked-decisions row "Regex backend
(validation)" for what the field means.

Text output also gains a `hooks:` line reporting whether the
pre-commit/pre-push gate is actually wired up for this repo (JSON:
a `hooks` object, the same shape `audit`'s hooks check and `doctor`
use — see [`repo-aegis doctor`](#repo-aegis-doctor) for the full code
list). `status` does not exit non-zero over a hooks problem — the line
is the signal; `audit` (or `doctor`, fleet-wide) is the gate:

```
hooks:    FAIL — core.hooksPath is <repo>/.git/hooks (local override),
          expected ~/.config/repo-aegis/hooks; no pre-commit found.
          fix: git config --unset core.hooksPath
```

To inspect leak-context strict mode, run `repo-aegis context status --json`
(it is not embedded in `status`).

### `repo-aegis check`

Scans content against the repo's scoped deny set. The pre-commit /
pre-push hooks shell out to this; the Claude Code PostToolUse hook
calls it via `hook scan-after-write`.

| Flag | Default | Meaning |
|---|---|---|
| `--staged` | — | scan the staged diff |
| `--path <path>` | — | scan a single file (canonicalised; symlinks resolved; rejected if outside cwd) |
| `--range <revspec>` | — | scan added lines in a commit range, e.g. `<remote>..<local>` |
| `--push-ref <ref>` | — | scan a ref the remote does not have yet, relative to `refs/remotes/<remote>/*` (used by pre-push for new branches and tags) |
| `--remote <name>` | `origin` | with `--push-ref`: remote whose tracking refs bound the scan |
| `--history` | — | scan full git history with `git log -G <pattern>` per pattern |
| `--since <revspec>` | — | with `--history`: lower-bound revspec |
| `--max-file-bytes <n>` | 1048576 (1 MiB) | per-file size cap; larger files reported as `skipped: too-large` |
| `--ignore-allowlist-comments` | off | do not respect `repo-aegis: allow` comments (audit-grade strict) |
| `--ignore-waivers` | off | do not apply waivers from `.repo-aegis.yml`; report every `_always` finding even if a reviewed-benign waiver exists (audit-grade strict) |
| `--min-patterns <n>` | 0 | exit **2** if the computed deny set has fewer than `<n>` patterns. Fail-closed: a scan that had nothing to match is not a clean scan. Env: `REPO_AEGIS_MIN_PATTERNS` |
| `--require-deny-set` | off | sugar for `--min-patterns 1` |
| `--redact-attribution` | off | strip engagement ids and engagement-derived pattern ids from output. Set this for anything published — PR comments, issues, public job logs. Env: `REPO_AEGIS_REDACT_ATTRIBUTION=1` |
| `--verbose` | off | reveal literal matched markers (NEVER pass from hooks) |

Behaviour:
1. Validate exactly one of `--staged`/`--path`/`--range`/`--push-ref`/
   `--history` is given. Else exit 2.
2. Read repo config; compute deny set.
3. **Fail-closed**: if class = `customer-coupled` and engagements is
   empty → exit 2 with the "must declare engagement" error. Any
   underlying `git` failure (diff, rev-list, merge-base, log) also
   exits 2 rather than being swallowed as "clean" — a scan that
   couldn't run is not the same thing as a clean scan.
4. Empty deny set → exit 0 with `{ "hits": [], "status": "no-deny-set" }` —
   **unless** a `--min-patterns` floor is set, which is checked first and
   exits 2. See [Failing closed](#failing-closed-on-an-empty-deny-set).
5. Scan per the chosen mode. Filter binary/oversize per
   `SkippedFile` reason. Renamed/copied files (`R`/`C` diff entries)
   are scanned like any other changed file in `--staged`/`--range`/
   `--push-ref` mode — a rename is not a way to skip the scanner.
6. Waivers (see [`repo-aegis waive`](#repo-aegis-waive)) are applied
   next: a hit matching an unexpired `(patternId, blob)` waiver in
   `.repo-aegis.yml` is removed from `hits` and counted in `waived`
   instead. `--ignore-waivers` skips this step entirely.
7. Path exemptions (see [`alwaysBlockExemptPaths`](configuration.md))
   narrow an exempt path's matching to non-`_always` patterns only —
   never applied to `--ignore-allowlist-comments`-style audit modes,
   which is what `audit --fixture-check` uses to keep exemptions
   visible.
8. Hits printed redacted (position + engagement; never literal).
9. `scratch` class → exit 0 even with hits (advisory).
10. Otherwise exit 1 if any (non-waived, non-downgraded) hits.

### `check --push-ref` (new-ref / release-tag scanning)

Resolves a diff base from commits the given `--remote`'s tracking refs
don't already reach (`git rev-list --boundary <ref> --not
--remotes=<remote>`), then scans that range with the same machinery as
`--range`:

| Situation | `rangeMode` in JSON | Scan |
|---|---|---|
| nothing in `<ref>` that `<remote>`'s tracking refs lack | `nothing-new` | none — the release-tag case |
| exactly one boundary commit | `incremental` | diff from that boundary |
| several boundaries (e.g. a merge of two already-pushed lines) | `incremental-widened` | diff from an octopus merge-base of all boundaries — a superset, so it can only over-scan |
| no boundary, or no `refs/remotes/<remote>/*` at all | `full-history` | the old full-history behaviour, unchanged |

Text output for the `nothing-new` case: `repo-aegis: nothing new to
scan (ref already reachable from <remote>)`. JSON gains `mode:
"push-ref"` and `rangeMode` (plus `base` when one was computed).

**Escape hatch:** `REPO_AEGIS_NEW_REF_FULL_SCAN=1` forces `full-history`
unconditionally, bypassing the boundary logic above.

**Residual risk.** `--remotes=<remote>` reads *remote-tracking* refs,
which a hook never refreshes (no network in a hook, by design).
Stale-*behind* tracking refs cause over-scanning — safe. Stale-*ahead*
tracking refs (possible after a server-side force-push or branch
deletion) could under-scan; the env var above is the manual override,
and server-side push protection is the only non-advisory backstop.

### Waivers in `check` output

`check` always prints `repo-aegis: waived: N` (text mode) and a
`waived: ScanHitJson[]` array plus `expiredWaivers: []` (JSON), on
every run, even when both are empty — a waiver must never disappear a
finding silently. See [`repo-aegis waive`](#repo-aegis-waive) below for
how a waiver is minted.

JSON (clean):
```json
{
  "mode": "staged",
  "hits": [],
  "historyHits": [],
  "skipped": [],
  "repo": { /* RepoJson */ },
  "denySet": { "files": ["_always", "customer-b"], "patternCount": 27 },
  "advisory": false,
  "warnings": []
}
```

JSON (with hits):
```json
{
  "mode": "path",
  "hits": [
    { "path": "src/foo.ts", "line": 42, "column": 13,
      "engagement": "customer-b", "matchPreview": "ac***N=14" }
  ],
  "skipped": [],
  "repo": { /* RepoJson */ },
  "denySet": { "files": ["_always", "customer-b"], "patternCount": 27 },
  "advisory": false,
  "warnings": []
}
```

### `repo-aegis waive`

Mints, lists, or removes a reviewed-benign waiver for an `_always`
finding — the narrow, auditable alternative to `--no-verify` when a
`check` hit is a genuine false positive (e.g. a fixture private key
that isn't covered by an `alwaysBlockExemptPaths` glob).

| Flag | Default | Meaning |
|---|---|---|
| `--pattern <id>` | — | pattern id to waive, e.g. `_always/9f2c1a4b7de0` (copy from a `check` finding's `patternId`) |
| `--blob <sha>` | — | git blob sha (40 hex) the waiver covers — the post-image blob of the finding |
| `--reason <text>` | — | why this finding is reviewed-benign (required to add a waiver) |
| `--approver <name>` | — | who reviewed and approved this waiver (required to add a waiver) |
| `--expires <date>` | none | optional `YYYY-MM-DD` after which the waiver no longer applies |
| `--list` | off | list existing waivers instead of adding one |
| `--remove` | off | remove a waiver instead of adding one (requires `--pattern` and `--blob`) |

Behaviour:
1. **Only `_always`-stem patterns are waivable.** `waive` on an
   engagement or `_private_infra` pattern id is refused — waivers
   exist to unblock a benign secret-*shape* match, never to weaken the
   customer-marker deny set. A pattern id's digest is only safe to
   commit to a public repo when it's derived from a generic `_always`
   shape in the first place; an engagement-marker digest would be an
   offline oracle for guessing the literal it came from.
2. **Refuses to run when stdin is not a TTY**, unless
   `REPO_AEGIS_WAIVE_NONINTERACTIVE=1` is set. A waiver is a human
   decision; this stops a hook, script, or coding agent from minting
   one on its own behalf — which would otherwise reconstruct
   `git push --no-verify` with extra steps. Combined with two other
   controls: `hook check-write` (the PreToolUse gate) refuses an agent
   `Write`/`Edit`/`MultiEdit` to `.repo-aegis.yml` outright, and
   `check` always reports `waived: N` so a waiver is never silent (see
   above). All three are required; none alone is sufficient.
3. Writes under `.repo-aegis.yml`'s `waivers:` key (see
   [configuration.md](configuration.md)), preserving comments and key
   order via a structured YAML edit — not a parse/re-stringify
   round-trip. Appends an audit-log record.
4. Re-running `waive` for the same `(pattern, blob)` upserts the entry
   (new reason/approver/date/expiry) rather than erroring or
   duplicating.
5. An expired waiver (per `--expires`) no longer applies; `check`
   reports it separately (`expiredWaivers`) and warns, rather than
   treating it as absent silently.

JSON (`waive --pattern ... --blob ...`):
```json
{
  "action": "waive-add",
  "pattern": "_always/9f2c1a4b7de0",
  "blob": "3f7a1e2c9b8d0f4a6e5c7b1d2a3f4e5d6c7b8a9f",
  "reason": "fixture keypair used only in scan.test.ts",
  "approver": "jdoe",
  "date": "2026-07-26",
  "expires": null,
  "updated": false
}
```

### `repo-aegis render`

Regenerates per-engagement marker files from the registry under a
write lock.

| Flag | Default | Meaning |
|---|---|---|
| `--dry-run` | off | print plan, write nothing |
| `--retention-months <n>` | 12 | months an ended engagement's markers stay in the deny set |

Behaviour:
1. Acquire `withLockSync`. Load registry. Validate every pattern.
2. If any pattern invalid → exit 2 with full report (no partial render).
3. Write `markers/<id>.txt` for each `isActive(e, retentionMonths)`. `chmod 600`.
4. Write `markers/_always.txt` from registry's `alwaysBlock`.
5. Delete `markers/<stale>.txt` for files whose stem is no longer in
   the active set.
6. Marker files carry a `MARKER_FORMAT_VERSION` header.

JSON: `RenderResult` from `core` (`written`, `removed`, `flat`).

---

## Engagement registry management

### `repo-aegis engagements list [--all]`

Lists registered engagements. Without `--all`, hides ended
engagements past the 12-month retention window.

JSON:
```json
{
  "engagements": [
    { "id": "customer-a", "name": "Customer A", "active": true,
      "started": "2025-10-01", "ended": null, "markerCount": 5 }
  ],
  "alwaysBlock": { "patternCount": 3 }
}
```

### `repo-aegis engagements add <id>`

Add a new engagement. Validates marker patterns and triggers `render`.

| Flag | Default | Meaning |
|---|---|---|
| `--name <name>` | id | human-readable name |
| `--started <date>` | today (UTC) | ISO-8601 date |
| `--marker <pattern>` | — | repeatable; the marker patterns |

Errors:
- `RESERVED_ID` if `id == "_always"`.
- `ENGAGEMENT_EXISTS` if id is already in registry.
- `PATTERN_VALIDATION` if any pattern fails the safety check.

### `repo-aegis engagements end <id> [--purge]`

Marks the engagement ended. By default, markers retain for 12 months
(per `--retention-months`). `--purge` back-dates `ended` so markers
are removed at next render.

### `repo-aegis engagements show <id>`

Pretty-prints one entry plus stats.

### `repo-aegis engagements remove <id> --hard`

Hard-delete an engagement from the registry. Required `--hard` flag
(removing a registry entry is a data-subject-erasure operation; we
want the operator's explicit acknowledgement). Refuses to remove
`_always`.

For soft / retention-window removal, use `engagements end <id>` with
optional `--purge` instead.

---

## Setup

### `repo-aegis init`

Bootstrap. Idempotent. Defaults to installing both git hooks and
the Claude Code PostToolUse hook.

| Flag | Default | Meaning |
|---|---|---|
| `--with-hooks` | on | also run `install hooks` |
| `--no-with-hooks` | — | skip git hook installation |
| `--with-claude` | on | also run `install claude-md` |
| `--no-with-claude` | — | skip Claude Code hook installation |
| `--force` | off | overwrite existing engagements.yaml |
| `--claude-home <dir>` | `~/.claude` | override default Claude home |

Steps:
1. `mkdir -p` config dirs with required chmod (700 dirs, 600 files).
2. Scaffold `engagements.yaml` if missing (one example, comment block).
3. `render`.
4. With `--with-hooks`: `install hooks` against current cwd repo.
5. With `--with-claude`: `install claude-md`.

### `repo-aegis install hooks`

Writes `pre-commit` and `pre-push` to `~/.config/repo-aegis/hooks/`
and points `core.hooksPath` at that directory.

| Flag | Default | Meaning |
|---|---|---|
| `--global` | **on** (since 0.7) | write `core.hooksPath` in the global git config, covering every repo on the machine |
| `--local` | off | write `core.hooksPath` in this repo's local git config only (the pre-0.7 default) |
| `--unset-local` | off | clear a repo-local `core.hooksPath` that would shadow the global value just installed, in one step |
| `--force` | off | overwrite a conflicting `core.hooksPath` in the scope being written |
| `--uninstall` | off | unset `core.hooksPath` in **both** global and local scope, and remove pre-commit/pre-push from `<home>/hooks` |

Conflict resolution: if the scope being written already has a
*different* `core.hooksPath`, the install refuses without `--force`
and prints the prior value verbatim so the user can save it before
replacing.

**Global by default, since 0.7.0.** Coverage used to be per-repo and
opt-in at install time. Because git consults exactly one hooks
directory, setting a *global* `core.hooksPath` would otherwise
silently disable any `.git/hooks` script another tool installed
directly into a given repo (an older husky setup, a hand-written
hook, a `prepare` script). To avoid trading one silent-coverage bug
for another, the generated `pre-commit`/`pre-push` scripts **chain**:
after the repo-aegis check runs, they `exec` the repo's own
`.git/hooks/<name>` if one exists and is executable (and isn't the
file that was just run, guarding against a global path that happens
to point at `.git/hooks` itself). A repo-aegis hit still blocks
regardless of what the chained hook returns. `init` inherits the
global default, so a fresh `init` now arms hook coverage
machine-wide, not just for the repo it ran in.

Use `repo-aegis doctor` (below) to sweep a machine's repos for hooks
that are unset, foreign, stale, or shadowed by this mechanism.

### `repo-aegis install gitignore`

Appends a managed block of recommended secret-file patterns to
`~/.config/git/ignore`. Idempotent (markers between `# repo-aegis:
managed block` and `# repo-aegis: end managed block`).

| Flag | Default | Meaning |
|---|---|---|
| `--gitignore-path <path>` | `~/.config/git/ignore` | target file |
| `--uninstall` | off | strip the managed block |

### `repo-aegis install ci`

Emits (or `--write`s) the generated leak-scan workflow(s), and prints a
`dependabot.yml` fragment that keeps their action pins current.

| Flag | Default | Meaning |
|---|---|---|
| `--profile <name>` | `pr` for install, `all` for `--uninstall` | which workflow(s): `pr`, `strict`, or `all` |
| `--write` | off | write to disk instead of printing |
| `--force` | off | overwrite an existing workflow file |
| `--no-require-deny-set` | off | emit `--min-patterns 0` instead of `--require-deny-set` |

**Profiles.**

- **`pr`** → `.github/workflows/leak-scan.yml`. The blocking gate: PRs, pushes
  to a default branch, tag pushes, and the `public` event. Three jobs —
  `leak-scan` (one `audit` per run, not one per file), `new-ref-scan`
  (`check --push-ref` on tags, where remote refs are authoritative rather than
  possibly-stale as they are in a local hook), and `config-guard` (re-runs with
  `--ignore-allowlist-comments` when a PR modifies `.repo-aegis.yml` or the
  workflow itself).
- **`strict`** → `.github/workflows/leak-scan-strict.yml`. Weekly, with
  `--ignore-allowlist-comments --history` and every optional check enabled,
  filing findings as a single tracked issue. The PR gate must honour
  suppressions to be usable, which makes the set of suppressions invisible in
  the only place anyone looks; this is where it becomes visible. Separate file,
  not another job, because it holds `issues: write` — a permission a
  PR-triggered job must never be able to reach.

Note there is no `--ignore-waivers` in either: `audit` never applies waivers at
all (unlike `check`), so it is already strict in that dimension.

**When to pass `--no-require-deny-set`.** The default fails closed on an empty
deny set, which is right whenever the registry is *supposed* to be reachable
from CI — an empty one then means it failed to load. For some repos an empty
deny set on CI is instead a permanent fact: a `public-eligible` repo blocks
*every* engagement, so its deny set is the full customer-marker set, which is
exactly what must never reach a public runner. There `--require-deny-set` does
not catch a misconfiguration, it fails every run. The opt-out emits
`--min-patterns 0`; the marker scan then reports `skipped: empty deny set` and
the deny-set-*independent* checks (lockfile/private-registry egress,
visibility, remote consistency) still do real work. repo-aegis's own repo is
the worked example of this class — see
[`.github/workflows/leak-scan.yml`](../.github/workflows/leak-scan.yml).

Generated workflows are SHA-pinned, Node 24, timeout-bounded, install the CLI
from outside the checkout with `--ignore-scripts`, and set
`REPO_AEGIS_REDACT_ATTRIBUTION=1`. See [github-action.md](github-action.md).

`config-guard` cannot protect itself — a PR can delete the job. Register it as a
**required status check by name** in the ruleset so a missing job blocks the
merge.

### `repo-aegis install claude-md`

Wires the PostToolUse hook into Claude Code:
1. Appends a managed block to `~/.claude/CLAUDE.md` describing how
   the agent should react to a hit.
2. Adds an entry to `~/.claude/settings.json` under
   `hooks.PostToolUse[matcher = "Write|Edit|MultiEdit"]` with
   `command = "repo-aegis hook scan-after-write"`. PATH-resolved at
   hook time.

No file is written under `~/.claude/hooks/` — the bin command parses
stdin JSON natively, so `jq` is no longer required.

| Flag | Default | Meaning |
|---|---|---|
| `--claude-home <dir>` | `~/.claude` | override default location |
| `--dry-run` / `--print-only` | off | preview the would-be settings.json + CLAUDE.md additions |

### `repo-aegis doctor`

Fleet-wide sweep: verifies repo-aegis hooks are actually live across
every repo under a set of scan roots, not just the one you happen to
be sitting in. A single-repo `status`/`audit` run can't see a
machine-wide regression — the same `core.hooksPath` mistake that's
invisible in one repo (looks fine or looks broken, no comparison
point) turns up immediately when four sibling repos are healthy and a
fifth silently isn't.

| Flag | Default | Meaning |
|---|---|---|
| `--scan-root <path...>` | platform default roots | one or more directories to walk for git working trees (repeatable) |
| `--fix` | off | report (dry-run) or, with `--yes`, unset a repo-local `core.hooksPath` override that's shadowing a healthy global value |
| `--yes` | off | apply `--fix` changes; without it, `--fix` only reports what it would do |

Behaviour:
1. Walk every working tree under the scan roots; resolve each one's
   hook state (same `resolveHookState` used by `status`/`audit`).
2. Report every repo whose effective hooks path isn't repo-aegis's,
   **and** every repo whose own `.git/hooks` scripts are being
   shadowed by a `core.hooksPath` (global or local) — see
   [`install hooks`](#repo-aegis-install-hooks)'s chaining note.
3. `--fix` only ever unsets a repo-*local* override that differs from
   the expected repo-aegis path; it never touches a global value.
   Before mutating, it records the prior local value and the repo's
   config file mtime to the audit log — forensics captured before the
   repair, not after, so a regression stays datable.
4. Exit 1 if any repo fails (post-fix, if `--fix --yes` ran).

JSON:
```json
{
  "action": "doctor",
  "dryRun": true,
  "roots": ["/Users/you/repos"],
  "results": [
    { "workingTree": "/Users/you/repos/some-repo", "code": "HOOKS_PATH_LOCAL_OVERRIDE",
      "ok": false, "effectivePath": "/Users/you/repos/some-repo/.git/hooks",
      "shadowedRepoHooks": [], "fixed": false }
  ],
  "summary": { "scanned": 12, "failed": 1, "fixed": 0 }
}
```

This — not a per-repo GitHub Actions step — is the answer to "wire
hook-liveness checking into CI": a GitHub-hosted runner never has
repo-aegis hooks installed, so a per-repo `hooks` check would fail
every run and get muted (`audit --no-hooks-check` is what the
generated CI workflow sets instead). `doctor` is a developer-machine
sweep, run on demand or on a schedule.

---

## Repo classification

### `repo-aegis classify [--apply] [--rules <path>]`

Auto-detect class+engagement from this repo's `git remote get-url
origin` against a rules YAML (default `~/.config/repo-aegis/classify.yml`).

```yaml
rules:
  - match: "github\\.com[:/]de-otio/"
    class: public-eligible
  - match: "gitlab\\.example\\.com[:/]customer-a/"
    class: customer-coupled
    engagement: customer-a
```

Without `--apply`: prints suggestion (and engagement id, if redacted
to `(redacted)` in human output for terminal safety).
With `--apply`: sets `repo-aegis.class` and adds the engagement.

Pattern safety: rule `match` regexes are validated through the same
`validatePattern` pipeline as marker patterns.

---

## Audit

### `repo-aegis audit`

Composite repo health check, useful as a CI step or before publishing
a tarball / VSIX.

| Flag | Default | Meaning |
|---|---|---|
| `--history` | off | also sweep full git history with `git log -G` per pattern (slow) |
| `--no-marker-scan` | — | skip the marker scan over tracked files |
| `--no-lockfile-check` | — | skip package-lock.json non-public-registry check |
| `--no-fixture-check` | — | skip fixture/__fixtures__/testdata directory scan |
| `--no-remote-check` | — | skip the remote-vs-class consistency check |
| `--no-hooks-check` | — | skip the git-hooks liveness check (`core.hooksPath` wiring); the generated CI workflow always sets this — hooks are never installed on a CI runner |
| `--org <org>` | — | run a one-shot GitHub code-search sweep against this org (needs token) |
| `--published <pkg-or-tarball>` | — | scan a packed npm tarball, VSIX bundle, or npm package name |
| `--no-secret-scan` | — | with `--published`: skip the universal secret-shape scan over archive contents |
| `--ignore-allowlist-comments` | off | report findings a `repo-aegis: allow` comment suppresses (audit-grade strict) |
| `--token <env-var>` | `GH_TOKEN` | env var holding the GitHub token for `--org` |
| `--max-queries <n>` | 30 | cap on `--org` seed-derived queries per run |
| `--accept-cross-border` | off | consent to sending `--org` seed substrings to GitHub |
| `--min-patterns <n>` | 0 | exit **2** if the computed deny set has fewer than `<n>` patterns (see `check`) |
| `--require-deny-set` | off | sugar for `--min-patterns 1` |
| `--redact-attribution` | off | strip engagement attribution from output (see `check`) |
| `--verbose` | off | reveal literal matches (NEVER from hooks) |

Each check returns:
```ts
{
  name: string;
  ok: boolean;
  findings: { message: string; detail?: unknown; informational?: boolean }[];
  skipped?: boolean;
  skipReason?: string;
}
```

`audit` exit code: 1 if any check fails, 2 on usage error or an unmet
`--min-patterns` floor, 0 if clean. A finding with `informational: true` is
reported but never gates `ok` — see the fixture-check note immediately below
and, for the hooks check, [`repo-aegis doctor`](#repo-aegis-doctor).

Top-level JSON envelope:

```json
{
  "action": "audit",
  "cwd": "/path/to/repo",
  "class": "customer-coupled",
  "engagements": ["customer-a"],
  "checks": [ /* CheckResult[] */ ],
  "denySet": { "files": ["_always", "customer-b"], "patternCount": 27 },
  "summary": { "run": 6, "failed": 0, "totalFindings": 0, "informationalFindings": 0 },
  "warnings": []
}
```

`denySet` is new in 0.8.0 and mirrors the shape `status` and `check` already
emit. Without it, a consumer could not tell "audit passed" from "audit had
nothing to scan" by reading the output — which is the failure
[`--min-patterns`](#failing-closed-on-an-empty-deny-set) exists to remove.
Under `--redact-attribution`, `engagements` is `[]`, `denySet.files` is masked,
and `attributionRedacted: true` is added.

**Fixture check keeps path exemptions honest.** `--no-fixture-check`
skips the whole check; when it runs, it always scans with the **full**
pattern set — `alwaysBlockExemptPaths` globs (see
[configuration.md](configuration.md)) are never applied here. An
`_always` hit that falls inside an exempt path is demoted to
`informational: true` rather than dropped, so an exemption stays
visible in `audit` output even though `check` doesn't block on it.
Engagement and `_private_infra` hits are never informational, at any
path.

### `audit --org` notes

Sending markers (or substrings derived from them) to GitHub Code
Search is a cross-border data transfer. The `--accept-cross-border`
flag (or the `REPO_AEGIS_ACCEPT_ORG_SEED_TRANSFER=1` env var) is a
hard gate for compliance. The seed query budget is capped at
`--max-queries` (default 30).

### `audit --published` notes

Accepts:
- npm tarball path (`.tgz`)
- VSIX bundle path (`.vsix`)
- npm package name (then `npm pack --silent <name>` against the
  default registry; offline fallback fails with `NPM_NOT_FOUND` or
  similar binary-preflight code)

Extracts to a temp dir; runs the marker scan against every extracted
file. Post-extraction `realpathSync` defends against zip-slip
(refuses entries that resolve outside the temp dir).

**Two passes, not one.** The marker scan matches archive contents
against the engagement deny set. A second, deny-set-independent pass
matches the universal secret shapes (PEM private-key headers, the
hex-encoded form, JWTs, forge tokens) and is what `--no-secret-scan`
turns off. Both gate the check.

**Why the second pass exists.** The engagement registry is
machine-local by design — it holds customer markers, which is exactly
what must never reach a public CI runner. So a publish workflow
scanning its own tarball has **zero** deny-set patterns, and the
marker pass matches nothing. That is legitimate, not a
misconfiguration, and it is why `--min-patterns` is the wrong tool
here: raising the floor would just fail every publish. The secret-shape
pass needs no registry, and covers the threat that actually applies to
a registry tarball — a key or token that reached the archive through
build output or `files`/`.npmignore` drift rather than through a
tracked source file the hooks already cover.

**An inert marker pass is reported, not hidden.** When the deny set is
empty, the check emits an **informational** finding
(`PUBLISHED_EMPTY_DENY_SET`). It does not fail the check — an empty
deny set is the normal CI case — but "matched against nothing" and
"matched clean" must not render identically, which is the same
principle `--min-patterns` enforces elsewhere.

Secret-shape findings report kind, path and count, never the matched
bytes, so they are safe to print in a public job log.

---

## Inspection

### `repo-aegis markers list [--verbose]`

Lists active patterns grouped by source file. Patterns shown by index
and engagement attribution by default; `--verbose` reveals literal
patterns (never pass from hooks).

### `repo-aegis markers test <string> [--verbose]`

Reports which patterns in this repo's deny set would match
`<string>`. Output is engagement+pattern-index by default; literal
matches only with `--verbose`.

---

## Leak-context strict mode

A simple flag-file at `~/.config/repo-aegis/state/leak-context-mode`.
When present, the global Claude Code `CLAUDE.md` snippet flips into
"strict" guidance for the agent. Does not change the deterministic
hook gate — that runs identically — but it changes the agent's
self-instruction tone.

### `repo-aegis context on` / `off` / `status`

Toggles / reads the flag.

---

## `hook` (coding-agent entry points)

### `repo-aegis hook scan-after-write`

The Claude Code PostToolUse hook. Reads the tool-result JSON on stdin,
extracts `tool_input.file_path` (or `tool_input.path` for older
shapes), and runs `check --path` on it. Output flows back into the
agent's tool result as JSON (always — never literal markers).

This is the canonical hook entry. Settings.json from
`install claude-md` references it by bin name (`repo-aegis hook
scan-after-write`), which is PATH-resolved at hook time.

Silent exits (code 0):
- empty stdin (the agent invoked the hook with no payload)
- unparseable JSON
- no `tool_input.file_path` (the hook fired on a tool we don't model)
- `file_path` does not exist on disk

Otherwise: hands off to `check`. Exit semantics are `check`'s.

---

## Scanner subcommands (`repo-aegis-scan`)

The scanner is published as a separate npm package
(`@de-otio/repo-aegis-scan`). It runs queries against GitHub Code
Search (one query per engagement-marker, with org filters) to detect
leaks already published on GitHub.

### `repo-aegis-scan run`

```sh
repo-aegis-scan run \
  --queries <file>                  # may repeat
  --state <file>                    # seen-hits.json
  [--exclude-org <org>]             # may repeat
  [--exclude-repo <full_name>]      # may repeat
  [--output-format issue|json|markdown]   # default: json
  [--report-issue-repo owner/repo]        # required if --output-format=issue
  [--token <env-var-name>]          # default: GH_TOKEN
  [--inter-request-sleep-ms <n>]    # default: 2500
  [--max-pages-per-query <n>]       # default: 10
  [--cap-results-per-query <n>]     # default: 1000
  [--no-update-state]               # dry-run
  [--prune-state-older-than <days>] # drop seenIso entries older than this
  [--reveal-matches]                # include literal snippets in output (default OFF)
```

Exit codes:
- 0: completed; either no new hits, or new hits filed via issue/markdown
- 1: completed; new hits found AND `--output-format=json` (caller must react)
- 2: error (token missing, query parse fail, all-queries-failed,
     state unreadable, `--report-issue-repo` missing for issue mode)

### `repo-aegis-scan validate-queries <file>`

Schema check; flags un-quoted phrases, missing `org:` filters,
duplicate names.

### `repo-aegis-scan encrypt-query <file> --recipient <pubkey>`

Wraps `age` to encrypt the queries YAML. Used when the deployment
repo (the one that runs `scan run` on a schedule) is itself public
and you don't want to commit plain-text query strings.

### `repo-aegis-scan decrypt-query <file> --identity <key>`

Inverse of `encrypt-query`.
