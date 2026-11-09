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

> **Known issue:** `allow` and `deny` currently ignore `--cwd` (they read the
> process working directory); run them from inside the target repo.

`--home` and `--registry-path` set the corresponding env vars
(`REPO_AEGIS_HOME` / `REPO_AEGIS_REGISTRY`) before the subcommand
runs, so any deeply-nested call into `core` picks them up
transparently.

## Exit codes

Stable across every subcommand:
- **0**: success / clean.
- **1**: actionable finding (hits found / new code-search hits).
- **2**: usage / config / "tool couldn't do its job".

What exit **1** means differs by command; check the command before reacting:

| Command | Exit 1 means |
|---|---|
| `check` | a non-waived marker hit, a blocking history hit, or a private-registry reference (`egress`) in a public-facing repo; never for a `scratch` repo (advisory) |
| `audit` | at least one check failed |
| `doctor` | at least one `fail`-severity finding (warnings never change the exit code) |
| `egress-readback` | `PUBLISHED_BODY_MISMATCH`: the live PR body differs from the file |
| `repo-aegis-scan run` | new hits found, only with `--output-format json` |
| `hook scan-after-write`, `hook scan-bash-output` | a hit (for the Bash hook, secret-shaped content). `scan-after-write` exits 0 in a `scratch` repo; `scan-bash-output --advisory` exits 0 on a hit. See [`hook`](#hook-coding-agent-entry-points) for what Claude Code does with exit 1 |
| `egress-check`, `hook guard-egress`, `hook check-write` | **a fault in the guard itself, not a finding.** Exit 1 is non-blocking: the shim and the hook framework proceed with the command. A deliberate refusal is always exit **2** |

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
  "visibility": "unknown",
  "visibilityProbe": {
    "visibility": "unknown",
    "status": "unauthorized",
    "detail": "`gh` ran but could not see this repo — …",
    "fix": "check which account `gh` is using (`gh auth status`), …",
    "fromCache": true
  },
  "publicFacing": false,
  "allowedEngagements": [{ "id": "customer-a", "name": "Customer A", "active": true }],
  "denySet": { "files": ["_always", "customer-b"], "patternCount": 27 },
  "alwaysBlock": { "patternCount": 3 },
  "regexBackend": "re2",
  "zeroMarkerEngagements": [],
  "warnings": [],
  "hooks": { /* HookState: effectivePath, origin, expectedPath, scripts, … */ }
}
```

`zeroMarkerEngagements` lists the ids of **active** engagements that have no
markers (an engagement with nothing to match protects nothing; add markers by
hand or with [`suggest-markers`](#repo-aegis-suggest-markers)). Ids only, never
patterns.

`regexBackend` is `"re2"` when the optional `re2` dependency is
installed and active for pattern validation, or `"in-process"`
otherwise. See the design doc's locked-decisions row "Regex backend
(validation)" for what the field means.

When the registry defines identities or maps owners to them (schemaVersion 3),
the JSON also carries `identity`:
`{ identities: [{ name, kind, login | app }], mappings: [{ target, kind:
"personal-org" | "engagement", person?, agent? }], requireIdentity }`, and text
mode prints an `identities:` block. It holds names, kinds, logins and app
slugs only, never anything secret. An engagement is named by its id and never
by its orgs; a personal org is named by the org. A login is printed in text only when a personal org uses its identity; an engagement-only or unreferenced one prints as `<engagement-only login>` (an Enterprise Managed User shortcode can identify a customer). `--json` carries every login.

#### `visibilityProbe` — why "unknown" is never the whole answer

GitHub visibility drives the egress-hygiene gate, so a probe that
*could not look* must not be mistaken for one that looked and found
nothing interesting. `visibilityProbe.status` says which:

| Status | Meaning |
|---|---|
| `resolved` | GitHub answered; `visibility` is authoritative |
| `no-gh` | the `gh` CLI is not installed / not on PATH |
| `no-remote` | the repo has no GitHub remote (nothing to ask about) |
| `unauthorized` | `gh` ran but could not see this repo — wrong account, missing scope, expired auth, or the repo does not exist |
| `unrecognised` | `gh` failed or answered in a way the probe cannot classify |

`fromCache` is `true` when `visibility` came from the cached
`repo-aegis.visibility` git-config value rather than this run's probe.
`null` outside a git repo.

`unauthorized` is the one to act on, and it is the common case on a
machine with **two `gh` accounts**: every public repo resolves and every
*private* repo 404s, so a whole org's private repos silently stay at
`unknown`. Re-run under the right account, e.g.
`GH_TOKEN=$(gh auth token --user <user>) repo-aegis status`.

Text mode puts the status on the `github:` line and adds a `warning:`
with the fix. It warns on `unauthorized` even when a cached value
answered — a stale cache plus a blind probe is exactly how a repo keeps
the wrong class. `status` never exits non-zero over this.

The probe deliberately does **not** surface `gh`'s own stderr: that text
carries the org and repo name, which may itself be a customer marker.

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
pre-push hooks shell out to this. The Claude Code PostToolUse hook
(`hook scan-after-write`) uses the same scanner but is a separate entry
point with its own logic; see [`hook`](#hook-coding-agent-entry-points).

| Flag | Default | Meaning |
|---|---|---|
| `--staged` | — | scan the staged diff |
| `--path <path>` | — | scan a single **file**, or every file under a **directory** (recursively). A relative path resolves against `--cwd` (the repo under test), **not** the process cwd. Canonicalised; symlinks resolved; rejected if outside the working tree. If nothing could be scanned at all, exit **2** with `PATH_NOT_SCANNED` — see step 5 below |
| `--range <revspec>` | — | scan added lines in a commit range, e.g. `<remote>..<local>` |
| `--push-ref <ref>` | — | scan a ref the remote does not have yet, relative to `refs/remotes/<remote>/*` (used by pre-push for new branches and tags) |
| `--remote <name>` | `origin` | with `--push-ref`: remote whose tracking refs bound the scan |
| `--history` | — | scan full git history with `git log -G <pattern>` per pattern |
| `--since <revspec>` | — | with `--history`: lower-bound revspec |
| `--max-file-bytes <n>` | 1048576 (1 MiB) | per-file size cap; larger files reported as `skipped: too-large` |
| `--max-files <n>` | 10000 | with a directory `--path`: exit **2** with `PATH_TOO_MANY_FILES` rather than scan more than `<n>` files. A truncated scan would read as a clean one |
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

   **`--path` mode is all-or-nothing**: the requested file is the entire
   scope of the run, so if it lands in `skipped` then nothing was
   scanned, and that exits **2** with `PATH_NOT_SCANNED` rather than
   reporting `hits: []`. Same fail-closed rule as the git-backed modes in
   step 3 — a scan that could not run is not a clean scan. (In the other
   modes a skipped file is one of many, so it stays a reported skip.)

   **A directory `--path`** is walked recursively and every regular file
   in it is scanned through the same path as the single-file form, so
   canonicalisation, the working-tree check, path exemptions, the size cap
   and binary detection behave identically. What it does *not* do is hide
   anything:

   - `.git` is the only directory not walked — its contents are compressed
     objects no line scan can read, and history has its own mode
     (`--history`). Skipped directories are listed in `skippedDirs`.
   - Symlinks are not followed, in either shape, and each one is reported
     in `skipped` with reason `symlink`. Content that lives inside the
     tree is still reached at its real path.
   - Per-file skips (`binary`, `too-large`) are reported as usual and do
     **not** fail the run — the rest of the tree was still scanned. The
     all-or-nothing test for a directory is "no file was read at all".
   - More than `--max-files` files exits **2** with `PATH_TOO_MANY_FILES`.
     Stopping early and reporting what was found would be a truncated scan
     presented as a result.

   `--json` for a directory carries two extra keys, `filesScanned` and
   `skippedDirs`; the file form's envelope is unchanged. A directory
   handed to the **file** scanner reports `skipped` reason `directory`
   (this was `unreadable` until the directory form landed, which named the wrong cause).
6. Waivers (see [`repo-aegis waive`](#repo-aegis-waive)) are applied
   next: a hit matching an unexpired `(patternId, blob)` waiver in
   `.repo-aegis.yml` is removed from `hits` and counted in `waived`
   instead. `--ignore-waivers` skips this step entirely.
7. Path exemptions (see [`alwaysBlockExemptPaths`](configuration.md))
   narrow an exempt path's matching to non-`_always` patterns only —
   never applied to `--ignore-allowlist-comments`-style audit modes,
   which is what `audit`'s fixture check (on by default; skip it with
   `--no-fixture-check`) uses to keep exemptions visible.
8. Hits printed redacted (position + engagement; never literal).
9. `scratch` class → exit 0 even with hits (advisory).
10. Otherwise exit 1 if any (non-waived, non-downgraded) hits, **or** any
    `egress` finding: a private-registry reference in a lockfile or `.npmrc`
    in scope, reported only for a public-facing repo (see
    [`visibilityProbe`](#visibilityprobe--why-unknown-is-never-the-whole-answer)).
    In `--history` mode a `historyHits` entry carries `alreadyPublic`; when
    `true` (the commit is already reachable from the remote, checked only for
    a public-facing repo) it is reported as a warning and does not count
    toward the exit code.

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

`check --json` always carries a `waived: ScanHitJson[]` array (each entry
adds the waiver's `reason`, `approver` and optional `expires`) plus
`expiredWaivers: []`, on every run, even when both are empty. In text mode,
`repo-aegis: waived: N finding(s) via .repo-aegis.yml` is printed only when
`N > 0` (a permanent `waived: 0` on every commit would be noise), and a
warning line is added when any waiver has expired. A waiver must never
disappear a finding silently. See [`repo-aegis waive`](#repo-aegis-waive) below for
how a waiver is minted.

JSON (clean):
```json
{
  "mode": "staged",
  "hits": [],
  "historyHits": [],
  "skipped": [],
  "egress": [],
  "repo": { /* RepoJson */ },
  "denySet": { "files": ["_always", "customer-b"], "patternCount": 27 },
  "advisory": false,
  "warnings": [],
  "waived": [],
  "expiredWaivers": []
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
  "historyHits": [],
  "skipped": [],
  "egress": [],
  "repo": { /* RepoJson */ },
  "denySet": { "files": ["_always", "customer-b"], "patternCount": 27 },
  "advisory": false,
  "warnings": [],
  "waived": [],
  "expiredWaivers": []
}
```

`egress` holds private-registry findings (`{ file, line?, host, pkg? }`; see
step 10 above) and is non-empty only for a public-facing repo. A directory
`--path` adds `filesScanned` and `skippedDirs`; `--push-ref` adds `rangeMode`
(and `base`); `--remote-url` adds `destination`. An empty deny set returns the
short form `{ "hits": [], "skipped": [], "egress": [], "status": "no-deny-set",
"warnings": [] }` (exit 0 unless a floor is set).

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
2. **Adding a waiver refuses to run when stdin is not a TTY**
   (`WAIVE_NONINTERACTIVE`), unless `REPO_AEGIS_WAIVE_NONINTERACTIVE=1` is
   set. `--list` and `--remove` are not gated. A waiver is a human
   decision; this stops a hook, script, or coding agent from minting
   one on its own behalf — which would otherwise reconstruct
   `git push --no-verify` with extra steps. Combined with two other
   controls: `hook check-write` (the PreToolUse gate) refuses an agent
   `Write`/`Edit`/`MultiEdit` to `.repo-aegis.yml` outright, and
   `check --json` always reports `waived` (text mode when `N > 0`) so a
   waiver is never silent (see above). All three are required; none alone
   is sufficient.
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

JSON: `{ "dryRun": boolean, "written": { path, engagementId, patternCount }[],
"removed": string[], "flat": string | null }`. `dryRun` is `true` under
`--dry-run`, when nothing was written or deleted.

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
| `--github-org <org>` | — | repeatable; GitHub org(s) that map to this engagement. Registers an **owner**: needs a terminal (below) |
| `--personal-org <org>` | — | repeatable; GitHub org(s) or logins you own, appended to top-level `personalOrgs` (no engagement is created). Mutually exclusive with `--github-org`. Registers an **owner**: needs a terminal (below) |

**Registering an owner needs a person at a terminal.** `--github-org` and
`--personal-org` tell repo-aegis that publishing to that owner is safe, and
the egress guard's rule h refuses a publish to an owner that is not
registered, so an agent that could register owners would undo the guard
(issue #151). The command therefore refuses with `OWNER_ADD_NEEDS_TTY` (exit
2) unless stderr is a TTY **and** the terminal is a person's: no agent host
(`claude`, `codex`, `gemini`) or pty wrapper may sit above the process,
`CLAUDECODE=1` must not be set, and the process chain must reach a login
session, `sshd`, a terminal emulator or an attached tmux/screen. If the chain
cannot be read (no `ps`, as in an agent's sandbox) the answer is "not a
person". `REPO_AEGIS_EGRESS_HUMAN` and `REPO_AEGIS_WAIVE_NONINTERACTIVE` are
**not** honoured, and no approval lifts it. The agent hook also refuses any
agent Bash command whose text contains the command (`AGENT_RAN_HUMAN_COMMAND`).
A terminal opened from inside an agent (a tmux server started from it) can
still carry `CLAUDECODE=1`; open a fresh terminal window, or unset that
variable and `CLAUDE_CODE_ENTRYPOINT`. The ancestry check is a speed bump, not
proof of a person: outside the agent sandbox a same-user agent can forge it.
Adding no owner (an engagement with markers only) needs no terminal. Each
successful owner add is audited as `registry-owner-add` with a kind and a
count, never the owner's name.

Errors:
- `RESERVED_ID` if `id == "_always"`.
- `ENGAGEMENT_EXISTS` if id is already in registry.
- `PATTERN_VALIDATION` if any pattern fails the safety check.
- `OWNER_ADD_NEEDS_TTY` for `--github-org` / `--personal-org` without a person's terminal.
- `OWNER_SET_EMPTY_NEEDS_TTY` for a change that leaves the registry with no
  owners when it had one (see `end` and `remove` below).
- `REGISTRY_WOULD_BE_INVALID` when the result would not load (an org may
  appear only once, in `personalOrgs` or in one engagement's `githubOrgs`).
  Every registry mutator validates the new registry in memory first and
  writes nothing on failure.

### `repo-aegis engagements end <id> [--purge]`

Marks the engagement ended. By default, markers retain for 12 months
(per `--retention-months`). `--purge` back-dates `ended` so markers
are removed at next render. If that leaves no registered owner when there was
one, it needs a terminal (`OWNER_SET_EMPTY_NEEDS_TTY`): with no owners rule h
switches itself off, so emptying the owner set is the same as registering every
owner. Ending an engagement that leaves at least one owner needs no terminal.

### `repo-aegis engagements show <id>`

Pretty-prints one entry plus stats.

### `repo-aegis engagements remove <id> --hard`

Hard-delete an engagement from the registry. Required `--hard` flag
(removing a registry entry is a data-subject-erasure operation; we
want the operator's explicit acknowledgement). Refuses to remove
`_always`.

For soft / retention-window removal, use `engagements end <id>` with
optional `--purge` instead. Like `end`, a removal that leaves no registered
owner needs a terminal (`OWNER_SET_EMPTY_NEEDS_TTY`).

### `repo-aegis upstreams add <owner>/<repo>` / `remove <owner>/<repo>` / `list`

Manages `allowedUpstreams` in the registry: exact `owner/repo` entries, no
wildcards, lower-cased and validated like the schema's own entries. It exists
for forks. Rule h refuses a publish to an owner that is not registered; an
allowed upstream lifts rule h for **one repository and for the verbs `gh pr
create|edit|comment|review` and `gh issue create|edit|comment` only**. It never
admits `git push`, merge, release, repo or workflow verbs, or a `gh api`
write. An upstream does not become one of your own repositories: rules e–g
still apply, a `*` approval does not cover it, and each publish still needs a
person or `repo-aegis approve <owner>/<repo>`.

- `add` needs a terminal, with the same checks and refusal as an owner add on
  `engagements add` (`OWNER_ADD_NEEDS_TTY`; no environment variable or
  approval lifts it). It is audited as `registry-owner-add`, kind `upstream`,
  with no name. An invalid argument is `INVALID_UPSTREAM`.
- `remove` and `list` need no terminal: removing only tightens.

JSON: `{ "action": "upstreams-add", "upstream", "added" }`,
`{ "action": "upstreams-remove", "upstream", "removed" }`,
`{ "action": "upstreams-list", "upstreams" }`.

### Identities (schema version 3)

`identity add|remove|require` and `engagements set-identity` record which
GitHub identity belongs to which owner (see
[configuration.md](configuration.md#registry-schema-version-3-github-identities-per-owner)).
This release stores and shows the mapping only; no command chooses or injects
a token from it.

**Every command here but `identity list` and `identity require --on` needs a person at a terminal**, checked the same way as
`engagements add --personal-org`: otherwise it exits 2 with
`IDENTITY_CHANGE_NEEDS_TTY` (no environment variable or approval lifts it) and
writes nothing. The agent hook also refuses any Bash command whose text runs
one (`AGENT_RAN_HUMAN_COMMAND`). The gate runs before validation, so an invalid
argument is no oracle for an agent.

#### `repo-aegis identity list [--json]`

Read-only, and **an agent may run it** (the hook does not refuse it, unlike
every other `identity` verb but `require --on`). Prints every identity (name,
kind, and its GitHub login or App slug) and where each is used: the
`person` column (acts when a person is present) and the `agent` column (acts
when none is), as personal orgs and engagements. Engagements appear by id,
never by their orgs. It prints no token, key or key-file path: the registry
holds none, and the command reads nothing else. Use it to answer "which
account does repo-aegis think acts for this owner?" when a refusal such as
`GH_IDENTITY_WRITE_NEEDS_HUMAN` asks.

Redaction follows `status`: text prints a `gh-login` identity's login only when a personal org (the
operator's own) uses it; an engagement-only or unreferenced one prints `<engagement-only login>`, because an
Enterprise Managed User login carries a shortcode that can name a customer. `--json` carries every login. A login that
is empty or is not GitHub login syntax prints `(not a valid GitHub login)` in text and carries `loginProblem`
(`empty` or `invalid`) in JSON; the registry loader rejects such a login today, so this is a check, not an expected state.
The registry records no App installation account, so none is listed.

```
identities (requireIdentity):
  alice: gh-login alice
    person: personal-org example-org
    agent:  -
  work: gh-login <engagement-only login>
    person: engagement customer-a
    agent:  -
  work-bot: github-app example-bot
    person: -
    agent:  personal-org example-org, engagement customer-a
