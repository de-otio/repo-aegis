# Preventing client data from reaching a public repository

*Adapted from the author's internal notes, 2026-11.*

This guide is the background to repo-aegis: the layered approach to keeping one client's names
and data out of another client's repositories, and out of public ones, that the tool automates
in part. It is written as a pattern, so most of it applies without repo-aegis. Where the tool
implements a step, the text says so. Everything here comes from the author's own experience
with several clients on one machine, not from a measured study, and incident details are
deliberately not included.

Examples use placeholders (`customer-a`, `acme-corp`, `example.com`). The commands are
illustrations: adapt them before relying on them.

## The premise

No single control catches every leak. A stack of cheap, complementary controls, each catching a
different class of slip, makes leaks rare enough to manage. In order from "removes the cause"
to "catches the symptom":

0. **Identity and account separation.** The only real permission boundary. The other layers are
   guardrails.
1. **Remove ambient coupling.** Make a project depend only on its own configuration, so
   client-derived strings do not enter the working tree by accident.
2. **Deterministic gates.** Pre-commit, pre-push and CI checks that refuse content containing
   known markers.
3. **Guidance for AI coding agents.** Rules and hooks, so agents avoid the patterns that create
   leaks.
4. **Periodic audits.** Sweeps that find what the earlier layers missed.

You do not need all five. Identity separation, one pre-commit check and one agent rule cover the
most common failures.

Two facts shape every trade-off below:

- **One false negative is permanent.** Once a string has been public, even briefly, it may be
  copied into caches and archives that you cannot reach. A false positive costs a few seconds.
  Tune checks to be strict.
