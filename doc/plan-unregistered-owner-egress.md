# Plan: refuse egress to unregistered owners (issue #151)

Status: decisions confirmed 2026-11-02, after an internal review and an
independent security review (§8). Ready for implementation. Source read at
`e1e88ca` (v0.10.3).

## 1. Problem

The egress guard classifies a destination by its owner but never refuses an
owner. A destination under an owner that is in neither `personalOrgs` nor any
engagement's `githubOrgs` resolves (in `withLocalClass`,
`packages/core/src/egress-policy.ts:346`) to `private-strict`, visibility
`unknown`, `classKnown: false`. From there:

- **Rule e** (cross-org) needs a source working tree. Only `git push` and a
  payload file inside a checkout have one. `gh issue create --body …`,
  `gh pr comment`, `gh api -X POST …/issues -f body=…` and a body file in the
  session scratchpad have none, so rule e never runs.
- **Rule f** scans against an empty deny set (the owner belongs to no engagement).
- **Rule g** asks for a person. Any live approval that matches satisfies it,
  and a `*` approval matches every owner (`egress-approval.ts:229`).

With `approve '*'` live, an agent can post an issue, a comment or a PR body to
any repository on GitHub.

## 2. Decisions

These settle the issue's open questions and the points the review in §8 raised.
D3, D5, D7 and D10 change behaviour beyond the issue's text. The operator
confirmed all four on 2026-11-02, on condition that D5, D7 and D10 are
documented (§4, PR 7) and that every refusal explains itself (§3.9).

| # | Decision |
|---|---|
| D1 | **Rule h**: refuse non-interactive egress to an owner that is not registered. No approval satisfies it. A human at a TTY passes it, and so does `REPO_AEGIS_EGRESS_HUMAN=1`, which has the same human-only contract as rule g. Code: `UNREGISTERED_OWNER_EGRESS`, the same code at all three layers. |
| D2 | **"Registered" means** `owner ∈ personalOrgs ∪ ⋃ engagements[*].githubOrgs`, lower-cased, or `owner/repo ∈ allowedUpstreams` for the verbs in D6. Nothing else counts: not the destination cache, not a local `repo-aegis.class`, not an explicit approval. An agent can write each of those. |
| D3 | **The authenticated `gh` login is not trusted implicitly.** *(Confirmed.)* The issue suggested treating it as personal without listing it. Two reasons against: (a) on a machine with several `gh` accounts, the active one can be an employer account, and treating it as "personal" would put a work owner inside the personal boundary; (b) in the shim and pre-push layers the active account depends on the command's environment (`GH_CONFIG_DIR`, `GH_TOKEN`), which the agent controls. Instead, `doctor` reports the login when it is not listed (§3.8). |
| D4 | **Rule h is skipped (fails open) only when no registry file exists, or the registry declares no owners.** *(Revised after the independent review, §8.4 F11; confirmed 2026-11-02, including the cost for encrypted registries.)* A registry that exists but is **unparseable or encrypted** does not skip rule h. An agent that can write the file could otherwise switch rule h off at every layer by appending one bad YAML line, which looks like corruption rather than an attack. In that state rule h refuses every non-interactive egress that has a destination: no owner can be confirmed, so none is admitted. A person at a terminal can still publish. `doctor` reports `REGISTRY_UNREADABLE` as a **failure**, not a warning. Cost: an operator who keeps the registry encrypted at rest gets no non-interactive publishing until it is decrypted. Each skip or refusal says which state applied. |
| D5 | **An unresolved write fails closed under rule h.** *(Confirmed; must be documented.)* A write whose owner cannot be named offline (a GraphQL mutation addressed by node id, a `gh api` write to an endpoint with no owner in its path, an implicit target overridden by an earlier `export GH_REPO=…`) counts as unregistered. This departs deliberately from "context rules fail open". The context is not missing; what is known is that a write goes to an owner nobody has vouched for. #113 took the same stance. Rule h refuses these before rule g, so a `*` approval no longer covers a GraphQL mutation. §3.7 gives an optional, network-only way to lift the refusal. |
| D6 | **Forks: `allowedUpstreams`**, a list of exact `owner/repo` entries with no wildcards. It lifts rule h only for `gh pr create`, `gh pr edit`, `gh pr comment`, `gh pr review`, `gh issue create`, `gh issue edit` and `gh issue comment`. It does not lift rule h for `git push`, merge, release, repo or workflow verbs, or `gh api` writes. An upstream does not become "ours": rules e–g still apply, and a `*` approval does not cover it (D7), so a publish still needs a person or an explicit `approve <owner>/<repo>`. |
| D7 | **`*` approvals cover only `personalOrgs` owners**, plus destination-less verbs (`npm publish`), which were already covered only by `*`. A customer's public repository now needs `approve <org>/*` or `approve <org>/<repo>`. *(Confirmed; must be documented.)* This is stricter than the issue's text, which scoped only `*`. `<org>/*` and `<org>/<repo>` behave as before, but rule h runs first. |
| D8 | **Adding an owner needs a person.** `engagements add --personal-org`, `--github-org`, the new `upstreams add`, and `init`'s migration of `classify.yml` into owner lists all refuse without a TTY on stderr, and they do not honour any env escape. This mirrors `approve`. Without this gate, rule h is one non-interactive command away from a bypass (§8, S1). *Extended 2026-11-02 after the PR 5 review:* emptying the owner set is the same bypass, because D4 skips rule h for a registry with no owners. So these also need a TTY: `init --force` or any other overwrite of a registry that declares owners, upstreams, markers or `always_block`, and any removal that leaves zero owners when there was at least one before. Removals that leave at least one owner stay ungated. Every mutator validates the new registry in memory before writing, so no command leaves an unparseable file behind. |
| D9 | **Placement:** rule h runs immediately after destination resolution, before rule e and before the #114 visibility lookup. It is offline and cheap, and it avoids a `gh repo view` against an owner the guard is about to refuse anyway. Lettering: the issue's name "rule h" is kept for traceability. The old trailing "h: scratch → allow" row in the design doc becomes the unlettered "otherwise allow". (The code never special-cased `scratch`.) |
| D10 | **A non-interactive `gh pr create` must name its target.** *(Confirmed; must be documented.)* New shape rule `GH_PR_CREATE_IMPLICIT_TARGET`: from a shell with no person, `gh pr create` must carry `--repo`, `GH_REPO` or a URL positional. Otherwise gh picks the base repo itself, from `remote.*.gh-resolved` and remote priority. That is config the agent can edit, so the destination depends on state the guard reads at a different moment than gh does (§8.4, F2 and F6). *(The independent review corrected the first draft's rationale: without a TTY, gh does not consult the API for a fork's parent. It does so only when it can prompt, which a pty wrapper would allow, see S10.)* It is the `gh` counterpart of rule a's `PUSH_IMPLICIT_TARGET`. It is unconditional, so it needs no registry, and an approval does not lift it, because the fix is to re-issue the command, not to get permission. It covers `gh pr create` only; widening it to other `gh` write verbs is a separate change. |

## 3. Design

### 3.1 Rule h in `decideOne` (`packages/core/src/egress-policy.ts`)

```ts
// after resolve(), BEFORE refreshDestinationVisibility()
if (destination !== null && !opts.humanPresent) {
  const owners = registeredOwners(opts.registry);          // Set<string>, lower-cased
  if (owners.size > 0 && !ownerAdmitted(destination, intent, owners, opts.registry)) {
    return deny("UNREGISTERED_OWNER_EGRESS", reasonH(verb, destination), destination);
  }
}
```

