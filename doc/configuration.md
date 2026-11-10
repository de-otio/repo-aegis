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

## The operator's own identity (`selfIdentity`)

`privateInfra:` in the registry holds this machine's private
infrastructure — internal registry hosts, internal domains — and is
enforced **only in public-facing repos**, because those hosts are
legitimate (often required) in a private one. `selfIdentity:` is its
mirror image, enforced **only in `customer-coupled` repos**:

```yaml
# ~/.config/repo-aegis/engagements.yaml
selfIdentity:
  - example-org
  - internal-project-codename
  - claude\.ai/code/session_
```

It holds the operator's **own** names — the GitHub orgs they own, their
project and package names, internal project codenames, internal
hostnames, and the agent session-link shape.

**Why the gate points the other way.** Engagement markers stop a
*customer's* strings entering *our* repos. `selfIdentity` stops *our*
strings entering a *customer's* repo — a PR body naming our internal
codename, a fixture carrying our npm scope, an agent session URL pasted
into a commit message. Outside a customer repo these strings are not
merely harmless but load-bearing: our own org name is in the remote URL
of every repo we own, so enforcing it anywhere else would fire
constantly in exactly the places it belongs. Hence `public-eligible`,
`private-strict` and `scratch` never load the list.

**Where it applies.** Two places, both from the same gate:

- a repo whose class is `customer-coupled`, on every path `check` and
  the hooks already cover; and
- via the egress guard, an egress **destination** that resolves to a
  `customer-coupled` repo — so a PR body or release note is scanned
  against the destination's rules before it is published, not against
  the rules of the tree it was written in.

**Rendered to a reserved stem, and excluded from `markers.txt`.** The
patterns become `markers/_self_identity.txt`, never per-engagement
files, and — like `_private_infra` — are deliberately **absent from the
flat `markers.txt` union**. That file exists for consumers with no
notion of repo class; handing it a class-gated set would enforce it
everywhere, which for this list means blocking the operator's own name
in every repo the operator owns.

Like every non-`_always` stem, `_self_identity` is never path-exempt
(`alwaysBlockExemptPaths` does not reach it — our project name in a
fixture we hand to a customer is still our name in their repository),
never waivable, and never named in `--redact-attribution` output.

**Populating it — `scan-env --self`.** The same discovery-then-offer
discipline as the host scan, dry-run by default:

```sh
repo-aegis scan-env --self                      # show candidates, write nothing
repo-aegis scan-env --self --from ~/code        # scan a different tree
repo-aegis scan-env --self --accept self-identity   # record them
```

Candidates come from three places: every org in the registry's
`personalOrgs`, the `name` of every `package.json` under `--from`
(default: the current directory, `node_modules` skipped — a
dependency's name is somebody else's identity), and the built-in agent
session-link shape. A scoped package name yields both halves:
`@example-scope/toolkit` offers `example-scope` and `toolkit`. Names
shorter than six characters are reported and dropped rather than
recorded, for the reason short markers are always dropped — a four-
character literal matched case-insensitively as a substring would
flood unrelated content. `--accept` takes `self-identity` and nothing
else here; the host placements (`private-infra`, `always-block`,
`engagement`) are a usage error together with `--self`.

`selfIdentity` is optional and additive, and needs **no
`schemaVersion` bump** — see the compatibility note at the end of this
document.

## Registry schema version 3: GitHub identities per owner

Schema version 3 records **which GitHub identity belongs to which owner**
(`doc/plan-owner-identity.md`). The `gh` shim uses it: for an owner with an entry, the
call runs as the identity the registry names, in the column that who is present selects
(see "Identities in practice" below). Owners with no entry are unchanged.

```yaml
# ~/.config/repo-aegis/engagements.yaml
schemaVersion: 3
identities:
  me:        { kind: gh-login,   login: alice }
  me-bot:    { kind: github-app, app: example-bot }      # a GitHub App slug
  work:      { kind: gh-login,   login: alice-work }
  work-bot:  { kind: github-app, app: example-work-agent }
requireIdentity: true
personalOrgs:
  - example-org                                 # a plain string: unmapped, as in version 2
  - { name: other-org, person: me, agent: me-bot }
engagements:
  - id: customer-a
    name: Customer A
    markers: [customer-a-marker]
    githubOrgs: [customer-a-org]
    person: work                                # applies to every org of the engagement
    agent: work-bot
```

- **`identities`** maps a name to `{ kind: gh-login, login }` (a person's
  `gh` account) or `{ kind: github-app, app }` (a GitHub App slug).
- **`person`** (who acts when a person is at the keyboard) must name a
  `gh-login` identity; **`agent`** (who acts when none is) must name a
  `github-app` identity. A `personalOrgs` entry is a plain string or
  `{ name, person?, agent? }`; an engagement may carry `person` / `agent`,
  which apply to all its `githubOrgs`.
- **`requireIdentity`** is set to `true` by the first `engagements
  set-identity` and cleared by `identity require --off` (a person, at a
  terminal). `identity require --on` sets it again; it only tightens, so it
  needs no terminal and an agent may run it. It makes
  `doctor` report `OWNER_IDENTITY_UNMAPPED` as a failure instead of a warning,
  and an agent's write to a registered owner with no identity entry is refused
  (`GH_IDENTITY_UNMAPPED_OWNER`). An owner with only a `person` identity is not
  affected: it is mapped.
