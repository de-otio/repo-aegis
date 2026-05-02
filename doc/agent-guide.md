# repo-aegis — agent operator guide

> Audience: a coding agent (Claude Code, Cursor, Aider, Cline, etc.)
> driving repo-aegis on behalf of a user who never invokes it
> directly.
>
> Purpose: tell the agent everything it needs to know to use the tool
> correctly, recover from hits without leaking, and operate the
> registry on the user's behalf.

If you are a human reading this: yes, it is written second-person at
your AI. Skip to the [README](../README.md) for the user-oriented
overview.

## Mental model

repo-aegis is a deterministic gate against customer-data leaks across
a multi-tenant developer machine. The user has many engagements
(customers, employers, projects). Each engagement has a marker file
with regex patterns identifying its strings. Every git repository on
the machine is classified into one of four classes; the deny set for
a given repo is the union of all marker files, scoped according to
the repo's class and the engagements the user has explicitly allowed
in that repo.

When you write or edit a file, the PostToolUse hook fires and runs
`repo-aegis hook scan-after-write` on the path you just touched. The
hook output flows back into your tool result. Hits show up as JSON
with `path:line:col + engagement_id`, never as the literal matched
string. **You are expected to react to these hits.**

## The four classes

| Class | When | Hook behaviour |
|---|---|---|
| `public-eligible` | OSS / public personal repos | Strict: every engagement marker blocks |
| `private-strict` | Default. Could plausibly leak | Strict: same as public-eligible |
| `customer-coupled` | A repo *for* customer X — customer X's strings legitimately appear | Strict: every *other* engagement's markers block. Customer X's markers are excluded *only* in customer X's allowed-engagement repo. |
| `scratch` | Throwaway / `~/tmp/...` | Advisory: hits printed but never block |

**Read this carefully**: in a `customer-coupled` repo with
engagement = `customer-a`, customer-A's strings are *expected* in the
code and won't trigger hits. Customer-B's strings *will* trigger hits.
The point is precisely to avoid false positives in customer-A's own
repo while still blocking cross-tenancy leakage.

## The five facts to internalise

1. **Never echo the literal matched marker back to the user.** The
   hook deliberately redacts it. If you can see a literal customer
   string in a hit, you've passed `--verbose` and you must not — that
   flag is for the user at the terminal, never from a hook or an
   agent.
2. **Never retry a write with the marker still present.** Retrying
   the same content will just re-trigger the hit. Either redact the
   string in the new write, or stop and surface to the user.
3. **Surface the hit to the user with the engagement attribution and
   the position, propose a redaction, and wait for confirmation.**
   The user owns the decision on whether the string is a real leak,
   a synthetic test fixture, or a missing `repo-aegis: allow`
   exception.
4. **The classes and allowed engagements per repo are not your
   inference to make.** Run `repo-aegis status` (or check the JSON
   output of any command). The repo configuration is the source of
   truth, not your guess from filenames or recent conversation.
5. **The registry is the user's data and their compliance surface.**
   Adding/removing engagements, ending engagements, or deleting
   registry entries are operations you can perform on the user's
   instruction, but never silently on your own initiative.

## Reacting to a PostToolUse hit

The `repo-aegis hook scan-after-write` hook output looks like:

```json
{
  "mode": "path",
  "hits": [
    {
      "path": "/Users/.../src/foo.ts",
      "line": 42,
      "column": 13,
      "matchPreview": "[redacted]",
      "engagement": "customer-b"
    }
  ],
  "skipped": [],
  "repo": {
    "cwd": "/Users/.../some-repo",
    "isGitRepo": true,
    "class": "customer-coupled",
    "engagements": ["customer-a"]
  },
  "denySet": { "files": ["_always", "customer-b"], "patternCount": 27 },
  "advisory": false,
  "warnings": []
}
```

**What this tells you, what to do:**