- **These layers stop accidents.** They are not a wall against a person or an agent that is
  deliberately trying to get around them. Hooks can be skipped; see
  [what the layers cannot catch](#what-these-layers-cannot-catch).

## Where leaks come from

The patterns below were abstracted from real clean-ups. They are the reason for most of the
rules that follow:

- Ambient package-manager configuration writing a client-scoped registry URL into a committed
  lockfile.
- Client-specific values written inline into integration tests that ran against deployed
  client environments.
- Client documents used as test fixtures because they were the easiest source of "real-world"
  examples.
- Client or former-employer names used as example values in source code, then bundled by the
  build tool into a published package, including its sourcemap.
- A "rename the name" fix applied to the working tree only, which left the original string
  reachable in history and signalled that something had been there.
- An AI agent reusing a string it had seen in tool output or earlier in the conversation.

## Layer 0: identity and account separation

Client work and personal or open-source work should not share an identity at any layer that has
push access. If the SSH key that can push to a client's host has no permission on your personal
account, you cannot push client-coupled code to your personal repository by accident: the wrong
remote rejects you. No content scan fails closed as reliably as a server-side authorisation
failure.

**SSH keys per identity.** Use a host alias per identity, each with its own key, and
`IdentitiesOnly yes`. Without that setting, ssh offers every key and the first one the server
accepts wins, which defeats the separation.

```
Host github.com-personal
    HostName github.com
    User git
    IdentityFile ~/.ssh/id_ed25519_personal
    IdentitiesOnly yes

Host github.com-customer-a
    HostName github.com
    User git
    IdentityFile ~/.ssh/id_ed25519_customer_a
    IdentitiesOnly yes
```

Check which identity an alias uses with `ssh -T git@github.com-personal`.

**Git author identity per directory.** Bind `user.name`, `user.email` and any signing key to a
filesystem location with `includeIf "gitdir:..."`, so commits carry the right identity without
anyone remembering a per-repository command.

**Every other tool that authenticates.** Apply the same idea to each:

- Browsers: one profile per identity.
- Shells: a per-project environment (for example direnv) that exports `AWS_PROFILE`,
  `NPM_CONFIG_USERCONFIG` and `GH_CONFIG_DIR` for that project only.
- npm: a per-client user config for the client's registry token, so your default `~/.npmrc`
  never contains it.
- `gh`: it uses HTTPS and a token, not your SSH keys, so SSH separation does not reach it. Give
  it a separate config directory per identity. Note that `gh repo clone` defaults to HTTPS.
  repo-aegis can pick the GitHub account per owner for you; see
  [configuration](configuration.md#setting-up-identities-a-walkthrough).

### Organisational responsibility: managed accounts

Everything above assumes the engineer controls their own GitHub setup and applies it
consistently. The highest-impact failure the author has seen is structural instead: when an
employer provides no managed GitHub accounts, people use individual accounts, and GitHub's
default visibility for a repository created under an individual account is **Public**. Someone
creates a repository for work code, does not toggle the visibility, and pushes. The window
between creation and the first push can be seconds, and none of the later layers help, because
they all assume the repository already exists.

The fix belongs to the employer, in order of strength:

1. **Managed accounts under an organisation with SSO**, with the organisation's default
   repository visibility set to Private and visibility changes restricted to administrators.
   This makes the failure structurally impossible, because individual accounts are out of the
   workflow.
2. **At minimum**, an organisation that every engineer joins, with default visibility Private,
   visibility changes restricted, and a rule that work repositories are created inside it.
3. "We told people to be careful" is not a control.

Where an organisation has managed accounts, add server-side enforcement that no client-side
bypass can skip: push protection with custom patterns registered from your marker list (a paid
GitHub feature), organisation-wide repository templates with the right `.gitignore` and checks,
restricted third-party app installation, and audit-log alerts on repository visibility changes.

If you are stuck without managed accounts, create repositories from the command line with the
visibility stated explicitly, and verify it before the first push:

```sh
gh repo create <owner>/<name> --private --source=. --remote=origin --push=false
gh repo view <owner>/<name> --json visibility
```

## Layer 1: remove ambient coupling

A project's state should depend on configuration that lives in the project, not in whatever your
machine's user-level configuration was last set to by unrelated work.

### Pin the package registry per project

Put a `.npmrc` (or the yarn or pnpm equivalent) at the project root that names the public
registry:

```
registry=https://registry.npmjs.org/
```

The cause is that some private-registry login commands (AWS CodeArtifact's
`aws codeartifact login --tool npm` is one) write the client's registry URL into the **global**
`~/.npmrc`. From then on, an `npm install` in any project on the machine goes through the
client's registry and writes that registry's URLs, which include the client's name and account
ID, into the project's `package-lock.json`. The leak is delayed and indirect: it happens at the
next unrelated install, long after the login command. Other cloud artifact registries have
similar behaviour.

Defences, strongest first:

1. A per-project `.npmrc` that pins the registry. It survives forgetting to log out.
2. Log out of the registry after each session.
3. Scope the client's registry to one shell with `NPM_CONFIG_USERCONFIG`.
4. A pre-commit check that refuses a lockfile diff containing any `resolved` URL that is not on
   the public registry. It works on a fresh machine with no marker list at all.

### Pin cloud profile and region per project

Export `AWS_PROFILE` and the region in a per-project environment file. Without it, `aws` and
`cdk` use whatever profile the shell last had, including a client's profile from another
terminal tab, and committed cloud configuration then carries the wrong account's IDs and ARNs.

### Tests against deployed environments

Take anything client-specific a test needs (an allowed email domain, an account ID, a hostname,
a role ARN) from environment variables, and skip the test when the variable is unset. The client
string never appears in source, contributors supply their own value, and CI is not pushed to
commit a default.

### Test fixtures: synthesise, do not capture

The easiest source of realistic fixture content is the client's own data. Resist it. Capturing
saves minutes and creates a permanent disclosure risk. Instead, derive the **structure** from
real examples and substitute synthetic content that exercises the same code paths.

- Name fixtures for the feature (`network-overview.md`), never for the client. A filename can be
  a marker.
- Use neutral content: `Acme`, `Example Co`, example domains, RFC 1918 address space, and
  obviously fake account IDs.
- If a real fixture is unavoidable, keep it outside the repository and load it by environment
  variable.
- The same applies to snapshot tests, seed data and recorded HTTP cassettes. Cassettes are the
  riskiest: they can hold authorisation headers, personal data and internal hostnames.

### Source-code literals: use neutral examples

When writing CLI help, README examples or default configuration, it is natural to reach for a
familiar name, and the familiar name is often a current or former client or employer. A name
does not have to be your current client's to leak.

- Use `acme-corp`, `example.com`, `<your-org>` and `customer-a` for every example value.
- Remember the build step: bundlers embed source string literals into the output. A name that
  only ever appeared in `src/` can ship in `dist/`.
- Sourcemaps duplicate it. They embed full source text (`sourcesContent`) and the source paths,
  which can include a directory named after a client.

### Build output and agent state

- `.gitignore` build output (`dist/`, `build/`, `cdk.out/`, coverage and tool caches) and prune
  anything already tracked.
- Add AI-agent and editor state directories to a **global** gitignore (`core.excludesfile`).
  A per-repository entry only works if you remember it in every new repository. Agent state
  files contain paths and session metadata, and a path such as `~/repos/<client>/...` is itself
  a marker. The slip this prevents is `git add -A` after an agent session.

### Classify each repository

Enforcement should depend on what a repository is. A workable set of classes:

| Class | Examples | Behaviour |
| ----- | -------- | --------- |
| public-eligible | Open-source work on a personal or organisation account, public or could become public | Strict: block every known marker |
| private-strict | Private repositories that might become public, or are backed up to a personal host | Same as public-eligible |
| customer-coupled | A client's own repository on the client's host | Block every **other** client's markers and the organisation-wide ones; allow this client's own |
| scratch | Local-only, never pushed | Advisory only |

The class decides whether enforcement happens. A second tag, the **engagement** (one client
relationship), decides which slice of the marker list applies. Without it, a "client repository"
class has two bad options. If hooks skip client repositories, client A's data can flow into
client B's repository unnoticed. If hooks apply the full list, the client's own name fires on
every legitimate reference, and people respond by passing `--no-verify` or deleting the client
from the list, which defeats the check everywhere.

So partition the markers by engagement and let each repository declare its engagements:

> deny set = every engagement's markers, except this repository's own, plus the always-block list

Inside client A's repository, client B's strings, internal codenames and client-specific email
patterns are still denied, and only client A's own strings pass.

Fail safe: a repository with no class defaults to the strict class, and a client-coupled
repository with no engagement is rejected with a request to declare one. Silently skipping a
misclassified repository defeats the pattern. In repo-aegis the class and engagement live in
`repo-aegis.class` and `repo-aegis.engagement` (per clone, in git config) or a
`.repo-aegis.yml` at the repository root, and `repo-aegis classify --apply` works them out from
the remote's GitHub owner. See [configuration](configuration.md).

## Layer 2: deterministic gates

### The marker list

A **marker** is a pattern that identifies something that must not appear where it should not.
The marker list is the load-bearing primitive: every gate, scan and audit in this guide reads
it, so build it first. For each client, include:

- Full name, short forms, abbreviations, product names and internal codenames.
- Domain names and internal hostnames you might paste while debugging.
- Cloud account IDs (12-digit numbers), and bucket names carrying a client prefix.
- Private-registry URLs.
- Partner and SaaS identifiers issued for the engagement.
- **SaaS tenant identifiers.** These are easy to overlook and appear in pasted URLs: the
  client's workspace subdomain on each SaaS product it uses, space keys and ticket prefixes in
  a wiki or issue tracker, tenant domains for identity and productivity suites, and their
  GitHub organisation and Pages URLs. Include percent-encoded variants.
- Names of the client's sibling tools and packages. Mentioning one in a design document as
  something you will integrate with is itself a leak.

Then a short **always-block** list of strings that are sensitive everywhere: internal
codenames not tied to one client, and secret-shaped strings. Per-client email addresses belong
in that client's list, not in the always-block list, because `name@client.example` is expected
inside the client's own repositories.

Practical notes:

- Store the list **outside every repository**, private to your machine. The list names every
  client you work for, so it is itself sensitive. In repo-aegis it lives in the registry,
  `~/.config/repo-aegis/engagements.yaml`.
- Write markers as regular expressions with a boundary so they are precise
  (`acme-?corp[^a-zA-Z0-9]`, not `acmecorp`). Portable regular expressions matter: word-boundary
  escapes behave differently across `grep` implementations.
- When a benign string matches, narrow the pattern. Do not drop it.
- Keep it in sync across machines by an encrypted dotfiles repository, a password manager note
  or an encrypted cloud folder, depending on your threat model.

### What to gate

- **Pre-commit:** scan the staged content (not the working tree) against the deny set.
- **Pre-push:** scan what is about to leave, including the case of a force-push, where the range
  of new commits is less obvious.
- **CI:** run the same scan on the server, so skipping a local hook does not get past it. Handle
  the case where the base commit is no longer reachable.
- **Generic secrets:** add a general secret scanner for credential shapes (such as gitleaks or
  trufflehog) next to the marker scan, and turn on the host's push protection where it exists.
  The marker scan knows your names. The secret scanner knows token formats.
- **Built artefacts:** scan `dist/`, tarballs and sourcemaps before publishing, as below.

### Scan what you build, not only what you write

Marker hooks scan source. Bundlers copy source literals into output, and sourcemaps copy the
whole source, so a name that passed the source scan can still ship. Run the marker scan over
the built output, including `*.js.map` and files that are gitignored, between the build and the
publish. In npm, a `prepublishOnly` script that builds and then scans makes it impossible to
publish a tarball with a marker in it unless someone passes `--ignore-scripts`.

## Layer 3: AI coding agents

An agent absorbs whatever it is shown. A client name that appears in a working directory path,
in `git log` output or in a tool result will be reused in the next commit message, plan or
test fixture, unless something stops it. In the author's experience an agent also wrote a
recap that named a client in plain text and, while cleaning up an earlier leak, wrote a
commit message that explained what was being removed. Both slips happened because there was no
hard rule and no check.

Three kinds of control, from weakest to strongest:

**A written rule.** A global instruction file (for Claude Code, `~/.claude/CLAUDE.md`) that
states the rule absolutely, lists the surfaces (source, tests, docs, scratch directories,
commit messages, pull-request text, package metadata, build output), gives positive guidance
(use `customer-a`, `<redacted>`, `example.com`) and says how to detect a public repository
(`git remote -v`, `gh repo view --json visibility`). Add a short per-project reminder to
projects that are public.

**The limit of a written rule.** In the author's experience, **recency beats rules**: a rule
in an instruction file loses to a string that has come up dozens of times in the current
session. A rule shapes defaults. It does not filter a specific token. This is why the
deterministic checks are not redundant with the rule.

**Checks that run as code.** Hooks around the agent's tool calls:

- **Before a write:** scan the content about to be written and refuse a marker. Good for blunt,
  high-confidence cases.
- **After a write:** scan the file that was just written and report the hit in a form the
  agent can act on. The author's experience is that concrete verification feedback produces a
  more reliable correction than a refused call, and that it suits subtle slips such as a name
  buried in a long generated example. Whether a given agent shows hook output to the model
  depends on the agent and its exit-code convention, so verify it for yours. repo-aegis does
  not depend on it for its blocking checks (see the README).
- **On tool output:** the dominant route for an agent to learn a client's name is the output of
  its own tools. Redacting markers from tool results before the agent sees them addresses the
  cause, at the price of the agent no longer being able to reason about the literal string
  when you want it to (incident response, audits). A session-scoped switch for those cases is
  worth having.
- **On the destination:** check where a push, pull request, release or publish is going, not
  only what it contains. This is the part content scanning cannot do, and it is what
  repo-aegis's egress guard does.

Two further points. Habits an agent picks up mid-session do not survive to the next session,
so a hook is the way to make a good habit durable. And when the work itself is about leaks
(incident response, audits, writing a guide like this one), the markers are unavoidably in the
conversation and the slip risk is at its highest. Treat that as the time for the strictest
settings, not the loosest.

For an organisation, AI coding tools are currently mostly individual-developer products with
per-user configuration, so central policy is hard to push down. The options, from most to
least central, are: route model traffic through an organisation-managed gateway that can
enforce policy server-side; push configuration to machines with your device-management tool;
commit a generic instruction file into repository templates (keep it generic, because it is
visible in the repository); and use hooks that consult a central policy. Plan for the gap
instead of assuming a vendor will close it.

## Layer 4: periodic audits

Some leaks get through: a commit made with `--no-verify`, a hook that was not running, a
client whose markers you had not added yet.

- **On engagement day one**, before writing code, add the client's markers. The first leak
  from a new client is structurally undetectable if the list has not heard of them. A checklist:
  legal name and abbreviations, product names, primary and sub-domains, each cloud account ID,
  bucket prefixes, private-registry URLs, internal hostnames and SSO domain, partner IDs, and
  internal project codenames, which are often the most sensitive of all.
- **Keep a registry** that maps each engagement to its markers, start and end dates and active
  repositories, so offboarding scans are accurate and markers can be pruned safely.
- **At offboarding**, sweep every repository touched during the engagement, **including history**
  (`git log --all -G '<pattern>'`), and every published artefact (packages, bundles, container
  images), because a registry holds its own copy. Mark the engagement ended, but keep its
  markers for a safety margin, such as a year. A pruned marker that turns out to still matter
  is invisible until the next leak.
- **On a schedule**, search public code for your markers (for example with `gh search code`
  from a scheduled workflow, with the query list kept private), and re-curate the list every
  quarter.
- **Audit more than commits.** Repository description, topics and About text, branch names,
  tags, and release notes are all published, and none of them is in a commit.

Detection is the last line of defence: by the time a sweep finds a leak, it is already public.

## What these layers cannot catch

Read this last. It says where not to trust the rest.

**Hooks can be skipped or never run.**

- `git commit --no-verify` and `git push --no-verify` skip every client-side hook.
- Edits made in a hosting provider's web UI never pass a local hook. Server-side push
  protection is the only defence there.
- Cloud IDEs and some tool integrations may not honour your hooks path.
- A hook can be **configured, installed and disconnected**. A repository-local `core.hooksPath`
  beats a correct global one, and if it points at a directory with no hook scripts, the scan
  silently never runs. Nothing reports it, because "protected and clean" and "not protected at
  all" look the same: no output. In the author's case it was found only because four sibling
  repositories printed a "clean" line in the same minute and one did not, and most repositories
  on the machine turned out to be affected. Make the scanner announce that it ran, check that
  the hook is wired (not merely installed), and when you find a disabled guard, record the
  file's metadata before you repair it, because repair overwrites the evidence.

**Publish surfaces that never pass a hook.** Release asset uploads, issue, pull-request and
discussion bodies, workflow logs (public for public repositories), workflow artefacts, Pages
sites, gists, and forks made before you can purge a leak. These are why repo-aegis checks the
destination of `gh` commands and not only `git push`.

**Metadata that is indexed but is not source.** A client-scoped dependency name in a manifest
exposes the client's package scope through the dependency graph. Submodule URLs and git
dependency URLs do the same. Repository description and topics are set outside git.

**Binary and built content.** A text diff does not see inside an archive, a large-file pointer
shows the pointer and not the file, and compiled output can embed the source path (so
`~/repos/<client>/...` ends up in a binary). Sourcemaps duplicate every source marker.

**Branch names and commit messages that describe the clean-up.** A branch named after the
string being removed tells a reader exactly what to search for, and it stays in network graphs
and caches after deletion. Use bland names for remediation branches, delete them after the
merge, and keep fix commit messages neutral.

**An incomplete fix is worse than none.** Renaming a string in the working tree with a
follow-up commit leaves the original in every earlier commit, reachable by anyone with a SHA,
and the existence of the fix signals that there was something to find. A check that only reads
the current tree passes. Either do the full history rewrite and cache-verification process, or
leave the history alone, because the half-fix has the costs of both. Always audit history, not
just the current tree.

**The marker list is incomplete by definition.** You learn some of a client's internal
hostnames and codenames only after weeks of work. Day-one onboarding narrows the gap and never
closes it.

**Caches outlive everything.** Once a string has been public, even briefly, assume that
archives, code-search indexes and commercial scanners have a copy. That is why prevention
matters more than detection, and why the audit schedule should be daily, not weekly, for the
markers that matter most.

## A starting set

If you do only five things, do these in this order:

1. **Build the engagement registry and markers** on day one of each engagement. Every other
   gate reads them.
2. **Add the agent rule** to your global instruction file, even before the markers exist. It
   shapes behaviour in the abstract.
3. **Separate identities**, including the `gh` CLI, with `IdentitiesOnly`, per-directory git
   identity and per-project environment.
4. **Install the pre-commit and pre-push gates** and a general secret scanner, both reading the
   markers, and turn on the host's push protection.
5. **Scan built artefacts** before every publish.

Add the rest as you hit near misses. Do not try to deploy everything at once.

## Using repo-aegis

repo-aegis implements the parts of this guide that are about enforcement on one machine: the
engagement registry and per-repository deny set (Layer 1 and 2), the pre-commit, pre-push and CI
checks (Layer 2), the agent write, shell and egress hooks plus a strict "leak context" mode
(`repo-aegis context on`) (Layer 3), and `repo-aegis audit` for sweeps (Layer 4). It does not do identity separation by itself beyond choosing the GitHub account per
owner, and it is not an organisation-wide DLP product. Start with the [README](../README.md),
then [why the checks are shaped the way they are](why-ai-coding.md) and the
[design notes and threat model](design/README.md).
