# repo-aegis — agent install guide

> Audience: a coding agent (Claude Code, Cursor, Aider, Cline, etc.) that
> a developer has just told to *install and configure* repo-aegis on
> their machine. The agent has been pointed at
> `https://github.com/de-otio/repo-aegis` and needs to know what to do.
>
> Purpose: take the agent from "package not on disk" to "registry
> configured, hooks wired, status verified" without making compliance
> decisions on the user's behalf and without leaking the user's
> customer data.

If you are a human reading this: yes, it is written second-person at
your AI. Skip to the [README](../README.md) for the user-oriented
overview and to [doc/agent-guide.md](agent-guide.md) for the
operator guide that takes over after install.

## What you are installing

repo-aegis is a CLI for the consultant / contractor pattern: one
machine, multiple concurrent customer engagements, plus personal and
OSS work. It stops customer-A's data from leaking into customer-B's
repo (or into a public OSS repo) by maintaining an
**engagement-scoped deny set** of customer-identifying patterns and
running it as a deterministic gate on every write path: pre-commit,
pre-push, and Claude Code Pre/PostToolUse hooks.

You are not building a model. You are wiring a **regex gate**. The
gate runs locally; nothing leaves the machine.

Read [doc/agent-guide.md](agent-guide.md) ("Mental model" + "The
five facts to internalise") before configuring engagements — those
sections explain what the user is going to ask you to set up and
why each constraint exists. The install steps below assume you've
internalised that framing.

## What this guide does NOT do for you

These are compliance decisions only the user can make. Surface them,
do not guess:

- **Which engagements exist.** You must ask the user. Do not infer
  customer names from filenames, recent conversation, or git remotes
  on disk.
- **What the markers are for each engagement.** The user knows their
  customer's identifiers (company name, codename, canonical domain,
  internal hostnames). Ask. Do **not** invent markers; do **not**
  run `suggest-markers` (which sends prose to a local model) without
  explicit user direction.
- **Which classification to apply to each existing repo.** Use
  `classify --apply` (which derives from the git remote + registry
  org membership) when you have it; ask the user when you don't.
- **Whether to enable the audit log** (off by default, opt-in
  compliance trail). Ask.
- **Whether to encrypt the registry at rest.** Surface as an option;
  do not auto-encrypt.

## Pre-flight

Before installing, check:

```sh
node --version          # must be >= 20
npm --version
which repo-aegis        # is it already installed?
```

If `repo-aegis` is already on PATH:

```sh
repo-aegis --version
repo-aegis status       # in any git repo, to confirm it works
```

If the existing install is older than the current published version,
ask the user whether to upgrade (`npm install -g
@de-otio/repo-aegis@latest`). Don't auto-upgrade — a working install
might be older for a reason.

If the user is on a machine they don't have global npm permissions
on, install per-project instead:

```sh
npm install --save-dev @de-otio/repo-aegis
# then invoke as: npx repo-aegis ...
```

## Step 1 — install the package

```sh
npm install -g @de-otio/repo-aegis
```

The package publishes from npm with **trusted publishing
provenance** as of v0.2.0+ (sigstore attestation). After install:

```sh
repo-aegis --version
repo-aegis --help
```

If `npm install -g` fails on permissions, do not `sudo`. Surface
the error. The user has either an `nvm` / `volta` setup that
isolates global installs, or they want a per-project install.

## Step 2 — bootstrap

```sh
repo-aegis init
```

This is idempotent. It:

1. Creates `~/.config/repo-aegis/` (configurable via
   `REPO_AEGIS_HOME`).
2. Scaffolds an empty `engagements.yaml` registry.
3. Renders empty marker files (one per engagement, plus `_always`).
4. Installs git hooks at `~/.config/repo-aegis/hooks/` (pre-commit,
   pre-push) and sets `core.hooksPath` per repo.