- `registeredOwners(registry)`: `personalOrgs ∪ githubOrgs`. Put it in a new
  `packages/core/src/registered-owners.ts` so that `check.ts`, `doctor` and the
  approval matcher share one implementation.
- `ownerAdmitted`: returns true when every candidate owner of the destination
  is registered. Candidates come from §3.3; there is usually one. It also
  returns true when the destination is `owner/repo ∈ allowedUpstreams` and
  `intent.verb` is in the D6 set. `destination.unresolved` → false.
- `opts.registryState: "loaded" | "missing" | "unreadable"` is new and passed
  by every caller. "Encrypted" counts as `"unreadable"`. Per D4 as revised:
  - `"missing"` → rule h is skipped;
  - `"loaded"` with no owners → rule h is skipped;
  - `"loaded"` with owners → rule h judges normally;
  - `"unreadable"` → rule h refuses every non-interactive egress that has a
    destination.

  Today all three callers fall back to an empty registry on any error. They
  must now report which case occurred, so that "empty because missing",
  "empty because unreadable" and "loaded and empty" cannot be confused.
- The reason names the destination and the fix, never the registry contents:
  `"<verb> → <owner>/<repo>: owner <owner> is not registered (in neither
  personalOrgs nor any engagement). No approval covers this. If <owner> is
  yours, a person adds it from a terminal: repo-aegis engagements add
  --personal-org <owner> (or --github-org for a customer); for an upstream you
  contribute to, repo-aegis upstreams add <owner>/<repo>."` It names only the
  destination owner, which is already in the command; it does not list the
  registered owners.
- Update the load-bearing comment at the top of the file: rule h is the
  documented exception to "context rules fail open" (D5), and it is a refusal
  that approvals do not satisfy.

### 3.2 Approval scoping (`packages/core/src/egress-approval.ts`)

`findApproval(destination, ref, path, now)` gains a `personalOrgs: ReadonlySet<string>`
parameter. Rule: `a.org === "*"` matches when `destination.org ∈ personalOrgs`,
or when the call is destination-less (`findApprovalDefault`'s `{*,*}`
sentinel, used only for `npm publish`). Keep that sentinel distinct from
`unresolved: "graphql-mutation"`, which also uses `*/*`. Rule h refuses an
unresolved destination before rule g in a non-interactive shell, but the
matcher must not depend on that ordering. Pass an explicit
`destinationless: true` instead of overloading `*`.

Callers to update: `findApprovalDefault` (egress-policy), `check.ts:496`
(pre-push), and any `approve --list`/test helpers. `approve <owner>/…` for an
unregistered owner still mints, but prints a warning that rule h will refuse
non-interactive egress there until the owner is registered. A `*` mint prints
the scope it now has: "personalOrgs owners only".

### 3.3 Destination resolution: name the owner gh will actually write to

Rule h is only as good as the resolver. Today these reach a different owner
than the resolver reports (§8, S2–S6). Each fix lands in
`egress-intent.ts` / `resolveDestinationOffline`.

*Governing principle (added after the PR 2a review).* A parser that lists
the shapes it understands will always miss some. So any shell segment that
invokes `gh` (directly, through a wrapper or interpreter, or through an
alias) or `git push`, and whose verb or target the parser cannot fully
determine, yields an **unresolved** intent, never "no intent". That covers an
unknown command word or group, an alias the guard cannot expand, `sh -c` or
`eval` text it cannot tokenise, and a parse or expansion error. Rule h then
refuses it for a caller with no person present (D5). Only an explicit
read-only allowlist of gh groups yields no intent.

*Backstop (added after the second PR 2a review).* The parser cannot model
every shell construct: reserved words, `find -exec`, `<(…)`, functions,
heredocs fed to `sh`, `python -c`. So after parsing, a linear scan of the
raw command text (heredoc and interpreter text included) looks for a `gh`
token followed by a gh command word, or `git` followed by `push`,
`send-pack` or `http-push`. Any such mention that no parsed intent accounts
for becomes an unresolved intent. The accepted false positive is a literal
quoted mention such as `echo "gh issue create"`, which is refused only
for a caller with no person present and only when the registry declares
owners.

1. **`GH_REPO`.** Leading `GH_REPO=…` assignments and `env GH_REPO=…` are
   currently skipped as "wrappers" (`egress-intent.ts:362`). Capture the value
   as `intent.envRepo`; it applies when there is no `--repo`, which is gh's own
   precedence. An earlier segment of the same command that runs
   `export GH_REPO=…` or `GH_REPO=…` on its own makes the intent
   `unresolved: "env-override"`. In the **shim**, `egress-check` reads its own
   `process.env.GH_REPO`, which is exactly the value the real `gh` will see,
   and passes it as `envRepo`.
2. **Positional targets.** `gh pr|issue <verb> https://github.com/<o>/<r>/(pull|issues)/<n>`,
   and `gh repo edit|create <o>/<r>`, name their repository positionally. Parse
   these into `intent.positionalRepo`. When `--repo`, `GH_REPO` and a URL
   positional disagree, every one of them is a candidate and all must be
   registered.
3. **Implicit base repo.** For a `gh` verb with no explicit target, gh does not
   simply use `origin`. It honours `remote.<name>.gh-resolved`, set by
   `gh repo set-default` and writable by anyone with `git config`, so no TTY is
   needed. The value is either `base`, which selects that remote, or a full
   `owner/repo`, which selects **that repository**, whatever the remote's URL
   is (§8.4, F2). Otherwise gh takes the first remote in the priority order
   `upstream`, `github`, `origin`, others. Newer gh may instead fail and ask
   for `gh repo set-default`. Without a TTY, gh does not look up a fork's
   parent. Candidate set:
   - a `gh-resolved` value of `base` → that remote's owner;
   - a `gh-resolved` value of `owner/repo` → that repository alone;
   - any other value → `unresolved: "gh-resolved"` (fail closed, D5);
   - no `gh-resolved` → **every** GitHub remote of the cwd, including remotes
     on ssh aliases, which gh translates itself.

   Rule h requires every candidate to be registered. A fork checkout whose
   `upstream` belongs to an unregistered owner is refused unless that upstream
   is in `allowedUpstreams`, which is the intended workflow.
4. **`gh api` endpoints with no owner in the path.** `parseApiEndpoint` returns
   null for `repositories/<id>/…`, `gists`, `projects/…` and so on, and the
   resolver then falls back to the cwd's origin. For **mutating** calls, classify
   the endpoint instead:
   - `repos/<o>/<r>/…` → that owner;
   - `orgs/<o>/…` → that owner;
   - `{owner}` placeholders → the cwd (gh fills them from the cwd), but only
     when the placeholder **is** the owner or repo segment. The query string
     is split off first. A placeholder elsewhere (`repos/stranger/r/issues?ref={branch}`,
     `…/git/refs/heads/{branch}`) leaves the literal owner/repo as the
     destination; any other placeholder in the owner or repo segment →
     unresolved. *(Added after the PR 1 review: the old code returned null for
     any `{` in the path, which attributed `stranger/r` writes to the cwd.)*
   - `user`, `user/…` → the authenticated account's own resources, exempt from
     rule h;
   - `markdown`, `markdown/raw` → read-only rendering, not egress;
   - anything else (including `repositories/<numeric-id>/…` and `gists`) →
     `unresolved: "opaque-endpoint"`.

   Before matching, reject endpoints containing `..`, `%2f`/`%2F` or an empty
   segment (`//`), as `unresolved`. Otherwise `repos/acme/x/../../stranger/r/issues`
   parses as `acme` (§8.4, F12).