```

#### `repo-aegis identity add <name> --gh-login <login> | --app <slug>`

Defines an identity: `--gh-login` makes a `gh-login` identity (a person),
`--app` a `github-app` identity (an agent). Exactly one is required. Names and
slugs are lower-cased and validated against the schema's shapes; a login is
kept as typed. The first identity writes `schemaVersion: 3`, and is refused
(`MULTIPLE_INSTALLS`) while a `repo-aegis` on `PATH`, or one an installed hook,
the shim or a Claude Code hook (managed drop-in or `settings.json`) is pinned to, cannot read version 3: it is judged by the supported
version read from that install's own core package, never by running it (an
older pinned `hook check-write` exits 1, which is non-blocking, so it would stop
protecting cross-org writes). Adding the same
definition again is a no-op; a different definition under an existing name is
`IDENTITY_EXISTS`.

#### `repo-aegis identity remove <name>`

Refused with `IDENTITY_IN_USE` while a personal org or an engagement still
names it (clear them first), `IDENTITY_NOT_FOUND` for an unknown name. The file
stays at version 3.

#### `repo-aegis identity require --off | --on`

`--off` clears `requireIdentity` (writes `requireIdentity: false`, so a later
`set-identity` does not turn it back on); it needs a terminal and is
human-only. `--on` sets it again; it only tightens, so it needs no terminal and
**an agent may run it** (the hook does not refuse it). `--on` on a registry
below version 3 is `NOTHING_TO_REQUIRE`. The first `set-identity` also turns it
on.

#### `repo-aegis engagements set-identity <engagement-id> [--person <name>] [--agent <name>] [--clear]`

Maps all of an engagement's `githubOrgs` to identities. `--person` must name a
`gh-login` identity and `--agent` a `github-app` identity
(`IDENTITY_KIND_MISMATCH`, `IDENTITY_NOT_FOUND`); a column that is not given is
left as it is. `--clear` removes both and cannot be combined with the others.
The first mapping sets `schemaVersion: 3` and, unless the key is already
present, `requireIdentity: true`.

**Personal orgs** (the form is `engagements set-identity --personal-org`, not a
separate `personal-org` command): `repo-aegis engagements set-identity --personal-org <org>
[--person <name>] [--agent <name>] [--clear]`. Personal orgs have no command
group of their own (they are added with `engagements add --personal-org`), so
this mirrors that form; it takes no `<id>`. The org must already be registered
(`PERSONAL_ORG_NOT_FOUND`): this command never adds an owner. A plain entry
becomes `{ name, person?, agent? }` and goes back to a plain string when
cleared; a comment on the entry is kept.

When `--person` names an identity whose login is empty or not GitHub login
syntax, the command still succeeds (a person ran it at a terminal) but warns on
stderr that writes through that identity will be refused until the login is
fixed, and prints the fix (clear the mappings, `identity remove`,
`identity add --gh-login`, map again); `--json` carries the same text as
`warning`. The registry loader rejects such a login today, so the warning is a
backstop, not a state you will normally see. The warning never contains the login.

An engagement with no `githubOrgs` is refused (`ENGAGEMENT_HAS_NO_ORGS`): an
identity would map nothing. The version guard (`MULTIPLE_INSTALLS`) sits on the
step that raises `schemaVersion` to 3, so `set-identity` on a file that is
already version 3 does not repeat it.

All of these keep the registry's comments and other fields, are audited as
`registry-identity-change` with the kind of change and no names, and print
JSON with `--json`. The other registry commands (`engagements add|end|remove`,
`upstreams add|remove`) leave identities and object-form personal orgs as they
found them.

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
| `--force` | off | overwrite existing engagements.yaml. Needs a terminal (`OWNER_SET_EMPTY_NEEDS_TTY`) when the existing registry declares anything: owners, upstreams, engagements, markers or `always_block` |
| `--migrate-classify` | off | port `~/.config/repo-aegis/classify.yml` into `githubOrgs` / `personalOrgs`; does not bootstrap or install. Adds owners, so it needs a terminal (`OWNER_ADD_NEEDS_TTY`), lists every owner and where it goes, and waits for a typed `y` on a stdin terminal (`MIGRATION_NOT_CONFIRMED` otherwise; nothing is written) |
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
| `--local` | off | write `core.hooksPath` in this repo's local git config only (the pre-0.7 default). When the global value already points at repo-aegis's hooks directory it writes nothing (a local value equal to the global one adds nothing) and says so; the hook scripts are still refreshed |
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
| `--uninstall` | off | remove the generated workflow file(s); refuses a file that was edited by hand, and is idempotent when the file is missing. Defaults to every profile |

**Profiles.**

- **`pr`** → `.github/workflows/leak-scan.yml`. The blocking gate: PRs, pushes
  to `main` or `master` (the template hard-codes `branches: [main, master]`;
  edit the file if your default branch is named otherwise), tag pushes, and the
  `public` event. Three jobs —
  `leak-scan` (one `audit` per run, not one per file), `new-ref-scan`
  (`check --push-ref` on tags, where remote refs are authoritative rather than
  possibly-stale as they are in a local hook), and `config-guard` (re-runs
  with `--ignore-allowlist-comments` when a PR modifies `.repo-aegis.yml` or
  the workflow itself). **Limit:** `config-guard` adds only
  `--ignore-allowlist-comments`; it audits the PR's own checkout, so it reads
  the PR's own `.repo-aegis.yml`. A PR that edits `class`, `engagements` or
  exempt paths is not re-judged against the base branch's configuration.
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

Wires the repo-aegis hooks into Claude Code. By default the hooks and the
deny rules (items 2 and 3) are written to a **root-owned managed-settings
drop-in** (`/Library/Application Support/ClaudeCode/managed-settings.d/
50-repo-aegis-<uid>.json` on macOS, `/etc/claude-code/managed-settings.d/…` on
Linux), from your own terminal: it shows the path, size, digest and a diff,
asks `[y/N]`, and `sudo` asks for your password. Each hook starts with a uid
guard so other accounts on the machine are unaffected. The first run also
removes repo-aegis's earlier entries from `~/.claude/settings.json` once the
drop-in is verified. `--user-settings` writes `~/.claude/settings.json` instead
(containers, no `sudo`). Details, recovery and caveats:
[configuration.md](configuration.md#the-claude-code-managed-drop-in).
1. Appends a managed block to `~/.claude/CLAUDE.md` describing how the
   agent should react to a marker hit, and how to recover from an egress
   denial (re-issue explicitly; never set `REPO_AEGIS_EGRESS_HUMAN`; read
   the `PUBLISHED →` receipt after a publish).
2. Adds entries to the managed drop-in (or `~/.claude/settings.json` with
   `--user-settings`), all idempotent. The commands
   below are shown by hook name; each is written as a one-line `sh` command
   that runs the hook on the **pinned** node and CLI by absolute path and
   exits 2 (blocking) if either is gone and no `repo-aegis` at least as new as
   the pinned version is on PATH (it then runs that one, with a warning), never
   a `repo-aegis` looked up on PATH while the pin works. An older by-name entry is replaced, not duplicated:

| Event | Matcher | Command |
|---|---|---|
| `PreToolUse` | `Write\|Edit\|MultiEdit` | `repo-aegis hook check-write` |
| `PreToolUse` | `Bash` | `repo-aegis hook guard-egress --agent claude` |
| `PostToolUse` | `Write\|Edit\|MultiEdit` | `repo-aegis hook scan-after-write` |
| `PostToolUse` | `Bash` | `repo-aegis hook scan-bash-output` |
| `PostToolUse` | `Bash` | `repo-aegis hook egress-receipt` |
| `SessionStart` | `*` | `repo-aegis hook first-touch` (only with `--first-touch`) |

Matchers are regular expressions over the tool name (see Claude Code's
[hooks documentation](https://code.claude.com/docs/en/hooks)). `MultiEdit` is
kept in the file-write matchers for Claude Code versions that have that tool;
whether the current release still does is unconfirmed here, and an
alternative that names no existing tool is inert.

The two `PostToolUse` Bash hooks share one matcher entry and both run;
neither replaces the other, and both coexist with any user-authored hook
already in that entry. `--uninstall` removes every repo-aegis entry and
reports the count per event.

3. Adds `permissions.deny` **`Edit(...)`** rules to `settings.json` for the
   files whose tampering bypasses the guard, and nothing else: the registry
   file and its `.age` ciphertext, the approvals store
   (`egress-approvals.json`), the destination cache (`destinations.json`: rules e-g read a cached entry's class and visibility, so a forged "private" entry for a public repo would skip the person check; every writer treats a failed write as a cache miss), `hooks/**` (the git hook scripts), `bin/**`
   (the `gh` shim), `markers/**` (the rendered deny set the write scan and
   the hooks read; editing it silently drops markers) and two files under
   `state/` that an enforcement path trusts: `deny-set.cache.json` (an
   unauthenticated cache; a forged entry with no patterns switches the scanner
   off) and the uninstall ledger, under `REPO_AEGIS_HOME`
   (default `~/.config/repo-aegis`; the markers directory follows
   `REPO_AEGIS_MARKERS_DIR`).
   Without them the agent's own file tools can add an owner to
   `engagements.yaml` with no terminal, which undoes the unregistered-owner
   check. Only `Edit` rules are written: Claude Code matches path rules for
   `Edit` and `Read` only, a `Write(path)` rule is never matched, and an Edit
   rule covers every built-in editing tool. Claude Code also merges Edit deny
   rules into the sandbox's write-deny list, so they stop a sandboxed Bash
   `sed -i` too; verify on your machine with a sandboxed `touch <registry
   file>` (it should fail). `state/` (audit log, lock, caches) is deliberately
   **not** denied: denying the whole home broke audit appends, the state lock,
   cache writes and an agent running `install hooks` or `install shim`. Because
   `markers/**` is denied, an agent-run `repo-aegis render` is refused inside
   the sandbox (`MARKERS_WRITE_PROTECTED`: a person runs `render` from their own
   terminal); the other flows that re-render (`engagements add|end|remove`,
   `markers add`, `suggest-markers --auto-accept-above`, `init`) already fail
   earlier, because they rewrite the denied registry file. A
   registry relocated to `$HOME`, `/` or a git work tree is denied as a file
   only, with a warning. `hooks/**`, `bin/**` and `markers/**` are narrow
   subdirectories and are denied wherever the home is; only a markers directory
   moved out of the home (`REPO_AEGIS_MARKERS_DIR`) into `$HOME`, `/` or a work
   tree is not denied, with a warning. The rest of `state/` is left writable on
   purpose: the audit log, the lock, `leak-context-mode` (it only changes the
   `CLAUDE.md` tone; no enforcement path reads it) and the other caches. The rules install added are recorded
   in `state/claude-md-deny-rules.json`; `--uninstall` removes exactly those,
   and only ones shaped like ours (`Edit(//…)` over a protected path under the
   repo-aegis home): the ledger lives in a directory an agent can write, so it
   cannot be used to delete your own rules. A rule you already had before
   install is never removed, and nothing is removed on a first install with no
   ledger, except the `Edit(//<dir>/**)` + `Write(//<dir>/**)` pair an earlier
   build wrote (both present together, or neither is touched). `doctor` reports
   `REGISTRY_AGENT_WRITABLE` (warn) while they are absent.

No file is written under `~/.claude/hooks/` — the bin command parses
stdin JSON natively, so `jq` is no longer required.

| Flag | Default | Meaning |
|---|---|---|
| `--claude-home <dir>` | `~/.claude` | override default location |
| `--dry-run` / `--print-only` | off | preview the would-be drop-in (or settings.json) + CLAUDE.md additions; runs nothing as root |
| `--user-settings` | off | write `~/.claude/settings.json` instead of the managed drop-in; `doctor` warns `ENFORCEMENT_IN_USER_SETTINGS` |
| `--first-touch` | off | also register the SessionStart `first-touch` hook |
| `--uninstall` | off | remove the drop-in (terminal and `sudo` password; run this **before** `npm rm -g repo-aegis`), the managed CLAUDE.md block and the settings.json entries |

The drop-in also registers a SessionStart `hook managed-heartbeat`, which records
`state/managed-hooks-seen` so `doctor` can tell that Claude Code loads the file
(`MANAGED_HOOKS_NOT_FIRING`).

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
| `--no-egress-checks` | — | skip the egress-guard checks (see [`doctor` — egress-guard checks](#doctor--egress-guard-checks)) |
| `--claude-home <dir>` | `~/.claude` | Claude Code home for the guard-hook check |

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

#### `personalOrgs` matches are visibility-checked

The registry's `personalOrgs` says the **org** is yours. It says nothing
about whether *this repo* is public — and `public-eligible` is what turns
egress-hygiene enforcement on, so getting it wrong in either direction
has teeth. When the remote's org is in `personalOrgs`, `classify` runs
one `gh repo view` probe and picks the class from the answer:

| Probe | Class |
|---|---|
| `public` | `public-eligible` |
| `private` / `internal` | `private-strict` (with a warning that it differed) |
| unresolved | **none** — see below |

The probe result rides on the JSON envelope as `visibility` and
`visibilityProbe` (same statuses as
[`status`](#visibilityprobe--why-unknown-is-never-the-whole-answer)).

When the probe cannot resolve visibility — no `gh`, or a `gh` account
that cannot see the repo — `--apply` **exits 2** with
`VISIBILITY_UNRESOLVED` and writes nothing. Neither guess is safe:
`public-eligible` on a private repo makes egress hygiene reject the
repo's own legitimate private-infra hosts, while `private-strict` on a
public repo switches that enforcement *off*. A dry run reports the same
state and suggests no class.

To resolve it: re-run under an account that can see the repo
(`GH_TOKEN=$(gh auth token --user <user>) repo-aegis classify --apply`),
or set the class explicitly with `git config repo-aegis.class <class>`.

Engagement (`githubOrgs`) matches and `classify.yml` rules are not
probed — neither depends on visibility.

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

The Claude Code PostToolUse hook for `Write|Edit|MultiEdit`. Reads the
tool-result JSON on stdin, extracts `tool_input.file_path` (or
`tool_input.path` for older shapes) and the session `cwd`, and scans the file
as it is on disk. It does **not** run `check --path`: it has its own logic
(`decideHookAction`, then `computeDenySet` and `scanFile`), and it applies
neither waivers nor the `--min-patterns` floor. It resolves the working tree
from the written path, not from `cwd`, and the payload is JSON that never
carries literal markers.

Settings from `install claude-md` register it as a pinned command (the pinned
node and CLI, by absolute path, exit 2 if either is gone) rather than by bin
name.

`--agent cursor` reads Cursor's `afterFileEdit` payload instead (`file_path`
at the root of the JSON; the working directory is the payload's `cwd` when it
has one, otherwise the first entry of `workspace_roots`). That event cannot block, so the check is
detection only: a non-zero answer carries a `note` saying the edit has already
happened and the pre-commit hook is the gate. Any other `--agent` value is the
Claude Code shape.

Silent exits (code 0):
- empty stdin (the agent invoked the hook with no payload)
- unparseable JSON
- no `tool_input.file_path` (the hook fired on a tool we don't model)
- `file_path` does not exist on disk

Exit codes:

| Exit | When |
|---|---|
| 0 | clean; an empty deny set (`status: "no-deny-set"`); a `scratch` repo (advisory) |
| 1 | a marker hit in a non-`scratch` repo (a redacted `hits` payload, on **stderr**) |
| 2 | `CROSS_ORG_WRITE` (legacy detection only: the real refusal is the PreToolUse `hook check-write`), `CUSTOMER_COUPLED_NO_ENGAGEMENT`, an unreadable or encrypted registry, `HOOK_INPUT_TOO_LARGE` (payload past 1 MiB with no readable file path), or a scan error |

> **Unverified:** Claude Code surfaces PostToolUse output to the model only on
> exit 2; these hooks exit 1 on a hit, which its
> [hooks documentation](https://code.claude.com/docs/en/hooks) describes as a
> non-blocking error that the model does not see. Whether the agent sees a hit
> from this hook is not confirmed in a live session. Tracked.

### `repo-aegis hook check-write`

The PreToolUse hook for `Write|Edit|MultiEdit`: the primary write gate. It
runs **before** the tool does and looks only at the path and the session
`cwd`, never at content. Exit 2 blocks the write: `CROSS_ORG_WRITE` (the
destination's trust boundary does not overlap the session's),
`WAIVER_FILE_WRITE_REFUSED` (an agent write to `.repo-aegis.yml`), an
unreadable or encrypted registry (a missing registry is not an error), or
`HOOK_INPUT_TOO_LARGE`. Exit 0 otherwise. Exit 1 is a fault outside the
registry and is non-blocking.

### `repo-aegis hook scan-bash-output [--advisory]`

The PostToolUse hook for `Bash`. Scans the command's stdout and stderr for
secret-shaped content (PEM private keys, JWTs, GitHub tokens) and, on a match,
exits 1 with a `SECRET_LEAK` payload on **stdout**: kinds, a count and offsets,
never the matched bytes. `--advisory` exits 0 on a hit and still emits the
payload. The same exit-1 caveat as `scan-after-write` applies (see the note
above).

### `repo-aegis hook first-touch`

The SessionStart hook (registered only with `install claude-md --first-touch`).
Classifies the current repo from its remote and the registry and prints a
`FirstTouchResult` as JSON (`status`: `already-classified`, `applied`,
`needs-confirmation` or `skipped`).

### `repo-aegis hook managed-heartbeat`

The SessionStart hook of the managed drop-in. Records a timestamp in
`state/managed-hooks-seen` so `doctor` can tell that Claude Code loads the
drop-in (`MANAGED_HOOKS_NOT_FIRING`). Evidence, not a gate: it always exits 0.

---

## Egress guard (destination-aware publishing)

Design: [design/egress-guard.md](design/egress-guard.md). One decision
function in core (`parseEgressIntents` + `decideEgress`) enforced at three
points. The rules, in evaluation order — shape rules are unconditional,
context rules fail open (except rule h), and no layer ever rewrites a command:

| # | Rule | Code | Decision |
|---|---|---|---|
| D2 | a write through `dot gh` (`node <path>/dot.mjs gh …` or `dot gh …`) with no person present and no leading `--as bot`; evaluated first. Any other wrapper is an unparsed shape, refused by rule h | `DOT_GH_WRITE_NEEDS_BOT` | deny |
| pty | the publish runs under a pty wrapper (`script`, `unbuffer`, `expect`, `socat`, `ssh -t`, `tmux`, `screen`, an interpreter's pty module) | `EGRESS_PTY_WRAPPER` | deny |
| a | `git push` without both `<remote>` and `<refspec>` | `PUSH_IMPLICIT_TARGET` | deny |
| b | egress after a `cd` / `pushd` earlier in the same command | `EGRESS_AFTER_CD` | deny |
| c | egress joined to earlier segments with `;`, `\|\|` or `&` | `EGRESS_UNGUARDED_CHAIN` | deny |
| d | payload path (`--body-file`, `-F`, `--notes-file`, `--input`, `--body @f`, `-F k=@f`) is relative, expands `$TMPDIR`, or sits under `/var/folders/**` or the shared sandbox temp root (the session-unique `…/scratchpad/` segment is exempt; `-` is stdin) | `PAYLOAD_MODE_DEPENDENT_PATH` | deny |
| b′ | the publishing segment (or an earlier `export` in the same command) sets `REPO_AEGIS_*`, `HOME`, `PATH`, `XDG_CONFIG_HOME`, `GH_CONFIG_DIR`, `GH_HOST`, `GIT_CONFIG*`, `GIT_SSH*`, `GIT_DIR`, `GIT_WORK_TREE`, `SRT_*`, `SHELL`, `BASH_ENV`, `BASH_FUNC_*`, `LD_*`, `DYLD_*`, or uses `env -i` / `env -u`, `--git-dir` / `--work-tree`, or `git -c remote.*` / `url.*` / `core.sshCommand` / `core.hooksPath` | `EGRESS_ENV_OVERRIDE` | deny |
| b″ | the publishing segment follows, in the same command, `git remote`, `git config`, `gh repo set-default`, `gh alias set`, `gh auth`, `export`, or a write into `.git/`, `~/.ssh/config`, `~/.gitconfig` or the gh config | `EGRESS_AFTER_STATE_CHANGE` | deny |
| a′ | `gh pr create` with no person present and none of `--repo`, `GH_REPO` or a URL positional (D10; unconditional, no approval lifts it) | `GH_PR_CREATE_IMPLICIT_TARGET` | deny |
| h | no person present, and the destination's owner is not registered (not in `personalOrgs`, not in any engagement's `githubOrgs`, and not an exact `allowedUpstreams` entry on `gh pr create\|edit\|comment\|review` or `gh issue create\|edit\|comment`); a write whose owner cannot be named offline counts as unregistered. Runs right after resolution, before e and before the visibility lookup. **No approval satisfies it** | `UNREGISTERED_OWNER_EGRESS` | deny |
| e | the pushed repo's (or the payload file's tree's) trust boundary is positively disjoint from the destination's | `CROSS_ORG_EGRESS` | deny |
| f | payload content matches the destination's deny set (its own class when the destination is the tree's origin; `customer-coupled` to the matching engagement when the destination org is in an engagement's `githubOrgs`, whatever the cwd; `_always` only otherwise; `_self_identity` joins for customer-coupled) | `PAYLOAD_MARKER_HIT` | deny (hit count only) |
| g | destination public-facing, or verb ∈ {`gh pr merge`, `gh release *`, `gh repo create\|edit`, `gh gist create`, `gh workflow run`, `npm publish`}, and no human present — and no live approval (`repo-aegis approve`) that covers the destination (a `*` approval covers only `personalOrgs` owners and `npm publish`; see `approve`) | `PUBLIC_EGRESS_NEEDS_HUMAN` | `ask` where the framework has it; `deny` otherwise — never `allow` |
| g′ | rule g on a **`gh`** verb, where the caller reports the `gh` shim is not the first `gh` on its `PATH` (only the agent hook reports this) | `SHIM_UNREACHABLE_NEEDS_HUMAN` | deny — there is no layer below the hook left to hold the command |
| — | otherwise (including class `scratch`) | — | allow |

Rule h was lettered for "class `scratch` → allow" before 0.11.0; that row is
now the unlettered "otherwise". Two more shape rules read the command text
alone: `GITHUB_API_VIA_HTTP_CLIENT` (`curl` / `wget` writing to
`api.github.com` or `uploads.github.com`) and `GH_AUTH_TOKEN_NETWORK` (`gh auth
token` in a command that also makes a network call; a `git` subcommand counts
only if it can reach a remote, so `git tag` or `git log` does not). Rule h is skipped when no
registry file exists or the registry declares no owners (each refusal or stderr
note says which); an encrypted or unparseable registry does **not** skip it, and
refuses every non-interactive egress that has a destination.

"Human present" is a TTY on stderr — stdin is often a pipe even for a
person, so it is never the signal — that no agent host or pty wrapper sits
above in the process chain (and `CLAUDECODE=1` does not say otherwise), or
`REPO_AEGIS_EGRESS_HUMAN=1`, a documented human-only escape with the same
contract as `REPO_AEGIS_WAIVE_NONINTERACTIVE`: an agent never sets it, and
setting it is a visible act in any transcript. For rules g and h a chain that
cannot be read, or that reaches init without a login session, `sshd`, a
terminal emulator or an attached multiplexer, keeps the plain TTY answer,
because refusing a person's own publish is the worse failure; `approve` and the
owner adds make the opposite choice and refuse. All of this is a speed bump,
not proof of a person. Destination resolution is offline:
`git push <remote>` reads the remote's push URLs (`git remote get-url --push
--all`, so `insteadOf`, `pushInsteadOf` and `pushurl` apply, and every push URL
must be admitted; an ssh host alias is read from `~/.ssh/config` by a pure
parser, never `ssh -G`); `gh … --repo o/r` is direct (also `-Ro/r`), as are
`GH_REPO` and a PR / issue URL or `<o>/<r>` given positionally; `gh api
repos/o/r/…` reads the org and repo from the API path (`orgs/o/…` gives the org
with repo `*`; a path with `{owner}`/`{repo}` placeholders in the owner or repo
segment falls back to the cwd's origin, which is what `gh` itself does); `gh
api user…` and `gh gist create` belong to your own account (rule g needs a
person; no approval covers them); a `gh` verb with no explicit target uses
**gh's own pick** (remotes in the order `upstream`, `github`, `origin`, then the
rest, with `remote.<name>.gh-resolved` honoured first). A `gh api` endpoint with
no owner in it (`repositories/<id>/…`, `gists`, `projects/…`), a path with `..`,
`%2f` or an empty segment, a target held in a shell variable, an alias the guard
cannot expand and a push URL that does not resolve are **unresolved**, and rule
h refuses them with no person present. Anything the parser cannot take apart
that invokes `gh` or `git push` is unresolved too, never "no publish".
`gh api graphql` is judged by its document (`-f`/`-F query=…`,
`-F query=@file`, or the `query` member of an `--input` JSON body): a
read-only query falls back to the cwd's origin as before, but a
**mutation** names its target by node id (`pullRequestId`,
`repositoryId`, …), which nothing offline can map to a repository, so its
destination is **UNKNOWN** — never the cwd's repository. An UNKNOWN
destination is treated as public-facing (rule g asks, or refuses from a
shell), only a `*` approval covers it, and reasons and receipts print it
as `UNKNOWN repository …` / `UNKNOWN (GRAPHQL MUTATION TARGET NOT
RESOLVED, TREATED AS PUBLIC)`. A document the guard cannot read — stdin,
a missing file, a body that is not JSON, an unexpanded `$(…)` in the
agent hook — is treated as a mutation. No network lookup of the node id
is made.
Class and cached visibility apply when the destination is the tree's own
origin, **or when this machine holds another checkout of it**: the
machine-wide destination cache (`$REPO_AEGIS_HOME/destinations.json`) maps
`<org>/<repo>` to the checkout that declares it, and the resolver reads
that checkout's live config (its snapshot, if the checkout is gone). The
cache is written by everything that visits a repository and reads its
class — `classify --apply`, `status`, `doctor`'s sweep, and the guard
itself on every command it judges from inside a repository — so it needs
no maintenance of its own; `doctor` is the way to fill it in one go.
**Only a recorded `private` lets a destination through unattended**: a
destination whose visibility is unknown — nothing cached for it, in any org
— is **treated as public-facing** (printed as `visibility uncached, treated
as public`), so rule g asks, and a shell with no TTY and no live approval
refuses. Before that, the guard makes one live lookup (`gh repo view
<org>/<repo> --json visibility`, 5-second timeout) and, when it answers,
records the result in the destination checkout's `repo-aegis.visibility` so
the next call is offline again. A lookup that fails for any reason (no `gh`,
wrong account, no network) leaves the destination unknown and refused: the
network is only ever a way out of the refusal, never a condition for it.
Set `REPO_AEGIS_VISIBILITY_LOOKUP=0` to skip the lookup. `public-eligible`
is public-facing whatever the cache says, because the class is a
declaration and the cache only an optimisation. Reasons name `<org>/<repo>`, visibility, class and ref —
never payload content, matched substrings, or registry entries — and say
where the class came from (`from --repo`, `from the API path`, `from the
checkout at <path>`).

### `check --remote-url <url>` (the git pre-push layer)

The generated pre-push hook passes git's `$2` (the remote URL) to both
`check --push-ref … --remote-url <url>` and `check --range … --remote-url
<url>`. Before the content scan, `check`:

1. parses the URL (GitHub only; a local path or a non-GitHub host skips
   these checks — fail open — but a URL-shaped value that does not resolve
   to a GitHub repository is unresolved, and step 2 refuses it);
2. refuses with **`UNREGISTERED_OWNER_EGRESS`** (exit 2) first of all, before
   any cache write or visibility lookup, when no person is present and the
   URL's owner is not registered (or the registry is unreadable), whatever
   approvals exist;
3. refuses with **`CROSS_ORG_PUSH`** (exit 2) when the URL's org is
   positively disjoint from the repo's trust boundary — deterministic,
   offline, no TTY involved;
4. refuses with **`PUBLIC_PUSH_NEEDS_HUMAN`** (exit 2) when the destination
   is public-facing and no human is present (a live `repo-aegis approve`
   for it stands in for the person). The destination's class and
   visibility are this repository's own when the URL is its origin; when
   the URL names another repository, they come from that repository's
   checkout via the destination cache (see above). A visibility that is
   still unknown after the one live lookup described above is treated as
   public — the same rule the `gh` shim and the agent hooks apply — and
   the refusal says so and names `repo-aegis approve <org>/<repo>` and
   `repo-aegis status` (which records a private repository's visibility);
5. otherwise prints one stderr line, the git-native receipt:
   `repo-aegis: pushing <ref-or-range> → <org>/<repo> (<visibility>)`,
   where an unknown visibility reads `visibility uncached, treated as
   public`.

With `--json`, the output object carries `destination: { org, repo,
visibility, class, publicFacing, declaredBy }`, where `declaredBy` is
`origin`, `cache`, or `none` (the class is this repository's and may not
describe the destination; the visibility is `unknown`), plus
`assumedPublic: true` when the destination is public-facing only because
its visibility is unknown. Either refusal is recorded in the audit log
when it is on. The template change bumps the hook digest: installed copies
report `HOOKS_SCRIPT_STALE` until `install hooks` runs again. (0.11.0 changed
only a comment in the script, to say that `$2` is the URL after all rewriting,
but the digest covers the script's text, so the same reinstall applies.)

### `repo-aegis hook guard-egress [--agent claude|codex|gemini|copilot|cursor|antigravity]`

The pre-command hook. Reads the host's JSON on stdin (the host adapter picked
by `--agent` finds the command and the `cwd`), parses the command, runs
`decideEgress` with `capabilities.ask` true for hosts that can ask and false
otherwise, and answers in the host's own shape. `--agent` is matched without
regard to case. An unknown value is treated as a host that cannot ask (`ask`
becomes `deny`), never as `claude`; it answers in the PreToolUse shape and
reads the command from whichever known payload shape arrives
(`tool_input.command`, Copilot `toolArgs`, a root `command`, Antigravity
`toolCall.args.CommandLine`).

**A payload that was not judged is not silent.** The hook still fails open
(the host's allow), but when the payload names a shell tool and has no command
where this `--agent` reads one, or carries a command in another host's shape
(a Claude- or Gemini-shaped payload under `--agent antigravity`, a Cursor
`preToolUse` payload under `--agent cursor`), or is not JSON at all, it prints
one fixed line on stderr, `repo-aegis: guard-egress: this payload was not
judged (<reason>); check that the hook is registered with the right --agent
and event`, and writes a `guard-egress-malformed` record when the audit log is
on. The reason is fixed text, never payload bytes. A payload for a tool that is
not a shell stays `skip` and silent. Text typed into an open shell session is
judged as a command where the host's payload says so: Copilot `write_bash` /
`write_powershell` (`input`) and Antigravity `send_command_input` (`Input`).
Codex `write_stdin` is not judged (a known limit, see
[design/egress-guard.md](design/egress-guard.md)).

| `--agent` | Event / matcher | Command field | `ask` | Allow (no publishing op) |
|---|---|---|---|---|
| `claude` (default) | `PreToolUse` / `Bash` | `tool_input.command` | yes | nothing, exit 0 |
| `codex` | `PreToolUse` / `Bash` (older builds: `shell`) | `tool_input.command` | no: degrades to `deny` | nothing, exit 0 |
| `gemini` (legacy) | `BeforeTool` / `run_shell_command` | `tool_input.command` | no: degrades to `deny` | nothing, exit 0 |
| `copilot` | `preToolUse` / `bash` (also `PreToolUse`) | `toolArgs` (a JSON-encoded string) `.command`; or `tool_input.command` | yes in the interactive CLI; the cloud agent and autopilot treat it as a deny | nothing, exit 0. **Never exits 1**: Copilot fails closed on a non-zero exit other than 2, so an internal error is rendered as an allow |
| `cursor` | `beforeShellExecution`, and `afterFileEdit` for the write scan | root `command` | yes, on `beforeShellExecution` only | `{"permission":"allow"}` |
| `antigravity` (unverified) | `PreToolUse` / `run_command` | `toolCall.args.CommandLine` | no: degrades to `deny` | `{"decision":"allow"}` |

Registration is by hand for every host but Claude Code; the snippets, each
marked doc-derived and not exercised in a live session, are in
[agent-install.md](agent-install.md#other-agents). The Claude-style answer is:

| Decision | Exit | stdout | stderr |
|---|---|---|---|
| allow (or no publishing operation in the command) | 0 | — | — |
| ask | 0 | `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":…}}` | — |
| deny | 2 | the same shape with `"deny"` | `{ code, error, details: { verb, destination? } }` |

Copilot's answer carries the decision in both places its two events read, in
one object: `{"permissionDecision":"ask"|"deny","permissionDecisionReason":…,"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":…,"permissionDecisionReason":…}}`
(top level for camelCase `preToolUse`, `hookSpecificOutput` for PascalCase
`PreToolUse`; exit 0 for ask, 2 for deny, the structured refusal on stderr as above).

It never emits `updatedInput`. A registry that is missing, encrypted or
unreadable does not disable the shape rules (an encrypted or unparseable one
makes rule h refuse every non-interactive egress that has a destination).
Before the egress parse, and for **any** Bash command, the hook also refuses
(deny, exit 2): a raw HTTP client writing to the GitHub API
(`GITHUB_API_VIA_HTTP_CLIENT`) and `gh auth token` next to a network call
(`GH_AUTH_TOKEN_NETWORK`); a command whose text runs `repo-aegis approve`,
`engagements add --personal-org|--github-org`, `upstreams add`, `identity add|remove`, `identity require --off`, `engagements set-identity` or
`init --migrate-classify|--force`, in any shape (`AGENT_RAN_HUMAN_COMMAND`); and a
command that starts a detached session: `tmux new -d`, `tmux new-window` /
`send-keys`, `screen -dm`, `setsid`, `daemonize`, `nohup … & disown`
(`AGENT_DETACHED_SESSION`). These are text-level speed bumps: a program word
built at run time, or a script written by an earlier call, gets past them and
falls to the terminal and ancestry checks. A quoted mention next to a
repo-aegis word is refused too. Registered by
`install claude-md` on `PreToolUse` matcher `Bash`. Treat every other host as
**doc-derived, not exercised in a live session**: the payload shapes come from
each vendor's documentation (Codex: [hooks docs](https://developers.openai.com/codex/hooks);
Copilot CLI and Cursor and Antigravity CLI likewise), and the fixtures under
`packages/cli/src/commands/__fixtures__/hosts/` are marked `doc-derived` until
a real capture replaces them. Gemini CLI has been replaced by Antigravity CLI
([announcement](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/)),
whose payload differs, so `--agent gemini` keeps its name for the old shape
only (legacy) and `--agent antigravity` is the one for the new CLI.

`--agent cursor` and `--agent antigravity` answer in their host's own shape
instead of the table above (both built from vendor docs, not yet seen from a
real host; plan §5):

| Host | Event | Allow | Ask | Deny | Guard error |
|---|---|---|---|---|---|
| Cursor | `beforeShellExecution` (root `command`) | `{"permission":"allow"}`, exit 0 | `{"permission":"ask","user_message":…,"agent_message":…}`, exit 0 | the same with `"deny"`, exit 0 | exit 1, no stdout (Cursor fails open) |
| Antigravity CLI | `PreToolUse`, matcher `run_command` (`toolCall.args.CommandLine`) | `{"decision":"allow"}`, exit 0 | none: `ask` is answered as deny | `{"decision":"deny","reason":…}`, exit 0 | `{"decision":"allow"}`, exit 0 |

Allow is never empty for these two (Cursor blocks on invalid output;
Antigravity requires a `decision`). Cursor's `ask` is enforced only on
`beforeShellExecution`, so the Cursor adapter does not judge a `preToolUse`
payload (it fails open and prints the one "not judged" line above): register
the hook on `beforeShellExecution`. Antigravity's exit codes
are undocumented, so every answer exits 0 and a deny is carried by the JSON.

The hook also reads its **own** `PATH` — the one its host will hand the
shell it is about to permit — and tells the policy whether the `gh` shim
is the first `gh` on it. When it is not, a `gh` verb that would have been
`ask` is denied with `SHIM_UNREACHABLE_NEEDS_HUMAN` instead (rule g′
above): an `ask` is only a refusal while something below it can hold the
command, and on at least one agent host an unanswered `ask` is resolved
by a classifier rather than a person. `git push` is untouched by this —
the pre-push hook is PATH-independent — and so is `npm publish`, which
has no shim to be unreachable. A `PATH` lookup that throws leaves the
capability unset and changes nothing: this hook fails open on its own
defects, but a lookup that succeeds and says the shim is absent is a
fact, not a defect.

`command` may be a string or an argv array. An array is flattened
before parsing: if it carries a `-c` / `-lc`-style flag the element
after it is the script the policy judges (`["bash", "-lc", "git
push"]` → `git push`); otherwise the elements are joined with spaces.
The `cwd` used is the harness's root `cwd` — where the command *will*
run — never the hook process's own working directory.

### `repo-aegis hook egress-receipt`

The post-command hook (`PostToolUse` matcher `Bash`). If the command that
just ran carried a publishing operation, returns one line per operation as
`additionalContext`:

```
PUBLISHED → <org>/<repo> (<VISIBILITY>, class <class>): <ref | PR #n | tag>
```

or `EGRESS FAILED → …` when the tool output shows the publish did not
happen. Silent otherwise.

A publish is **confirmed, never assumed**. Where the tool prints something
only a real publish produces, that evidence decides the line: git's
`<src> -> <dst>` ref table (or `Everything up-to-date`), the pull-request
URL `gh pr create|edit` prints, the release URL `gh release create`
prints. Without it — and with no failure text either — the line reads

```
EGRESS UNCONFIRMED → <org>/<repo> (<VISIBILITY>, class <class>): <detail> — nothing in the output confirms it landed; verify before retrying
```

which is the honest answer when a push dies in transport and prints
nothing a scanner recognises. The failure patterns are English while git
is translated (a German git says `Schwerwiegend:`, `Fehler:`,
`[zurückgewiesen]`), so they only choose between *failed* and
*unconfirmed*; they are not what establishes a publish. Ref flags (`!`
refused, `=` already current) and the arrow are not translated, and are
read directly. Verbs with no distinctive success output — `gh issue
create`, a mutating `gh api` — keep the older rule: no failure evidence
reads as a publish. A non-zero `exit_code` on the tool response, when the
harness supplies one, outranks any text.

### `repo-aegis install shim [tool]`

Writes `<home>/bin/gh` (the only `tool` today), a wrapper to put first on
`PATH`. It locates the real `gh` by scanning `PATH` past its own directory
— never a hard-coded path, never itself — passes `--version`, `help` and
`completion` through untouched, and `exec`s `repo-aegis gh --home <home> -- "$@"`
(see [`repo-aegis gh`](#repo-aegis-gh---home-home----gh-args)) for every other
invocation, publishing or not: no shell code runs after the `exec`, so nothing in
the shim can see a token. With the pinned node or CLI gone, such a call goes to the
`repo-aegis` on `PATH` when that is at least as new as the pinned version (with a
warning), and is otherwise refused (exit 2), reads included. Idempotent: a second run reports
`already installed`. A file at that path that repo-aegis did not write
is refused with `SHIM_PATH_OCCUPIED` unless `--force` is passed.

It also **pins taaad**, the tool that mints GitHub App tokens: the first `taaad`
on `PATH`, as the realpaths of its launcher, of the interpreter named by its
shebang and of its package directory (the venv root), written into the shim next
to the pinned node and CLI (not into the agent-writable `state/` directory). The
command says whether all three are owned by root and writable by root only; if
not, `doctor` warns (`TAAAD_AGENT_WRITABLE`); App identities still work. `--json` carries a `taaad` object (`pinned`, the paths,
`rootOwned`, `problem`).

### `repo-aegis gh --home <home> -- <gh args>`

What the shim runs; not meant to be typed. In order:

1. the egress decision, exactly as `egress-check` makes it (same refusals, exit 2;
   same receipts and body read-back), from the same code;
2. the identity decision (`chooseIdentity`), from the registry **and the
   approvals under `--home` only**: `REPO_AEGIS_HOME`, `REPO_AEGIS_REGISTRY` and
   the other `REPO_AEGIS_*` variables of the caller are ignored. Presence comes from
   `checkTerminal()` (a TTY and a process chain with a positive root): `REPO_AEGIS_EGRESS_HUMAN`
   and approvals do not count;
3. refuse (exit 2, the structured reason on stderr, `gh` not run); or run the real `gh`
   with the caller's environment unchanged (an unmapped owner, a call that names none,
   or a person at a terminal for an owner with only an agent identity, with a hint); or
   **inject**: a token for the chosen identity goes to the trusted `gh` as `GH_TOKEN` in
   that child's environment, and nowhere else.

Token sources: a `gh-login` identity runs `gh auth token --hostname github.com --user <login>`
with the trusted `gh` and every token and redirect variable removed; a `github-app` identity
runs the pinned `taaad mint --app <slug> --repo <owner>/<repo> --permissions read|write|contents-write --json`
with an environment of exactly `HOME`, `PATH=/usr/bin:/bin`, `TERM` and `LANG`, and accepts the
answer only when `installationAccount` is the owner, `repositories` is exactly the repository
and the permissions are no wider than the scope. A supplied `GH_TOKEN` / `GITHUB_TOKEN` is never
used for a mapped owner with no person present; with one, it must be the mapped account's token
(SHA-256, `timingSafeEqual`).

The injected `gh` gets an allowlisted environment: `HOME`, a PATH the caller cannot extend,
`TERM`, `LANG` / `LC_*`, `TMPDIR`, `GH_REPO` when set, `GH_TOKEN`, and fixed `GH_PAGER=`,
`GH_PROMPT_DISABLED=1`, `GH_NO_UPDATE_NOTIFIER=1`, `GH_NO_EXTENSION_UPDATE_NOTIFIER=1`,
`GIT_TERMINAL_PROMPT=0` and `GIT_CONFIG_COUNT` overrides (`core.fsmonitor=false`,
`core.hooksPath=/dev/null`, `credential.helper=`, `core.sshCommand=ssh`). Pagers, editors, proxies,
`BASH_ENV`, `SHELLOPTS` and the caller's `GIT_CONFIG_*` do not reach it. An injecting call prints
`repo-aegis: as <identity> (<kind>) for <owner>/<repo>` on stderr and appends a record (identity,
kind, owner/repo, verb, approval id; never the token) to `<home>/state/gh-decisions.jsonl`
whatever the audit log's setting; refusals are recorded too.

Any fault between choosing and spawning on a mapped owner is `GH_IDENTITY_UNAVAILABLE` and `gh`
does not run for a **write** (never a call as the active account). A **read** (a call the egress
parser finds no publish in) whose identity cannot be produced (no token, a failed mint, an unreadable
registry, a fault) runs as the active `gh` account instead, with one stderr line:
`repo-aegis gh: GH_IDENTITY_UNAVAILABLE: <reason>, so this read runs as the active gh account; proceeding`.
No token of any kind is attached, and the decision log records `fallback`. Findings about the
identity itself (`GH_IDENTITY_INSTALLATION_MISMATCH`, `GH_BINARY_UNTRUSTED`) still refuse a read.
On an unmapped call a fault warns and `gh` runs unchanged. Exit status is `gh`'s own.

For a verb that runs `git` here (`pr checkout`, `pr create`, `repo sync`, a clone,
`issue develop --checkout`) with no person present, the repository's own git configuration is
judged first (`GH_IDENTITY_ARG_UNSAFE`). A repo-local `core.hooksPath` that resolves (realpath) to
repo-aegis's own `<home>/hooks` directory, which `install hooks --local` writes, is accepted; any
other value, and every other setting, still refuses. An **account-bound** approval for the owner
(`repo-aegis approve <owner>/<repo>` or `<owner>/*`, for an owner with a mapped GitHub account, so
the approval records a login) covers that refusal for its scope and lifetime: the call runs, stderr
gets `repo-aegis: approval <id> covers <setting> for <owner>/<repo>`, and the decision log and the
audit log (when on) record the approval id. The approval's login must be the one the owner's person
identity has in the registry NOW (an approval minted before that identity was re-mapped covers
nothing, and an owner with no person identity has nothing to bind to). An approval without a login,
a `*` approval, an approval for another repository or owner, a ref-limited one and an expired one
(an approval is expired from the instant its lifetime ends) do not cover it.
Unsafe arguments (`--editor`, `--hostname`, `--template` and the like) are not covered by an approval.

Installing is not enabling: the shim only guards once `<home>/bin`
precedes the real `gh` on `PATH`, which this command prints (also as
`pathInstruction` in `--json`) but cannot do — it is a shell-profile
edit. `doctor` reports `SHIM_MISSING` / `SHIM_NOT_FIRST` until both
halves are done.

`--uninstall` removes the shim **only if repo-aegis wrote it** (the
file carries a header line); a foreign file at the shim path is left in
place and reported (`changed: false`, with the reason). The top-level
`uninstall` applies the same rule.

### `repo-aegis install git-credential [--uninstall]`

Makes the repo-aegis credential helper the **first** helper git runs for
`https://github.com` and sets `credential.https://github.com.useHttpPath=true`
(so the helper sees `<owner>/<repo>`), both in the **global** git config. Needs
a person at a terminal (`GIT_CREDENTIAL_NEEDS_TTY`), for `--uninstall` too:
removing the helper would hand an agent's pushes to the person's own credential.

The helper line is `!'<pinned node>' '<pinned cli>' git-credential --home '<pinned home>'`. "First" is checked, not assumed:

- it is inserted after the last empty reset entry (`helper =`) of `credential.https://github.com.helper` in the global config, before that key's first entry when there is no reset, or appended when the key is absent;
- the result is simulated first. If another helper would still answer first (a system-scope one such as `osxkeychain`, or a global generic one with no reset in front), the install **refuses and changes nothing**, with the command that fixes it (`git config --global --add credential.https://github.com.helper ""`, which makes git forget the helpers before it for github.com; re-add the ones you still want after the repo-aegis line);
- afterwards the real config is read back, and a wrong order is rolled back;
- re-running it repairs an order that `gh auth setup-git` or an upgrade broke, and replaces a line whose pin moved.

`--uninstall` removes exactly what was added: the helper line (by exact value) and, when this install set it, `useHttpPath` (restoring its previous value). What was added is recorded in `<home>/state/git-credential-install.json`; with no ledger nothing is removed. After an install and an uninstall the global config is byte-identical to before (tested). The top-level `repo-aegis uninstall` runs this step; without a terminal it reports the step as failed and leaves the config alone. `doctor` reports `GIT_CREDENTIAL_HELPER_ORDER` (a failure when an owner is mapped to an agent identity and the order is wrong).

### `repo-aegis git-credential --home <pinned home> <get|store|erase>`

The git credential helper itself; git runs it, you do not (`install git-credential` configures it). It reads the credential protocol on stdin.

- `store` and `erase`: ignored, exit 0.
- `get` for `protocol=https`, `host=github.com` (any case, also `github.com:443`) with a path `<owner>/<repo>[.git]`:
  - **a person present** (`identityPresence`: a terminal that is a person's): prints nothing, so the next helper answers as it would without repo-aegis;
  - **no person present** (an agent, or no terminal): `chooseIdentity` decides from the registry in `--home` only. An unmapped owner prints nothing. An owner with only a `person` identity: a fetch, pull, clone or other known read gets that login's own token from the trusted gh (never the active account's), after the same pre-mint checks, with no approval, no stderr line and a `scope: read`, `verb: fetch` audit record; a push (or an alias or unreadable subcommand, which may be one) is `GH_IDENTITY_WRITE_NEEDS_HUMAN` unless a login-bound approval covers it, the same approval `repo-aegis gh` honours (`<owner>/<repo>` or `<owner>/*`, minted from a terminal, carrying exactly the login the owner's person identity has, no ref limit, unexpired). Then the helper hands git that login's own token (`gh auth token --user <login>` through the trusted gh, never the active account's), prints `repo-aegis: approval <id> lets this push run as the GitHub account mapped to <owner>` on stderr, and writes a `git-credential` audit record with the approval id (no login, no token). Every pre-mint check below applies to it exactly as to an App token. An owner with an `agent` identity gets `username=x-access-token` and `password=<token>`, minted by the pinned taaad as `mint --app <slug> --repo <owner>/<repo> --permissions <scope> --json` with an environment of exactly `HOME`, `PATH=/usr/bin:/bin`, `TERM` and `LANG`, and checked (installation account equals the owner, the repositories are exactly the one, the permissions are no wider than the scope). A URL with an embedded username still yields `x-access-token`.
  - the scope is `contents-write` when the nearest `git` above `git-remote-https` is `push` or `send-pack`, and `read` for any other remote operation (fetch, pull, clone, ls-remote, an alias).
  - **an unreadable process list** (typically a sandbox that blocks `ps`; the default Claude Code sandbox does): `AGENT_PUSH_CHAIN_UNREADABLE`, unless a live approval covers it. An approval minted by `repo-aegis approve <owner>/<repo>` or `<owner>/*` from a terminal covers it when it carries the login the owner's person identity has in the registry now (not one recorded before a re-mapping; an owner with no person login, or no readable registry, has nothing to bind to) and no ref limit; a `*` approval, an approval for another owner or repository, and an expired one do not. A covered request continues through every other check and mints a `contents-write` token (a push cannot be told from a fetch, so the wider scope is taken), prints `repo-aegis: approval <id> covers an unreadable process list for <owner>/<repo>` on stderr, and, with the audit log on, adds the `approval` id and `covers` code to its `git-credential` record. The approvals are read from `--home`, never from `REPO_AEGIS_HOME`. An approval covers only "cannot tell": a chain that was read and shows a caller other than git's HTTPS remote helper is `AGENT_CREDENTIAL_DIRECT_FILL` whatever is approved. Without an approval the refusal names a sandbox as the likely cause and three steps for a person: run the push from a terminal, run `repo-aegis approve <owner>/<repo>`, or allow the agent's command to run outside the sandbox.
- **Every refusal** prints exactly `quit=true` on stdout (git then stops asking and does not prompt), the refusal with its code on stderr, and exits 0. Falling through on a refusal would give the agent the person's credential. The refusals: no `git-remote-https` in the process chain, such as `git credential fill` run by hand (`AGENT_CREDENTIAL_DIRECT_FILL`), or an unreadable chain (`AGENT_PUSH_CHAIN_UNREADABLE`); a configuration or environment that could redirect or capture the token (`AGENT_PUSH_CREDENTIAL_CONFIG`); a second, different path in one request (`AGENT_PUSH_CREDENTIAL_PATH`); an unreadable registry, taaad failing or the App not installed on the repository (`GH_IDENTITY_UNAVAILABLE`); an installation of another account (`GH_IDENTITY_INSTALLATION_MISMATCH`); no pinned taaad (`GH_BINARY_UNTRUSTED`); and the `chooseIdentity` refusals (`GH_IDENTITY_PRESENCE_UNKNOWN`, `GH_IDENTITY_WRITE_NEEDS_HUMAN`, …).
- The token is written to stdout only: never to stderr, the audit log (which records identity, owner, repository and scope) or any argument vector.
- **A failed mint** names the step that failed, from taaad's exit code and its error text (matched, never printed): the screen is locked, nobody answered the Touch ID prompt in time, the prompt was declined or its limit reached, the App has no installation or its installation does not include the repository or grant `contents: write`, or a generic failure. With the audit log on, it is recorded as a `git-credential` entry with `outcome: "refused"`, the code and that `reason` word. taaad gets 300 s, longer than taaad-signer's 240 s wait for Touch ID.

The pre-push hook adds `AGENT_PUSH_NEEDS_APP`: with no person present, an owner mapped to an agent identity and an SSH push URL (`git@…`, `ssh://…`, or an `~/.ssh/config` alias for github.com) is refused with the HTTPS form; over HTTPS the helper order is re-checked (`GIT_CREDENTIAL_HELPER_ORDER`). The existing destination checks run first and are unchanged.

### `repo-aegis approve <org>/<repo> | <org>/* | * [--ref <ref>] [--ttl <duration>] [--note <text>]`, `approve --list`, `approve --revoke <id|all>`

The human's side of rule g. Minting **requires a TTY on stderr that is a
person's** (no agent host or pty wrapper above the process, no `CLAUDECODE=1`,
a chain that reaches a login session, `sshd`, a terminal emulator or an
attached multiplexer) and does not honour `REPO_AEGIS_EGRESS_HUMAN` — so an
agent cannot mint its own approval (`APPROVE_NEEDS_TTY`, exit 2). A live
approval whose scope matches the destination (and, when `--ref` was given, the
ref) stands in for the person in **every** layer — the agent hook, the `gh`
shim, the git pre-push hook — for rule g and nothing else: the shape rules,
rule h (`UNREGISTERED_OWNER_EGRESS`), the cross-org boundary and the payload
scan still apply. Default TTL 15 minutes; `--ttl 2h`, `90s`, `1d`; never more
than 24 hours.

**The account.** For an `<org>/<repo>` or `<org>/*` approval on an owner whose registry entry maps a
`person` identity (a `gh-login`), the approval records that login, and minting prints it (`as <login>`,
and in `--json` as `approval.login`; `--list` shows it). That login is what lets an agent **write as that
account** to an owner with no `agent` App (`GH_IDENTITY_WRITE_NEEDS_HUMAN` otherwise); only an approval
that carries exactly that account, for that owner and repository (or `<owner>/*`), covers it. An approval
minted before accounts were recorded, one for another account, a ref-limited one and a `*` approval never
do: `*` records no account.

**Scope.** Since 0.11.0 a `*` approval is not a global wildcard. It covers a
destination only when the owner is in `personalOrgs`, plus destination-less
verbs (`npm publish`, which only `*` covers). A customer org needs `<org>/*` or
`<org>/<repo>`; an allowed upstream needs `<owner>/<repo>`. `<org>/*` and
`<org>/<repo>` behave as before, but rule h runs first, so **no approval of any
form helps with an owner that is not registered**:

| Approval | Personal org | Customer org | Allowed upstream (PR / issue verbs) | Unregistered owner | `npm publish` |
|---|---|---|---|---|---|
| `*` | covered | no | no | no | covered |
| `<org>/*` | covered | covered | covered | no | no |
| `<org>/<repo>` | that repo | that repo | that repo | no | no |

A `*` approval never covers a GraphQL mutation (rule h refuses it first), a
gist or any account-level `gh api user…` call. Minting prints what the scope
covers: `approve '*'` says it covers `personalOrgs` only (and `npm publish`
only, when the registry lists no personal org), and `approve <owner>/…` for an
unregistered owner prints a warning that the approval will not help until a
person registers the owner (`engagements add`, or `upstreams add <owner>/<repo>`
for a fork's upstream). A refusal that finds a live `*` approval that does not
apply names it and says why. Stored at `$REPO_AEGIS_HOME/egress-approvals.json`
(0600); not consumed on use (a push passes two layers). Mint, every use
(with the layer) and revoke are audit records (`egress-approval-mint`,
`egress-approval-use`, `egress-approval-revoke`). The agent hook answers
an approved publish with an explicit `allow` whose reason names the
approval; `egress-check` reports it as `approval: { id, expiresAt }`;
the pre-push hook prints `repo-aegis: human approval <id> stands in for
a person on this push`. `--list` and `--revoke` need no TTY. The typical
use: `repo-aegis approve <org>/<repo> --ttl 15m` once, then let the agent
push, open the PR, merge, tag and release.

### `repo-aegis egress-check -- <gh args…>`

The decision call behind the shim (usable directly). Exit 0 on allow with
`{ action: "allow", destination?, readback?, receipt?, failedReceipt? }` on
stdout; exit 2 on deny with the structured reason on stderr. `readback` is
set for `gh pr create|edit` with a body file, and tells the shim to run
`egress-readback` afterwards. `receipt` (`PUBLISHED → …`) and
`failedReceipt` (`EGRESS FAILED → …`) are set whenever the command
carries a publishing intent; the shim prints exactly one of them **after**
the real `gh` has returned, keyed on its exit code — a receipt must never
claim a publish that did not happen, and at decision time nothing has run.
(Before 0.9.2 this command printed `PUBLISHED →` itself, before `gh` ran.)

### `repo-aegis egress-readback --body-file <path> --pr <ref> [--repo o/r] [--gh <path>] [--timeout-ms <n>]`

After `gh pr create|edit`, reads the live PR body back (`gh pr view --json
body`) and compares it to the file. Exit 1 with
**`PUBLISHED_BODY_MISMATCH`** and byte counts — never either content — on
difference; exit 0 on match; exit 0 with `READBACK_UNAVAILABLE` on any
read-back failure, because a failed check must not fail the publish it
could not have blocked anyway.

### `doctor` — egress-guard checks

Every context rule reads class and cached visibility, so a
destination-aware control on an unclassified estate is silent. `doctor`
now reports, unless `--no-egress-checks`:

| Check | Fires when | Fix |
|---|---|---|
| `PUSH_DEFAULT_IMPLICIT` | global `push.default` is unset or not `nothing` | `git config --global push.default nothing` |
| `SHIM_MISSING` / `SHIM_NOT_FIRST` / `SHIM_STALE` | no shim; another `gh` precedes it on `PATH`; the shim on `PATH` is an earlier release's script | `repo-aegis install shim`; fix `PATH` order; `repo-aegis install shim` |
| `ENFORCEMENT_UNPINNED` (**fail**) | an installed git hook, the shim or a Claude Code hook command calls `repo-aegis` by name (an install from before the enforcement pin) | `repo-aegis install hooks` / `install shim` / `install claude-md` |
| `ENFORCEMENT_PIN_MISSING` (**fail**) | a pinned node or CLI path no longer exists, so the hook or shim falls back to the `repo-aegis` on `PATH` when it is at least the pinned version, and refuses otherwise | `repo-aegis install hooks` / `repo-aegis install shim` / `repo-aegis install claude-md` |
| `MULTIPLE_INSTALLS` (warn) | more than one `repo-aegis` on `PATH` (each listed with its version), or the first one is not the pinned one | keep one install, then re-run `install hooks` and `install shim` |
| `GUARD_HOOK_UNREGISTERED` | neither the managed drop-in nor Claude Code `settings.json` has a `guard-egress` entry | `repo-aegis install claude-md` |
| `MANAGED_DROPIN_STALE` / `MANAGED_DROPIN_NOT_ROOT_OWNED` / `MANAGED_DROPIN_UNREADABLE` (**fail**) | the managed drop-in differs from what would be written now; it or a directory above it is owned by a user, writable by group or others or a symlink; it is not `0644` (directories `0755`) | `repo-aegis install claude-md` |
| `MANAGED_DROPIN_ORPHANED` / `MANAGED_DROPIN_LEDGER_STALE` (**fail**) | the drop-in has no ledger entry or its pin points at missing files (every hook blocks); or the ledger names a drop-in that is gone | `repo-aegis install claude-md`, or remove it: `sudo rm '<path>'` (printed); `install claude-md --uninstall` clears a stale ledger |
| `MANAGED_HOOKS_DISABLED` / `MANAGED_SOURCE_SHADOWED` / `MANAGED_HOOKS_NOT_FIRING` (**fail**) | another managed file sets `disableAllHooks: true`; a macOS `com.anthropic.claudecode` profile outranks the files; or a Claude Code session started after the last heartbeat (server-managed policy and MDM keys make Claude Code ignore drop-ins, invisibly) | check `/status` in Claude Code lists `(drop-ins)`; have the policy owner add the hooks, or `install claude-md --user-settings` |
| `SUDO_NOPASSWD` (warn) | `sudo -n -k true` succeeds, so an agent with a fake terminal can rewrite or remove the drop-in: no stronger than the user file | require a sudo password for this account |
| `ENFORCEMENT_IN_USER_SETTINGS` (warn) | repo-aegis hooks are in `~/.claude/settings.json`, which must stay per machine | `repo-aegis install claude-md` |
| `CLASS_VISIBILITY_UNRESOLVED` (per repo) | a repo with a GitHub remote has no explicit class or no cached visibility | `repo-aegis classify --apply && repo-aegis status` in that repo |
| `PERSONAL_ORG_UNREGISTERED` (per repo) | the remote org is in no engagement's `githubOrgs` and not in `personalOrgs` | `repo-aegis engagements add --personal-org <org>` (or `--github-org`); **a person runs this from their own terminal** (it refuses without a TTY) |
| `REGISTRY_UNREADABLE` (**fail**) | the registry exists but does not parse or validate, or a newer repo-aegis wrote it (`schemaVersion` above what this build reads), so rule h asks (agent hook) or refuses (pre-push, the shim) every non-interactive egress that has a destination | repair the file (`repo-aegis status` shows why); for a newer schema, upgrade repo-aegis, then `repo-aegis install hooks` and `repo-aegis install claude-md` |
| `REGISTRY_ENCRYPTED` (warn) | the registry is encrypted at rest, so repo-aegis runs as if there were none: rule h and the GitHub identity mapping are off; marker scanning is unaffected. Encryption at rest is removed in 0.15.0 | `repo-aegis registry decrypt --identity <file>` (a person, at a terminal) |
| `OWNERS_UNDECLARED` (**fail**) | the registry loads but declares no owners, so rule h is inert | `repo-aegis engagements add --personal-org <login>` (a person, at a terminal) |
| `GIT_CREDENTIAL_HELPER_ORDER` (**fail**, only when some owner is mapped to an `agent` identity) | the repo-aegis git credential helper is not installed, is from another install (a moved CLI or Node), or another helper answers first for `https://github.com` (a reset entry, a system-scope helper, `gh auth setup-git`); an agent's HTTPS push there would be authenticated as the person | a person runs `repo-aegis install git-credential` from a terminal |
| `OWNER_IDENTITY_UNMAPPED` (warn; **fail** when `requireIdentity` is set) | registered owners have no identity entry (no `person` and no `agent`); one finding with the count, the owners are named only in `--json` (`names`; registered owners can be customer names) | `repo-aegis identity add`, then `repo-aegis engagements set-identity` (a person, at a terminal) |
| `GH_LOGIN_UNREGISTERED` | a logged-in `gh` account's login is not a registered owner | `--personal-org <login>` (a person, at a terminal) |
| `GH_MEMBER_ORG_UNREGISTERED` | an organisation a logged-in `gh` account belongs to is not registered | `--personal-org` or `--github-org`, or leave it and let rule h refuse it |
| `REGISTERED_ORG_NOT_MEMBER` (info) | a registered owner is no checked account's login or organisation (normal for archived engagements) | none required |
| `REGISTRY_AGENT_WRITABLE` (warn) | Claude Code `settings.json` has no `permissions.deny` `Edit` rule covering the registry file, its `.age`, the approvals store, `hooks/` and `bin/` | `repo-aegis install claude-md`; verify with a sandboxed `touch` |
| `GH_BINARY_UNTRUSTED` (warn) | the `gh` first on `PATH` is under `$HOME`, the cwd or a temp directory, sits in a group/world-writable or non-root directory, or is not the standard install | install gh from your package manager; keep user-writable directories out of `PATH` ahead of it |
| `GH_CONFIG_REDIRECT` (warn) | gh is configured to redirect requests (`http_unix_socket`, or a config/host/token environment variable), so other accounts' tokens were not read | unset the variable, or `gh config set http_unix_socket ''` |
| `PREPUSH_HOOK_MISSING` (warn) | the egress guard hook is registered but the **global** `core.hooksPath` is unset or not the repo-aegis hooks directory, so a repo that does not set it locally has no `pre-push` hook, the only layer that sees the environment git and ssh really run with | `repo-aegis install hooks` |
| `SHELL_STARTUP_OVERRIDES` (warn) | `~/.zshenv`, `~/.zshrc`, `~/.zprofile`, `~/.zlogin`, `~/.bashrc`, `~/.bash_profile`, `~/.bash_login` or `~/.profile` sets `GH_REPO`, `GH_HOST`, `GH_CONFIG_DIR`, `GIT_SSH_COMMAND`, `GIT_SSH`, `GIT_SSH_VARIANT`, `SRT_*` or `REPO_AEGIS_*`; reported by name and file, never value | remove the export |
| `SSH_GITHUB_REDIRECT` (info) | `~/.ssh/config` has a `Host github.com` block whose `HostName` is not GitHub, or that applies a `ProxyCommand` / `ProxyJump` | none if intended |
| `HOOKS_PATH_LOCAL_DUPLICATE` (info, per repo) | a repo-local `core.hooksPath` names the same directory as the global one, so it adds nothing; older `install hooks --local` runs wrote these. Removing it is safe: the global value takes over | `git config --local --unset core.hooksPath` (in that repo) |
| `AGENT_REMOTE_IS_SSH` (warn, per repo) | the repo's owner has a GitHub App as its **agent** identity and `origin`'s push URL is SSH, which goes out as the person's SSH key, so an agent's `git push origin` is refused (`AGENT_PUSH_NEEDS_APP`). `classify --apply` prints the same finding | `git remote set-url --push origin https://github.com/<org>/<repo>.git`; a person runs it (it changes the push URL only, fetches and the person's own pushes keep SSH) |

The `gh`-backed checks (`GH_LOGIN_UNREGISTERED`, `GH_MEMBER_ORG_UNREGISTERED`,
`REGISTERED_ORG_NOT_MEMBER`) cover **every account logged in for
github.com**, not just the active one. A token is only as safe as the binary
it is handed to, so:

- The active account is checked **without reading any token** (`gh api`
  acts as it). Another account's token (`gh auth token --user`) is read only
  after a **y/N on a stdin terminal that names the gh binary path**. Without a
  terminal, or if you decline, only the active account is checked and the
  report says so; the others are `SKIP`.
- Doctor skips these checks, with a reason, when another `gh` precedes the
  repo-aegis shim on `PATH`, or when the `gh` it would spawn is not trusted:
  only absolute `PATH` entries count (an empty or relative one would resolve
  against the cwd), the resolved real path is what is run, and **both the
  `PATH` entry's own directory and the resolved file's directory** are refused
  under `$HOME`, the cwd or a temp directory, or when group/world-writable or
  not owned by root (or by you inside a package-manager prefix such as
  `/opt/homebrew`). The resolved file must itself be a gh: named `gh` and a
  standard install path or inside `<prefix>/Cellar/gh/` / `<prefix>/opt/gh/` of
  `/opt/homebrew`, `/usr/local` or linuxbrew, so a link named `gh` to `/bin/sh`
  or `/usr/bin/env` is refused. `GH_BINARY_UNTRUSTED` warns.
- Before any other account's token is read, a gh whose own configuration
  redirects requests is refused (`GH_CONFIG_REDIRECT`, warn): `http_unix_socket`
  set in its config (`gh config get http_unix_socket`), or `GH_CONFIG_DIR`,
  `GH_HOST`, `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN` or
  `GITHUB_ENTERPRISE_TOKEN` in doctor's environment (names only are reported).
- The token goes to the child `gh` through its environment only; it is never
  printed, logged, stored or put in an argument, and a child's stderr is
  discarded. Doctor never runs `gh auth switch`.

Each finding names its account. `REGISTERED_ORG_NOT_MEMBER` uses the union of
all accounts' memberships; its owner list is in `--json` (`names`) only. If the
accounts cannot be listed, doctor checks the active account and says so. With
`gh` absent, logged out, untrusted, or an account's token invalid, the check is
reported `SKIP`, never `FAIL`. Organisation names appear only in a finding's
`fix` and in `--json`, never in a summary line. `doctor` prints `all clean`
only when nothing at all was reported; with only warnings, info or skips it
prints `no failures`.

Only `fail`-severity findings make `doctor` exit 1. `warn` (`WARN`), `info`
(`INFO`) and `SKIP` lines are reported and never change the exit code; JSON
checks carry `severity`, `skipped` and, for gh findings, `account`.

JSON gains `machine: DoctorCheck[]` and per-repo `checks: DoctorCheck[]`;
`summary.failed` counts the failing ones. `--claude-home <dir>` points the guard-hook
check at a Claude Code home other than `~/.claude`. The sweep also records
every checkout with a GitHub origin into the destination cache
(`summary.destinationsRecorded`; the text output says `recorded N
checkout(s) into the destination cache`) — run `doctor` once after
installing to give the egress guard its map of the machine.

### `scan-env --self`

Offers `selfIdentity` candidates — the registry's `personalOrgs`,
`package.json` names under `--from`, the agent session-link shape — dry-run
by default; `--accept self-identity` persists them. See
[configuration.md](configuration.md).

### `scan-env`

Discovers private package-registry hosts from this machine's toolchain
configs (`~/.npmrc`, `pip.conf`, `~/.docker/config.json`,
`~/.m2/settings.xml`, `~/.cargo/config.toml`, `~/.yarnrc.yml`) and offers them
as markers. Dry run unless `--accept` is given; it never reads auth tokens.

| Flag | Default | Meaning |
|---|---|---|
| `--accept <placement>` | — | persist the discovered hosts: `private-infra` (blocked in public-facing repos only), `always-block` (everywhere) or `engagement` |
| `--engagement <id>` | — | required with `--accept engagement` |
| `--self` | off | offer the operator's own identity instead (see above); only `--accept self-identity` is valid with it |
| `--from <path>` | cwd | also scan project-level configs under this directory |
| `--scan-home <dir>` | `$HOME` | whose dotfiles to scan; distinct from the global `--home`, which moves the repo-aegis config directory |

---

## Additional commands

### `repo-aegis explain <CODE|topic> [--json]`, `explain --list`

Prints what a refusal or error code means and what to do about it. Every
refusal ends `[CODE; details: repo-aegis explain CODE]`, and a refusal can
reach an agent working in any repository, where this repo's
`doc/agent-guide.md` does not exist; the guide ships inside the npm package
(`dist/docs/`, copied at build time, with `agent-sandbox.md`) and this command
reads it from there.

**Read-only, and an agent may run it.** It reads two files that sit next to the
command and nothing else: no registry, no network, no git, no repository, and
the working directory is irrelevant, so it gives the same answer from any
directory.

It finds the row of the guide's error table whose `<a id="…">` anchor matches
the code (or whose first cell names it) and prints its meaning and recovery,
followed by the `###` section of the guide that row links to, if it links to
one. The code is matched case-insensitively and `-` counts as `_`. Besides
codes, `sandbox` prints the shipped `agent-sandbox.md`, and the slug of any `##`
or `###` heading of the guide (`cross-repo-writes`) prints that section.
`--list` prints every known code, one per line. `--json` prints `{ code, codes,
anchor, meaning, recovery, section }` (or `{ topic, markdown, source }` for a
topic); `--list --json` prints `{ codes, topics }`.

An unknown code exits 2 with `UNKNOWN_CODE` and the nearest known codes (in
`details.nearest` under `--json`). `EXPLAIN_DOCS_MISSING` (exit 2) means the
guide is not next to the command, which only happens in an unbuilt checkout.

### `repo-aegis suggest-markers`

LLM-assisted marker discovery: extracts prose from a repo, asks a **local**
Ollama model for candidate tokens and proposes regex markers for an
engagement. Off the deterministic gate path; it runs only when invoked. See
[packages/llm/README.md](../packages/llm/README.md).

| Flag | Default | Meaning |
|---|---|---|
| `--engagement <id>` | required | engagement to add markers to |
| `--from <path>` | cwd | repo to scan |
| `--model <id>` | `llama3.2:3b` | Ollama model id |
| `--endpoint <url>` | `http://127.0.0.1:11434` | Ollama endpoint |
| `--allow-remote-model` | off | allow a non-loopback endpoint (sends the repo's prose to a remote service) |
| `--accept-remote-author-domains` | off | send git-log author email domains even to a non-loopback endpoint |
| `--auto-accept-above <n>` | — | auto-accept candidates with confidence at or above `n` (0 to 1) |
| `--dry-run` | off | print candidates and exit without persisting |

### `repo-aegis registry encrypt --recipient <pubkey>` / `registry decrypt --identity <path>`

Encrypts the registry at rest with `age` (`engagements.yaml` becomes
`engagements.yaml.age`, the plaintext is removed) and reverses it. `encrypt`
refuses with `REGISTRY_ALREADY_ENCRYPTED` when a ciphertext or the
`state/registry.encrypted` marker exists; `decrypt` refuses when there is no
ciphertext. The CLI never decrypts on demand: while the registry is encrypted,
commands that need it fail with `REGISTRY_ENCRYPTED` until a person runs
`decrypt`.

### `repo-aegis audit-log on | off | show [--all] | path`

The operator compliance trail, **off by default**. `on`/`off` toggle it;
`show` prints the last 50 records (`--all` for every record); `path` prints the
log file's path (`--json` adds `enabled` and `exists`). When on, each successful
state-changing command appends one JSONL record of structural metadata
(engagement ids, counts, paths), never literal markers or matched text.

### `repo-aegis uninstall [--yes] [--purge-repos] [--purge-home] [--scan-root <path...>] [--claude-home <dir>]`

Reverses every install step in one command: git hooks, global gitignore block,
the Claude Code wiring (`install claude-md --uninstall`), the CI workflow(s),
the `gh` shim and the git credential helper. A **dry run** unless `--yes`.
`--purge-repos` also unsets the `repo-aegis.*` git config in every repo under
the scan roots (default `~/repos`, `~/code`, `~/src`, `~/projects`);
`--purge-home` also deletes `~/.config/repo-aegis/` (registry, audit log,
profiles, caches).

`repo-aegis uninstall sweep-repos [--yes] [--scan-root <path...>]` runs just
the per-repo step: it walks the scan roots and unsets `repo-aegis.class` and
`repo-aegis.engagement`, dry run unless `--yes`.

### Other options not listed above

- `hook scan-bash-output --advisory`: see [`hook`](#hook-coding-agent-entry-points).
- `install ci --uninstall`, `doctor --no-egress-checks` and `--claude-home`:
  see their own sections.
- `status` JSON `zeroMarkerEngagements`, `check` JSON `egress` and
  `historyHits[].alreadyPublic`, `render` JSON `dryRun`: documented with
  each command's JSON.

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
  [--semantic]                      # embedding-based sweep alongside the regex one (needs Ollama)
  [--ollama-endpoint <url>]         # default: http://127.0.0.1:11434
  [--ollama-model <id>]             # embedding model; default: nomic-embed-text
  [--ollama-timeout-ms <n>]
  [--allow-remote-ollama]           # permit a non-loopback endpoint (default OFF)
  [--semantic-max-bytes-per-candidate <n>]  # default: 16384
```

`--semantic` is off by default, asynchronous and advisory; it needs an
engagements registry and the profile files that `rebuild-profiles` builds.
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
and you don't want to commit plain-text query strings. Other flags:
`--recipient-file <path>` (one recipient per line) and `--output <path>`
(default `<file>.age`).

### `repo-aegis-scan decrypt-query <file> --identity <key>`

Inverse of `encrypt-query`. `--output <path>` writes the cleartext there
(default: stdout).

### `repo-aegis-scan rebuild-profiles`

Builds the per-engagement embedding profiles that `run --semantic` compares
against. Flags: `--ollama-endpoint`, `--ollama-model`, `--ollama-timeout-ms`
and `--allow-remote-ollama` (as for `run`), `--threshold <n>` (cosine
threshold for new profiles, default 0.78), `--diff` (report stored-vs-current
manifest drift without embedding or writing), `--engagement <id...>`
(restrict to these engagements) and `--registry <path>`.