- `engagement: "customer-b"` — you tripped customer-B's marker.
- `repo.class = customer-coupled, engagements = ["customer-a"]` — this
  repo legitimately references customer-A but not customer-B. So you
  wrote a customer-B string into a customer-A repo. That is exactly
  the cross-tenancy leak the tool is built to prevent.
- `matchPreview: "[redacted]"` — you do **not** know what the
  literal string was. You only know it was in the line `src/foo.ts`
  at line 42, column 13.

Steps:

1. Open the file at the indicated line.
2. The string at column 13 is the offender. *You can read it locally*
   (the file is on disk) but you must not paste it back to the user
   verbatim — refer to it abstractly: "the customer-B-derived string
   on line 42".
3. Propose a redaction or removal. Common options:
   - Replace with a neutral placeholder (`customer-b`, `<redacted>`,
     `example.com`, an IETF-reserved test domain).
   - Remove the line entirely if it was only there as a comment or
     a copy-paste artefact.
   - If the line *is* a legitimate test fixture and you have user
     consent, add a per-line allowlist comment (see below).
4. Wait for the user's confirmation before re-writing the file.

## Per-line allowlist comments

Sometimes a line legitimately needs to contain a marker pattern —
synthetic test fixtures, regression tests for a leak that's been
remediated, etc. The escape hatch is a comment containing the
literal token `repo-aegis: allow` (case-insensitive) on the same
line:

```ts
const fixture = "acme-corp.example"; // repo-aegis: allow synthetic test data
```

The token is intentionally explicit (not just `allow`) so unrelated
comments don't accidentally suppress hits.

`audit --history --ignore-allowlist-comments` re-runs the scan
ignoring these — useful for compliance review.

**Don't add `repo-aegis: allow` comments on your own initiative.**
The user's choice to deliberately allow a marker on a line is a
compliance decision. Propose the comment, wait for confirmation.

## Common workflows

### "I'm starting work on a new customer"

```sh
repo-aegis engagements add <id> \
  --name "Customer A" \
  --marker "acme-corp" \
  --marker "acme\\.com"
```

This adds the engagement to the registry, validates the patterns
(rejecting any that fail the regex-safety check), renders the marker
files, and reports JSON. Never invent the markers — ask the user;
they know their customer's identifiers better than you do.

### "I'm initialising a repo for customer A"

```sh
cd /path/to/customer-a-repo
repo-aegis classify --apply  # if a classify.yml rule matches the remote
# or, manually:
git config repo-aegis.class customer-coupled
repo-aegis allow customer-a
```

`classify --apply` reads `~/.config/repo-aegis/classify.yml` and
matches the repo's `git remote get-url origin` against the rules.
First match wins; sets `repo-aegis.class` and adds the engagement.

If there's no classify.yml or no rule matches, set both manually with
`git config` and `repo-aegis allow`.

### "I just got a hit, what do I do"