5. **`git push` URL rewriting and ssh aliases.** Resolve the push destination
   with `git remote get-url --push --all <remote>`, which applies `insteadOf`,
   `pushInsteadOf` and `remote.<name>.pushurl`, and returns every push URL.
   Every URL is a candidate. (The first draft named `git ls-remote --get-url`;
   the review verified that it ignores `pushInsteadOf` and `pushurl`, §8.4 F7.)
   For a host that is not in a `github.com[-alias]` form, read `~/.ssh/config`
   with a **small pure parser**: `Host` and `HostName` only, with no `Include`
   and no `Match`. Accept `HostName` ∈ {`github.com`, `ssh.github.com`}. Do
   **not** run `ssh -G`: it evaluates `Match exec`, the file can be written by
   the agent, and the hook runs outside the agent's sandbox (§8.4, F8). Pre-push
   needs none of this. The review verified that git passes the hook the URL
   *after* all rewriting (including `-c` and `GIT_CONFIG_*`), once per push URL.
6. **Harden `parseRemoteUrl`, and stop treating a null as "no destination".**
   Accept a case-insensitive host, an optional port, a trailing dot,
   `ssh.github.com`, `www.github.com`, any ssh user, and an optional leading
   `/` in the scp path. The review found each of these returns null today
   (§8.4, F4). For `git push` with a URL-shaped remote, and for any `gh` repo
   verb, a destination that still does not resolve is
   `unresolved: "opaque-url"` and rule h refuses it (D5). Only `npm publish`
   is legitimately destination-less. A remote that is plainly a local path, or
   a non-GitHub host the parser does understand, stays out of scope as before.
7. **gh flag syntax.** gh (pflag) accepts `-Rvalue` and `-R=value` as well as
   `-R value`. The parser understands only the last form. As verified against
   the built parser:
   - `gh issue create -Rstranger/r --body x` → an intent with no repo, so the
     resolver falls back to the cwd;
   - `gh api -XPOST repos/stranger/r/issues -fbody=hi` → **no intent at all**.

   Normalise every single-dash token longer than two characters into
   `[-X, value]`, stripping a leading `=`, before the flag loop in `classifyGh`
   (§8.4, F1).
8. **A per-verb table of the positionals and flags that name a repository**
   (§8.4, F9), replacing ad-hoc parsing:
   - `gh issue transfer <n> <o>/<r>` (the destination);
   - `gh repo sync <o>/<r>`, `gh repo fork --org`;
   - `gh secret|variable set --org|--repo`;
   - `gh label clone`;
   - `gh issue develop --branch-repo`;
   - the PR/issue URLs and `gh repo edit|create` from item 2.

   A `gh` write verb whose shape is not in the table → `unresolved`.
9. **`gh gist create`** belongs to the authenticated account. It is not
   attributed to the cwd's origin, and a `*` approval never covers it. Today a
   personal `*` approval covers a public paste (§8.4, F10).

### 3.4 Environment overrides on an egress segment — new shape rule

`REPO_AEGIS_HOME=…`, `REPO_AEGIS_REGISTRY=…`, `REPO_AEGIS_VISIBILITY_LOOKUP=0`,
`REPO_AEGIS_ASSUME_PUBLIC`, and `REPO_AEGIS_EGRESS_HUMAN` prefixed to a `gh` or
`git push` command reach the shim and the pre-push hook, which read their
registry and approvals from that environment. An agent can point them at a
registry that lists the stranger, or at a forged approvals file. The agent hook
judges with its own environment, so it is not fooled, but it currently only
*asks* on rule g. Add shape rule **b′** `EGRESS_ENV_OVERRIDE`: refuse an egress
intent whose own segment, or an earlier `export` in the same command, assigns
any of these:

- `REPO_AEGIS_*`;
- `HOME` (`paths.ts` derives the default home from it);
- `PATH` (the shim locates `repo-aegis` through it, so a fake that exits 0
  would do);
- `XDG_CONFIG_HOME`, `GH_CONFIG_DIR`, `GH_HOST`;
- `GIT_CONFIG*` (`GIT_CONFIG_COUNT/KEY/VALUE` rewrites the push URL; verified
  by the review), `GIT_SSH*` (including `GIT_SSH_VARIANT`), and
  `SRT_SSH_PROXY_COMMAND`, which the trusted sandbox ssh template evaluates
  (R9);
- `GIT_DIR`, `GIT_WORK_TREE` (and the `--git-dir`/`--work-tree` flags on a
  push), which move the repository the remote is read from (PR 2a review);
- `BASH_ENV`, `ENV`, `ZDOTDIR`;
- or uses `env -i` or `env -u` (§8.4, F3).

It also refuses `git -c` keys under `remote.*`, `url.*`, `core.sshCommand` and
`core.hooksPath` on a push segment (F7). It is unconditional like rules a–d,
and the code is distinct so the agent guide can explain it.

**Shape rule b″ `EGRESS_AFTER_STATE_CHANGE`** (§8.4, F6). Rule c allows `&&`,
so `git remote set-url origin <stranger-url> && git push origin main` and
`gh repo set-default stranger/r && gh issue create …` are judged against the
config as it is *before* the first segment runs. Refuse an egress segment that
follows, in the same command, any of:

- `git remote` or `git config`;
- `gh repo set-default`, `gh alias set`, `gh auth`;
- `export`;
- a redirect or write into `.git/`, `~/.ssh/config`, `~/.gitconfig` or the gh
  config.

The fix the message gives is to run the change as its own call; the guard
then judges the egress against the new state.

b″ only has to cover the same command. A change made in an earlier call,
such as `git config core.sshCommand …`, `url.*.insteadOf`, a git or gh alias,
or `GIT_SSH_COMMAND` in a startup file, is visible to the resolver on the next
call, because the resolver reads it then. *(PR 4 review: the resolver must
actually read these. An ssh override makes any non-literal-github.com ssh host
unresolved.)*

Together these close the hook layer. The shim and pre-push cannot distinguish
an override from a legitimate test environment, which is a residual risk
(§8, R2).

### 3.5 Pre-push parity (`packages/cli/src/commands/check.ts`)

`evaluateDestination` has its own implementation and does not call
`decideEgress`. Add rule h there, after `parseRemoteUrl` and before
`CROSS_ORG_PUSH`. Use `registeredOwners()`, `registryForBoundary()`'s
three-way state (it already distinguishes "missing" from "unreadable"), and
`isHumanPresent()`. The code is `UNREGISTERED_OWNER_EGRESS` (shared) and it is
audited through `auditRefusal`. Also pass `personalOrgs` to `findApproval`. The
hook digest changes, so `HOOKS_SCRIPT_STALE` already prompts operators to
reinstall. The pre-push *script* does not change, only the CLI it calls, so
check whether a digest bump is needed at all.

### 3.6 `allowedUpstreams` and the owner-mutating commands

- Schema (`packages/core/src/schemas.ts`): optional
  `allowedUpstreams: z.array(ownerRepoSchema)`. Each entry is `owner/repo`,
  each half validated with `orgNameSchema`'s charset, lower-cased, de-duplicated
  and parse-time validated like `personalOrgs`. The schema is additive with no
  `schemaVersion` bump, by the same argument as `selfIdentity`. Older readers
  have no rule h, so ignoring the field is harmless.
- New `repo-aegis upstreams add|remove|list <owner>/<repo>`. `add` is TTY-gated
  (D8); `remove` and `list` are not, because removing only tightens. The
  mutation goes through `registry-mutate.ts`, like `engagements add`.