5. Installs the Claude Code hooks: PreToolUse `check-write` (refuses
   cross-org writes), PostToolUse `scan-after-write` (deny-set
   scan), PostToolUse `scan-bash-output` (secret-shape scan), and
   the SessionStart `first-touch` hook (auto-classify on first
   touch).
6. Appends a managed block to `~/.claude/CLAUDE.md` describing the
   hook behaviour to the agent.

After `init`:

```sh
repo-aegis engagements list --json
# -> { "engagements": [], "alwaysBlock": [], "schemaVersion": 2 }
```

Empty registry. That's expected — you haven't configured anything
yet.

If the user has `REPO_AEGIS_HOME` set in their environment (a
non-default config home), `init` honours it. Don't try to "fix"
this — it's deliberate.

## Step 3 — collect engagement information from the user

This is the **interactive step**. You don't know the user's
customers; ask. A reasonable script:

> I'll need a few pieces of information to configure repo-aegis.
> For each customer / employer / engagement that you currently work
> with on this machine, tell me:
>
> 1. A short stable id (e.g. `customer-a`, `acme`, `client-foo`).
>    This goes in commit messages and config; it's not customer-
>    visible. Avoid the literal customer name if the id will appear
>    in public artefacts.
> 2. A human-readable name (e.g. "Customer A").
> 3. The GitHub org(s) that map to this engagement (e.g.
>    `acme-corp`). This lets repo-aegis auto-classify future repos
>    in those orgs without prompting.
> 4. Three to five **markers** — short regex patterns identifying
>    strings that should not appear outside this engagement's repos.
>    Common patterns: company name (`\\bacme-corp\\b`), product
>    codenames, canonical domain (`acme\\.com`), internal hostname
>    pattern (`internal\\.acme\\.example`), bug-tracker prefix.
>
> Also tell me your *personal* GitHub orgs — orgs you own where
> public/OSS work happens. These are configured separately and
> classify their repos as `public-eligible`.

Ask for all engagements at once if it's natural in the conversation;
ask one at a time if the user prefers. Either is fine.

**Things to watch for when listening to the user's answers:**

- **Marker patterns are regexes.** If the user gives you a literal
  string with a regex metacharacter (e.g. `acme.com`), wrap the
  metacharacter in escape (e.g. `acme\\.com`) before passing to
  `engagements add`. The CLI runs a regex-safety validator (rejects
  ReDoS-suspect patterns and oversize patterns) but cannot fix
  ambiguous user intent.
- **Don't suggest markers.** The user knows what's identifying for
  their customer. You don't.
- **The id is not the marker.** `customer-a` is the engagement id;
  the marker is the literal regex that catches that customer's
  strings. They look similar in examples but they are different
  fields.
- **Personal orgs ≠ engagement orgs.** A single GitHub org belongs
  to *exactly one* of {`personalOrgs`, an engagement's
  `githubOrgs`}. The CLI enforces uniqueness across engagements; if
  the user lists the same org twice, ask which scope it belongs to.

## Step 4 — register engagements

For each engagement the user gave you:

```sh
repo-aegis engagements add customer-a \
  --name "Customer A" \
  --github-org acme-corp \
  --marker '\bacme-corp\b' \
  --marker 'acme\.com' \
  --marker 'AC-[0-9]+'
```

Use **single quotes** to avoid shell-interpreting the regex.

For personal orgs (no engagement created — just an entry in
top-level `personalOrgs`):

```sh
repo-aegis engagements add --personal-org rmyers --personal-org my-oss-org
```

After each `engagements add`, the CLI returns JSON with the rendered
marker count. Surface the result to the user briefly:

> Registered customer-a (Customer A). 3 markers active. The marker
> file lives at `~/.config/repo-aegis/markers/customer-a.txt`.

The user **does not** need to see the literal patterns echoed back
— they typed them in. Don't echo them.

If `engagements add` fails with `PATTERN_VALIDATION`:

- The error reports the engagement id and a structural reason
  (`regex-syntax`, `redos-suspect`, `oversize`). It **does not**
  echo the literal pattern.
- Tell the user which engagement and which reason. Ask for a
  reformulated pattern. Do **not** auto-rewrite the pattern; that's
  your guess at intent.

If `engagements add` fails with `ENGAGEMENT_EXISTS`:

- The id is already registered. Run `repo-aegis engagements show
  <id> --json` to inspect, surface the existing entry, and ask the
  user whether to update (different verb: `engagements add
  --github-org` is additive on orgs and markers) or pick a different
  id.

If `engagements add --github-org X` fails because `X` already
belongs to another engagement / `personalOrgs`, surface verbatim and
ask the user which scope it should belong to. Do **not**
auto-resolve.

## Step 5 — classify the user's existing repos

For every git repo on disk that the user works in, the
classification (`repo-aegis.class` + allowed engagements) needs to
be set. Two paths:

**Auto-classify based on remote** — for each repo:

```sh
cd /path/to/repo
repo-aegis classify --apply
```

If the repo's `git remote get-url origin` matches an engagement's
`githubOrgs`, it sets `repo-aegis.class = customer-coupled` and
`allow`s that engagement. If it matches `personalOrgs`, it sets
`repo-aegis.class = public-eligible`. If neither, it reports
`matched: null` and sets nothing — ask the user.

**Manual classify** when auto fails:

```sh
git config repo-aegis.class private-strict       # or customer-coupled / public-eligible / scratch
repo-aegis allow customer-a                       # only for customer-coupled
```

Do **not** classify customer repos as `public-eligible`. Do **not**
classify personal repos as `customer-coupled`. The classes are
not interchangeable; their hook behaviour differs (see
[doc/agent-guide.md "The four classes"](agent-guide.md)).

If the user has many repos, you can sweep with the SessionStart
hook (already installed in step 2): each time the user opens a
repo in their agent, `repo-aegis hook first-touch` runs and either
classifies cleanly or surfaces `needs-confirmation`. So you don't
have to classify every repo eagerly during install.

## Step 6 — verify

```sh
repo-aegis engagements list --json
repo-aegis status                                 # in some classified repo
```

`status` should show the repo's class, allowed engagements, and a
non-zero `patterns` count. If `patterns: 0`, no engagement has
markers configured yet — go back to step 4.

Sanity-test the deny set in a `customer-coupled` repo:

```sh
cd /path/to/customer-a-repo
repo-aegis markers test 'acme-corp' --json
# -> { "input": "acme-corp", "matches": [...] }   # at least one match for customer-a
```

If a known-good marker doesn't match, the engagement may not be
`allow`'d in that repo, or the regex is broken. Re-check `status`.

## Step 7 — hand off to the operator guide

At this point repo-aegis is installed and configured. From here on,
the agent's day-to-day operation — reacting to hits, adding new
engagements, classifying new repos, handling cross-org writes — is
covered in **[doc/agent-guide.md](agent-guide.md)**. Read it before
the user starts working.

Surface to the user:

> repo-aegis is installed and configured. {N} engagement(s)
> registered. {M} repo(s) classified.
>
> The hooks now run on every Write/Edit/MultiEdit and every Bash
> tool call. If a write would cross trust boundaries
> (`CROSS_ORG_WRITE`) it is refused before the file is created. If
> a write contains a marker for a forbidden engagement, the tool
> result will carry a redacted hit with the engagement id and the
> file:line:column.
>
> If you ever want to remove repo-aegis, run `repo-aegis uninstall`
> (dry-run by default; pass `--yes` to apply). Don't hand-edit
> `~/.claude/settings.json` to remove the hooks.
>
> Optional: enable the audit log (`repo-aegis audit-log on`) for a
> compliance trail of state-changing CLI invocations.

## Common pitfalls

### "I see `customer-coupled with no engagement` errors after `classify --apply`"