See [Reacting to a PostToolUse hit](#reacting-to-a-posttooluse-hit)
above.

### "I want to know what this repo's deny set looks like"

```sh
repo-aegis status --json
```

Shows the repo's class, allowed engagements, and the deny set
summary (file stems and pattern count, not the patterns themselves).

For deeper inspection (still redacted by default):

```sh
repo-aegis markers list --json
repo-aegis markers test "<some-string>" --json
```

`markers test` is especially useful for "would this string trip the
hook in this repo?".

### "Run a full audit on this repo"

```sh
repo-aegis audit --json
```

Composite check:
- Marker scan over tracked files (skips binaries, oversize files).
- `package-lock.json` non-public-registry check.
- Fixture-directory scan.
- Remote-vs-class consistency.

Add `--history` for a full git-log sweep (slow). Add `--published
<tarball-or-pkg>` to also scan a packed bundle. Add `--org <org>` (with
`--accept-cross-border`) to also run a one-shot GitHub code-search
sweep against the org.

### "End an engagement"

```sh
repo-aegis engagements end customer-a
```

Marks `ended: <today>`. Markers retain for 12 months by default (the
window is configurable per `render --retention-months`). After the
window, next `render` removes the marker file.

`--purge` back-dates so markers are removed at next render
immediately.

### Encrypting the registry

The engagement registry can be encrypted at rest with age:

```sh
repo-aegis registry encrypt --recipient age1...
```

This writes `engagements.yaml.age` next to the plaintext, removes the
plaintext, and writes a marker file at
`~/.config/repo-aegis/state/registry.encrypted` recording the
recipient and the timestamp. To resume work the user runs:

```sh
repo-aegis registry decrypt --identity /path/to/identity-file
```

This restores `engagements.yaml` (chmod 600), removes the ciphertext,
and removes the marker.

**When the user does this:** between work sessions, when the machine
will be away from a trusted environment, or when storing the home dir
on cloud-synced storage. Encryption-at-rest is the *intended* state
for those periods.

**When you (the agent) hit a `REGISTRY_ENCRYPTED` error:**

If you call any registry-reading command (`status`, `check`,
`engagements list`, `audit`, `render`, etc.) and you get back JSON
like:

```json
{
  "code": "REGISTRY_ENCRYPTED",
  "error": "engagement registry at … is encrypted at rest …",
  "details": "…"
}
```

…then the registry is in its encrypted-at-rest state. **Do NOT
run `registry decrypt` on your own initiative.** Decryption requires
the user's identity file path, which is sensitive material — they
must give it to you explicitly. Surface the situation:

> The engagement registry is encrypted at rest. To proceed, run:
> `repo-aegis registry decrypt --identity <path-to-your-age-identity>`.
> Tell me the identity-file path if you'd like me to run it.

Wait for an explicit identity-file path before invoking `registry
decrypt`. Do not guess (e.g. "tried `~/.ssh/id_ed25519`"); a wrong
guess at best fails noisily, at worst silently uses the wrong key.

After successful decryption you can re-run the command that failed.
At end of session, ask the user whether they want to re-encrypt with
`registry encrypt` before stopping.

### Audit log

The audit log is an optional compliance trail: when enabled, every
state-changing CLI invocation appends one JSON Lines record to
`~/.config/repo-aegis/state/audit.log`. It answers questions like
"did the operator allow customer-A in this repo on date X" from a
single file rather than archaeology across `.git/config` and the
engagement registry.

**What gets captured:** `allow`, `deny`, `engagements add` /
`engagements end` / `engagements remove`, `classify --apply`, `init`,
`install hooks` / `install claude-md` / `install gitignore` /
`install ci`, `render`, `registry encrypt` / `registry decrypt`. One
record per successful invocation, written *after* the primary action
persists. Each record carries `ts`, `action`, `actor` (from
`process.env.USER`), and structural metadata — engagement ids,
counts, paths. **Never literal marker patterns or matched
substrings.**

**Default state:** OFF. Existing users see no behaviour change after
upgrade. Opt in per machine:

```sh
repo-aegis audit-log on        # enable
repo-aegis audit-log off       # disable (existing records preserved)
repo-aegis audit-log show      # last 50 records
repo-aegis audit-log show --all
repo-aegis audit-log path      # active log file path
```

The file is chmod 600, append-only, and rotates to
`audit.log.<iso>` when it exceeds 10 MiB (configurable via
`audit-log.json`'s `rotateBytes` field).

**As an agent: do not write to this file directly.** It's the user's
compliance surface, and the only sanctioned writers are the
state-changing commands above (which append automatically when the log
is on). If the user asks you to enable, disable, or inspect the log,
use the `audit-log` subcommands above. If they ask you to "remove an
incorrect record", surface the situation: the log is intentionally
append-only — corrections go in as a new record (e.g. `engagements
remove --hard` followed by `engagements add` rather than editing the
log file).

### "Permanently delete an engagement record (data-subject erasure)"

```sh
repo-aegis engagements remove customer-a --hard
```

`--hard` is required and intentionally loud: removing a registry
entry is a compliance operation, not a routine cleanup. For soft
removal with a retention window, use `engagements end --purge`
instead.

## Hooks lifecycle

### Pre-commit / pre-push

Installed by `repo-aegis install hooks` (or `init`). They live at
`~/.config/repo-aegis/hooks/pre-commit` and `pre-push`, with
`core.hooksPath` set per repo.

Pre-commit shells out to `repo-aegis check --staged`. Pre-push reads
ref-update lines on stdin and runs `repo-aegis check --range` per
updated ref (force-pushes use the empty-tree SHA so every commit on
the new branch is scanned).

Both hooks `exit 0` if `repo-aegis` isn't on PATH (fail-open) so the
git workflow doesn't break for users who haven't installed the CLI
globally.

### Claude Code PostToolUse

Installed by `repo-aegis install claude-md` (or `init --with-claude`).
The settings.json entry references `repo-aegis hook scan-after-write`
— a CLI subcommand resolved through PATH at hook time, **not** an
absolute path to a shell script.

The hook fires on every `Write`, `Edit`, and `MultiEdit` tool call.
It reads your tool-result JSON on stdin, extracts the file_path,
and runs `check --path` against the deny set. Output (always JSON,
never literal markers) flows back into your tool result.

It exits 0 silently when:
- stdin is empty / unparseable
- there's no file_path in the payload (you used a tool we don't model)
- the file_path doesn't exist on disk

So a "no marker hit" looks the same to you as "no scan ran". That's
intentional — the hook is invisible to you on the happy path.

## Failure modes

### "I get `customer-coupled with no engagement` errors"

The repo's `.git/config` has
`repo-aegis.class = customer-coupled` but no
`repo-aegis.engagement`. The hook fails closed (exit 2) rather than
silently bypassing — the user (or you, on their behalf) must run
`repo-aegis allow <engagement-id>` to declare which engagement(s)
this repo legitimately references.

If the remote URL maps cleanly via classify rules, run
`repo-aegis classify --apply`. Otherwise ask the user.

### "I get `REPO_AEGIS_HOME is overridden` warnings"

The user has `REPO_AEGIS_HOME` set in the env. This is a deliberate
signal — they're using a non-default config home. The warning prints
on every TTY invocation; in a hook context (stderr-is-pipe) it's
suppressed because the warning would itself be a recency-pressure
signal. Don't try to "fix" this.

### "The hook says `engagement registry not found`"

The user hasn't run `repo-aegis init`. Do that:

```sh
repo-aegis init
```

It scaffolds the registry stub, renders empty marker files, and
installs both git hooks and the Claude Code PostToolUse hook. It is
idempotent — safe to run again.

### "The hook says `pattern validation failed`"

A marker pattern in the registry is malformed (regex syntax error,
ReDoS-suspected, oversized). `render` (and operations that trigger
render — `engagements add`, `engagements end`, `engagements remove`,
`init`) bail out and report the offending engagement-id and the
reason. Open the registry and fix the pattern; re-run the operation.

The pattern is **redacted in the JSON output by default**. To see
the literal pattern, the user runs
`repo-aegis render` (no `--json`) at the terminal. **You** never see
the literal pattern from a hook.

## Output redaction policy — internalise this

Hooks NEVER pass `--verbose`. The `repo-aegis hook scan-after-write`
subcommand calls `check` without `--verbose`, so this can't be
subverted by hand-edited settings.json. If you find yourself writing
a tool result that quotes a literal marker string, **stop**: that
string came from somewhere you weren't supposed to see it.

Error messages NEVER enumerate registry contents. They redirect to
`repo-aegis engagements list` (which the user runs at a terminal, in
`--json` form for you). If you need to know which engagements exist,
run that command — don't try to extract them from error text.

## Self-instructions for context safety

These reinforce CLAUDE.md guidance and apply specifically when
working with repo-aegis:

1. When a hit fires, you'll know an engagement-id (e.g.
   `customer-b`). Refer to the leak abstractly thereafter ("the
   customer-B-derived string") — don't echo the literal value, even
   if you've already read it from disk.
2. After you remediate a leak, **do a marker grep on the file you
   wrote** before reporting completion. The grep is the only
   reliable check; the rule above is not. Use:
   ```sh
   repo-aegis markers test "$LITERAL" --json
   ```
   on any specific value you're worried about — but prefer scanning
   the whole file with `repo-aegis check --path <file>`.
3. If you're writing about leak prevention, audit work, or incident
   response, the recency pressure is highest. Run a marker scan
   (`repo-aegis audit --json`) on the document directory before
   reporting completion.
4. If the user asks you to "remember" a customer name to use later,
   propose adding it to the registry as an engagement marker
   instead. That way it lives in the deny set and protects future
   sessions, rather than being pinned in your context where the next
   "concrete example" prompt will reach for it.

## Error codes

Every CLI failure with exit 2 emits a JSON error payload (under
`--json`) of shape:

```json
{ "code": "USAGE", "error": "specify exactly one of …", "details": "…" }
```

Codes you should recognise and act on:

| Code | Meaning | Recovery |
|---|---|---|
| `USAGE` | flag combination invalid | re-read the command's flags; do not retry blindly |
| `NOT_GIT_REPO` | command needs a git repo, this dir isn't one | confirm with `git rev-parse --is-inside-work-tree`; if user wants to scan ad-hoc, use `check --path` (which works outside a git repo) |
| `REGISTRY_NOT_FOUND` | `engagements.yaml` missing | run `repo-aegis init`; user-confirmed if the home is non-default |
| `REGISTRY_PARSE` | YAML invalid / shape wrong | open the registry, fix YAML; `details` carries the underlying parse error |
| `REGISTRY_ENCRYPTED` | the registry is encrypted at rest (`engagements.yaml.age` present, plaintext absent) | surface to user; ask for the age identity-file path; run `repo-aegis registry decrypt --identity <path>`. Do NOT decrypt without an explicit user-supplied path |
| `REGISTRY_ALREADY_ENCRYPTED` / `REGISTRY_NOT_ENCRYPTED` | `registry encrypt`/`decrypt` would clobber existing state | a stale marker or leftover ciphertext; surface to the user, do not auto-resolve |
| `PATTERN_VALIDATION` | a marker pattern failed validation (regex syntax / ReDoS / oversize) | open registry; `details` carries the engagement id and reason but **redacts the literal pattern**. The user runs `repo-aegis render` at a terminal to see the literal |
| `ENGAGEMENT_EXISTS` | `engagements add` with an id already in use | use `engagements show <id>` to inspect, `engagements end <id>` if outdated |
| `ENGAGEMENT_NOT_FOUND` | `allow`/`deny`/`engagements end`/`show`/`remove` query didn't match | run `engagements list --json` to see options |
| `AMBIGUOUS_QUERY` | fuzzy match on `allow`/`deny` returned multiple candidates | re-issue with the exact id |
| `RESERVED_ID` | tried to create or remove `_always` as an engagement id | use the top-level `always_block:` field in the registry |
| `REMOVE_REQUIRES_HARD` | `engagements remove` without `--hard` | for soft removal use `engagements end <id> --purge`; for hard removal pass `--hard` (data-subject-erasure semantics) |
| `LOCK_TIMEOUT` | another repo-aegis process is holding the registry lock | wait and retry; if persistent, the user has a stale lockfile to investigate |
| `OUTSIDE_WORKING_TREE` | `check --path` resolved to a file outside the repo working tree | a likely symlink-attack indicator; do NOT auto-rerun on a different path. Surface to the user. |
| `CUSTOMER_COUPLED_NO_ENGAGEMENT` | `check` ran in a `customer-coupled` repo with no engagement set | run `repo-aegis allow <id>` after confirming with the user which engagement(s) the repo references |
| `HOOKS_PATH_CONFLICT` | `install hooks` saw a different `core.hooksPath` already set | tell the user the prior value verbatim; ask if they want to overwrite with `--force` |
| `SETTINGS_PARSE_ERROR` | `~/.claude/settings.json` is not valid JSON | the user has a corrupt settings file; do not auto-fix |
| `RULES_PARSE_ERROR` / `INVALID_RULES` | `classify --rules` YAML parse / validation failed | `details` carries which rules; user fixes the file |
| `WORKFLOW_EXISTS` | `install ci` saw an existing workflow file | the user must explicitly pass `--force` to overwrite |
| `TOKEN_MISSING` | `scan run` could not find the GitHub token env var | the user must export `GH_TOKEN` (or whatever `--token <env-var>` names) |
| `QUERY_VALIDATION` | `scan run`/`validate-queries` rejected a query file | `details` carries the per-query reasons |
| `STATE_PARSE_ERROR` | `scan run` state file is corrupt | the user resolves it manually; do not auto-truncate |
| `ENCRYPT_ERROR` / `DECRYPT_ERROR` | `scan encrypt-query`/`decrypt-query` failed | typically a missing/invalid `age` recipient/identity |
| `FS_ERROR` | generic filesystem write failed | check the permissions in `details`; the user owns this |
| `GIT_CONFIG_ERROR` / `GIT_ERROR` | a git plumbing call failed | `details` carries the underlying git stderr |
| `RENDER_ERROR` | unexpected render failure | unusual; surface to user |
| `REGISTRY_ERROR` | unexpected registry-load failure | unusual; surface to user |

`audit` also emits per-finding diagnostic codes inside its
`checks[].findings[].detail.code` field (NOT top-level error codes —
the audit command's own exit code reflects the aggregate). Watch for:
- `ORG_SCAN_CONSENT_REQUIRED` — `audit --org` ran without
  `--accept-cross-border` (or `REPO_AEGIS_ACCEPT_ORG_SEED_TRANSFER=1`).
  The user must agree to the cross-border data transfer first; do NOT
  auto-add the flag.
- `ORG_SCAN_TRUNCATED` — the seed-derived query cap (`--max-queries`,
  default 30) was hit; the result is partial.
- `PUBLISHED_ARCHIVE_ESCAPE` — `audit --published` extracted a
  zip-slip-suspect archive (an entry resolves outside the temp dir);
  the audit refuses to scan it. Do NOT bypass.

Generic codes you should ignore in favour of recovery:
- `error` (no `code` field) — fatal but not categorised; surface to the user.

## Environment variables

| Var | Effect | Notes |
|---|---|---|
| `REPO_AEGIS_HOME` | Override `~/.config/repo-aegis` as the config home | Stderr warning printed on every TTY invocation when set; suppressed in hook context. |
| `REPO_AEGIS_REGISTRY` | Override the registry path independently from home | Set by the `--registry-path` global flag. |
| `REPO_AEGIS_ACCEPT_ORG_SEED_TRANSFER` | Equivalent to passing `--accept-cross-border` to `audit --org` | The user must set this themselves; do not auto-set. |

`REPO_AEGIS_REVEAL_MATCHES` is **not** an env var. The previous
env-var path was deliberately removed because env vars propagate to
subprocess hooks unintentionally and could cause literal markers to
flow into agent tool-result context. The only path to literal-reveal
is a `--verbose` CLI flag passed by a human at a terminal.

## `.repo-aegis.yml` repo override

A repo can ship a `.repo-aegis.yml` at its root that declares the
class and engagements as project defaults:

```yaml
class: customer-coupled
engagements:
  - customer-a
```

**Precedence (first wins):**
1. CLI flag (`--cwd`, etc).
2. `.git/config` (per-clone `repo-aegis.class` / `repo-aegis.engagement`).
3. `.repo-aegis.yml` at the repo root.
4. Default (`private-strict`, no engagements).

So a checked-in `.repo-aegis.yml` provides the project's intent;
per-clone `git config` overrides it locally without changing the
file. If you `repo-aegis status` and the repo's class came from the
override, the JSON will show `classFromOverride: true` /
`engagementsFromOverride: true`.

When you're new to a repo, **always run `repo-aegis status --json`
first** — don't infer class from filenames or recent conversation.
The `.repo-aegis.yml` file is the maintainer's authoritative
declaration for that repo.

## PostToolUse hook payload variations

The hook accepts both `tool_input.file_path` (current Claude Code
contract for Write/Edit/MultiEdit) and `tool_input.path` (older
shape, kept for forward-compat). Anything else under `tool_input`
results in a silent exit-0 — the hook fired on a tool whose payload
shape we don't model.

## Quick-reference: every command, JSON output

| Command | Action | JSON shape (top-level keys) |
|---|---|---|
| `allow <id>...` | adds engagement to repo | `action`, `results`, `repo` |
| `deny <id>...` | removes engagement from repo | `action`, `results`, `repo` |
| `status` | repo class + allowed engagements | `repo`, `allowedEngagements`, `denySet`, `alwaysBlock`, `warnings` |
| `check --staged` | scan staged diff | `mode`, `hits`, `skipped`, `repo`, `denySet`, `advisory`, `warnings` |
| `check --path <f>` | scan single file | (same) |
| `check --range <r>` | scan commit range | (same) |
| `check --history` | scan full git log | (same; `historyHits` populated) |
| `render` | regenerate marker files | `RenderResult` |
| `engagements list` | list engagements | `engagements`, `alwaysBlock` |
| `engagements add <id>` | add new engagement | `action`, `id`, `name`, `markers`, `rendered` |
| `engagements end <id>` | mark ended | `action`, `id`, `ended`, `purged`, `rendered` |
| `engagements show <id>` | show one engagement | `action`, `id`, `name`, `started`, `ended`, `active`, `markerCount`, `notes` |
| `engagements remove <id> --hard` | hard-delete | `action`, `id`, `removed`, `rendered` |
| `registry encrypt --recipient <pubkey>` | encrypt registry at rest | `action`, `registry`, `recipient`, `marker` |
| `registry decrypt --identity <path>` | decrypt registry | `action`, `registry`, `identity`, `markerRemoved` |
| `init` | bootstrap | `action`, `home`, `registry`, `rendered`, `hooks`, `claude` |
| `classify [--apply]` | auto-detect class | `action`, `remote`, `matched`, `applied`, `before`/`after` |
| `audit` | composite repo audit | `repo`, `denySet`, `checks` |
| `markers list` | inspect deny set | `files`, `patterns` |
| `markers test <s>` | probe a string | `input`, `matches` |
| `context on/off/status` | toggle strict mode | `action`, `enabled` |
| `install hooks` | install git hooks | `action`, `hooksDir`, `installed`, `coreHooksPath` |
| `install claude-md` | install Claude hook | `action`, `claudeHome`, `claudeMd`, `hookCommand`, `settings` |
| `install gitignore` | append global gitignore | `action`, `path`, `appended` |
| `install ci` | emit GHA workflow | (printed to stdout, not JSON) |
| `hook scan-after-write` | (PostToolUse entry) | same as `check --path` |
| `audit-log on` | enable compliance trail | `action`, `wasOn`, `isOn`, `path` |
| `audit-log off` | disable compliance trail | `action`, `wasOn`, `isOn`, `path` |
| `audit-log show [--all]` | print recorded events | `action`, `path`, `enabled`, `total`, `shown`, `records` |
| `audit-log path` | print log file path | `action`, `path`, `enabled`, `exists` |

Always pass `--json` when you want machine-readable output. Without
it, output is tuned for a human at a terminal.

## Reference

- Tool home page: https://github.com/de-otio/repo-aegis
- Design: [doc/design/README.md](design/README.md)
- CLI reference: [doc/design/cli-reference.md](design/cli-reference.md)