- TTY gate (D8) on `engagements add` whenever `--personal-org` or
  `--github-org` is present, and on `init` when the migration would add owners.
  Factor the gate out of `approve.ts` into `requireTerminal(code, message,
  {stderrIsTTY})` with the same test seam. New error code `OWNER_ADD_NEEDS_TTY`.
- Audit record `registry-owner-add` on every successful owner or upstream add.

### 3.7 Optional, later: lift D5 for GraphQL mutations by live lookup

Rule h now hard-refuses every non-interactive GraphQL mutation, including
resolving a review thread on the operator's own PR. A lifting lookup in the
style of #114 (the network can only lift, never impose) would: extract **every**
node-ID-shaped token from the document and all variables (`-f/-F`, `--input`
JSON), both new-style (`PR_…`, `I_…`, `PRRT_…`) and legacy base64 IDs; query
`nodes(ids:[…]) { … on RepositoryNode { repository { owner { login } } } }`
with a 5-second timeout; and allow past rule h only if every id resolves and
every owner is registered. An opaque document, an id that cannot be extracted,
or a timeout leaves the refusal in place. This is a separate PR. Ship rule h
without it and measure how often the refusal fires first.

### 3.8 `doctor` / `status`

New `doctor` checks (`packages/cli/src/commands/doctor-checks.ts`). They make
network calls and are best-effort; when `gh` is absent or unauthenticated they
report `skipped`, not `fail`.

| Check | Fires when | Fix |
|---|---|---|
| `OWNERS_UNDECLARED` | the registry loads but declares no owners, so rule h is inert | `engagements add --personal-org <login>` (from a terminal) |
| `GH_LOGIN_UNREGISTERED` | `gh api user` login ∉ registered owners | `engagements add --personal-org <login>` |
| `GH_MEMBER_ORG_UNREGISTERED` | an org from `gh api user/orgs --paginate` is not registered | `--personal-org` or `--github-org`, or ignore: rule h will refuse it |
| `REGISTERED_ORG_NOT_MEMBER` (info) | a registered org is not in the account's memberships | none required (archived engagements are normal); informational |
| `REGISTRY_AGENT_WRITABLE` (warn) | Claude Code settings have no deny rule for writes under the registry directory | `install claude-md` (adds it, see §8, R1) |

As in `PERSONAL_ORG_UNREGISTERED`, org names appear only in the `fix` field and
in `--json`, never in a summary line. The membership list can contain customer
names, and doctor output can land in an agent transcript.

*Amended 2026-11-02:* other agent sessions on the same machine often switch
the active `gh` account, so the active account at the moment doctor runs is
arbitrary. Checking only the active account would give results that change
from run to run. Doctor therefore checks **every account logged in for
github.com** (from `gh auth status`). For each one it runs the calls with that
account's token passed to the child `gh` through the environment
(`gh auth token --user <login>`). The token is never printed, logged or
stored. Doctor **never** runs `gh auth switch`, because that would change the
account under other sessions. Each finding names the account it applies to;
`GH_LOGIN_UNREGISTERED` fires per account, and
`REGISTERED_ORG_NOT_MEMBER` uses the union of every account's memberships.
If listing accounts fails, doctor falls back to the active account and says
so in the check text.

### 3.9 Refusal messages

A refusal is the only thing the agent and its human see. A vague one teaches
them to work around the guard. Every refusal this plan adds or changes answers
five questions, in this order, in the `reason` string and in the stderr JSON
alike:

1. **What** was refused: the verb and the destination, using
   `describeDestination` (`gh issue create → stranger/repo`).
2. **Why**, in one plain sentence that names the rule's idea rather than its
   letter ("the owner `stranger` is not registered as yours or a customer's").
3. **Does an approval help?** State it either way. Rules h, D10 and the shape
   rules say "No approval covers this." Rule g says which approval would cover
   it. When a live approval exists but does not cover the destination (D7),
   say so and say why, because otherwise the operator believes the guard is
   broken.
4. **The fix, and who does it.** Give the exact command, and mark whether a
   person runs it from a terminal ("a person runs, from a terminal: …") or the
   agent re-issues the command ("re-issue as: …"). An agent must be able to
   tell from the text alone that it is not allowed to run the fix itself.
5. **Where to read more**: the code, and `doc/agent-guide.md#<code>`.

Never include registry contents, other owners, engagement ids, payload bytes
or matched strings (existing redaction rule). Keep the first sentence
self-sufficient: some hosts truncate the reason.

Templates. Wording is final in review, but the structure is not optional.

| Code | Message |
|---|---|
| `UNREGISTERED_OWNER_EGRESS` (named owner) | `gh issue create → stranger/repo: refused. The owner "stranger" is not registered (in neither personalOrgs nor any engagement), so repo-aegis cannot tell whether this repository is yours. No approval covers this. If "stranger" is yours or a customer's, a person runs, from a terminal: repo-aegis engagements add --personal-org stranger (or --github-org stranger under the engagement). If it is an upstream you contribute to: repo-aegis upstreams add stranger/repo (PRs and issues only). Agents: do not retry or reroute; report this to your human. [UNREGISTERED_OWNER_EGRESS, see doc/agent-guide.md]` |
| … unresolved GraphQL mutation (D5) | `gh api graphql (mutation): refused. A GraphQL mutation names its target by node id, so repo-aegis cannot tell offline which owner it writes to, and an unknown owner is treated as unregistered. No approval covers this (since 0.11.0 a '*' approval no longer does). Run it from a terminal, or use a gh command that names the repository (--repo <owner>/<repo>), which repo-aegis can check. …` |
| … opaque `gh api` endpoint (D5) | `gh api -X POST repositories/123/issues: refused. The endpoint does not name an owner (it uses a numeric id), so repo-aegis cannot check it. No approval covers this. Re-issue with the repos/<owner>/<repo>/… form of the endpoint, or run it from a terminal. …` |
| … upstream, verb not allowed (D6) | `git push → upstream-org/lib: refused. upstream-org/lib is an allowed upstream, but allowed upstreams accept only PRs, issues and comments, not git push. No approval covers this. Push to your fork and open a PR with gh pr create --repo upstream-org/lib. …` |
| … several candidate owners (§3.3.3) | `gh pr comment 12 → (no --repo): refused. This checkout has remotes under acme and stranger, and gh may post to either; stranger is not registered. No approval covers this. Re-issue with --repo <owner>/<repo>, or have a person set the default with gh repo set-default. …` |
| `GH_PR_CREATE_IMPLICIT_TARGET` (D10) | `gh pr create: refused. Without --repo, gh chooses the base repository from this checkout's remotes and gh-resolved config, which can change between this check and the run. No approval covers this; nothing is wrong with the destination, only with how it is named. Re-issue as: gh pr create --repo <owner>/<repo> …. [GH_PR_CREATE_IMPLICIT_TARGET]` |
| `PUBLIC_EGRESS_NEEDS_HUMAN` with a live `*` that does not apply (D7) | Existing message, plus: `A '*' approval (<id>, until <time>) is live, but since 0.11.0 '*' covers only personalOrgs owners; customer-a-org is a customer org. A person runs: repo-aegis approve customer-a-org/repo (or customer-a-org/*).` The owner named is the destination's own, which is already in the command. |
| `EGRESS_ENV_OVERRIDE` | `gh pr create: refused. The command sets REPO_AEGIS_REGISTRY, which would make the gh shim and pre-push hook read a different registry or approvals file than this guard. No approval covers this. Re-issue without the REPO_AEGIS_* assignment. …` |
| `EGRESS_PTY_WRAPPER` | `script … gh issue create: refused. Running a publish under script/unbuffer/expect gives it a terminal, and repo-aegis treats a terminal as a person. No approval covers this. Run the command directly; if it needs a person, ask your human for an approval. …` |
| `OWNER_ADD_NEEDS_TTY` | `engagements add --personal-org stranger: refused. Adding an owner tells repo-aegis that publishing there is safe, so only a person at a terminal can do it (the same rule as repo-aegis approve). Agents: ask your human to run this command themselves. …` |