- **Shapes** (fail closed): an identity name and an app slug match
  `^[a-z0-9][a-z0-9-]{0,62}$`; a login matches
  `^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:_[A-Za-z0-9]{1,20})?$` (the optional `_shortcode` is the Enterprise Managed User form `handle_shortcode`). None may start with `-` or `_`, so a value
  can never be read as an option later.
- **Validation** is at parse time and names the path: every reference
  resolves, the kinds match the column, an unknown key inside `identities` or a
  `personalOrgs` object is an error, and an owner still appears in only one
  place (the duplicate and personal/engagement disjointness rules apply to
  object entries too). Identity names are checked on the raw YAML keys, so a
  `__proto__` key is an error.
- **Typos are errors from version 3.** An engagement may carry only `id`,
  `name`, `started`, `ended`, `reposActive`, `markers`, `notes`, `githubOrgs`,
  `person` and `agent`. A top-level key within edit distance 2 of a known one
  (`identites`, `requireIdentiy`) is rejected; other unknown top-level keys
  are still passed through, as in every version. Below version 3 nothing new
  is rejected.
- **Version gate.** `identities`, an object-form `personalOrgs` entry, an
  engagement's `person` / `agent` and `requireIdentity` need
  `schemaVersion: 3`; with a lower version the registry is rejected, naming
  the version. A build that predates version 3 refuses the file as newer than
  it supports: rule h then refuses every non-interactive egress, and an older
  pinned `hook check-write` exits 1, which Claude Code treats as non-blocking,
  so the cross-org write check **fails open** on that install. Upgrade every
  install first. Every command that raises the version (the first `identity
  add`) checks for that and refuses (`MULTIPLE_INSTALLS`) while a `repo-aegis`
  on `PATH`, or one that an installed git hook, the `gh` shim or a Claude Code
  hook (the managed drop-in or `settings.json`: the pin that runs `hook
  check-write`) is pinned to, cannot read version 3. "Cannot read" is judged by the supported version
  read from that install's own core package, never by running it; if that is
  unreadable the package version is compared, and an install whose version is
  unreadable is refused.
- **Written only on adoption.** The file stays at its version until the first
  identity is defined (`identity add`) or mapped. It is never lowered.
- **Parsed shape.** `Registry.personalOrgs` stays a list of names. The
  mapping is a separate `identityMap` keyed by lower-cased owner, so every
  existing consumer reads what it always read.