The remote matched an engagement org but `allow` wasn't called. Run
`repo-aegis allow <engagement-id>` in that repo. (`classify --apply`
should have done this; if it didn't, the engagement may not have
the org attached. Check `repo-aegis engagements show <id> --json`.)

### "The user has existing repos with `repo-aegis.class` set from before"

`init` and `classify --apply` are both idempotent and won't overwrite
existing classification. If the user wants to re-classify, they can
`git config --unset repo-aegis.class` first, then re-run `classify
--apply`. Don't unset on their behalf.

### "The CLAUDE.md block looks weird in the user's existing CLAUDE.md"

`install claude-md` (called by `init`) appends a marker-bracketed
block. If the user has an older block from a previous install, it
remains untouched (the marker prevents duplicate insertion). To
refresh: `repo-aegis install claude-md --uninstall && repo-aegis
install claude-md`. Ask the user before doing this — they may have
hand-edited the block.

### "I can't tell which Claude Code config home to use"

Default is `~/.claude`. Override with `--claude-home <dir>` or by
passing `claudeHome` to the `install claude-md` command directly.
The user is the source of truth on this; don't probe with `find`.

### "The user has multiple machines and wants the same registry on all of them"

The registry lives in `~/.config/repo-aegis/engagements.yaml`. To
sync across machines, the user can:

- Encrypt the registry at rest (`repo-aegis registry encrypt
  --recipient age1...`) and keep the ciphertext in a dotfiles repo,
  decrypting on each machine via `registry decrypt --identity
  <path>`.
- Or replicate the file via their existing dotfiles workflow.

Don't propose a sync mechanism without asking. The registry is
sensitive data even when it's not encrypted (it lists all the
user's customers and their identifying patterns).

## What you should never do during install

- **Run `suggest-markers`.** It sends prose from the user's repo
  to a local Ollama model. The user must opt in.
- **Set `--auto-accept-above` on `suggest-markers`.** Auto-acceptance
  bypasses the user's review of model-suggested markers.
- **Set `--allow-remote-model` / `--allow-remote-ollama`** anywhere.
  Sending customer prose to a non-localhost model is a compliance
  decision.
- **Use `--purge-repos` / `--purge-home`** in any flow. These belong
  to uninstall, not install.
- **Echo a literal marker pattern back to the user.** They typed it;
  they don't need it back.
- **Commit the user's `engagements.yaml` to a public repo.** It
  contains customer identifiers in plaintext. The user owns whether
  to encrypt-and-sync; surface that decision when relevant.
- **Set the `git config user.email` to a customer-derived address.**
  Repo-aegis doesn't touch git identity, but agents that "set up
  everything" sometimes do; don't.

## Short version (for an agent that read this and wants the recipe)

```sh
# 1. install
npm install -g @de-otio/repo-aegis

# 2. bootstrap
repo-aegis init

# 3 + 4. for each engagement the user named, with their markers:
repo-aegis engagements add <id> \
  --name "<Name>" \
  --github-org <org> \
  --marker '<pattern>' \
  --marker '<pattern>'

# (personal orgs separately:)
repo-aegis engagements add --personal-org <org>

# 5. for each existing repo on disk:
cd <repo>
repo-aegis classify --apply       # or `git config repo-aegis.class ...; repo-aegis allow <id>`

# 6. verify
repo-aegis engagements list --json
repo-aegis status
repo-aegis markers test '<known-marker>'
```

Then read [doc/agent-guide.md](agent-guide.md).

## Reference

- Tool home page: https://github.com/de-otio/repo-aegis
- Operator guide (post-install): [doc/agent-guide.md](agent-guide.md)
- README (user-oriented overview): [../README.md](../README.md)
- CLI reference: [doc/cli-reference.md](cli-reference.md)
- Uninstall: `repo-aegis uninstall --help` or
  [agent-guide.md "Uninstalling"](agent-guide.md#uninstalling)