**Mint-time messages** (`approve`): `approve '*'` prints
`Approved '*' for 15m: covers repositories under your personalOrgs only (not
customer orgs, not unregistered owners).` `approve stranger/repo`, where the
owner is unregistered, prints a warning that this approval will not help until
the owner is registered, and gives the `engagements add` / `upstreams add`
command.

Implementation: one `refusal()` helper in core builds the five parts, so that
the hook, the shim and pre-push cannot drift apart. `check.ts` currently words
its own messages; move it onto the helper. Note that `check.ts:478` already
prints `boundaryOrgs` in the `CROSS_ORG_PUSH` message and details, and that
list can contain customer orgs. Moving onto the helper removes it: name only
the destination owner (§8.4, F12).

## 4. Work breakdown (PRs, in order)

Each PR is small enough to verify in one session.

1. **Core: registered owners and rule h.** Add `registered-owners.ts`, rule h
   in `decideOne`, `registryState` plumbing through `hook-guard-egress.ts` and
   `egress-check.ts`, the new `EgressCode`, and the comment update. Tests in
   §5.1. No resolver changes yet, so behaviour changes only for already-resolved
   unregistered owners.
2. **Resolver hardening**: §3.3 items 1–4 and 6–9 (flag normalisation first,
   since every other parser fix depends on it); the §3.4 shape rules b′ and b″;
   D10's `GH_PR_CREATE_IMPLICIT_TARGET`; S11's alias resolution. This is the
   largest PR. Split it into 2a (parser: items 7, 8, 1, 2, S11) and 2c
   (resolution: items 3, 4, 6, 9, b′, b″, D10) if it will not verify in one
   session. This PR
   removes the bypasses. Without it, PR 1 can be routed around.
2b. **Human-presence hardening** (§8, S10 as revised by F5): wrapper detection
   for pty wrappers, multiplexers and interpreters; the `EGRESS_PTY_WRAPPER`
   shape rule; the text-level refusal of `approve` and owner adds in agent
   commands; and the agent-ancestry check in `requireTerminal()`. It blocks the release because D1 and D8 rest on the
   TTY test.
3. **Approval scoping** (§3.2) and the warnings at mint time.
4. **Pre-push parity** (§3.5) and git URL resolution (§3.3 item 5).
5. **Registry gates and `allowedUpstreams`** (§3.6). **This must ship in the
   same release as PR 1.** Without the TTY gate, rule h can be undone with one
   non-interactive command.