Changing any of this is an owner-registry change: a person at a terminal
runs `repo-aegis identity add|remove|require --off` or `repo-aegis engagements
set-identity` (a personal org is `engagements set-identity --personal-org <org>`) (`IDENTITY_CHANGE_NEEDS_TTY`), and the agent hook refuses the
command text (`AGENT_RAN_HUMAN_COMMAND`). See
[cli-reference.md](cli-reference.md#identities-schema-version-3).

### Setting up identities (a walkthrough)

All of this is run by a person, from their own terminal. Agents cannot run it.

1. **Upgrade every install, then run `repo-aegis install shim`** (and keep its `bin` directory
   first on `PATH`). `doctor` should show no `SHIM_STALE` and no `GH_BINARY_UNTRUSTED`.
2. **Define identities.** One `gh-login` per GitHub account you are logged into with `gh`, and one
   `github-app` per App that taaad holds (`taaad apps list`):

   ```sh
   repo-aegis identity add me --gh-login alice
   repo-aegis identity add me-bot --app example-bot
   ```
3. **Map each registered owner.** A personal org takes `--personal-org`; an engagement maps all
   its `githubOrgs` at once (`repo-aegis status` lists the ids):

   ```sh
   repo-aegis engagements set-identity --personal-org example-org --person me --agent me-bot
   repo-aegis engagements set-identity customer-a --person work
   ```

   **The first `set-identity` turns `requireIdentity` on.** From then on an agent's write to a
   registered owner with no mapping at all is refused (`GH_IDENTITY_UNMAPPED_OWNER`). Map every
   owner `doctor` lists under `OWNER_IDENTITY_UNMAPPED`, or run `repo-aegis identity require --off`.
4. **Recommended for agent pushes** (as the mapped person account, or as an App you opt in to): `repo-aegis install git-credential` (see below).
   Without it, pushes keep using your own credential; with it, an agent's push to an App-mapped
   owner must use the HTTPS remote.
5. **Check:** `repo-aegis status` shows the mappings; `repo-aegis doctor` should report no
   `OWNER_IDENTITY_UNMAPPED`.

**Which owners can have an `agent` App.** `taaad mint` refuses a repository whose owner is not the
account the App is installed on, so the App must be installed on that exact owner.

- **Your own account or an org you own:** register the App there (`taaad register`, or
  `taaad register --org <org>` for an org-owned App) and install it.
- **An org you do not administer:** a private App can only be installed on the account that owns
  it, and taaad's Operating Rule 8 forbids making it public. So a personal App cannot be used there.
  The App has to be owned by that org and installed by an org owner. You can request the
  installation from the App's page, and an owner approves it. A repository admin can install it
  only on repositories they administer, only if the App requests no organisation or
  "administration" permission, and only if the org has not turned that off.
- **Or map only a `person`.** This is the intended setup for orgs you do not control. Agents read
  as that account, and each write needs an approval you mint for that login
  (`repo-aegis approve <owner>/<repo>`). No admin is involved.

**What changes for agents.** A `dot gh` write to a mapped owner is refused
(`DOT_GH_OWNER_MAPPED`): agents use plain `gh --repo <owner>/<repo> …` there, and repo-aegis picks
the account. With taaad's optional macOS helper `taaad-signer` installed, each fresh App token asks
you for Touch ID; a token is then reused until shortly before it expires.

### Identities in practice

With `repo-aegis install shim` done and `<home>/bin` first on `PATH`, every `gh` call goes
through `repo-aegis gh`. For a call whose owner is mapped (the owner comes from `--repo` / `-R`, a
URL, a `repos/<owner>/<repo>/…` endpoint, `GH_REPO` or the working directory's remote):

- **A person at a terminal** runs as the owner's `person` identity (their `gh` account). An owner
  with only an `agent` identity runs as the active account, with a hint.
- **No person present** (an agent) runs as the owner's `agent` identity, a GitHub App: a token is
  minted for exactly that repository, with permissions limited to the verb (reads: metadata and
  contents, plus pull requests and issues; writes: what the App was granted on that repository).
  An agent write needs `--repo <owner>/<repo>`: a repository taken only from the working directory is
  refused (`GH_IDENTITY_NEEDS_LITERAL_TARGET`).
- **An owner with only a `person` identity**: an agent's reads run as that person; an agent's
  writes need a live approval minted for that person's login (`repo-aegis approve <owner>/<repo>`
  records it), else `GH_IDENTITY_WRITE_NEEDS_HUMAN`.
- A token you already hold in `GH_TOKEN` / `GITHUB_TOKEN` is not used for a mapped owner:
  refused for an agent, compared with the mapped account's token for a person.
- If the identity cannot be used (no token, taaad failing, an untrusted `gh`), a write is refused
  (`GH_IDENTITY_UNAVAILABLE`, `GH_BINARY_UNTRUSTED`); it never silently runs as whichever account is
  active. A read whose identity is merely unavailable (`GH_IDENTITY_UNAVAILABLE`) runs as the active
  account with one warning line on stderr, and carries no token.

Every injecting call prints `repo-aegis: as <identity> (<kind>) for <owner>/<repo>` and appends
a record (never the token) to `<home>/state/gh-decisions.jsonl`.

**taaad and root ownership.** App tokens are minted by taaad, the only holder of the App private
keys. App identities need taaad v0.6.0 or later (`taaad mint`). taaad's optional macOS helper,
`taaad-signer`, asks for Touch ID before each fresh token; repo-aegis reports its two refusals
(prompt limit reached, prompt declined) and works the same with or without it. `install shim`
pins taaad's launcher, the interpreter its shebang names and its package directory.
A taaad installed under your home directory works (the usual `pipx install`). `doctor` reports a
**warning**, `TAAAD_AGENT_WRITABLE`, when any of the three, or a directory above them, is not owned by
root, because an agent that deliberately edited taaad's code could capture the tokens it mints.
repo-aegis guards against honest mistakes, not a determined agent, so this is not a refusal. If you
want the extra protection, install taaad into a root-owned prefix, for example
`sudo pipx install --global taaad` (under `/opt/pipx`, on `PATH` through `/usr/local/bin`), remove the
user-level copy, and re-run `repo-aegis install shim`. On Apple Silicon a Homebrew Python is user-owned,
so a venv whose interpreter resolves into `/opt/homebrew` keeps the warning. A missing pin (no taaad
on `PATH` at `install shim`) does refuse App identities, since nothing can mint. `gh-login` identities
do not need taaad. repo-aegis runs `gh` for the call from
a trusted location only (the same vetting `doctor` applies: not under your home directory, the
current directory or a temp directory; not group- or world-writable).

### Git pushes by an agent (the credential helper)

The helper **only chooses the account**; whether a push may go is decided by the pre-push rules
(rule g for a public destination, rule h cross-org) and the Bash hook. By default (D1) an owner
mapped to a `person` identity (a `gh-login`) is pushed as that login. An owner mapped to an `agent`
identity (a `github-app`) is **opt-in**: the push then carries a token narrowed to that one
repository. `repo-aegis install git-credential` (a person, at a terminal) puts the repo-aegis helper
first in the global git config for `https://github.com` and sets
`credential.https://github.com.useHttpPath=true`; what it added is recorded in
`<home>/state/git-credential-install.json` and `--uninstall` removes exactly that
(see [cli-reference.md](cli-reference.md#repo-aegis-install-git-credential---uninstall)).

- With a person present the helper prints nothing and your own helpers answer as before; the same for an unmapped owner, a missing registry, and an encrypted one (which also prints a note on stderr: `repo-aegis registry decrypt` makes it readable). A registry that exists but cannot be read (it does not parse, or a newer repo-aegis wrote it) refuses a push with `GH_IDENTITY_UNAVAILABLE`, because git's next helper would answer with whichever account it holds; `doctor` says whether to repair the file or upgrade.
- An agent's push over SSH to an owner with an App is refused by the pre-push hook (`AGENT_PUSH_NEEDS_APP`): push over HTTPS.
- An owner with an App needs the pinned taaad: the one `install shim` recorded in the shim at `<home>/bin/gh` (see "Identities in practice"). With none it refuses (`GH_BINARY_UNTRUSTED`). An App token cannot be minted from inside the Claude Code sandbox (the signer's network connection is blocked; see [agent-sandbox.md](agent-sandbox.md)); a person-mapped owner mints nothing and works there.
- Helper order matters: a reset entry, a system-scope helper such as `osxkeychain`, or `gh auth setup-git` can put another helper first, and that one answers with your credential. The install checks this and refuses with instructions rather than guess, with one exception: on stock macOS (a system `osxkeychain` and no global entry for github.com yet) it writes an empty reset entry, its own line, and `osxkeychain` back after it, and `--uninstall` removes all three. `doctor` fails with `GIT_CREDENTIAL_HELPER_ORDER` when an owner has an agent identity and the order is wrong.
- **Accepted limit: the process chain is a heuristic, even inside the sandbox.** It is used only to tell a known read (`fetch`, `pull`, `clone`, `ls-remote`, `archive`, `remote`, `submodule`) from a push: `git-remote-https` must be the helper's parent or grandparent (a plain shell may sit between), its argv must be `[git-remote-https, <remote>, https://github.com/<path>]` with the request's path (case and `.git` aside), and no `git credential…` command may sit between. Anything that does not match, and a process list that cannot be read, counts as a push, never as a read, so the helper never refuses on it. A same-user process can set its own name and argv: the process list is not a security boundary (the same limit as presence detection, `process-ancestry.ts`).
- A push to an owner that has only a `person` identity is answered with that login's own token from the trusted gh, never the active gh account's, with one stderr line naming the account it ran as. No approval is read. A known read gets the same login's token and prints nothing, so a fetch never runs as whichever account gh or the keychain has active. SSH pushes to such an owner are not touched by the helper and go through the pre-push rules as before.
- Settings that could capture the token make the helper refuse (`AGENT_PUSH_CREDENTIAL_CONFIG`): a credential helper in the repository's own config, and `GIT_TRACE_CURL`, `GIT_CURL_VERBOSE`, `GIT_TRACE_PACKET` or `GIT_TRACE_REDACT=0` in the environment (each would write the token to a trace). A proxy (`HTTPS_PROXY`, `http.proxy`), a CA bundle, `http.extraHeader` and `http.sslBackend` do not refuse: the default Claude Code sandbox sets a proxy on every command, a CONNECT proxy cannot read TLS, and planting a CA bundle is an attack, not an accident. `http.sslVerify=false` and `GIT_SSL_NO_VERIFY` give the token and print a `repo-aegis: warning:` line.
- A helper after repo-aegis's that would persist the token refuses it (`AGENT_PUSH_CREDENTIAL_STORE`). An **App** token is refused for any storing helper (`osxkeychain`, `store`, ...): the person's later pushes would then run as the App. A person's own login token, push or read, is refused only for `store` (plaintext in `~/.git-credentials`) and for a helper repo-aegis does not recognise; the OS stores (`osxkeychain`, `libsecret`, `wincred`, a credential manager) and `cache` pass, because saving the person's token in the person's own keychain changes nothing about which account later pushes use.
- **A repository with its own `core.hooksPath`** (husky and other hooks managers set it in the repository's config). Git then runs only that directory, so repo-aegis's global pre-push guard does not run, and since the helper no longer judges pushes it would hand the person's token to a script-run push (`npm run release`) that nothing checks. So a push as the person's account is refused (`AGENT_PUSH_GUARD_NOT_RUNNING`) when the repository's own `core.hooksPath` is not repo-aegis's hooks directory **and** the destination is not recorded as private (offline, from the same `repo-aegis.visibility` cache pre-push reads; `repo-aegis classify` records it). A repository recorded as private, a global `core.hooksPath`, a known read and an App identity are not affected. To fix it for good, chain repo-aegis's hook from the repository's own hooks directory: have its `pre-push` run `<home>/hooks/pre-push "$@"`. **Known residual:** `git push --no-verify` skips the pre-push hook whatever the helper says; repo-aegis guards against honest mistakes, not a determined agent.

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
`REPO_AEGIS_WAIVE_NONINTERACTIVE=1` is set; and `check` says so
(`waived: N` in its text output, the list in `--json`) whenever a waiver
suppressed a finding.

**Precedence (first wins):**

1. `.git/config` (per-clone `repo-aegis.class` / `repo-aegis.engagement`).
2. `.repo-aegis.yml` at the repo root.
3. Default (`private-strict`, no engagements).

No command-line flag sets the class or the engagements (`--cwd` only chooses
which repo is read). `repo-aegis status --json` does not report which source a
value came from: its `repo` object carries `class`, `classExplicit` (`false`
means the default is in use) and `engagements`.

## The registry's five states

Every layer (the agent hook, the `gh` shim, the pre-push hook, the `gh` identity
layer, the write hooks and `doctor`) reads the registry through one loader and
gets one of five states. They cannot disagree about which one applies.

| State | What it is | Rule h (unregistered owner) | The write hooks | `doctor` |
|---|---|---|---|---|
| `loaded` | the file parses and validates | judges, unless it declares no owners | read it | `OWNERS_UNDECLARED` (fail) when it declares no owners |
| `missing` | no registry file | skipped, with a note | an empty registry | nothing |
| `encrypted` | only `engagements.yaml.age` exists | skipped, with a note: repo-aegis runs **as if there were no registry** | an empty registry (not an error) | `REGISTRY_ENCRYPTED` (warn) |
| `unparseable` | the file exists but does not parse or validate | the agent hook **asks** a person (a host with no prompt denies); pre-push and the shim refuse | `REGISTRY_ERROR`, exit 2 | `REGISTRY_UNREADABLE` (fail) |
| `newer-schema` | the file parses but its `schemaVersion` is above what this build reads (`3`) | as `unparseable`, with an "upgrade repo-aegis" fix | `REGISTRY_ERROR` with the newer-schema text, exit 2 | `REGISTRY_UNREADABLE` (fail), fix: upgrade, then `install hooks` and `install claude-md` |

An error the loader does not recognise counts as `unparseable`: it never reads
as "no registry".

**Encryption at rest is deprecated** and is removed in 0.15.0. Until then,
`registry encrypt` still works, but an encrypted registry switches off rule h and
the GitHub identity mapping (a registry-reading command such as `status` still
says `REGISTRY_ENCRYPTED`). Marker scanning (`_always` and the engagement marker
files) is not affected. `registry decrypt --identity <key>` brings the registry
back; a person runs it.

**What an encrypted registry quietly widens.** With no registry, an engagement
has no `githubOrgs`, so the cross-org boundary collapses to the repository's own
`origin` org. Two engagements under **one** org (say, two customers hosted in the
same GitHub org) stop being separate boundaries: a write or push from one
engagement's checkout into the other's is no longer a cross-org event, and
nothing refuses it. Rule h is off at the same time, so an unregistered owner is
not refused either. To keep this from being silent, every layer says so: the
write hooks (`check-write`, `scan-after-write`) and the agent's egress hook show
the person a one-line notice as the JSON `systemMessage` (Claude Code drops
stderr on exit 0), once per call; pre-push prints it on stderr once per push;
`doctor` warns `REGISTRY_ENCRYPTED`. And because an agent must not be able to put
the machine into this state, `registry encrypt` refuses unless a person's
terminal is attached (`REGISTRY_ENCRYPT_NEEDS_TTY`).

The `ask` on an unreadable registry is not a way through for a push: the pre-push
hook refuses until the registry can be read. When a newer repo-aegis has written
the registry (schema skew), upgrade repo-aegis, then run `repo-aegis install hooks`
and `repo-aegis install claude-md`, so the hooks run the new version.

## The pinned enforcement binary

The git hooks (`pre-commit`, `pre-push`) and the `gh` shim run the scanner by
**absolute path**, never by name. `repo-aegis install hooks` and `repo-aegis
install shim` resolve two paths and write them into the generated scripts:

- the Node executable (`process.execPath`, canonicalised), and
- the CLI entry (the `dist/index.js` of the install that is running, canonicalised).

Every call in the scripts is `"$__ra_node" "$__ra_cli" …`; the only other way
in is the fallback below. The paths are shell-quoted when rendered, and a path
containing a newline or NUL refuses the install (`PIN_PATH_UNSUPPORTED`). A third
line, `__ra_version='<version>'`, records the version of the CLI that was
pinned.

Why: a name is looked up on the caller's `PATH`, and an agent can usually write
to a directory in the user's home that comes first on it. A `repo-aegis` (or a
`node`, which the CLI's `#!/usr/bin/env node` line also resolves by name) that
exits 0 there would switch off the pre-commit scan, the pre-push scan and the
shim's egress check. Two installs on one machine also meant the person's
terminal and the agent's shell enforced different versions.

**A pin that is gone no longer locks you out, and no longer opens a hole.** If a
pinned file is missing or not usable (a Node upgrade through a version manager
moves `process.execPath`; an install was removed), the script does not look at
`PATH` while the pin works. When it does not, it falls back to the `repo-aegis`
on `PATH` **only if that one is at least as new as the pinned version**, prints a
`WARNING` that names both versions and the re-pin command, and runs it. Otherwise
it refuses:

| The `repo-aegis` found on `PATH` | Result |
|---|---|
| none | refuse: "no repo-aegis is on PATH" |
| older than the pinned version | refuse, naming both versions ("an older repo-aegis may not read this machine's registry") |
| first line of `--version` is not exactly `MAJOR.MINOR.PATCH` (a prerelease, `v0.14.0`, empty, a crash) | refuse; what it printed is never echoed |
| at least as new | run it, with a warning |
| (the pin has no recorded version: an install from before 0.14.0) | refuse, and say so; no fallback |

When a Claude Code hook runs through the fallback, the `repo-aegis` it runs shows
the person a one-line notice (the JSON `systemMessage`, on every answer, an allow
included, because stderr is dropped on exit 0); the fallback tells it so with
`REPO_AEGIS_PIN_FALLBACK=1`, which only ever adds that notice.

Refusals exit as before: `pre-commit` and `pre-push` exit 1, the `gh` shim exits 2
for any call but `--version`, `help` and `completion`, and every Claude Code hook
command exits 2. The comparison is numeric (0.9.0 is older than 0.14.0); a
prerelease suffix on the pinned version is dropped, which only raises the floor.
The reason for the floor: a `repo-aegis` older than the pinned one may not read
this machine's registry (a newer schema), which is the lockout this replaces.

There is no environment variable that turns any of this off, because an agent
could set it. A person re-runs the installer from a terminal. **After moving or
upgrading Node, or reinstalling repo-aegis, re-run `repo-aegis install hooks`,
`repo-aegis install shim` and `repo-aegis install claude-md`.** `doctor` keeps
reporting `ENFORCEMENT_PIN_MISSING` as a failure until you do.

How it shows up elsewhere:

- `status` and `doctor` compare each installed hook with the script rendered for
  the **current** pin, so a hook rendered for another path, or an older unpinned
  one, is `HOOKS_SCRIPT_STALE`; the same comparison gives the shim `SHIM_STALE`.
- `doctor` reports `ENFORCEMENT_UNPINNED`, `ENFORCEMENT_PIN_MISSING` and
  `MULTIPLE_INSTALLS` (see `doc/agent-guide.md`).
- `install claude-md` writes every Claude Code hook command (`check-write`,
  `guard-egress`, `scan-after-write`, `scan-bash-output`, `egress-receipt`,
  `prompt-submit`, `first-touch`) into the [managed drop-in](#the-claude-code-managed-drop-in)
  (or, with `--user-settings`, into `settings.json`) as a pinned one-line `sh`
  command: shell-quoted absolute paths to
  the node and CLI, `exec`'d so the tool call on stdin reaches the CLI, and an
  exit **2** with the fix on stderr if either file is missing. A missing command
  would exit 127, which Claude Code treats as a non-blocking hook error: the hook
  would be skipped and the tool call would proceed. The point is the `PATH` the
  agent's shell sees: its first entry is typically `~/.config/repo-aegis/bin`
  (the shim directory), and a `repo-aegis` file placed there would replace the
  `guard-egress` hook that judges every agent command. Re-running `install
  claude-md` replaces an older by-name `repo-aegis hook …` entry (and one pinned
  elsewhere) in place; `--uninstall` removes either form.
- `install claude-md` adds `permissions.deny` Edit rules for the pinned CLI's
  package directory and the pinned Node executable, so an agent cannot overwrite
  the code the pin points at. A package directory inside a git work tree (a
  development checkout) is not denied; the install prints a warning instead.
- Because of the two points above, whatever file holds the Claude Code hooks
  holds paths that are specific to one machine. By default that is the
  [managed drop-in](#the-claude-code-managed-drop-in), which belongs to the
  machine, so `~/.claude/settings.json` can stay portable. With
  `--user-settings` it is `settings.json` itself, and then that file must stay
  per machine: do not sync it, or symlink it from a repository that other
  machines check out. Every hook would exit 2 on a machine where the paths do
  not exist, and each machine's install would overwrite the file for all the
  others. `doctor` warns (`ENFORCEMENT_IN_USER_SETTINGS`) while the hooks are in
  that file.

Not covered: which `gh` binary the shim runs (it still looks for the first `gh`
on `PATH` that is not itself), and the shim's existing rule that a fault in the
guard itself (an exit other than 0 or 2) does not block `gh`.

## The Claude Code managed drop-in

`repo-aegis install claude-md` puts the Claude Code hooks and the
`permissions.deny` rules in **one root-owned file** instead of your
`~/.claude/settings.json`:

| Platform | File |
|---|---|
| macOS | `/Library/Application Support/ClaudeCode/managed-settings.d/50-repo-aegis-<uid>.json` |
| Linux | `/etc/claude-code/managed-settings.d/50-repo-aegis-<uid>.json` |

Why: Claude Code merges hook entries and `permissions` lists across all
settings scopes, and a user or project file cannot remove or disable a managed
hook. The file is `root:root 0644`, so the agent (which runs as you) cannot
edit it, which is stronger than a deny rule in a file you own. Your own
`settings.json` then holds only portable preferences and may be synced.

Sources for the Claude Code behaviour this relies on: the
[settings page](https://code.claude.com/docs/en/settings) (precedence across
scopes; list keys such as `permissions` merge across files) and the
[managed settings page](https://code.claude.com/docs/en/managed-settings.md)
(delivery mechanisms; managed settings sit above every user, project and
local file). That a user or project file cannot disable a managed *hook*, and
the exact `managed-settings.d` paths in the table above, come from the
install code and were not re-checked against those pages or re-tested against
each Claude Code release (unverified). The hook contract itself (exit codes,
matchers) is at <https://code.claude.com/docs/en/hooks>.

The path comes from the platform and your uid, never from a stored record. The
file holds only `hooks` and `permissions.deny`: the six hooks (`check-write`,
`guard-egress`, `scan-after-write`, `scan-bash-output`, `egress-receipt`,
`prompt-submit`; plus `first-touch` when you asked for it), a SessionStart heartbeat, and the same
`Edit(//…)` deny rules as before (registry, approvals, hooks, shim, markers, the
pinned CLI package and the pinned Node).

**One file per account, and a uid guard.** A managed file applies to every
account on the machine, but the pin names one account's Node and CLI. Each hook
command therefore starts with `__u=$(/usr/bin/id -u …)` and does nothing (exit
0) when the uid is not yours; a failing `id` blocks (exit 2) instead of passing.
The guard runs before the pin check: on Ubuntu, home directories are `0750`, so
another account would otherwise see your pin as missing.

### Installing

Run it from your own terminal; it is not something an agent can do for you.

```sh
command -v repo-aegis && npm ls -g repo-aegis    # check it is the install you expect (below)
repo-aegis install claude-md                     # add --first-touch for the SessionStart classify hook
```

It requires an interactive terminal, shows the target path, byte count,
sha256 and a diff against the current file, and asks `[y/N]`. Only then does
`sudo` ask for **your password**; that prompt is the control (a terminal check
can be faked with a pty). The only commands that run as root are fixed ones,
each by absolute path (`/usr/bin/sudo`, `install`, `tee`, `/bin/chmod`,
`chown`, `/bin/mv`, `/bin/rm`, `/bin/rmdir`), with fixed arguments and a
minimal environment: the content goes in on stdin to a hidden temp name
(`.50-repo-aegis-<uid>.json.tmp`, which Claude Code ignores), is checked as
you, and is moved into place atomically, then read back (owner `0:0`, mode
`0644`, same digest). The installer refuses if `sudo` or one of those tools
is not a root-owned file that others cannot write, or if the system directory
or any parent is a symlink, not root-owned or writable by group or others (as
on WSL, where `/etc/claude-code` is user-writable). Re-running with nothing
changed runs nothing as root. `--dry-run` prints the drop-in and writes nothing.

**Check what you run.** The privileged step is only as trustworthy as the
`repo-aegis` you launch: a planted fake that asks for your `sudo` password
cannot be told apart from inside itself. On a machine where an agent has had
shell access, check `command -v repo-aegis` and `npm ls -g repo-aegis` first.

### Moving from `settings.json`

After the drop-in is written and read back, and only if no other managed source
outranks it (`MANAGED_HOOKS_DISABLED`, `MANAGED_SOURCE_SHADOWED`) and the
heartbeat check is not failing (`MANAGED_HOOKS_NOT_FIRING`; "skipped" on a first
install is fine), the install removes its own earlier hook entries and ledgered
deny rules from `~/.claude/settings.json` (indentation and trailing newline
kept; nothing else touched) and tells you to confirm that `/status` in Claude
Code shows `(drop-ins)` or `(file + drop-ins)`. **Removing anything from that
file needs a person at a terminal**, even when the drop-in itself is unchanged
and no root step runs: without one, the install prints what a run from a
terminal would remove and leaves the file byte-identical. (If you put the
entries back because the drop-in was shadowed, an agent re-running the install
cannot strip them again.) The first SessionStart then records a heartbeat that
`doctor` checks; Claude Code reloads managed files when they change, so this
takes effect in running sessions. A heartbeat or install time dated in the
future fails the check, because a rewritten timestamp could hide a drop-in that
is not loaded.

### Without sudo: `--user-settings`

`repo-aegis install claude-md --user-settings` writes `~/.claude/settings.json`
as before. Use it in containers and devcontainers, or where there is no managed
location (it is also what `install claude-md` falls back to, with a note, on an
unsupported platform, as root, or without `/usr/bin/id`). `init` uses it, because
`init` runs without a prompt; run `repo-aegis install claude-md` afterwards to
move the hooks into the drop-in. `doctor` warns (`ENFORCEMENT_IN_USER_SETTINGS`):
that file holds machine-specific paths and an agent running as you can edit it.

### Recovering from a lockout

A fail-closed hook whose pin is gone (repo-aegis removed with `npm rm -g`, Node
moved) blocks that account's agent on every call, and you cannot edit a
root-owned file. The message each blocked call prints names both ways out, with
the literal path:

```
re-pin it by running: repo-aegis install claude-md   or remove this managed hook: sudo rm '/etc/claude-code/managed-settings.d/50-repo-aegis-1000.json'
```

Either run `repo-aegis install claude-md` from your terminal (with a working
`repo-aegis`), or run that `sudo rm` line yourself. `doctor` says the same
(`MANAGED_DROPIN_ORPHANED`).

### Uninstalling

Run `repo-aegis install claude-md --uninstall` (or `repo-aegis uninstall --yes`)
**before** `npm rm -g repo-aegis`. npm lifecycle scripts are not relied on: they
do not run reliably on `npm rm -g` and cannot prompt for `sudo`. Uninstall asks
for a terminal and `[y/N]`, then removes the drop-in for **your uid** whatever
the ledger says, then `managed-settings.d/` and the system directory with
`rmdir` only if they are empty **and** the ledger records that repo-aegis
created them, then its entries in `settings.json`. It reads back: if the file
is still there it exits 1 naming the path. It never touches
`managed-settings.json`, another drop-in, or another uid's drop-in.
The ledger is `state/claude-md-managed.json` (digest, whether each directory was
created by repo-aegis, install time); it is written before the privileged write
and removed only after a verified removal. The ledger is advisory: it sits in
`state/`, which an agent can write, so it never supplies a path to root. Forging
it can at most make uninstall remove the legacy `50-repo-aegis.json` (when that
file exists) or an empty directory.

### What the drop-in does not guarantee

- **Passwordless `sudo`** (`NOPASSWD`: CI runners, many dev boxes). An agent
  with a fake terminal (`script`, `expect`, a pty library) can then run install
  or uninstall end to end, so the drop-in is no stronger than the user file
  there. `doctor` says so (`SUDO_NOPASSWD`, a warning). The installer runs
  `sudo -k` first and last, never probes with `sudo -n` to skip a prompt, and
  the egress guard also refuses an agent's Bash command that runs
  `install claude-md --uninstall` or `uninstall --yes`, or `sudo rm`, `mv`,
  `tee` and similar on the managed-settings directory, directly or under
  `script`/`expect` (`AGENT_RAN_HUMAN_COMMAND`). That layer reads command text;
  it is not a boundary.
- **Server-managed settings and MDM.** By default (`first-wins`) any
  server-managed policy (for example signing in to a Team or Enterprise
  organisation) or any MDM key makes Claude Code silently ignore every file
  drop-in, and nothing local shows it. A macOS configuration profile
  (`com.anthropic.claudecode` under `/Library/Managed Preferences/`) is seen by
  `doctor` (`MANAGED_SOURCE_SHADOWED`); a server-managed policy is not, which
  is what the heartbeat is for. If it fires, have the policy's owner add the
  repo-aegis hooks there, or use `--user-settings`.
- **Other managed files.** A sibling managed file with `disableAllHooks: true`
  switches off every managed hook (`MANAGED_HOOKS_DISABLED`).
- The file is `0644`, so other accounts can read your home path from it.
  `allowManagedHooksOnly` does not affect repo-aegis, whose hooks are managed.
  A SessionStart hook that exits 2 is a notice, not a block, so the heartbeat
  cannot lock anyone out.
- Systems without `/usr/bin/id` (NixOS, Guix) use `--user-settings`.

## Environment variables

| Var | Effect |
|---|---|
| `REPO_AEGIS_HOME` | Override `~/.config/repo-aegis` as the config home. Stderr warning printed on every TTY invocation when set; suppressed in hook context. |
| `REPO_AEGIS_REGISTRY` | Override the registry path independently from home. Set by the `--registry-path` global flag. |
| `REPO_AEGIS_MARKERS_DIR` | Override the directory of rendered marker files (default `markers/` under the config home). |
| `REPO_AEGIS_ACCEPT_ORG_SEED_TRANSFER` | Equivalent to passing `--accept-cross-border` to `audit --org`. The user must set this themselves; agents do not auto-set. |
| `REPO_AEGIS_NEW_REF_FULL_SCAN` | Set to `1` to force `check --push-ref` to fall back to a full-history scan unconditionally, bypassing the boundary-based incremental logic. Escape hatch for the rare case where the boundary derivation itself is suspect. |
| `REPO_AEGIS_WAIVE_NONINTERACTIVE` | Set to `1` to let `repo-aegis waive` run with stdin that isn't a TTY. `waive` refuses otherwise, specifically so a hook, script, or coding agent cannot mint a waiver on its own behalf. A human deliberately scripting a waiver still has to set this themselves. |
| `REPO_AEGIS_MIN_PATTERNS` | Minimum deny-set size; `check` and `audit` exit 2 below it. Equivalent to `--min-patterns <n>`. The composite Action sets it from its `require-deny-set` / `min-patterns` inputs rather than splicing a flag into a user-supplied `args` string, where a consumer could overwrite it. |
| `REPO_AEGIS_REDACT_ATTRIBUTION` | Set to `1` to strip engagement attribution from output. Equivalent to `--redact-attribution`. Set by the Action and by every generated CI workflow, because a job log, a PR comment, and an issue body are publication channels. |
| `REPO_AEGIS_ASSUME_PUBLIC` | Set to `1` to assert this repo is public-facing, which turns private-registry egress enforcement **on**. Exists for CI: a fresh clone has no cached `repo-aegis.visibility`, while a workflow knows the answer from `github.event.repository.private`. **One-directional by design** — there is no counterpart that asserts "private". An env var that switches findings *off* would be a waiver nobody reviewed, reachable from a shell profile or a workflow edit, with none of the audit trail `waive` insists on. One-directional also needs no anti-spoofing story: nobody gains by asserting the stricter value. |
| `REPO_AEGIS_VISIBILITY_LOOKUP` | Set to `0` to stop the live `gh` lookup of a repository's visibility. An unknown visibility then stays unknown, and is refused without a person. For machines where a hook must never spawn `gh`, and for the test suite. |
| `REPO_AEGIS_EGRESS_HUMAN` | Set to `1` for one invocation to declare that a person is running it, so the egress guard treats it as a human action. Ignored when an agent host is detected above the process (for example Claude Code). Never honoured by `approve`, the owner adds (`engagements add --github-org` / `--personal-org`, `upstreams add`) or `init --migrate-classify`, which need a terminal. An agent must never set it. |

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

## Compatibility of `alwaysBlockExemptPaths`, `waivers` and `selfIdentity`

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

`selfIdentity` is the same shape of addition with the opposite lean,
and it is worth being precise about it. An older repo-aegis drops the
key and therefore does **not** enforce `_self_identity` — laxer, not
stricter, but only in `customer-coupled` repos and only by declining a
protection that install never had. Version gating exists to stop a
stale reader from **mis-enforcing** a key it half-understands; a reader
that ignores the key enforces exactly the pre-`selfIdentity` deny set,
which is the state every install was already in. Gating it behind a
`schemaVersion` bump would trade an absent addition for a hard failure:
every older client would refuse the registry outright.
