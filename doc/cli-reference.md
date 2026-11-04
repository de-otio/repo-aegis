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
  "warnings": []
}
```

`regexBackend` is `"re2"` when the optional `re2` dependency is
installed and active for pattern validation, or `"in-process"`
otherwise. See the design doc's locked-decisions row "Regex backend
(validation)" for what the field means.

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
pre-push hooks shell out to this; the Claude Code PostToolUse hook
calls it via `hook scan-after-write`.

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
   exits 2 (blocking) if either is gone, never a `repo-aegis` looked up on
   PATH. An older by-name entry is replaced, not duplicated:

| Event | Matcher | Command |
|---|---|---|
| `PreToolUse` | `Write\|Edit\|MultiEdit` | `repo-aegis hook check-write` |
| `PreToolUse` | `Bash` | `repo-aegis hook guard-egress --agent claude` |
| `PostToolUse` | `Write\|Edit\|MultiEdit` | `repo-aegis hook scan-after-write` |
| `PostToolUse` | `Bash` | `repo-aegis hook scan-bash-output` |
| `PostToolUse` | `Bash` | `repo-aegis hook egress-receipt` |
| `SessionStart` | `*` | `repo-aegis hook first-touch` (only with `--first-touch`) |

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

The Claude Code PostToolUse hook. Reads the tool-result JSON on stdin,
extracts `tool_input.file_path` (or `tool_input.path` for older
shapes), and runs `check --path` on it. Output flows back into the
agent's tool result as JSON (always — never literal markers).

This is the canonical hook entry. Settings.json from
`install claude-md` registers it as a pinned command (the pinned node and
CLI, by absolute path, exit 2 if either is gone) rather than by bin name.

Silent exits (code 0):
- empty stdin (the agent invoked the hook with no payload)
- unparseable JSON
- no `tool_input.file_path` (the hook fired on a tool we don't model)
- `file_path` does not exist on disk

Otherwise: hands off to `check`. Exit semantics are `check`'s.

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
token` in a command that also makes a network call). Rule h is skipped when no
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

### `repo-aegis hook guard-egress [--agent claude|codex|gemini]`

The pre-command hook. Reads the framework's JSON on stdin
(`tool_input.command` or a root-level `command`, plus the root `cwd`),
parses the command, runs `decideEgress` with `capabilities.ask` true for
`claude` (the default) and false otherwise, and answers:

| Decision | Exit | stdout | stderr |
|---|---|---|---|
| allow (or no publishing operation in the command) | 0 | — | — |
| ask | 0 | `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":…}}` | — |
| deny | 2 | the same shape with `"deny"` | `{ code, error, details: { verb, destination? } }` |

It never emits `updatedInput`. A registry that is missing, encrypted or
unreadable does not disable the shape rules (an encrypted or unparseable one
makes rule h refuse every non-interactive egress that has a destination).
Before the egress parse, and for **any** Bash command, the hook also refuses
(deny, exit 2): a raw HTTP client writing to the GitHub API
(`GITHUB_API_VIA_HTTP_CLIENT`) and `gh auth token` next to a network call
(`GH_AUTH_TOKEN_NETWORK`); a command whose text runs `repo-aegis approve`,
`engagements add --personal-org|--github-org`, `upstreams add` or `init
--migrate-classify|--force`, in any shape (`AGENT_RAN_HUMAN_COMMAND`); and a
command that starts a detached session: `tmux new -d`, `tmux new-window` /
`send-keys`, `screen -dm`, `setsid`, `daemonize`, `nohup … & disown`
(`AGENT_DETACHED_SESSION`). These are text-level speed bumps: a program word
built at run time, or a script written by an earlier call, gets past them and
falls to the terminal and ancestry checks. A quoted mention next to a
repo-aegis word is refused too. Registered by
`install claude-md` on `PreToolUse` matcher `Bash`; Codex CLI and Gemini
CLI snippets are in [agent-install.md](agent-install.md) (there `ask`
degrades to `deny`).

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
— never a hard-coded path, never itself — passes every non-publishing
invocation through untouched, and for the publishing verbs runs
`repo-aegis egress-check` first. Idempotent: a second run reports
`already installed`. A file at that path that repo-aegis did not write
is refused with `SHIM_PATH_OCCUPIED` unless `--force` is passed.

Installing is not enabling: the shim only guards once `<home>/bin`
precedes the real `gh` on `PATH`, which this command prints (also as
`pathInstruction` in `--json`) but cannot do — it is a shell-profile
edit. `doctor` reports `SHIM_MISSING` / `SHIM_NOT_FIRST` until both
halves are done.