6. **`doctor` checks** (§3.8) and the `install claude-md` deny rule.
7. **Docs.** Each behaviour change gets an entry that states what changed,
   why, and how to recover:
   - `doc/design/egress-guard.md`: the rules table (h, b′, D10's shape rule,
     the pty rule); the §1 resolution paragraph (candidate owners, `GH_REPO`,
     URL positionals, opaque endpoints, `insteadOf`/ssh aliases, and the
     remaining fork gap R5); the threat-model and locked-decision rows. Plus
     three dated "*Added …*" paragraphs in the doc's existing style:
     - **D5**: unresolved writes fail closed under rule h. Why it departs from
       "context rules fail open"; that a `*` approval no longer covers GraphQL
       mutations; the workarounds (a `gh` verb with `--repo`, the
       `repos/<o>/<r>/…` endpoint form, or a terminal); and that §3.7's lift
       may follow.
     - **D7**, in §4a (approvals): `*` covers `personalOrgs` owners and
       destination-less verbs only; customer orgs need `<org>/*` or
       `<org>/<repo>`; upstreams need `<owner>/<repo>`. Include the scope
       table: approval form × owner kind (personal, customer, upstream,
       unregistered) → covered or not.
     - **D10**: why a non-interactive `gh pr create` needs `--repo` (gh can
       pick a fork's parent), the parallel with `PUSH_IMPLICIT_TARGET`, and
       that it is `gh pr create` only.
   - `doc/agent-guide.md`: a row in the error-code table for each new code
     (`UNREGISTERED_OWNER_EGRESS`, `EGRESS_ENV_OVERRIDE`, `EGRESS_PTY_WRAPPER`,
     `GH_PR_CREATE_IMPLICIT_TARGET`, `OWNER_ADD_NEEDS_TTY`), with recovery
     text that matches §3.9; the rule that an agent never adds owners or
     upstreams; and the change to what `*` covers.
   - `doc/agent-install.md`: lines 261–302 and 678–683 currently have the
     **agent** run `engagements add --personal-org/--github-org`. Rewrite them
     as a step the human runs.
   - `doc/cli-reference.md`: the `approve` scope semantics, `upstreams`, and
     the TTY requirement on owner adds; matching `--help` text in `program.ts`.
   - CHANGELOG 0.11.0, under a **"Stricter (may refuse what 0.10 allowed)"**
     heading, one bullet each for rule h, D5, D7, D10 and the owner-add TTY
     gate, each ending in its recovery. Lead with "run `repo-aegis doctor`".
8. *(optional)* §3.7 GraphQL lift.

Release PRs 1–5 (including 2b) together as a minor version (0.11.0). This is a deliberate
tightening, and an operator whose `personalOrgs` is incomplete will see
refusals. The CHANGELOG entry leads with "run `repo-aegis doctor`".

## 5. Tests

Pin nondeterminism. Use `REPO_AEGIS_VISIBILITY_LOOKUP=0` (already the suite
default), a temp `REPO_AEGIS_HOME`, stubbed `gh` for doctor, and a fixed
`now` for approvals.

### 5.1 `egress-policy.test.ts` (unit, injected resolver/approvals)

Registry fixture: `personalOrgs: [acme]`, engagement `customer-a` with
`githubOrgs: [customer-a-org]`, `allowedUpstreams: [upstream-org/lib]`.

- Rule h refuses each of the issue's five commands against `stranger/repo`
  from a non-interactive shell: `gh issue create --body x`,
  `gh pr comment --body x`, `gh api -X POST repos/stranger/repo/issues -f body=x`,
  `gh pr create --body-file <scratchpad>/b.md --repo stranger/repo`, and
  `git push git@github.com:stranger/repo.git main`. It refuses each **with no
  approval, with `*/*`, with `stranger/*`, and with `stranger/repo`**, and the
  approval finder is asserted not to be consulted.
- The same five against `acme/repo` give exactly today's decisions. Use a
  behaviour-comparison table that runs the v0.10.3 expectations unchanged.
- `customer-a-org/x` passes rule h; a `*/*` approval no longer satisfies rule g
  there, while `customer-a-org/*` does (D7).
- `humanPresent: true` passes rule h.
- `registryState` `missing` or loaded-but-no-owners → rule h skipped, with the
  note present. Loaded with owners → on. `unreadable` (a parse error, or an
  encrypted file) → refused even for an owner that the unreadable file would
  have listed (D4 as revised, F11).
- `allowedUpstreams`: `gh pr create --repo upstream-org/lib` passes rule h but
  still hits rule g (public, no `*` cover; `approve upstream-org/lib` covers
  it). `git push` and `gh api -X POST` to `upstream-org/lib` are refused by
  rule h. `upstream-org/other` is refused.
- Rule h precedes rule e and the visibility lookup: a stubbed lookup is asserted
  not to be called for an unregistered owner.
- An unresolved GraphQL mutation is refused by rule h without a person, and
  passes with a person (then rule g as today).
- Case: `--repo Stranger/Repo` is refused, and `--repo ACME/x` is admitted.
- Property-based (fast-check): for any owner string drawn from the GitHub
  charset, and any registry whose owner set does not contain it, the decision
  for a non-interactive `gh issue create --repo <owner>/r` is
  `deny/UNREGISTERED_OWNER_EGRESS`, whatever the approvals store contains.

### 5.2 `egress-intent.test.ts` (resolver hardening)

- `GH_REPO=stranger/r gh issue create --body x`,
  `env GH_REPO=stranger/r gh …`, and `export GH_REPO=stranger/r && gh …` →
  owner `stranger`, or `unresolved` for the export.
- `gh pr comment https://github.com/stranger/r/pull/5 --body x` → `stranger`,
  from inside an `acme` checkout.
- `gh api -X POST repositories/123/issues -f body=x` and
  `gh api -X POST gists -f …` → `unresolved: "opaque-endpoint"`.
  `gh api -X POST markdown` → not egress. `gh api -X PUT user/starred/…` →
  self.
- A checkout with `origin=acme/fork` and `upstream=stranger/r`, with no
  `--repo`, gives candidates {acme, stranger}, so the command is refused. With
  `gh-resolved=base` on origin, the only candidate is acme. With
  `gh-resolved=stranger/r` on origin, the only candidate is `stranger/r`, which
  is refused (F2). With a junk value → `unresolved`.
- **Flag-syntax matrix (F1)**, property-based: every (flag, value) pair in
  {`-R`, `-F`, `-f`, `-X`, `-b`, `-H`} × {`-R v`, `-Rv`, `-R=v`} yields
  identical intents. Include `gh api -XPOST … -fbody=x` (today: no intent) and
  `gh api -XDELETE repos/stranger/r`.
- **URL table (F4)**: every GitHub form the review listed (upper-case host, a
  port, `ssh.github.com:443`, a trailing dot, `www.`, a non-`git` ssh user, a
  leading `/`) parses to the right owner. An unparseable URL-shaped push target
  → `unresolved: "opaque-url"`.
- `gh api` paths with `..`, `%2f` or `//` → `unresolved` (F12).
- Positional table (F9): `gh issue transfer 5 stranger/r`,
  `gh repo sync stranger/r` → `stranger`.
- `gh gist create` → self, and not covered by `*` (F10).
- Every b′ variable (`REPO_AEGIS_*`, `HOME`, `PATH`, `XDG_CONFIG_HOME`,
  `GH_CONFIG_DIR`, `GH_HOST`, `GIT_CONFIG_*`, `GIT_SSH*`, `BASH_ENV`,
  `env -i/-u`) as a prefix to an egress segment → `EGRESS_ENV_OVERRIDE`.
  `git -c remote.origin.pushurl=… push` → refused.
- b″ (F6): `git remote set-url … && git push …`,
  `gh repo set-default stranger/r && gh issue create …`, and
  `export X=1 && gh …` → `EGRESS_AFTER_STATE_CHANGE`.
- The text-level refusal (F5): `tmux new -d "repo-aegis approve '*'"`,
  `bash -c 'repo-aegis engagements add --personal-org x'`, and a heredoc that
  contains `upstreams add` → refused.

### 5.3 Subprocess / integration

- `hook-guard-egress.test.ts`: rule h end to end for Claude Code (deny, not
  ask), Codex and Gemini stdin, and the redaction oracle (the reason contains
  the destination owner and no registry entry).
- `check-egress.test.ts`: a pre-push to a bare remote whose URL parses to
  `stranger/r` → exit 2 `UNREGISTERED_OWNER_EGRESS`, with and without an
  approval. The same through `insteadOf`, `pushInsteadOf`, `remote.*.pushurl`
  (including a remote with two push URLs, one registered and one not → refused),
  and an ssh `Host` alias whose `HostName` is `github.com`, using a fixture
  `~/.ssh/config` in a temp `HOME`. The fixture also contains
  `Match exec "touch <sentinel>"`, and the test asserts the sentinel is **never**
  created (F8).
- `tests/shim-smoke.sh`: `GH_REPO=stranger/r` in the shim's environment →
  refused.
- `engagements-mutate.test.ts` / `upstreams.test.ts`: owner adds refuse without
  a TTY, `REPO_AEGIS_WAIVE_NONINTERACTIVE=1` and `REPO_AEGIS_EGRESS_HUMAN=1` do
  not help, and the test seam `stderrIsTTY: true` succeeds. Removes need no TTY.
- `doctor.test.ts`: each new check, with a stubbed `gh`, including
  gh-unavailable → `skipped`.

### 5.4 Refusal messages (§3.9)

Table-driven over every code and variant in §3.9. Each case asserts that the
reason:

- names the verb and the destination owner/repo;
- contains the approval sentence ("No approval covers this", or the specific
  approval that would cover it);
- contains the exact fix command, marked as either a person's step or an agent
  re-issue;
- contains the code;
- does **not** contain any other registered owner, engagement id or upstream,
  or the payload fixture (the redaction oracle).

Assert the same for the hook's stderr, the shim's JSON and `check --json`, so
the three layers cannot drift. One D7 case: a live `*/*` plus a customer
destination → the message names the `*` approval and explains why it does not
apply.

Run `test-critic` on the PR 1 and PR 2 suites before merge.

## 6. Compatibility and rollout

- **Who sees new refusals:** non-interactive egress to owners not listed in
  the registry. The most likely cause is the operator's own login or a second
  org missing from `personalOrgs`. `doctor` names both. Contributing to OSS
  upstreams now needs `upstreams add` (once per repo) plus an approval per
  publish, which is the intended friction.
- **No registry or no owners:** rule h is inert (D4). A `*` approval,
  however, now covers only `npm publish` there: D7 limits `*` to
  `personalOrgs` owners, and there are none. Such operators need
  `approve <org>/*` or `approve <org>/<repo>`; `approve '*'` says so when it
  is minted. *(Corrected during PR 3: this line used to say "no change",
  which contradicted D7.)*
- **Older binaries** reading a registry with `allowedUpstreams` ignore it,
  through `.passthrough()`.
- **Agents:** the guide's new rows tell an agent that `UNREGISTERED_OWNER_EGRESS`
  is never worked around and never fixed by the agent: it reports the refusal
  to the human and stops.

## 7. Out of scope

- Server-side enforcement (GitHub rulesets can't express "who may open issues
  on a stranger's repo").
- Non-GitHub hosts, and `--hostname` values other than `github.com`.
- `gh` invoked by absolute path, `--no-verify`, `-c core.hooksPath=` (existing
  non-goals).
- Enterprise Managed User owners (names containing `_`). `ORG_NAME_REGEX`
  cannot register them, so rule h refuses them permanently for agents; a
  person at a terminal still passes. PR 7 states this as a known limitation.

## 8. Security review of this plan

The review asks one question: once this plan ships, how does non-interactive
content still reach an owner nobody registered? Findings S1–S11 were found
reading v0.10.3 against the issue's proposal. Each one is **resolved in the
plan above**; the right-hand column gives where. Findings R1–R5 are residual
risks the plan accepts, with the reason.

### 8.1 Findings resolved by the plan

| # | Sev | Finding (v0.10.3 + issue proposal as written) | Resolution |
|---|---|---|---|
| S1 | **Critical** | `engagements add --personal-org <stranger>` has no TTY gate (`engagements-mutate.ts`), and `doc/agent-install.md` has agents run it. Rule h as proposed is undone by one non-interactive command, the same self-approval that `approve`'s TTY gate exists to prevent. | D8, §3.6, PR 5 ships with PR 1 |
| S2 | **High** | `GH_REPO=stranger/r gh issue create --body x`: the assignment is skipped as a wrapper (`egress-intent.ts:362`), the resolver falls back to the cwd origin (registered), rule h passes, and gh posts to `stranger/r`. | §3.3.1. The hook parses the assignment; the shim reads its own env |
| S3 | **High** | `gh pr comment https://github.com/stranger/r/pull/5 --body x` from a registered checkout: positional URLs are not parsed, so the same fallback applies. Likewise `gh repo edit <o>/<r>`. | §3.3.2 |
| S4 | **High** | `gh api -X POST repositories/<numeric-id>/issues -f body=…`: `parseApiEndpoint` returns null and the resolver falls back to the cwd origin. The same applies to `gists` (an unattributed public paste, adjacent to this issue). | §3.3.4. Opaque mutating endpoints are unresolved, so rule h refuses them |
| S5 | **High** | Fork checkout: `origin=acme/fork` (registered), `upstream=stranger/r`. `gh pr create` without `--repo` targets `upstream` by gh's remote priority, but the resolver reports `origin`. | §3.3.3, partly. The fork parent with no `upstream` remote and no `gh-resolved` is still invisible offline; see D10 below |
| S6 | **Medium** | `git push` through `url.*.insteadOf` or an ssh `Host` alias not shaped `github.com-*` → `parseRemoteUrl` null → no destination, so rules e–h do not fire at the hook or at pre-push. | §3.3.5 (`git remote get-url --push --all`, and a pure ssh-config parser; corrected by F7 and F8) |
| S7 | **Medium** | `REPO_AEGIS_REGISTRY=<agent file> gh …` or `REPO_AEGIS_HOME=<dir with forged approvals> git push …` steers the shim's and the pre-push hook's registry and approvals. A forged registry lists the stranger, and a forged approval file satisfies rule g today. | §3.4 shape rule b′ at the hook layer. Residual at the lower layers (R2) |
| S8 | **Medium** | The issue's ordering, "rule h before rule g", still puts it after rule e/f context reads and after the #114 lookup, which sends `gh repo view stranger/r`. That is a needless network call that names the target. A rule h that reads `classKnown`/`fromCache` could also be satisfied by the destination cache, which the guard writes from any directory the agent `cd`s into. | D9 (rule h runs first). D2 (only the registry counts) |
| S9 | **Low** | `*` approvals match customer orgs too. A broad approval minted for a personal release window also covers publishing to a customer's public repo. | D7 |
| S10 | **Critical (pre-existing; D1 and D8 depend on it)** | "TTY on stderr" is not proof of a person. `script -q /dev/null <cmd>`, `unbuffer`, `expect`, `python -c 'import pty…'` and `ssh -tt localhost` give the child a pty. `script` is not in `WRAPPERS` (`egress-intent.ts:349`), so the hook does not even see the egress inside it. The shim and pre-push then see a TTY, and rules g and h both pass. Worse, `script -q /dev/null repo-aegis approve '*'` mints an approval, and the same trick would pass D8's owner-add gate. | **New PR 2b, blocking the release:** (1) add pty wrappers (`script`, `unbuffer`, `expect`, `faketty`, `socat`, `ssh -t`/`-tt`) to wrapper detection, so the inner command is parsed, and add a hook shape rule `EGRESS_PTY_WRAPPER` that refuses egress, `approve` and owner adds under them; (2) in `requireTerminal()` (used by `approve`, the owner adds and `upstreams add`), also walk the process ancestry and refuse when an agent host (`claude`, `codex`, `gemini`, `node …/claude-code`) is an ancestor. **Revised after §8.4 F5:** `tmux new -d '…'` and `screen -dm` give a real pty *and* reparent under a server whose ancestor is `launchd`, so both (1) and (2) fail. Add (3): multiplexers and pty-capable interpreters (`tmux`, `screen`, `zellij`, `python -c`/`perl -e` with `pty`, `expect -c`) to the blocklist; and (4) a hook rule that refuses any Bash command whose **text** contains `repo-aegis approve <target>`, `engagements add --personal-org`/`--github-org` or `upstreams add`, anywhere in it, including inside `bash -c`, heredocs and multiplexer arguments. All of this is still advisory, and the docs say so plainly: the TTY test is a speed bump, not proof of a person. Follow-up issue: a presence signal agents cannot forge (a Keychain item with a user-presence ACL / Touch ID on macOS) for `approve` and owner adds. File as its own issue, because it predates #151. |
| S11 | **High (pre-existing)** | `gh` aliases: after `gh alias set ic 'issue create'`, `gh ic --repo stranger/r --body x` is not recognised as an egress verb by the hook or the shim, and the real `gh` expands it and posts. Shell aliases (`gh alias set --shell`) can run anything. | Resolve aliases offline, from `gh`'s `config.yml` (`$GH_CONFIG_DIR` or the default), before classifying, in both the hook and the shim. Treat a shell alias (`!…`) whose expansion is unknown as an egress intent with `unresolved: "gh-alias"`. Add to PR 2. |

**D10 (decided, from S5).** gh can choose a fork's parent through the API,
and the offline resolver cannot see that. The options were (a) accept the gap
or (b) require an explicit target for non-interactive `gh pr create`. (b) was
chosen and ships in PR 2 (§2, D10). It closes S5 for `gh pr create`. Other
`gh` write verbs without `--repo` still rely on the candidate set from §3.3.3.

### 8.2 Residual risks (accepted, stated)

| # | Risk | Why accepted / mitigation |
|---|---|---|
| R1 | The registry file is on disk and writable by the agent's Bash. `sed -i` on `engagements.yaml` adds an owner without any TTY. The same holds for `registry encrypt --recipient <agent key>` followed by `registry decrypt --identity <agent key>` over ciphertext the agent wrote, which installs any content through the CLI and is audited only as `registry-decrypt` (PR 5 review, L2). | Client-side controls are advisory by construction (existing non-goal). Mitigations: `install claude-md` adds Claude Code `permissions.deny` for `Edit`/`Write` under the registry directory, and documents adding it to the sandbox `denyWrite`; `doctor` `REGISTRY_AGENT_WRITABLE`; owner adds through the CLI are audited. A direct edit is a visible act in the transcript. |
| R2 | The shim and pre-push hook honour `REPO_AEGIS_*` from the command's environment, and they cannot tell an agent's override from a test harness. | The agent hook, which judges with its own environment, refuses the override (b′). Ignoring the variables below the hook would break the test suite and legitimate relocations. Revisit if a host appears that has no pre-command hook. |
| R3 | Repository transfer or rename redirects: `acme/x` transferred to a stranger keeps redirecting, and rule h admits it by name. | Rare, and needs a prior action by a registered owner. A doctor sweep could compare cached `nameWithOwner` with the cached name; noted for a follow-up, not built. |
| R4 | `REPO_AEGIS_EGRESS_HUMAN=1` passes rule h. | The same contract as rule g, and b′ now refuses it when it is set on the egress segment at the hook layer. An agent that sets it outside a hook-guarded shell is the existing advisory non-goal. |
| R5 | The fork-parent case (S5) for `gh` write verbs other than `gh pr create`, such as `gh issue create` without `--repo` in a fork with no `upstream` remote. gh's issue and comment commands resolve through remotes, not the fork parent, so the exposure is small, but it is not proven. | Stated in the design doc's resolution paragraph so nobody assumes it is covered. Add a test pinning gh's behaviour for `issue create` in a fork. If gh does pick the parent, extend D10 to that verb. |

| R6 | Paths outside `git`/`gh` entirely: `curl -X POST https://api.github.com/… -H "Authorization: token $(gh auth token)"`, `git credential fill`, and `gh extension install` running arbitrary code. | Out of the guard's verb model. Cheap mitigation in PR 2: a hook rule refusing `curl`/`wget` against `api.github.com` with `-X POST\|PUT\|PATCH\|DELETE` or `-d`/`--data*`, and `gh auth token` in a command that also makes a network call. This is named so nobody assumes coverage. |
| R8 | **The hook guesses the command's `GH_REPO`.** The agent hook judges with its own environment, but the Bash tool's shell can get `GH_REPO` from startup files the hook never reads: `~/.zshenv` is agent-writable and sourced by every `zsh -c`. A gh write with no explicit target is then judged against the cwd while gh writes to `GH_REPO`. Only the shim sees the real environment (PR 2a review). | With the shim on PATH, the shim catches it. Hook-only installs are weaker here; say so in the design doc. `doctor` should flag `GH_REPO` exported from shell startup files. A stricter option, treating a targetless gh write as unresolved whenever the shim is not on PATH, is deferred: it would refuse every plain `gh issue create` on hook-only installs. |
| R9 | **ssh overrides.** Any `GIT_SSH_COMMAND`, `GIT_SSH` or `core.sshCommand` that can redirect the connection makes ssh aliases unresolved (PR 4). The one exception is the exact Claude Code sandbox proxy template, taken from the environment only. It passes `%h %p` to `SRT_SSH_PROXY_COMMAND` unchanged, so without it every agent push through an ssh alias would be refused. An agent that can write shell startup files could export its own `SRT_SSH_PROXY_COMMAND` (the R8 class). A literal `github.com` host is never looked up in the ssh config, so a `Host github.com` block that redirects it elsewhere is not seen. That sends bytes to a non-GitHub host, which is outside the guard's model. | Accepted and stated. `doctor` could flag `SRT_SSH_PROXY_COMMAND` or `Host github.com` redirects in startup and ssh files (follow-up). |
| R7 | **Registration oracle**: whether a refusal says rule h or rule g reveals whether an owner is registered. | Inherent to giving clear refusals (§3.9). The destination is in the agent's own command, so the oracle answers only "is this one owner registered", never "which owners are". Accepted. |

### 8.4 Independent review (Fable, 2026-11-02)

A second, independent pass by the `security-reviewer` agent ran the installed
`gh` 2.102.0 and `git` 2.56.0 offline and the built parser. F1 was re-checked
against `packages/core/dist` before merging. Every finding below is folded
into the plan; the right-hand column gives where.

| # | Sev | Finding | Plan change |
|---|---|---|---|
| F1 | High | pflag attached forms (`-Rstranger/r`, `-XPOST`, `-fbody=…`) are not parsed. `gh api -XPOST repos/stranger/r/issues -fbody=hi` produces no intent at all, at the hook *and* the shim. Verified. | §3.3.7. First step of PR 2 |
| F2 | High | `remote.<name>.gh-resolved` can hold `owner/repo`, not just `base`. `git config remote.origin.gh-resolved stranger/r` needs no TTY and redirects every implicit `gh` write. | §3.3.3 |
| F3 | High | b′ covered only `REPO_AEGIS_*`. `HOME`, `PATH`, `XDG_CONFIG_HOME`, `GH_CONFIG_DIR`, `GIT_CONFIG_*`, `GIT_SSH*` and `BASH_ENV` do the same job. | §3.4 b′ list |
| F4 | High | `parseRemoteUrl` returns null for valid GitHub URL forms, and a null destination skipped rule h. | §3.3.6 (harden the parser; a null URL-shaped target → `unresolved`, fail closed) |
| F5 | High | `tmux new -d` and `screen -dm` defeat both the pty-wrapper list and the ancestry walk. | S10 revised: multiplexers and interpreters, a text-level refusal of `approve` and owner adds, and an honest "advisory" statement. A follow-up for an unforgeable presence signal |
| F6 | Medium | Hook TOCTOU: config changed earlier in the same `&&` command is not seen. | §3.4 b″ `EGRESS_AFTER_STATE_CHANGE` |
| F7 | Medium | `git ls-remote --get-url` ignores `pushInsteadOf` and `pushurl` (verified). `git -c remote.*` rewrites the target. | §3.3.5 → `git remote get-url --push --all`; b′ refuses `-c remote.*\|url.*\|core.sshCommand` |
| F8 | Medium | `ssh -G` evaluates agent-writable `Match exec` from a hook that runs outside the sandbox. | §3.3.5: a pure parser, no `ssh -G`; a sentinel test |
| F9 | Medium | Repo-bearing positionals and flags are missing (`issue transfer`, `repo sync`, `--org`, `--branch-repo`, …). | §3.3.8 per-verb table; an unknown shape → `unresolved` |
| F10 | Medium | `gh gist create` is attributed to the cwd origin, so a personal `*` approval covers a public paste. | §3.3.9 |
| F11 | Medium | D4's fail-open on an unreadable registry is a one-line off-switch. | D4 revised: unreadable or encrypted → refuse (confirmed) |
| F12 | Low | `gh api` paths with `..`; curl with the gh token; the registration oracle; `check.ts` printing `boundaryOrgs`. | §3.3.4, R6, R7, §3.9 |

Corrections to the first draft that the review made:

- **D10's rationale was wrong.** Without a TTY, gh does not consult the API for
  a fork's parent. D10 stays, re-justified (§2).
- **§3.3.5 named the wrong git command, and a dangerous `ssh` call.** Both are
  fixed.
- **Verified facts:**
  - pre-push `$2` is the URL after all rewriting, once per push URL, also on
    `--dry-run`;
  - for a URL push `$1 == $2`, so the comment at `hook-scripts.ts:122` is wrong
    and should be fixed in PR 4;
  - `GH_REPO` applies to every command that resolves a base repo, and `--repo`
    overrides it.

The reviewer judged §3.7 (the GraphQL lift) over-engineered for now. That
agrees with the plan: ship rule h first.

### 8.3 Properties to keep (reviewer checklist for the PRs)

- No approval, cached destination, local class, or env var except
  `REPO_AEGIS_EGRESS_HUMAN` changes rule h's answer. Only the registry's owner
  lists and `allowedUpstreams` do, and adding to them needs a TTY.
- Nothing on the enforcement path depends on which `gh` account is active.
  Other sessions switch it at will (D3). Rule h, approvals and the registry
  never consult the gh login; only doctor reads it, and doctor reads every
  logged-in account.
- Rule h never makes a network call. §3.7's lookup can only turn a refusal into
  an allow, never the reverse, and it is off the default path.
- Every refusal answers the five questions in §3.9 (what, why, whether an
  approval helps, the fix and who runs it, where to read more), through the
  shared `refusal()` helper.
- Refusal text names the destination owner only. It never enumerates
  `personalOrgs`, `githubOrgs`, engagement ids or upstreams, and the redaction
  oracle test covers this.
- Every layer uses the same `registeredOwners()` and the same code, so `doctor`,
  the hook, the shim and pre-push cannot disagree about which owners are ours.
- "Missing registry", "unreadable registry" and "loaded with no owners" are
  separate states. Per revised D4, only "missing" and "loaded with no owners"
  skip rule h; "unreadable" (including encrypted) makes rule h refuse.
