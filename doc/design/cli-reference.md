# repo-aegis — CLI reference

> Every subcommand's flags, behaviour, exit codes, and JSON shape.
> The flag set is contract-tested in
> [`packages/cli/src/program.test.ts`](../../packages/cli/src/program.test.ts);
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
};
```

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
| `--history` | — | scan full git history with `git log -G <pattern>` per pattern |
| `--since <revspec>` | — | with `--history`: lower-bound revspec |
| `--max-file-bytes <n>` | 1048576 (1 MiB) | per-file size cap; larger files reported as `skipped: too-large` |
| `--ignore-allowlist-comments` | off | do not respect `repo-aegis: allow` comments (audit-grade strict) |
| `--verbose` | off | reveal literal matched markers (NEVER pass from hooks) |

Behaviour:
1. Validate exactly one of `--staged`/`--path`/`--range`/`--history`
   is given. Else exit 2.
2. Read repo config; compute deny set.
3. **Fail-closed**: if class = `customer-coupled` and engagements is
   empty → exit 2 with the "must declare engagement" error.
4. Empty deny set → exit 0 with `{ "hits": [], "status": "no-deny-set" }`.
5. Scan per the chosen mode. Filter binary/oversize per
   `SkippedFile` reason.
6. Hits printed redacted (position + engagement; never literal).
7. `scratch` class → exit 0 even with hits (advisory).
8. Otherwise exit 1 if any hits.

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

Writes `pre-commit` and `pre-push` to
`~/.config/repo-aegis/hooks/` and points `core.hooksPath` of the
current repo at that directory.

| Flag | Default | Meaning |
|---|---|---|
| `--force` | off | overwrite a conflicting `core.hooksPath` |
| `--uninstall` | off | unset `core.hooksPath` and remove pre-commit/pre-push |

Conflict resolution: if `core.hooksPath` is already set to a
*different* path, the install refuses without `--force` and prints
the prior value verbatim so the user can save it before replacing.

### `repo-aegis install gitignore`

Appends a managed block of recommended secret-file patterns to
`~/.config/git/ignore`. Idempotent (markers between `# repo-aegis:
managed block` and `# repo-aegis: end managed block`).

| Flag | Default | Meaning |
|---|---|---|
| `--gitignore-path <path>` | `~/.config/git/ignore` | target file |
| `--uninstall` | off | strip the managed block |

### `repo-aegis install ci`

Emits (or `--write`s) `.github/workflows/leak-scan.yml`. The workflow
runs `repo-aegis audit --json` once per repo (single subprocess —
not N marker scans).

| Flag | Default | Meaning |
|---|---|---|
| `--write` | off | write to disk instead of printing |
| `--force` | off | overwrite an existing workflow file |

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
| `--org <org>` | — | run a one-shot GitHub code-search sweep against this org (needs token) |
| `--published <pkg-or-tarball>` | — | scan a packed npm tarball, VSIX bundle, or npm package name |
| `--token <env-var>` | `GH_TOKEN` | env var holding the GitHub token for `--org` |
| `--max-queries <n>` | 30 | cap on `--org` seed-derived queries per run |
| `--accept-cross-border` | off | consent to sending `--org` seed substrings to GitHub |
| `--verbose` | off | reveal literal matches (NEVER from hooks) |

Each check returns:
```ts
{
  name: string;
  ok: boolean;
  findings: { message: string; detail?: unknown }[];
  skipped?: boolean;
  skipReason?: string;
}
```

`audit` exit code: 1 if any check fails, 2 on usage error, 0 if
clean.

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