`--uninstall` removes the shim **only if repo-aegis wrote it** (the
file carries a header line); a foreign file at the shim path is left in
place and reported (`changed: false`, with the reason). The top-level
`uninstall` applies the same rule.

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
| `ENFORCEMENT_PIN_MISSING` (**fail**) | a pinned node or CLI path no longer exists, so that hook exits 1 and that shim refuses publishing verbs | `repo-aegis install hooks` / `repo-aegis install shim` |
| `MULTIPLE_INSTALLS` (warn) | more than one `repo-aegis` on `PATH` (each listed with its version), or the first one is not the pinned one | keep one install, then re-run `install hooks` and `install shim` |
| `GUARD_HOOK_UNREGISTERED` | neither the managed drop-in nor Claude Code `settings.json` has a `guard-egress` entry | `repo-aegis install claude-md` |
| `MANAGED_DROPIN_STALE` / `MANAGED_DROPIN_NOT_ROOT_OWNED` / `MANAGED_DROPIN_UNREADABLE` (**fail**) | the managed drop-in differs from what would be written now; it or a directory above it is owned by a user, writable by group or others or a symlink; it is not `0644` (directories `0755`) | `repo-aegis install claude-md` |
| `MANAGED_DROPIN_ORPHANED` / `MANAGED_DROPIN_LEDGER_STALE` (**fail**) | the drop-in has no ledger entry or its pin points at missing files (every hook blocks); or the ledger names a drop-in that is gone | `repo-aegis install claude-md`, or remove it: `sudo rm '<path>'` (printed); `install claude-md --uninstall` clears a stale ledger |
| `MANAGED_HOOKS_DISABLED` / `MANAGED_SOURCE_SHADOWED` / `MANAGED_HOOKS_NOT_FIRING` (**fail**) | another managed file sets `disableAllHooks: true`; a macOS `com.anthropic.claudecode` profile outranks the files; or a Claude Code session started after the last heartbeat (server-managed policy and MDM keys make Claude Code ignore drop-ins, invisibly) | check `/status` in Claude Code lists `(drop-ins)`; have the policy owner add the hooks, or `install claude-md --user-settings` |
| `SUDO_NOPASSWD` (warn) | `sudo -n -k true` succeeds, so an agent with a fake terminal can rewrite or remove the drop-in: no stronger than the user file | require a sudo password for this account |
| `ENFORCEMENT_IN_USER_SETTINGS` (warn) | repo-aegis hooks are in `~/.claude/settings.json`, which must stay per machine | `repo-aegis install claude-md` |
| `CLASS_VISIBILITY_UNRESOLVED` (per repo) | a repo with a GitHub remote has no explicit class or no cached visibility | `repo-aegis classify --apply && repo-aegis status` in that repo |
| `PERSONAL_ORG_UNREGISTERED` (per repo) | the remote org is in no engagement's `githubOrgs` and not in `personalOrgs` | `repo-aegis engagements add --personal-org <org>` (or `--github-org`); **a person runs this from their own terminal** (it refuses without a TTY) |
| `REGISTRY_UNREADABLE` (**fail**) | the registry exists but is encrypted at rest or does not parse, so rule h refuses every non-interactive egress that has a destination | `repo-aegis registry decrypt --identity <file>` (a person, at a terminal), or repair the file |
| `OWNERS_UNDECLARED` (**fail**) | the registry loads but declares no owners, so rule h is inert | `repo-aegis engagements add --personal-org <login>` (a person, at a terminal) |
| `GH_LOGIN_UNREGISTERED` | a logged-in `gh` account's login is not a registered owner | `--personal-org <login>` (a person, at a terminal) |
| `GH_MEMBER_ORG_UNREGISTERED` | an organisation a logged-in `gh` account belongs to is not registered | `--personal-org` or `--github-org`, or leave it and let rule h refuse it |
| `REGISTERED_ORG_NOT_MEMBER` (info) | a registered owner is no checked account's login or organisation (normal for archived engagements) | none required |
| `REGISTRY_AGENT_WRITABLE` (warn) | Claude Code `settings.json` has no `permissions.deny` `Edit` rule covering the registry file, its `.age`, the approvals store, `hooks/` and `bin/` | `repo-aegis install claude-md`; verify with a sandboxed `touch` |
| `GH_BINARY_UNTRUSTED` (warn) | the `gh` first on `PATH` is under `$HOME`, the cwd or a temp directory, sits in a group/world-writable or non-root directory, or is not the standard install | install gh from your package manager; keep user-writable directories out of `PATH` ahead of it |
| `GH_CONFIG_REDIRECT` (warn) | gh is configured to redirect requests (`http_unix_socket`, or a config/host/token environment variable), so other accounts' tokens were not read | unset the variable, or `gh config set http_unix_socket ''` |
| `PREPUSH_HOOK_MISSING` (warn) | the egress guard hook is registered but the **global** `core.hooksPath` is unset or not the repo-aegis hooks directory, so a repo that does not set it locally has no `pre-push` hook, the only layer that sees the environment git and ssh really run with | `repo-aegis install hooks` |
| `SHELL_STARTUP_OVERRIDES` (warn) | `~/.zshenv`, `~/.zshrc`, `~/.zprofile`, `~/.zlogin`, `~/.bashrc`, `~/.bash_profile`, `~/.bash_login` or `~/.profile` sets `GH_REPO`, `GH_HOST`, `GH_CONFIG_DIR`, `GIT_SSH_COMMAND`, `GIT_SSH`, `GIT_SSH_VARIANT`, `SRT_*` or `REPO_AEGIS_*`; reported by name and file, never value | remove the export |
| `SSH_GITHUB_REDIRECT` (info) | `~/.ssh/config` has a `Host github.com` block whose `HostName` is not GitHub, or that applies a `ProxyCommand` / `ProxyJump` | none if intended |

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
