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
   **Registering an owner is not one of them.** You never add a
   `personalOrgs` entry, an engagement `githubOrgs` entry or an
   `allowedUpstreams` entry: those commands refuse without a person at a
   terminal, and you do not look for a way around that. See
   [Owners are the user's to register](#owners-are-the-users-to-register).

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

Leave `--github-org` and `--personal-org` off: they register an owner,
which only a person at a terminal may do (`OWNER_ADD_NEEDS_TTY`). Tell
the user which org belongs to this engagement and ask them to run
`repo-aegis engagements add <id> --github-org <org>` themselves.

### "I'm initialising a repo for customer A"

```sh
cd /path/to/customer-a-repo
repo-aegis classify --apply
# or, manually:
git config repo-aegis.class customer-coupled
repo-aegis allow customer-a
```

`classify --apply` reads the engagement registry, looks up the GitHub
org from the repo's `git remote get-url origin`, and:

- If the org is in any engagement's `githubOrgs`, classifies the repo
  `customer-coupled` and `allow`s that engagement.
- If the org is in `personalOrgs`, probes the repo's GitHub visibility
  (`gh repo view`) and classifies it `public-eligible` only when GitHub
  says it really is **public**; private / internal repos get
  `private-strict`. Being in a personal org says nothing about whether
  this particular repo is public, and `public-eligible` turns on
  egress-hygiene enforcement.
  - If the probe cannot resolve visibility (no `gh`, or `gh` is on an
    account that cannot see the repo), `--apply` **exits 2** with
    `VISIBILITY_UNRESOLVED` and writes nothing. Do not retry blindly and
    do not pick a class yourself: re-run with the right account
    (`GH_TOKEN=$(gh auth token --user <user>) repo-aegis classify --apply`),
    or surface the choice to the user, who can set it explicitly with
    `git config repo-aegis.class <class>`.
- If neither, falls back to a legacy `~/.config/repo-aegis/classify.yml`
  rules file (one-time deprecation warning naming the matched rule).
- If nothing matches, sets nothing and reports `matched: null`. Ask
  the user.

You can attach an org to an engagement (so the next repo in that org
auto-classifies) with `engagements add` — see the next workflow.

### "I just opened a repo I haven't seen before"

If installed via `init` or `install claude-md --first-touch`, a Claude
Code SessionStart hook runs `repo-aegis hook first-touch` automatically
on every session-start. Possible outcomes:

- **`already-classified`** — the repo already has `repo-aegis.class`
  set. No action.
- **`applied`** — the repo's GitHub org matched an engagement /
  `personalOrgs` entry. Class + engagements are now set; you can
  proceed.
- **`needs-confirmation`** — the org is unknown to the registry. The
  hook output names the org (redacted with `[SEC H-5]` for orgs ≥ 4
  chars: `xx***y`); ask the user whether to add it to an engagement
  (`engagements add --github-org`) or to `personalOrgs`, and have the
  user run that command from their own terminal. Do NOT guess, and do
  NOT run it yourself.
- **`skipped`** — no remote, not a git repo, etc. Surface to the
  user only if they're confused about why class is unset.

### "Add a GitHub org to an engagement so future repos auto-classify"

**A person runs this, from their own terminal.** Registering an owner tells
repo-aegis that publishing there is safe, so `--github-org`,
`--personal-org`, `upstreams add` and `init --migrate-classify` refuse
without a terminal (`OWNER_ADD_NEEDS_TTY`), and refuse again in the agent
hook if the command line contains them (`AGENT_RAN_HUMAN_COMMAND`). Give the
user the exact line and wait:

```sh
repo-aegis engagements add customer-a --github-org acme-corp
# or, on a brand-new engagement:
repo-aegis engagements add customer-a --name "Customer A" \
  --github-org acme-corp \
  --marker "acme-corp" \
  --marker "acme\\.com"
```

`--github-org` and `--personal-org` are mutually exclusive (a single
org belongs to either an engagement or to the user's personal orgs,
not both). Cross-engagement uniqueness is enforced — if the org is
already attached elsewhere, the command fails with a clear error.

The first time you write to a v1 registry that lacks a
`schemaVersion`, the command bumps it to v2 and prints a one-time
warning. v1 readers can no longer parse the file after this; the
upgrade is intentional.

### "Which GitHub identity should act for this org?"

**A person runs these, from their own terminal.** Registry schema version 3
records which GitHub identity belongs to an owner. `repo-aegis identity add`,
`identity remove`, `identity require --off` and `engagements set-identity`
(for an engagement, or with `--personal-org <org>`) refuse without a terminal
(`IDENTITY_CHANGE_NEEDS_TTY`) and are refused again in the agent hook if the
command line contains them (`AGENT_RAN_HUMAN_COMMAND`). An agent never picks
the identity it acts as. Give the user the exact line and wait:

```sh
repo-aegis identity add me --gh-login alice
repo-aegis identity add me-bot --app example-bot
repo-aegis engagements set-identity customer-a --person me --agent me-bot
```

`identity require --on` only tightens (it turns `requireIdentity` on), needs no
terminal, and you may run it if asked.

`repo-aegis status` shows the identities and mappings (names, kinds, logins,
app slugs; nothing secret), and `repo-aegis doctor` reports
`OWNER_IDENTITY_UNMAPPED` for registered owners with none. Nothing yet chooses
or injects a token from them: plain `gh` and `git` behave as before.

### "Suggest markers for this engagement from the repo's prose"

```sh
# Dry-run — print the candidates as JSON, do not modify anything:
repo-aegis suggest-markers --engagement customer-a --dry-run --json

# Auto-accept candidates above a confidence threshold:
repo-aegis suggest-markers --engagement customer-a --auto-accept-above 0.7

# Without --auto-accept-above and --dry-run, prints "review-required":
# the surviving candidate list is printed and nothing is written.
# Re-run with --auto-accept-above (or --dry-run) once the user has reviewed.
repo-aegis suggest-markers --engagement customer-a --json
```

Phase 2 pipeline:

1. **Extract prose.** Walks the current repo with hard-coded depth/file
   caps; reads README, CONTRIBUTING, CODEOWNERS, package.json metadata,
   docs, top-of-file comments. Hard-skipped: `.env*`, secrets, anything
   under `.git/`, `.ssh/`, `.aws/`, `.gnupg/`.
2. **Ask Ollama** (local, default `http://127.0.0.1:11434`,
   loopback-only by default) which strings look like customer
   identifiers. Anti-injection preamble + fenced delimiters protect
   the prompt.
3. **Synthesise** word-boundary regexes per token kind (company,
   codename, person-name, domain, ticket-prefix, account-id, other).
4. **Filter:** dictionary words, dependency names from
   `package.json` / `Cargo.toml` / `go.mod` / `pyproject.toml`,
   patterns already in this engagement's marker list, tokens that
   match `personalOrgs` / `$USER` / `$HOME` basename (`[SEC H-2]`).
5. **Decide:**
   - `--dry-run` → print, exit 0, no writes.
   - `--auto-accept-above <T>` → accept candidates with `confidence >= T`
     that pass the identity guard; identity-rejected candidates are
     dropped (cannot be auto-accepted).
   - Neither → print "review-required" candidate list and exit 0
     without persisting. The user re-runs with one of the two flags.
6. Approved patterns are appended to the engagement's marker list
   under a single registry lock (`addMarkerPatterns`), `render` runs,
   and the audit log records source basename, model id, endpoint host
   kind, candidate / accepted / identity-rejected counts, and the
   prompt version (`[SEC H-6]`). **Never** the literal patterns or
   tokens.

This is **discovery only** — never run on a hot path. The
deterministic gate (PostToolUse, pre-commit, pre-push) remains regex
against fixed marker files.

If Ollama isn't installed or running, the command exits with a clear
`OLLAMA_ERROR` rather than falling back. Ask the user.

If the endpoint is non-loopback and you didn't pass
`--allow-remote-model`, the command exits `REMOTE_DISALLOWED` before
opening any connection. Do **not** add `--allow-remote-model` on
your own initiative — sending customer prose to a non-local model is
a compliance decision the user owns.

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
substrings.** An owner or upstream add is recorded as `registry-owner-add`
with a kind and a count only, never the owner's name: owners can be
customer names, and the log can be read back into an agent transcript.

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

Pre-commit runs `repo-aegis check --staged`. Pre-push reads
ref-update lines on stdin and runs `repo-aegis check --range` per
updated ref (force-pushes use the empty-tree SHA so every commit on
the new branch is scanned).

Both hooks run the CLI **pinned at install time** by absolute path (the
Node executable and the CLI's `dist/index.js`, written into the script by
`install hooks`), not whatever `repo-aegis` or `node` is first on PATH. They
**fail closed**: if a pinned file is gone, the hook exits 1 naming the path and
`repo-aegis install hooks`. There is no environment variable to turn that off;
a person re-runs the installer, for example after moving or upgrading Node.
`install shim` pins the `gh` shim the same way (publishing verbs are refused
with exit 2; other `gh` verbs pass through). See
[`doc/configuration.md`](configuration.md#the-pinned-enforcement-binary).

### Claude Code PostToolUse

Installed by `repo-aegis install claude-md` (or `init --with-claude`).
The settings.json entries run `hook scan-after-write` (and the other
hook subcommands) on the **pinned** node and CLI by absolute path, wrapped
in a one-line `sh` command that exits 2 (a blocking hook error) if either
pinned file is gone, **not** a `repo-aegis` resolved through PATH (a file
named `repo-aegis` in a directory ahead of the real one on the agent's PATH
would otherwise replace the hook that judges every command) and not a shell
script. An older by-name entry is replaced on the next `install claude-md`
(`doctor` reports it as `ENFORCEMENT_UNPINNED` until then); `--uninstall`
removes either form. See
[`doc/configuration.md`](configuration.md#the-pinned-enforcement-binary).

**If every tool call is refused** with `repo-aegis: the pinned enforcement
binary is missing or not usable (…); re-pin it by running: repo-aegis install
claude-md`, the pinned node or CLI has gone (Node upgraded or removed,
repo-aegis reinstalled elsewhere). That refusal is the guard failing closed.
Stop and ask your human to run `repo-aegis install claude-md` from their own
terminal. Do not edit `settings.json`, do not run the CLI by another path, and
do not set `disableAllHooks`. By default the hooks live in a **root-owned managed
drop-in** (`/Library/Application Support/ClaudeCode/managed-settings.d/` on macOS,
`/etc/claude-code/managed-settings.d/` on Linux), which you cannot edit and must
not try to: the refusal text then also names `sudo rm '<that file>'`, a line only
your human runs, and `repo-aegis install claude-md --uninstall`, `repo-aegis
uninstall --yes` and any `sudo` command naming that directory are refused in your
Bash commands (`AGENT_RAN_HUMAN_COMMAND`). With `install claude-md --user-settings`
the hooks are in `settings.json` instead; that file then holds one machine's
absolute paths and must not be synced or symlinked from a repository shared by
other machines, or the same refusal appears there.

The hook fires on every `Write`, `Edit`, and `MultiEdit` tool call.
It reads your tool-result JSON on stdin, extracts the file_path,
and **resolves the destination working tree from that path** (not
from the launcher's `cwd`). It then applies the destination repo's
classification + deny set. Output (always JSON, never literal
markers) flows back into your tool result.

This means cross-repo writes (an agent rooted in repo A writing to a
file in repo B) are scanned against B's rules. As long as A and B are
in the same trust boundary — i.e. share an engagement's `githubOrgs`
or both sit in `personalOrgs` — the write goes through. Crossing
trust boundaries is refused with `CROSS_ORG_WRITE` (see
[Cross-repo writes](#cross-repo-writes)).

It exits 0 silently when:
- stdin is empty / unparseable
- there's no file_path in the payload (you used a tool we don't model)
- the file_path doesn't exist on disk

So a "no marker hit" looks the same to you as "no scan ran". That's
intentional — the hook is invisible to you on the happy path.

### Cross-repo writes

When the file_path lives in a different working tree than the
launcher's `cwd`, the hook's policy layer decides what to do based
on the **trust boundary** of each repo. A trust boundary is the set
of GitHub orgs the repo is associated with:

- **engagement orgs**: `engagements[*].githubOrgs` of every
  engagement the repo is `allow`'d into.
- **personal orgs**: `personalOrgs` from the registry, if the repo's
  class is `public-eligible`.
- **remote fallback**: the parsed org from `git remote get-url
  origin`, but only when the classification supplies no orgs.

Two repos share a trust boundary if their org sets overlap.

| Situation | Hook action |
|---|---|
| Same working tree (regular write) | scan against repo's rules |
| Different working tree, overlapping trust boundary | scan against destination's rules |
| Different working tree, destination unclassified (no class, no engagements, no remote) | scan against `_always`, emit `DEST_UNCLASSIFIED` warning |
| Different working tree, disjoint trust boundaries | refuse with `CROSS_ORG_WRITE` (exit 2) |
| File outside any git working tree (`/tmp/...`) | scan against `_always`-only deny set |

When you see `CROSS_ORG_WRITE`, the file is **already on disk**
(PostToolUse fires after the write succeeds). Surface to the user,
propose reverting the file, do not silently retry. The agent should
**not** widen the trust boundary on its own initiative (e.g. by
adding the destination's org to `personalOrgs` or to an engagement's
`githubOrgs`) — that's a compliance decision.

When you see `DEST_UNCLASSIFIED`, the destination repo has not been
classified. The scan still ran (against `_always`) but you have no
positive evidence the destination is in scope. Suggest to the user
that they classify the destination repo (`repo-aegis classify
--apply` from inside it).

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

## Uninstalling

If the user says "stop using repo-aegis," "remove repo-aegis," or
similar, **do not** manually edit `~/.claude/settings.json`,
`~/.claude/CLAUDE.md`, the workflow file, or per-repo git config. There
is a verb for this: `repo-aegis uninstall`.

Recommended flow:

```sh
repo-aegis uninstall                                # dry-run by default
```

Surface the dry-run plan to the user. Then, with their explicit
confirmation:

```sh
repo-aegis uninstall --yes                          # reverse all install … steps
repo-aegis uninstall --yes --purge-repos            # also unset repo-aegis.* in every classified repo
repo-aegis uninstall --yes --purge-home             # also delete ~/.config/repo-aegis/
repo-aegis uninstall --yes --purge-repos --purge-home   # full reset
```

What the steps do:

- **Always-on:** strips the managed `CLAUDE.md` block, removes
  PostToolUse + SessionStart hook entries from `settings.json`
  (preserving any third-party hooks in the same matcher entry),
  unsets `core.hooksPath` and removes the per-repo pre-commit /
  pre-push files, strips the managed block from `~/.config/git/ignore`,
  and removes the CI workflow file (only if it matches a known
  emitted template — a user-edited workflow is preserved with
  `WORKFLOW_MODIFIED`).
- **The git credential helper** (`install git-credential`): removes exactly
  the helper line and `credential.useHttpPath` that the install recorded in
  its ledger. This step needs a person at a terminal; run by an agent it is
  reported as not done (`GIT_CREDENTIAL_NEEDS_TTY`). Do not edit
  `~/.gitconfig` to remove it yourself.
- **`--purge-repos`:** walks `~/repos`, `~/code`, `~/src`, `~/projects`
  by default (override with `--scan-root <path>`, repeatable), finds
  every git working tree underneath, and unsets `repo-aegis.class` /
  `repo-aegis.engagement` from each. Idempotent.
- **`--purge-home`:** deletes `~/.config/repo-aegis/` (the registry,
  audit log, marker files, deny-set cache, embedding profiles, age
  ciphertext, leak-context flag). Refused if the home path doesn't
  end in `repo-aegis` (anti-fat-finger guard against a
  `REPO_AEGIS_HOME` pointing somewhere unrelated).

If the audit log is enabled, the dry-run report flags
`auditLogPresent: true`. **Suggest backing it up before
`--purge-home`** — it may be a compliance artefact (`repo-aegis
audit-log show > /tmp/audit-backup.jsonl`). Do not propose
`--purge-home` without surfacing this.

`--yes` is the user's explicit confirmation. Don't add it on your own
initiative; surface the dry-run, wait for the user's word.

The npm package itself is removed separately:

```sh
npm uninstall -g @de-otio/repo-aegis
```

`repo-aegis uninstall` doesn't run that for you — it's outside the
CLI's purview.

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

## Publishing (egress): what the guard does and how you recover

Everything above is about *content*. The egress guard is about
*destination*: it sits in the path of every command that publishes —
`git push`, `gh pr|issue|release|repo|api …`, `npm publish` — and decides
`allow`, `ask` (a human is prompted) or `deny` before the command runs.
It reaches you through three doors, and you may meet any of them:

- **Your own pre-command hook** (`repo-aegis hook guard-egress`, registered
  by `install claude-md` on Claude Code; Codex CLI and Gemini CLI have
  equivalents). This one sees your *whole* compound command before it runs,
  so it is where the shape rules live.
- **The git pre-push hook**, which now reads the remote URL git hands it
  (`check --remote-url`). It refuses a cross-org push (`CROSS_ORG_PUSH`)
  and, for a public destination with nobody at a terminal, asks for a
  person (`PUBLIC_PUSH_NEEDS_HUMAN`). On success it prints one line:
  `repo-aegis: pushing <ref> → <org>/<repo> (<visibility>)`.
- **A `gh` shim on `PATH`** (`install shim`), which runs the same decision
  for every publishing `gh` verb and, after `gh pr create|edit --body-file`,
  reads the live body back and reports `PUBLISHED_BODY_MISMATCH` if it is
  not the file you passed.

These rules need no context and always apply. Learn their shapes; they
are the ones you will hit:

| You wrote | Refused as | Write instead |
|---|---|---|
| `git push` (no remote, or no refspec) | `PUSH_IMPLICIT_TARGET` | `git push origin <branch>` — always both |
| `cd /x && … && git push origin main` | `EGRESS_AFTER_CD` | `git -C /x push origin main`, or `gh --repo <org>/<repo> …`, in its **own** tool call |
| `make ; git push origin main` (or `\|\|`, or `&`) | `EGRESS_UNGUARDED_CHAIN` | `make && git push origin main`, or a separate call |
| `gh pr create --body-file "$TMPDIR/pr-body.md"` (or a relative path, or `/var/folders/…`) | `PAYLOAD_MODE_DEPENDENT_PATH` | an absolute, session-unique path in the session scratchpad |
| `gh pr create …` with no `--repo` (and no `GH_REPO` or URL) | `GH_PR_CREATE_IMPLICIT_TARGET` | `gh pr create --repo <owner>/<repo> …`. Without it gh picks the base repository from this checkout's config, which can change between the check and the run. No approval lifts this. |
| `REPO_AEGIS_REGISTRY=… gh …`, `GH_CONFIG_DIR=… git push …`, `env -i …`, `git -c remote.origin.url=… push …` | `EGRESS_ENV_OVERRIDE` | the plain command, with no `REPO_AEGIS_*`, `HOME`, `PATH`, `GIT_*`, `GH_*`, `SRT_*`, `SHELL`, `LD_*` or `DYLD_*` assignment, no `env -i` / `-u`, no `--git-dir` / `--work-tree`, no `git -c remote.* \| url.* \| core.sshCommand \| core.hooksPath` |
| `git remote set-url … && git push …`, `gh repo set-default … && gh issue create …`, `export X=1 && gh …` | `EGRESS_AFTER_STATE_CHANGE` | run the state change as its own call, then the publish alone as the next call, so it is judged against the new state |
| `script -q /dev/null gh issue create …`, or the same under `unbuffer`, `expect`, `tmux`, `screen`, `ssh -t`, an interpreter's `pty` module | `EGRESS_PTY_WRAPPER` | the same command run directly. A wrapper hands the command a terminal, and a terminal reads as a person. If it needs a person, ask your human. |
| `node …/wrapper.mjs gh pr view …`, `python tool.py gh …` (an interpreter whose arguments contain `gh`, for example a script that picks a token and runs `gh` for you) | `UNREGISTERED_OWNER_EGRESS` (an unparsed shape: the guard cannot see the destination or tell a read from a write) | plain `gh … --repo <owner>/<repo>`. The guard recognises `dot gh` in the one form [below](#writing-to-github-through-dot-gh-always---as-bot) and no other wrapper, by design: an agent can edit them. Reads through any other wrapper are refused too. |
| `dot gh pr create --repo <owner>/<repo> …` (or `node …/dot.mjs gh …`) with no `--as bot` first, or `--as owner`, or `--as bot` after a `gh` word | `DOT_GH_WRITE_NEEDS_BOT` | `dot gh --as bot pr create --repo <owner>/<repo> …`, with `--as bot` as the first option. See [below](#writing-to-github-through-dot-gh-always---as-bot). |

One context rule does not fail open, because it is the point of the
guard: **`UNREGISTERED_OWNER_EGRESS`**. See the next section.

The other context rules fail open when the estate cannot answer, and never
block on their own uncertainty: `CROSS_ORG_EGRESS` (the payload's tree or
the pushed repo sits in a trust boundary disjoint from the destination's),
`PAYLOAD_MARKER_HIT` (the body file matches the destination's deny set —
including `selfIdentity` when the destination is customer-coupled), and
`PUBLIC_EGRESS_NEEDS_HUMAN` (public destination, or `merge` / `release` /
`publish` / `repo edit` / `workflow run`, and no person present) — which on a
`gh` verb becomes `SHIM_UNREACHABLE_NEEDS_HUMAN`, an outright refusal, when
the `gh` shim is not first on `PATH` and nothing below the hook could hold
the command.

### Writing to GitHub through `dot gh`: always `--as bot`

Some setups provide `dot gh`, a wrapper that runs `gh` with the token of the right identity for each command and never touches the shared active `gh` account. repo-aegis recognises it in exactly this form:

```
node <path>/scripts/dot.mjs gh [--as <identity>] [--explain] <gh args…>
dot gh [--as <identity>] [--explain] <gh args…>
```

**Every write you make through it carries `--as bot`, as its first option.** A write is anything that creates, changes or deletes something on GitHub: `pr create`, `pr edit`, `pr comment`, `pr review`, `pr close`/`reopen`, `issue …` writes, `release …`, `repo …` writes, `api -X POST|PATCH|PUT|DELETE`, and `api -f`/`-F` (which imply POST).

```
dot gh --as bot pr create --repo <owner>/<repo> --base main --head <branch> --title "…" --body-file <abs path>
dot gh --as bot pr comment 12 --repo <owner>/<repo> --body-file <abs path>
dot gh --as bot api -X POST repos/<owner>/<repo>/pulls/12/requested_reviewers -f "reviewers[]=<login>"
```

Why: without `--as`, `dot gh` chooses the identity from the repository's owner, and for your user's own organisation that is **your user's personal account**. A write as that account is your user publishing, with nobody at the keyboard. As the bot, the write is attributed to an agent, holds only the bot's narrow permissions, and leaves your user's approval meaningful.

- **First option, or it does not count.** `dot gh pr create --as bot …` hands `--as bot` to `gh`, not to `dot gh`; repo-aegis refuses it as a write without the bot.
- **Reads need nothing.** `dot gh --repo <owner>/<repo> pr view 12` picks the right account itself. `--as bot` on a read is fine too.
- **Check before you act:** `dot gh --as bot --explain --repo <owner>/<repo> pr create …` prints the identity and target and runs nothing.
- **Read the receipt.** Every run prints `dot gh: as bot (…) for <owner>/<repo>` on stderr. If it names any other identity on a write, stop.
- **Everything else still applies.** `--as bot` does not lift any other rule: public repositories still need your user's approval, unregistered owners are still refused, markers are still scanned. A refusal there is for your user, not for you to route around.
- **When the bot lacks a permission** (it has no access to issues, secrets, Actions or workflow files), `dot gh` says so. Stop and report it. Never retry as `--as owner`, `--as work` or plain `gh`: that is the accident this rule exists to stop.
- Any other way of running a wrapper (node options, `NODE_OPTIONS`, a different script name, a script path in a variable) is not recognised and stays refused.

### Owners are the user's to register

Rule h refuses a publish, from a shell with no person at it, when the
destination's owner is not registered: not in `personalOrgs`, not in any
engagement's `githubOrgs`, and not an exact `owner/repo` in
`allowedUpstreams` for a PR, issue or comment. The same code,
`UNREGISTERED_OWNER_EGRESS`, comes from the hook, the `gh` shim and the git
pre-push hook. Rules to follow:

- **No approval covers it.** `repo-aegis approve` cannot lift this refusal,
  whatever its scope, and neither can `*`. Do not ask the user for one.
- **You never register an owner or an upstream.** `engagements add
  --personal-org|--github-org`, `upstreams add`, `init --migrate-classify`,
  `init --force` over a populated registry, and any change that would leave
  zero owners are for a person, from a terminal. You do not run them, wrap
  them (`bash -c`, `script`, `tmux`, a heredoc), edit `engagements.yaml`
  yourself, or set `REPO_AEGIS_EGRESS_HUMAN`. Say what was refused, name the
  destination, and give the user the command from the refusal.
- **A write whose owner cannot be named counts as unregistered.** That is a
  GraphQL mutation (`gh api graphql` with a node id), a `gh api` write to an
  endpoint with no owner in the path (`repositories/<id>/…`, `gists`,
  `projects/…`), a target held in a variable (`--repo "$VAR"`,
  `GH_REPO=$X`, `gh pr comment "$URL"`), and an alias or extension the guard
  cannot expand. Name the repository literally: `gh issue comment --repo
  <owner>/<repo> …` or `gh api -X POST repos/<owner>/<repo>/issues …`.
  Otherwise the user runs it.
- **Forks.** A fork's upstream is refused until a person runs `repo-aegis
  upstreams add <owner>/<repo>`; that admits PRs, issues and comments there,
  and nothing else (not `git push`, merge, release, repo or workflow verbs,
  or `gh api` writes). The publish itself then still needs the usual approval.
- **A refusal that says the registry could not be read** means it is
  encrypted or damaged. Tell the user; do not decrypt it yourself.
- Rule h is inert with no registry file, or a registry that declares no
  owners, and each refusal or stderr note says so. `doctor` reports
  `OWNERS_UNDECLARED` and `REGISTRY_UNREADABLE` as failures. Surface them.

**What `*` covers.** A `*` approval no longer matches every owner. It covers
repositories under the user's `personalOrgs`, and commands with no
repository (`npm publish`). It does not cover a customer org, an allowed
upstream or an unregistered owner, and it never covers a GraphQL mutation or
a gist. For a customer's repository the user mints `repo-aegis approve
<org>/*` or `approve <org>/<repo>`. If you are refused with a live `*` in
place, the refusal names it and says why it does not apply; pass that on.

How to recover — the same three moves every time:

1. **Re-issue the command explicitly.** The guard is decision-only: it
   never rewrites your command, and it will not accept a rewrite from you
   that keeps the implicit form. Name the remote and the branch; name the
   repo; give the egress its own call; put the payload in the scratchpad.
2. **If it asked, that is the user's decision, not yours.** Do not retry
   in a different shape to avoid the prompt, do not split the command to
   get under the rule, and never set `REPO_AEGIS_EGRESS_HUMAN`. Tell the
   user what will be published where (the reason names `<org>/<repo>`,
   its visibility and class) and stop until they answer.
3. **Read the receipt.** After a permitted publish you get one line:
   `PUBLISHED → <org>/<repo> (<VISIBILITY>, class <class>): <ref | PR #n>`.
   If that is not the repository you intended, stop *before* the next
   command and say so — a deleted branch still serves its objects by sha,
   so the only remediation is not doing the next thing. Two other lines
   are possible: `EGRESS FAILED → …` (the command did not publish) and
   `EGRESS UNCONFIRMED → …` (the output proves neither way — verify, and
   do not report the work as published until you have).

If `doctor` reports `PUSH_DEFAULT_IMPLICIT`, `CLASS_VISIBILITY_UNRESOLVED`,
`PERSONAL_ORG_UNREGISTERED`, `SHIM_MISSING` / `SHIM_NOT_FIRST` or
`GUARD_HOOK_UNREGISTERED`, the destination-aware rules are partly blind on
this machine. Surface the `fix` line to the user; do not run
`engagements add` or `classify --apply` on your own initiative — which org
is "ours" is a compliance decision the user owns.

## Error codes

Every CLI failure with exit 2 emits a JSON error payload (under
`--json`) of shape:

```json
{ "code": "USAGE", "error": "specify exactly one of …", "details": "…" }
```

Codes you should recognise and act on (refusals from the egress guard and the
owner gates end with `[<CODE>, see doc/agent-guide.md#<code>]`, which points at
the row below):

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
| `OUTSIDE_WORKING_TREE` | `check --path` (CLI invocation, not the hook) resolved a file outside the *named* repo's working tree, even after symlink resolution | the file is genuinely outside any git tree the call was scoped to. Surface to the user; do NOT auto-rerun on a different path. The PostToolUse hook does NOT raise this — it resolves the destination tree from the path automatically. |
| `PATH_NOT_SCANNED` | `check --path` / `repo_aegis_check_path` read nothing: the one file it was asked to scan was skipped (missing, unreadable, binary, or over `--max-file-bytes`), or the directory it was given held no readable file | **this is not a clean result — nothing was scanned.** `error` names the reason. A missing file usually means a wrong path: relative paths resolve against `--cwd` (the repo), not your shell's cwd. Fix the path or the size limit and re-run; never report the file as clean. |
| `PATH_TOO_MANY_FILES` | a directory `--path` holds more files than `--max-files` (default 10000) | **nothing was scanned** — the run refused rather than report a truncated scan. Scan a narrower directory, or pass a higher `--max-files`. |
| `VISIBILITY_UNRESOLVED` | `classify --apply` matched a `personalOrgs` org but could not determine whether the repo is public | the correct class depends on the answer and guessing is unsafe in both directions. Re-run with an account that can see the repo (`GH_TOKEN=$(gh auth token --user <user>) …`), or surface the choice to the user, who sets it with `git config repo-aegis.class <class>`. Do NOT pick one yourself. |
| `CROSS_ORG_WRITE` | PostToolUse hook saw a write whose destination tree's trust boundary does not overlap the launcher's | the file is already on disk. Surface to the user, name the offending path, propose reverting. Do NOT modify `personalOrgs` / `githubOrgs` to widen the boundary; that's a compliance decision the user owns. |
| `DEST_UNCLASSIFIED` (warning, not fatal) | PostToolUse hook scanned a write into a destination repo with no class, no engagements, and no remote it could parse | the scan ran against `_always` only. Suggest the user classify the destination (`cd <dest> && repo-aegis classify --apply`). The hit (if any) is still real; treat it like a normal scan result. |
| `CUSTOMER_COUPLED_NO_ENGAGEMENT` | `check` ran in a `customer-coupled` repo with no engagement set | run `repo-aegis allow <id>` after confirming with the user which engagement(s) the repo references |
| `HOOKS_PATH_CONFLICT` | `install hooks` saw a different `core.hooksPath` already set | tell the user the prior value verbatim; ask if they want to overwrite with `--force` |
| `SETTINGS_PARSE_ERROR` | `~/.claude/settings.json` is not valid JSON | the user has a corrupt settings file; do not auto-fix |
| `RULES_PARSE_ERROR` / `INVALID_RULES` | `classify --rules` YAML parse / validation failed | `details` carries which rules; user fixes the file |
| `WORKFLOW_EXISTS` | `install ci` saw an existing workflow file | the user must explicitly pass `--force` to overwrite |
| `WORKFLOW_MODIFIED` | `install ci --uninstall` saw a workflow file whose body doesn't match any known emitted template | a user-edited workflow; refusing to delete it. Surface to the user with the path so they can review and `rm` manually. |
| `PURGE_HOME_REFUSED` | `uninstall --purge-home` saw a `REPO_AEGIS_HOME` that doesn't end in `repo-aegis` (or resolves to `/`, `$HOME`, etc.) | anti-fat-finger guard. Surface to the user with the resolved path; they either correct `REPO_AEGIS_HOME` or delete manually. Do NOT auto-bypass. |
| `TOKEN_MISSING` | `scan run` could not find the GitHub token env var | the user must export `GH_TOKEN` (or whatever `--token <env-var>` names) |
| `QUERY_VALIDATION` | `scan run`/`validate-queries` rejected a query file | `details` carries the per-query reasons |
| `STATE_PARSE_ERROR` | `scan run` state file is corrupt | the user resolves it manually; do not auto-truncate |
| `ENCRYPT_ERROR` / `DECRYPT_ERROR` | `scan encrypt-query`/`decrypt-query` failed | typically a missing/invalid `age` recipient/identity |
| `FS_ERROR` | generic filesystem write failed | check the permissions in `details`; the user owns this |
| `GIT_CONFIG_ERROR` / `GIT_ERROR` | a git plumbing call failed | `details` carries the underlying git stderr |
| `RENDER_ERROR` | unexpected render failure | unusual; surface to user |
| `REGISTRY_ERROR` | `hook check-write` could not read the registry (it exits 2 and the write is refused; the message names no org) | surface to the user: they run `repo-aegis status` or `doctor` in a terminal to see why |
| `OLLAMA_ERROR` | `suggest-markers` could not reach the Ollama server | the user must `ollama serve` and pull the model; do not retry blindly |
| `REMOTE_DISALLOWED` | Ollama endpoint failed `[SEC H-1]` validation (non-loopback without the matching opt-in flag, bad protocol, user-info, `localhost` resolves to non-loopback). Raised by `suggest-markers` (flag: `--allow-remote-model`) and by `repo-aegis-scan` (flag: `--allow-remote-ollama`). | surface to user; do not auto-add either opt-in flag |
| `BUNDLE_TOO_LARGE` | extracted prose exceeded the model's context budget | `details.bytes` carries the size; the user owns whether to shrink the corpus |
| `BUNDLE_FENCE_COLLISION` | extracted prose contained the chosen fence delimiter | retry happens automatically with a fresh delimiter; surfacing this means the retry also failed |
| `ROOT_CONTAINMENT` | `extractProse` resolved a forbidden ancestor path (`~/.config/repo-aegis`, `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/git`) | a likely symlink-attack indicator; do NOT bypass |
| `PUSH_IMPLICIT_TARGET` | egress guard: `git push` without both `<remote>` and `<refspec>` | re-issue as `git push <remote> <branch>`. The guard never rewrites the command for you; do not ask it to. |
| `EGRESS_AFTER_CD` | egress guard: a publishing command follows a `cd`/`pushd` in the same command line | use `git -C <abs-path>` or `gh --repo <org>/<repo>`, and give the publishing command its own tool call |
| `EGRESS_UNGUARDED_CHAIN` | egress guard: a publishing command is joined to earlier segments with `;`, `\|\|` or `&` | chain with `&&`, or run it as a separate call |
| `PAYLOAD_MODE_DEPENDENT_PATH` | egress guard: a `--body-file` / `-F` / `--notes-file` / `--input` path is relative, expands `$TMPDIR`, or sits under a mode-dependent temp root | write the payload to an absolute, session-unique path in the session scratchpad and pass that |
| <a id="unregistered_owner_egress"></a>`UNREGISTERED_OWNER_EGRESS` | egress guard (rule h), at the hook, the `gh` shim and pre-push: no person present, and the destination's owner is not in `personalOrgs`, not in any engagement's `githubOrgs`, and not an allowed upstream for a PR / issue / comment; or the owner cannot be named offline (GraphQL mutation, opaque `gh api` endpoint, a target in a variable, an alias the guard cannot expand, a push URL that does not resolve); or the registry is encrypted or damaged | **Stop and report it to the user; do not retry, reroute or fix it yourself.** No approval covers it, and `*` does not. If the owner is the user's or a customer's, a **person** runs from a terminal `repo-aegis engagements add --personal-org <owner>` (or `--github-org <owner>` under the engagement). For a fork's upstream, a person runs `repo-aegis upstreams add <owner>/<repo>` (PRs, issues and comments only). If the destination was unresolved, re-issue naming the repository literally (`--repo <owner>/<repo>`, or the `repos/<owner>/<repo>/…` endpoint), or have the user run it. |
| <a id="gh_pr_create_implicit_target"></a>`GH_PR_CREATE_IMPLICIT_TARGET` | egress guard: `gh pr create` from a shell with no person, with no `--repo`, `GH_REPO` or URL | re-issue as `gh pr create --repo <owner>/<repo> …`. No approval covers it; nothing is wrong with the destination, only with how it is named. |
| <a id="dot_gh_write_needs_bot"></a>`DOT_GH_WRITE_NEEDS_BOT` | egress guard, at the hook: a write through `dot gh` with no person present and no leading `--as bot` | **Fix it yourself:** re-issue as `dot gh --as bot <same gh arguments>`, with `--as bot` first. If the bot then lacks the permission, stop and report it; do not switch identity. |
| <a id="egress_env_override"></a>`EGRESS_ENV_OVERRIDE` | egress guard: the publishing command sets an environment variable or option that can point the shim, the pre-push hook, `gh` or `git` at different state (`REPO_AEGIS_*`, `HOME`, `PATH`, `GIT_CONFIG*`, `GIT_SSH*`, `GH_CONFIG_DIR`, `SRT_*`, `SHELL`, `env -i`, `git -c remote.*`, …). Also, whatever the command does: any command that runs `gh`, `git`, `taaad` or `security` with a `REPO_AEGIS_*` variable set (prefix, `env`, `sudo env`, `sh -c`, `eval`, `$(…)`, an earlier `export`), even a read such as `gh pr view` | re-issue without the assignment or option. No approval covers it, and neither does a person at the terminal. Never set these to make a refused command pass; `REPO_AEGIS_EGRESS_HUMAN` is for a person's own shell, never an agent's command text. |
| <a id="egress_after_state_change"></a>`EGRESS_AFTER_STATE_CHANGE` | egress guard: a publishing command follows, in the same command line, a change to state it reads (`git remote`, `git config`, `gh repo set-default`, `gh alias set`, `gh auth`, `export`, a write into `.git/`, `~/.ssh/config`, `~/.gitconfig`) | run the change as its own tool call, then re-issue the publish alone as the next call. No approval covers it. |
| <a id="egress_pty_wrapper"></a>`EGRESS_PTY_WRAPPER` | egress guard: the publish runs under `script`, `unbuffer`, `expect`, `socat`, `ssh -t`, `tmux`, `screen` or an interpreter's pty module, which would give it a terminal that reads as a person. Also, whatever the command does: any `gh`, `git`, `taaad` or `security` command run under such a wrapper, even a read | run the command directly. If it needs a person's go-ahead, ask your human for an approval or an owner registration. No approval covers the wrapper. |
| <a id="gh_auth_needs_human"></a>`GH_AUTH_NEEDS_HUMAN` | agent hook, with no person present: `gh auth` with anything but a plain `status` (`gh auth token`, `login`, `switch`, `status --show-token` / `-t`, …), `gh config set\|clear-cache`, `gh alias set\|import\|delete`, `gh extension install\|upgrade\|exec`, in any shape (`sh -c`, `eval`, `$(…)`, an absolute path, `gh --hostname x auth …`). **Stricter for agents** than before: `gh auth token` alone, with no network call, is refused now. A person at the terminal is not refused. | do not read, switch or reconfigure gh's credentials. Use plain `gh <verb> --repo <owner>/<repo> …`; repo-aegis chooses the identity. If the account setup itself must change, tell your human the exact line to run in their own terminal. No approval covers it. |
| <a id="token_mint_needs_human"></a>`TOKEN_MINT_NEEDS_HUMAN` | agent hook, with no person present: `taaad env\|agent\|credential-helper\|mint`; `security find-generic-password\|find-internet-password\|dump-keychain\|export\|unlock-keychain` (an absolute path counts); a `python*`, `node`, `perl`, `ruby` or `osascript` `-c` / `-e` text or heredoc that mentions `keyring` or `SecItemCopyMatching`. A speed bump, not a proof. A person at the terminal is not refused. | do not mint or read tokens or keychain secrets yourself. Use plain `gh <verb> --repo <owner>/<repo> …`. If a credential must be read or minted, tell your human the exact line to run in their own terminal. No approval covers it. |
| <a id="dot_gh_owner_mapped"></a>`DOT_GH_OWNER_MAPPED` | egress guard, at the hook: a `dot gh` write whose literal owner (`--repo` / `-R` / `GH_REPO`, a URL, a `repos/<owner>/<repo>` endpoint) has an identity mapped in the registry. Decided before `DOT_GH_WRITE_NEEDS_BOT`; with an unmapped owner that rule applies as before. | **Fix it yourself:** re-issue the same arguments to plain `gh` (`gh <the same arguments>`, without `dot`). repo-aegis picks the mapped identity for plain `gh`. No approval covers it, and neither does a person present. |
| <a id="agent_push_needs_app"></a>`AGENT_PUSH_NEEDS_APP` | git pre-push, no person present: the destination owner has an `agent` identity (a GitHub App) and the push URL is SSH (`git@github.com:…`, `ssh://…`, or an `~/.ssh/config` alias for github.com), so it would go out as the person's SSH key | **Fix it yourself:** push over HTTPS, `git push https://github.com/<owner>/<repo>.git <branch>`; the repo-aegis credential helper supplies an App token narrowed to that repository. No approval covers it. |
| <a id="agent_push_credential_config"></a>`AGENT_PUSH_CREDENTIAL_CONFIG` | the git credential helper, with no person present: a credential helper comes from the repository's own config (local, worktree or `-c` scope), `http.proxy`, `http.sslVerify=false`, `http.sslCAInfo`/`sslCAPath`, `http.extraHeader` or `http.sslBackend` is set outside system scope, `GIT_TRACE_CURL`, `GIT_CURL_VERBOSE`, `GIT_TRACE_PACKET`, `GIT_TRACE_REDACT=0`, a `*_PROXY` or `GIT_SSL_*` variable is in the environment, or git passed no `owner/repo` path (`credential.useHttpPath` off). The helper prints `quit=true`; git does not try another helper or prompt | **Do not work around it** (no `-c credential.helper=…`, no proxy, no trace variable): tell your human which setting was named; they fix it. No approval covers it. |
| <a id="agent_push_credential_path"></a>`AGENT_PUSH_CREDENTIAL_PATH` | the git credential helper: one request named two different repositories (or hosts), for example after a repository was renamed | retry the push once; if it repeats, stop and tell your human |
| <a id="agent_credential_direct_fill"></a>`AGENT_CREDENTIAL_DIRECT_FILL` | the git credential helper, with no person present: the request did not come from git's HTTPS remote helper (`git credential fill` run by hand, a direct call) | **Do not run `git credential` yourself.** Use `git push` / `git fetch` over HTTPS; git asks the helper itself. |
| <a id="agent_push_chain_unreadable"></a>`AGENT_PUSH_CHAIN_UNREADABLE` | the git credential helper, with no person present: the process list cannot be read, so a push cannot be told from a fetch and the token's scope cannot be chosen (a sandbox without `ps` does this) | tell your human; run the push from an environment where `ps` works |
| <a id="git_credential_helper_order"></a>`GIT_CREDENTIAL_HELPER_ORDER` | `doctor` (a failure when an owner is mapped to an agent identity) and git pre-push (an agent HTTPS push to such an owner): the repo-aegis credential helper is not the first helper git runs for `https://github.com` (a reset entry, a system-scope helper, or `gh auth setup-git` put another first), so the push was authenticated as the person | tell your human to run `repo-aegis install git-credential` from a terminal |
| <a id="git_credential_needs_tty"></a>`GIT_CREDENTIAL_NEEDS_TTY` | `install git-credential` (also `--uninstall`) with no person at a terminal | ask your human to run it |
| <a id="hook_input_too_large"></a>`HOOK_INPUT_TOO_LARGE` | egress guard: the hook input is larger than 1 MiB, so the command cannot be read whole and is not judged. Write hooks: a Write/Edit payload larger than 1 MiB whose file path is not near its start, so the write cannot be checked (before the write: refused) or the written file was not scanned (after it) | egress: put the large content in a file and pass the file (`--body-file`, `-F`, `--input`, `-d @file`); keep the command itself short. Writes: write the file in smaller parts (a first Write, then Edits); after a "not scanned" notice, tell your human which file you wrote so they can run `repo-aegis check --path <file>`. No approval covers it. |
| <a id="github_api_via_http_client"></a>`GITHUB_API_VIA_HTTP_CLIENT` | egress guard: `curl` or `wget` writing to `api.github.com` or `uploads.github.com` (`-X POST\|PUT\|PATCH\|DELETE`, or a data flag) | use `gh api -X <METHOD> repos/<owner>/<repo>/…` or a `gh` verb with `--repo <owner>/<repo>`, which are checked like any publish. No approval covers it. |
| <a id="gh_auth_token_network"></a>`GH_AUTH_TOKEN_NETWORK` | egress guard: `gh auth token` (or `gh auth status --show-token`) in a command line that also makes a network call (`curl`, `wget`, `nc`, `ssh`, an interpreter, or a `git` subcommand that can reach a remote; local ones such as `git tag` or `git log` do not count) | use `gh api …`, which uses its own credential and is checked. Never put the token in a command. No approval covers it. |
| <a id="agent_ran_human_command"></a>`AGENT_RAN_HUMAN_COMMAND` | agent hook: the command text runs `repo-aegis approve`, `engagements add --personal-org\|--github-org`, `upstreams add`, `identity add\|remove`, `identity require --off`, `engagements set-identity` or `init --migrate-classify\|--force`, or removes the managed drop-in (`install claude-md --uninstall`, `uninstall --yes`) or runs `sudo` (any verb; reading it needs none) on the Claude Code managed-settings directory, in any shape (`bash -c`, a heredoc, `tmux`, an alias, `script`, `expect`), with or without a terminal | stop. These commands are how a person vouches for a publish or an owner. Tell the user what you need and give them the exact line to run in their own terminal. Do not re-word it to get past the hook. A quoted mention next to a repo-aegis word is refused too; re-word the sentence. |
| <a id="agent_detached_session"></a>`AGENT_DETACHED_SESSION` | agent hook: the command starts a detached session (`tmux new -d`, `tmux new-window` / `send-keys`, `screen -dm`, `setsid`, `daemonize`, `nohup … & disown`) | run it in the foreground, or as a plain `nohup <command> &` for a dev server. If a long-lived terminal session is really needed, the user starts it. |
| <a id="identity_change_needs_tty"></a>`IDENTITY_CHANGE_NEEDS_TTY` | `identity add`, `identity remove`, `identity require --off` or `engagements set-identity` (an engagement or `--personal-org`) was run without a person's terminal. These record which GitHub identity acts for an owner. No env var or approval lifts it. | **Ask your human to run the command themselves**, from their own terminal window; the refusal prints it. Do not retry, wrap it in `script` / `tmux`, or edit `engagements.yaml`. The agent hook refuses the command text too (`AGENT_RAN_HUMAN_COMMAND`). |
| `MULTIPLE_INSTALLS` (`engagements set-identity`) | another `repo-aegis` on `PATH` is older than the running one (or its version cannot be read); it would refuse a schemaVersion 3 registry | tell the user to remove or upgrade the other install; do not try to work around it |
| <a id="owner_add_needs_tty"></a>`OWNER_ADD_NEEDS_TTY` | `engagements add --personal-org\|--github-org`, `upstreams add` or `init --migrate-classify` was run without a person's terminal (no TTY on stderr, or an agent host or pty wrapper above the process, or an unreadable process chain). No env var or approval lifts it. | **Ask your human to run the command themselves**, from their own terminal window; the refusal prints it. Do not retry, wrap it in `script` / `tmux`, or edit `engagements.yaml`. |
| <a id="owner_set_empty_needs_tty"></a>`OWNER_SET_EMPTY_NEEDS_TTY` | a change that would leave zero registered owners (`engagements end` / `remove` of the engagement holding the last owner, or `init --force` over a registry that declares anything) was run without a terminal; with no owners rule h switches itself off, so this is the same as registering every owner | ask your human to run it from a terminal. Removing one owner among several needs no terminal. |
| `REGISTRY_WOULD_BE_INVALID` | a registry mutator refused because the result would not load (typically an org registered twice: an org belongs to `personalOrgs` or to exactly one engagement) | nothing was written. Surface it; run `repo-aegis doctor` once the registry loads. Do not edit the file to force it. |
| `MIGRATION_NOT_CONFIRMED` | `init --migrate-classify` listed the owners it would register and did not get a typed `y` on a stdin terminal | nothing was written. A person re-runs it at a terminal and answers `y` after reading the list. |
| `APPROVE_NEEDS_TTY` | `repo-aegis approve` was run without a person's terminal | ask the user to run the `approve` line themselves; never set `REPO_AEGIS_EGRESS_HUMAN` or wrap it. |
| `CROSS_ORG_EGRESS` / `CROSS_ORG_PUSH` | egress guard: the pushed repo (or the payload's tree) belongs to a trust boundary disjoint from the destination's | this is the boundary both incidents crossed. Stop; name the destination to the user. Do NOT widen `personalOrgs` / `githubOrgs` to make it pass. |
| `PAYLOAD_MARKER_HIT` | egress guard: the body file matches the destination's deny set (`selfIdentity` included for a customer-coupled destination) | run `repo-aegis check --path <file>` from the destination repo to see which stems (never `--verbose` from a hook); redact; re-run. The reason carries a hit count only. |
| `PUBLIC_EGRESS_NEEDS_HUMAN` / `PUBLIC_PUSH_NEEDS_HUMAN` | egress guard: public destination, or `merge` / `release` / `publish` / `repo edit` / `workflow run`, and no human present | on Claude Code this arrives as a permission prompt — the user's decision. Elsewhere: tell the user what would be published where and stop. Never set `REPO_AEGIS_EGRESS_HUMAN`; never re-shape the command to dodge the rule. |
| `SHIM_UNREACHABLE_NEEDS_HUMAN` | egress guard: the same condition as above on a `gh` verb, in a shell where the `gh` shim is **not** the first `gh` on `PATH` — so no layer below the hook could hold the command if the prompt went unanswered | a refusal, not a prompt. Ask the user for `repo-aegis approve <org>/<repo>` from a terminal and re-issue the identical command; or tell them the agent was started from a shell that predates `repo-aegis install shim` (`repo-aegis doctor` reports `SHIM_NOT_FIRST` there). Never set `REPO_AEGIS_EGRESS_HUMAN`; never edit `PATH` to make this pass. |
| `PUBLISHED_BODY_MISMATCH` | `gh` shim read-back: the live PR body differs from the file that was passed (byte counts in `details`, never content) | the wrong document is published. Surface immediately; propose `gh pr edit --body-file <right file>` for the user to run; do not guess which file was meant. |
| `READBACK_UNAVAILABLE` (warning) | the read-back could not run (no PR identified, `gh` failed, timeout) | the publish itself succeeded; tell the user the body was not verified and offer to view it |
| `SHIM_PATH_OCCUPIED` | `install shim` found a file at `<home>/bin/gh` that repo-aegis did not write | surface the path; the user decides on `--force` |
| `PUSH_DEFAULT_IMPLICIT` (`doctor`) | global `push.default` is unset or not `nothing` | suggest `git config --global push.default nothing` — one line, every shell, every agent |
| `CLASS_VISIBILITY_UNRESOLVED` (`doctor`) | a repo with a GitHub remote has no explicit class or no cached visibility, so the destination rules are blind there | suggest `repo-aegis classify --apply && repo-aegis status` in that repo; do not run it yourself (see `VISIBILITY_UNRESOLVED`) |
| `PERSONAL_ORG_UNREGISTERED` (`doctor`) | the repo's remote org is in no engagement and not in `personalOrgs` | surface the `fix` line; which org is "ours" is the user's compliance decision |
| `MARKERS_WRITE_PROTECTED` (`render`) | the rendered markers directory is write-protected (the `install claude-md` Edit deny rules reach the sandbox) | tell the user to run `repo-aegis render` from their own terminal. Do not retry or look for another way to write the markers; editing them would silently drop customer markers. |
| `OWNER_IDENTITY_UNMAPPED` (`doctor`, a warning; a failure when the registry sets `requireIdentity`) | a registered owner has no GitHub identity entry | surface the `fix` line. `identity add`, `identity remove`, `identity require --off` and `engagements set-identity` are human-only: give the user the exact line, never run them yourself. |
| `REGISTRY_UNREADABLE` / `OWNERS_UNDECLARED` (`doctor`, failures) | the registry is encrypted or does not parse, so rule h refuses every non-interactive egress with a destination; or it loads with no owners, so rule h is inert | surface the `fix` line. Never run an owner add or `registry decrypt` yourself: both need a person at a terminal. |
| `GH_LOGIN_UNREGISTERED` / `GH_MEMBER_ORG_UNREGISTERED` / `REGISTERED_ORG_NOT_MEMBER` (`doctor`) | a logged-in `gh` account, or an organisation it belongs to, is not a registered owner (or, for the info check, a registered owner matches no account) | surface the `fix` line (it names the owners; the summary line does not). Which owners are "ours" is the user's decision, and only a person at a terminal can add one. `SKIP` means `gh` was absent or logged out, not that all is well. |
| `REGISTRY_AGENT_WRITABLE` / `GH_BINARY_UNTRUSTED` / `GH_CONFIG_REDIRECT` / `PREPUSH_HOOK_MISSING` / `SHELL_STARTUP_OVERRIDES` / `SSH_GITHUB_REDIRECT` (`doctor`, warnings and info) | no `permissions.deny` Edit rule for the registry, approvals, hooks, shim and rendered-markers paths; the `gh` first on `PATH` is in an agent-writable or non-standard place; the guard hook is registered but the global `core.hooksPath` is not the repo-aegis hooks directory; a shell startup file exports `GH_REPO`, `GH_HOST`, `GIT_SSH_COMMAND`, `SRT_*` or `REPO_AEGIS_*`; `Host github.com` in the ssh config points elsewhere or is proxied | suggest the `fix` line (`install claude-md` / `install hooks` / remove the export). Never print a startup file's value. |
| `ENFORCEMENT_UNPINNED` / `ENFORCEMENT_PIN_MISSING` (`doctor`, failures) | an installed git hook, the `gh` shim or a Claude Code hook command in `settings.json` still calls `repo-aegis` by name (written before the pin existed), so a `repo-aegis` or `node` first on `PATH` decides what enforces; or a pinned node or CLI path no longer exists (Node moved or upgraded, install removed), so that git hook exits 1, that shim refuses publishing verbs, and a Claude Code hook exits 2 on every matching tool call | surface the `fix` line (`repo-aegis install hooks`, `install shim` and/or `install claude-md`). A person at a terminal normally runs it; never look for another way to make a hook pass |
| `MULTIPLE_INSTALLS` (`doctor`, warning) | more than one `repo-aegis` is reachable on `PATH` (listed with each version), or the first one is not the pinned one, so a terminal and an agent's shell can run different versions | surface the list; the user keeps one install, removes the rest, then re-runs `install hooks` and `install shim` so the pin follows it. Doctor never runs the candidates; versions come from `package.json` |
| `PIN_PATH_UNSUPPORTED` (`install hooks`, `install shim`, `install claude-md`) | the Node or CLI path contains a newline or NUL, which cannot be written into the generated script | tell the user to install at an ordinary path; there is no override |
| `MANAGED_DROPIN_STALE` / `MANAGED_DROPIN_NOT_ROOT_OWNED` / `MANAGED_DROPIN_UNREADABLE` (`doctor`, failures) | the managed drop-in differs from what `install claude-md` would write now (moved Node or CLI, a new release, an edit); it or a directory above it is owned by a user, writable by group or others, or a symlink (so an agent could edit what enforces); it is not `0644` / its directories not `0755` (Claude Code starts without a source it cannot read) | surface the `fix` line. A person runs `repo-aegis install claude-md` from their own terminal (sudo asks for their password). Never try to change the file or its directories yourself |
| `MANAGED_DROPIN_ORPHANED` / `MANAGED_DROPIN_LEDGER_STALE` (`doctor`, failures) | the drop-in exists but the ledger has no entry for it or its pin points at missing files (every hook then blocks with exit 2); or the ledger names a drop-in that is gone (removed by hand) | tell the user to re-run `repo-aegis install claude-md`, or to remove it themselves with the `sudo rm '<path>'` line in the `fix`; for a stale ledger entry `repo-aegis install claude-md --uninstall` clears it. You do not run `sudo` |
| `MANAGED_HOOKS_DISABLED` / `MANAGED_SOURCE_SHADOWED` / `MANAGED_HOOKS_NOT_FIRING` (`doctor`, failures) | another managed file sets `disableAllHooks: true`; a macOS configuration profile for Claude Code outranks the managed files; or a Claude Code session started after the last drop-in heartbeat, so Claude Code is not loading the drop-in at all (a server-managed policy or an MDM key makes it ignore file drop-ins, and nothing local shows that) | enforcement through Claude Code hooks is not active. Tell the user plainly, and that `/status` in Claude Code should list `(drop-ins)`; do not work around it |
| `SUDO_NOPASSWD` / `ENFORCEMENT_IN_USER_SETTINGS` (`doctor`, warnings) | `sudo` runs without a password, so the drop-in is no stronger than the user settings file; the hooks are in `~/.claude/settings.json` (written with `--user-settings`, or before the drop-in existed), which must stay per machine | surface the `fix` line; `repo-aegis install claude-md` moves the hooks into the drop-in |
| `MANAGED_NEEDS_TTY` / `MANAGED_NOT_CONFIRMED` / `PRIVILEGED_TOOL_UNSAFE` / `SYSTEM_DIR_UNSAFE` / `DROPIN_INVALID` (`install claude-md`) | the drop-in is written (or removed) as root and needs a person at a terminal who types `y`; `sudo` or a tool it would run, or the system directory or a parent, is not root-owned/safe; the rendered drop-in failed validation (for example a path with a newline) | tell the user to run the command in their own terminal; for the two safety refusals the output says what is wrong and offers `--user-settings`. There is no flag that skips any of them |
| `SHIM_MISSING` / `SHIM_NOT_FIRST` / `SHIM_STALE` / `GUARD_HOOK_UNREGISTERED` (`doctor`) | the `gh` shim is absent, shadowed on `PATH`, or left over from an earlier release; the guard hook is not in `settings.json` | suggest `repo-aegis install shim` / fixing `PATH` order / `repo-aegis install claude-md`. A shadowed shim is also why a `gh` verb can be refused with `SHIM_UNREACHABLE_NEEDS_HUMAN`. |

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
- `PUBLISHED_SECRET_SHAPE` — `audit --published` found a universal
  secret shape (PEM private-key header, its hex form, a JWT, a forge
  token) in the archive. Reports kind, path and count, never the
  matched bytes. Treat as a stop-the-publish finding: the credential is
  about to become world-readable and effectively unrecallable. Fix by
  removing the file from the package (`files` / `.npmignore`) or
  rotating the credential — `--no-secret-scan` suppresses the check and
  is only right when the string is genuinely an example.
- `PUBLISHED_EMPTY_DENY_SET` — **informational**, does not fail the
  check. `audit --published` ran with a zero-pattern deny set, so
  archive contents were not matched against any engagement marker. This
  is normal on CI (the registry is machine-local by design) and is
  reported so a vacuous scan cannot be mistaken for a clean one. Do NOT
  "fix" it with `--min-patterns`: an empty deny set is correct there,
  and a floor would fail every publish. It is only worth investigating
  if you see it on a developer machine, where a registry is expected.
- `DENY_SET_BELOW_FLOOR` — `check`/`audit` ran with a `--min-patterns`
  floor (or `--require-deny-set`, or `REPO_AEGIS_MIN_PATTERNS`) and the
  computed deny set was smaller. Exit 2. This is **not** a clean scan and
  must never be reported as one: it almost always means the engagement
  registry was not available, so nothing was scanned. Diagnose the
  registry — `repo-aegis status --json` shows `denySet.patternCount` —
  and do NOT "fix" it by lowering or removing the floor.

Generic codes you should ignore in favour of recovery:
- `error` (no `code` field) — fatal but not categorised; surface to the user.

## Centralised sweep (`repo-aegis-scan`) and Phase 3 semantic mode

The `repo-aegis-scan` binary is a *separate* tool from the developer
gate: it runs in CI / cron / on a scheduled job server, sweeps GitHub
code-search for marker hits across orgs, and reports findings as
JSON / markdown / GitHub issues.

Phase 3 adds two opt-in extensions:

- `repo-aegis-scan rebuild-profiles` — for each engagement with
  `reposActive`, walks the first available repo, embeds its
  representative prose via Ollama, and writes
  `~/.config/repo-aegis/profiles/<engagement-id>.json` (chmod 0600,
  schema-versioned, sha256-stamped manifest).
  - `--diff` re-hashes the current reference docs and reports drift
    against the stored manifest *without* embedding or writing.
    Surface the diff to the user before agreeing to rebuild
    (`[SEC H-3]` defends against silent reference-document
    manipulation).
  - `--engagement <id>...` restricts to specific engagements.
- `repo-aegis-scan run --semantic` — after the regex sweep, fetches
  each new candidate's blob, embeds it, scores it against every
  profile, and reports engagements over the per-profile threshold.
  Best-effort: Ollama failures increment a counter (`embedErrors`)
  but never abort the regex sweep.

Output gains a `semantic` JSON section / "Semantic hits" markdown
table with columns: engagement, similarity, threshold, candidate
URL. **Never** the candidate's text or the profile's reference
content — only the scalar similarity and the URL.

If you're running this from an agent context:

- `--allow-remote-ollama` is gated behind the same `[SEC H-1]`
  validation as Phase 2; do not auto-set it.
- The semantic sweep is *advisory*. Treat it as a triage signal,
  not a block. A semantic hit without a regex hit means "this file
  looks semantically like customer X's content but didn't match a
  literal marker" — possibly a real leak, possibly a false positive
  on technical similarity.

## Environment variables

| Var | Effect | Notes |
|---|---|---|
| `REPO_AEGIS_HOME` | Override `~/.config/repo-aegis` as the config home | Stderr warning printed on every TTY invocation when set; suppressed in hook context. |
| `REPO_AEGIS_REGISTRY` | Override the registry path independently from home | Set by the `--registry-path` global flag. |
| `REPO_AEGIS_ACCEPT_ORG_SEED_TRANSFER` | Equivalent to passing `--accept-cross-border` to `audit --org` | The user must set this themselves; do not auto-set. |
| `REPO_AEGIS_EGRESS_HUMAN` | Declares that a human is present for one publishing command (`=1`), satisfying the egress guard's "needs a person" rule where no TTY is on stderr | **Human-only, by contract.** Never set it, never suggest setting it, never wrap a command in it. Setting it from an agent is a visible act in the transcript and defeats the one control that exists for exactly that case. If a publish needs a person, say so and stop. |
| `REPO_AEGIS_WAIVE_NONINTERACTIVE` | The equivalent escape for `repo-aegis waive` | Same contract: human-only. |

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
| `status` | repo class + allowed engagements | `repo`, `allowedEngagements`, `denySet`, `alwaysBlock`, `regexBackend`, `warnings` |
| `check --staged` | scan staged diff | `mode`, `hits`, `skipped`, `repo`, `denySet`, `advisory`, `warnings` |
| `check --path <f\|dir>` | scan one file, or a directory tree | (same; a directory adds `filesScanned`, `skippedDirs`) |
| `check --range <r>` | scan commit range | (same) |
| `check --history` | scan full git log | (same; `historyHits` populated) |
| `render` | regenerate marker files | `RenderResult` |
| `engagements list` | list engagements | `engagements`, `alwaysBlock` |
| `engagements add [id]` | add new engagement (id optional with `--github-org` / `--personal-org`; those two flags register an owner and are **for a person at a terminal**) | `action`, `id`, `name`, `markers`, `rendered`, `githubOrgs`, `personalOrgs` |
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
| `install claude-md` | install Claude hooks: the root-owned managed drop-in (default), or `settings.json` with `--user-settings` | `action`, `mode` (`managed`/`user-settings`), `claudeHome`, `claudeMd`, then `managed` (`path`, `uid`, `platform`, `digest`, `bytes`, `installed`, `unchanged`, `createdDirs`) and `migration` (managed), or `hookCommand`, `settings` (user-settings); `note?` when it fell back to the user file; `--dry-run` adds `managed.contents` |
| `install gitignore` | append global gitignore | `action`, `path`, `appended` |
| `install ci` | emit GHA workflow | (printed to stdout, not JSON) |
| `hook scan-after-write` | (PostToolUse entry) | same as `check --path` |
| `hook first-touch` | (SessionStart entry) classify previously-unclassified repo | `status` (`already-classified`/`applied`/`needs-confirmation`/`skipped`), redacted `details` |
| `suggest-markers --engagement <id> [--auto-accept-above <n>\|--dry-run]` | LLM-assisted marker discovery (Phase 2) | `action`, `engagement`, `candidates`, `accepted` (when persisting), `dryRun?`, `review?`, `identityRejected?`, `skippedDuplicates?`, `rendered?` |
| `init --migrate-classify` | port legacy `classify.yml` to registry | `action`, `migrated`, `personalOrgs`, `engagements` |
| `audit-log on` | enable compliance trail | `action`, `wasOn`, `isOn`, `path` |
| `audit-log off` | disable compliance trail | `action`, `wasOn`, `isOn`, `path` |
| `audit-log show [--all]` | print recorded events | `action`, `path`, `enabled`, `total`, `shown`, `records` |
| `audit-log path` | print log file path | `action`, `path`, `enabled`, `exists` |
| `install hooks --uninstall` | reverse `install hooks` | `action`, `hooksDir`, `removed`, `coreHooksPathUnset`, `previousCoreHooksPath` |
| `install gitignore --uninstall` | strip managed block | `action`, `target`, `removed`, `reason?` |
| `install claude-md --uninstall` | remove the managed drop-in (terminal, sudo), strip managed block + hook entries | `action`, `claudeMd`, `managed` (`path`, `removed`, `dirsRemoved`, `ledgerRemoved`), `settings` |
| `install ci --uninstall` | remove the workflow file | `action`, `target`, `removed`, `absent?` |
| `install shim [gh]` | write the `gh` egress shim to `<home>/bin` | `action`, `path`, `changed`, `tool`, `binDir`, `pathInstruction`, `reason?` |
| `install shim --uninstall` | remove the shim (never a file repo-aegis did not write) | `action`, `path`, `changed`, `reason?` |
| `upstreams add <owner>/<repo>` | allow PRs, issues and comments to a fork's upstream (**person at a terminal only**) | `action`, `upstream`, `added` |
| `upstreams remove <owner>/<repo>` / `upstreams list` | tighten / read; no terminal needed | `action`, `upstream`, `removed` / `action`, `upstreams` |
| `approve <org>/<repo>\|<org>/*\|*` | mint a time-limited approval for rule g (**person at a terminal only**); `--list` / `--revoke` need no terminal | `action`, `approval`, `warnings?` |
| `egress-check -- <gh args…>` | decide a `gh` publish (exit 0 allow / 2 deny) | `action`, `destination?`, `readback?`; deny reason on stderr |
| `egress-readback --body-file <f> --pr <ref>` | diff the live PR body against the file | `ok`, `bytes` / `PUBLISHED_BODY_MISMATCH` with byte counts / `READBACK_UNAVAILABLE` |
| `hook guard-egress [--agent <a>]` | (PreToolUse(Bash) entry) allow / ask / deny a publishing command | `hookSpecificOutput.permissionDecision` (+ reason); deny payload on stderr |
| `hook egress-receipt` | (PostToolUse(Bash) entry) one `PUBLISHED →` / `EGRESS FAILED →` / `EGRESS UNCONFIRMED →` line per publishing operation | `hookSpecificOutput.additionalContext` |
| `doctor` | hook liveness + egress-guard preconditions | `action`, `dryRun`, `roots`, `machine`, `results[].checks`, `summary` |
| `scan-env --self [--accept self-identity]` | offer / record `selfIdentity` candidates | `action`, `dryRun`\|`placement`, `candidates`\|`added`, `skippedDuplicates`, `tooShort` |
| `uninstall` (top-level) | reverse all install steps (hooks, gitignore, claude-md, ci, shim); opt-in flags purge home + per-repo config | `action`, `dryRun`, `steps`, `purgeRepos?`, `purgeHome?` |
| `uninstall sweep-repos` | walk roots, unset `repo-aegis.*` git config | `action`, `dryRun`, `roots`, `results` |

Always pass `--json` when you want machine-readable output. Without
it, output is tuned for a human at a terminal.

## Reference

- Tool home page: https://github.com/de-otio/repo-aegis
- Design: [doc/design/README.md](design/README.md)
- CLI reference: [doc/cli-reference.md](cli-reference.md)
