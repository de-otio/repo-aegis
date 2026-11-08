# Plan: the identity follows the target owner

Status: **spec, not implemented.** Branch `plan/owner-identity`. Revives and extends `doc/plan-gh-identity-selection.md` (parked 2026-11-04 on branch `plan/gh-identity-selection`), whose decisions and security review (H1–H5, M1–M5) are carried over here and referenced by their ids. Changes the stance of `doc/plan-recognise-dot-gh.md` §0 for this one concern (§2). Security review of this spec: §12.

## 1. Problem

Several agent sessions run on one machine, and each may need a different GitHub identity: a person's own account for their own org, a work account for an engagement's org, or a bot. `gh` acts as whichever account is *active*, and the active account is shared by every terminal and session, so sessions switch it under each other (`gh auth switch`). The workarounds all put the identity choice into text the agent writes:

- `GH_TOKEN="$(gh auth token --user <login>)" gh …` prints a stored token into a shell the agent controls. With any network program in the same line it is refused (`GH_AUTH_TOKEN_NETWORK`), and a `git` subcommand counts as one, so ordinary scripts trip it.
- `GH_CONFIG_DIR=… gh …` is refused (`EGRESS_ENV_OVERRIDE`), and correctly: it redirects `gh`.
- `dot gh [--as <id>] …` (recognised since v0.11.1) chooses from a table in agent-writable code. The guard only trusts the *word* `--as bot` (`plan-recognise-dot-gh.md` §6).

Goal: **plain `gh … --repo <owner>/<repo>` and plain `git push` run as the right identity for that owner and for who is at the keyboard, every time.** Nobody switches the active account, no token passes through a shell, and nothing the agent can edit takes part in the choice.

## 2. Threat model

`plan-recognise-dot-gh.md` §0 judged identity selection against accidental leaks only, and on that basis the owner parked the shim design as too strict (2026-11-04). On 2026-11-08 the owner asked for the most robust, best-practice solution instead. This plan therefore holds identity selection to a higher bar than the rest of the guard:

- **In scope:** accidents (wrong active account, a forgotten `--as`, a copied command with the wrong token), *and* an agent that reaches for a credential it was not given: reading a person's token, minting an App token itself, or steering which identity the pinned code picks.
- **The real boundaries** are those that already exist: the root-owned managed drop-in that pins the hooks (`plan-pin-enforcement-binary.md` D8), the pinned CLI and shim, the registry under deny rules and the TTY gate, the agent sandbox, and the keychain ACLs on stored tokens and PEMs.
- **Out of scope**, as everywhere in repo-aegis: an agent running unsandboxed as the same user, with password-less `sudo`, that sets out to defeat the guard. Client-side controls cannot stop it (`doc/design/egress-guard.md`, non-goals). §10 lists the limits this plan accepts and does not design around.

## 3. Best-practice principles applied

1. **Agents act as a non-human identity.** An agent's writes go out as a GitHub App installation, never as a person. Installation tokens are short-lived (≤ 1 h), revocable without touching a person's account, carry only the App's permissions, and are attributed to the bot. A person's approval then means something again, for example on code-owner review. This is R3 (scoped exchange) of the workload-identity rules.
2. **Least privilege per call.** Each App token is narrowed at mint time to the single target repository and to the permission class of the verb (read or write).
3. **One holder per credential.** Person tokens stay in `gh`'s keyring and App PEMs stay in taaad's keychain items. repo-aegis holds neither and stores no token, not even in a cache.
4. **Identity is chosen by pinned code from protected configuration.** That means the pinned CLI behind the shim and the git credential helper, reading the registry from the pinned home. It is never chosen from an argument, an environment variable or a file the agent can write.
5. **No fallback.** If the chosen identity cannot be used, the call is refused. It never falls back to the active account.
6. **Every use is visible and auditable.** Each call that uses an identity gets a stderr line and an audit record naming that identity (never the token).

## 4. Decisions

Carried from the parked plan, with its review ids:

| # | Decision | From |
|---|---|---|
| D1 | The shim `exec`s the pinned CLI (`<pinned node> <pinned cli> gh --home <pinned home> -- "$@"`) for **every** `gh` invocation except `--version`, `help` and `completion`. The CLI makes the egress decision and the identity decision, spawns `gh` itself and prints the receipt. No shell code runs after the `exec` | parked D1, M4, H2 |
| D2 | The mapping lives in the registry next to the owners it maps (§5.1). Changing it is an owner-registry change, so it needs a person at a terminal (`OWNER_ADD_NEEDS_TTY`) and is covered by the existing registry deny rules | parked D2 |
| D3 | **The token never enters a shell.** The CLI obtains it (§5.3) and passes it to the `gh` it spawns as `GH_TOKEN`, in that child's environment only. It is never printed, written, logged or put in argv. The same trusted `gh` is used for the fetch and for the call | parked D3, H2, H5 |
| D4 | No fallback. A mapped owner whose identity cannot be used, and any fault between choosing and spawning on a mapped call, is `GH_IDENTITY_UNAVAILABLE`, never a call as the active account | parked D4, H1 |
| D5 | Only a **literal** destination owner gets an identity: `--repo`, `-R`, a URL, a `repos/<owner>/<repo>/…` path. A call whose owner comes only from the cwd, from `gh`'s defaults, or that names several owners gets no injection. For a mapped owner known only from the cwd it prints a hint to name `--repo` | parked D8, M3 |
| D6 | Each injecting call prints `repo-aegis: as <identity> (<kind>) for <owner>/<repo>` on stderr and writes an audit record: identity, kind, owner/repo, verb, approval id if any. Never the token | parked D9 |
| D7 | `gh auth token`, `gh auth switch` and `gh auth status --show-token`, with any flags, are refused with no person present, at the hook and in the CLI (`GH_AUTH_NEEDS_HUMAN`) | parked D10, H4 |
| D8 | The registry and approvals used for the identity decision come only from the pinned home, never from `REPO_AEGIS_HOME`, `REPO_AEGIS_REGISTRY` or any other `REPO_AEGIS_*` in the caller's environment | parked D11, M2 |
| D9 | Injection is refused (`GH_IDENTITY_ENV_REDIRECT`) when `GH_HOST`, `GH_CONFIG_DIR`, `GH_ENTERPRISE_TOKEN` or `GITHUB_ENTERPRISE_TOKEN` is set, or the trusted `gh`'s config sets `http_unix_socket` (the `doctor` test `GH_REDIRECT_ENV`) | parked D12, H3 |

New in this plan:

| # | Decision | Why |
|---|---|---|
| N1 | **Two identities per owner: `person` and `agent`.** Who is present chooses the column: with a person present (`checkTerminal()` positive) the `person` identity is used, otherwise the `agent` identity. The owner chooses the row | It replaces the parked D7 approval gate for the common case: agents simply never act as the person. A person at their own terminal keeps working as themselves |
| N2 | An `agent` identity is a **GitHub App** (`kind: github-app`, a taaad slug). A `person` identity is a `gh` login (`kind: gh-login`). An `agent` identity of kind `gh-login` is rejected at parse time | Principle 1. A machine user's PAT would be a long-lived person-like credential; there is no case for it here |
| N3 | **An owner with a `person` identity but no `agent` identity:** with no person present, reads run as the person, and writes need a live approval for that repository **minted for that person's login** (`GH_IDENTITY_WRITE_NEEDS_HUMAN`). An approval minted before this change records no login and does not cover the write | The parked D7 and M5, kept as the fallback for owners where no App is installed yet. Reads as the person are what agents do today, now with the right person |
| N4 | **App tokens are minted by taaad**, the only holder of App PEMs. The pinned CLI runs taaad by an absolute path that `install shim` pins and checks the way it checks `gh` (owner, mode, not agent-writable). It reads the token from a pipe and never from a file. repo-aegis never sees a PEM | Principle 3. A second PEM holder is a design defect under R4 |
| N5 | **Each App token is narrowed at mint time** to `repositories: [<repo>]`, with permissions limited to the verb's class: reads get `metadata: read` and `contents: read`, plus `pull_requests: read` / `issues: read` where the verb needs them; writes get the App's granted permissions for that one repository. This needs a taaad option (§8). Until taaad has it, the App's full installation token is used and `doctor` reports `APP_TOKEN_NOT_NARROWED` (warn) | Principle 2. An installation token without narrowing reaches every repository the App is installed on |
| N6 | **The installation must belong to the target owner.** taaad reports the installation's account login with the token. If it does not equal the destination owner (case-insensitively), the call is refused (`GH_IDENTITY_INSTALLATION_MISMATCH`) and the token is discarded | A registry slip that maps an owner to another org's App would otherwise act in the wrong org with a valid token |
| N7 | **A token supplied by the caller is never used for a mapped owner when no person is present.** `GH_TOKEN` / `GITHUB_TOKEN` in an agent's environment on a mapped call is `GH_IDENTITY_TOKEN_SUPPLIED`. With a person present, the parked D6 rule applies: the supplied token must equal the mapped `person` login's token (SHA-256 digests, `timingSafeEqual`), else `GH_IDENTITY_TOKEN_MISMATCH` | An App token cannot be compared for equality (each mint is fresh), and an agent has no reason to bring a token once the CLI chooses |
| N8 | **`dot gh` on a mapped owner is retired.** The hook refuses a recognised `dot gh` call whose literal owner is mapped (`DOT_GH_OWNER_MAPPED`, fix: the same arguments to plain `gh`). For unmapped owners, `dot gh` and `DOT_GH_WRITE_NEEDS_BOT` work as in v0.11.1 | Two choosers for one owner would disagree. The pinned one wins, and the message names the plain command |
| N9 | **Agents cannot mint or read tokens themselves.** With no person present, the hook refuses `taaad env`, `taaad agent` and `taaad credential-helper`, `security find-generic-password`/`find-internet-password` naming a `gh:` or taaad service, and `gh auth token` in any form (D7) (`TOKEN_MINT_NEEDS_HUMAN`) | These are speed bumps (§10), but they close the cheap routes around N1. The keychain ACLs are the actual control |
| N10 | **git pushes follow the same mapping** (§5.6). With no person present, a push to a mapped owner that has an `agent` identity goes over HTTPS with the `repo-aegis git-credential` helper, which mints a narrowed App token (`contents: write`, one repository). The pre-push hook refuses an agent push to such an owner over SSH (`AGENT_PUSH_NEEDS_APP`), because an SSH key is the person's | Otherwise every `gh` write would be the bot while every push would still be the person |
| N11 | **Owners with no identity at all pass through unchanged**, and `doctor` warns once per registered owner without one (`OWNER_IDENTITY_UNMAPPED`). Rule h still refuses writes to unregistered owners | Adoption per owner. Nothing gets stricter until an owner is mapped, except D1's routing of every verb and D7/N9 |

## 5. Design

### 5.1 Registry (schema version 3)

```yaml
schemaVersion: 3
identities:
  me:        { kind: gh-login,   login: alice }
  me-bot:    { kind: github-app, app: example-bot }      # a taaad slug
  work:      { kind: gh-login,   login: alice-work }
  work-bot:  { kind: github-app, app: example-work-agent }
personalOrgs:
  - example-org                                 # a plain string: unmapped, as today
  - { name: other-org, person: me, agent: me-bot }
engagements:
  - id: customer-a
    githubOrgs: [customer-a-org]
    person: work                                # applies to every org of the engagement
    agent: work-bot
```

- **Version 3** is written only when the first identity is set, so nobody is migrated before they adopt. An older repo-aegis refuses a version-3 file with an error that names the version (the parked M1). `set-identity` refuses while another install on `PATH` is older than the one running it (`MULTIPLE_INSTALLS`).
- Validation at parse time: identity names match `^[a-z][a-z0-9-]{0,31}$`; `login` matches `^[A-Za-z0-9-]{1,39}$`; `app` matches taaad's slug shape; every `person`/`agent` reference resolves; `agent` refers to a `github-app` (N2) and `person` to a `gh-login`. An unknown key is a parse error (fail closed).
- Mutators, all TTY-gated like `engagements add`: `repo-aegis identity add <name> --gh-login <login> | --app <slug>`, `repo-aegis identity remove <name>` (refused while referenced), `repo-aegis engagements set-identity <id> [--person <name>] [--agent <name>] [--clear]`, and `repo-aegis personal-org set-identity <org> …` with the same options.
- `status` shows the mapping (names, kinds, logins, slugs; no secrets). `identity check` (person present) mints and discards one token per identity and runs one call that must pass and one that must fail, the R4 "probe at mint" rule: a read of a mapped repository passes, and a write to a repository the App is not installed on fails.

### 5.2 The `gh` decision (pinned CLI, per invocation)

A pure core function, `chooseIdentity(intent, registry, presence, approvals, env) → { kind: "none" } | { kind: "inject", identity, scope } | refusal`, followed by an imperative shell:

1. Parse the arguments with the existing resolver. With no person present, refuse `gh auth token|switch|status --show-token` (D7).
2. Make the existing egress decision (rules a–h, D2 `dot gh`, public approval, markers). A refusal is final.
3. Destination owner: exactly one, literal (D5). None, several, or cwd-only → `none`; go to step 9 with the caller's environment unchanged.
4. Look the owner up in the pinned registry (D8). Unmapped → `none` (N11). Unreadable → `GH_IDENTITY_UNAVAILABLE`.
5. Choose the column by presence (N1). With no person present and no `agent` identity, the `person` identity applies, and writes need a login-bound approval (N3).
6. Refuse a redirecting environment (D9) and an untrusted `gh` or `taaad` (D3, N4).
7. Caller-supplied token: N7.
8. Obtain the token (§5.3). For an App, check the installation's account (N6) and the narrowing (N5).
9. Spawn the trusted `gh` with the arguments unchanged. When injecting, set `GH_TOKEN` and remove `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN` and `GITHUB_ENTERPRISE_TOKEN` from the child's environment, then print the D6 line and write the audit record. Exit with `gh`'s status and print the receipt as today.

Any exception between steps 3 and 9 on a mapped call is `GH_IDENTITY_UNAVAILABLE`, and `gh` is not run (D4). On an unmapped call, an internal fault keeps today's behaviour (a warning, then `gh` runs unchanged).

### 5.3 Token sources

- **`gh-login`:** `<trusted gh> auth token --hostname github.com --user <login>`, run with every token and redirect variable removed from its environment (parked H5).
- **`github-app`:** `<pinned taaad> mint --app <slug> --repo <owner>/<repo> --permissions <class> --json` (§8). It returns `{token, expiresAt, installationAccount, repositories, permissions}` on stdout, which the CLI reads from a pipe. Before that option exists: `taaad env --app <slug>`, parsed the way `dot gh`'s `parseTaaadEnv` parses it, with `APP_TOKEN_NOT_NARROWED` and the installation check done by one `GET /installation/repositories` call with the token itself.
- **No cache, anywhere.** Each call mints. The latency budget is measured in phase 3 (target: p50 under 1 s added per `gh` call). If it is missed, the fix is a cache **inside taaad** (in the keychain, an expiry under the token's own, keyed by app, repository and permissions), not in repo-aegis.

### 5.4 Shim

The shim keeps the resolution of the real `gh` (for the skip list) and the pin guard, then `exec`s the CLI (D1). The bash verb pre-filter goes away. Reads outside the publishing groups now also pay for a Node start; that is the cost of judging every verb and choosing an identity for reads (M4).

### 5.5 Hook

- D7 and N9: the new shape refusals, decided by the same `core` functions at the hook and in the CLI.
- N8: `DOT_GH_OWNER_MAPPED`, decided before D2.
- `GH_AUTH_TOKEN_NETWORK` stays. Once agents no longer need `gh auth token`, its false positive on local `git` subcommands matters less. It is still fixed in phase 1: only `git` subcommands that can reach a remote count as network calls, and aliases and `-c` options stay network calls (fail closed).

### 5.6 git push (phase 4)

- `repo-aegis install git-credential` (person present) adds, in the user's global git config, `credential.https://github.com.helper` = `<pinned node> <pinned cli> git-credential --home <pinned home>`, ahead of any existing helper, and sets `credential.https://github.com.useHttpPath = true`, so the helper sees `<owner>/<repo>`. `--uninstall` removes exactly those entries (uninstall surface).
- The helper answers `get` only for a mapped owner, using the same `chooseIdentity` with the intent "push". With no person present and an `agent` identity, it returns `x-access-token` and a token narrowed to `contents: write` on that one repository. With a person present it returns nothing and lets the next helper answer, so the person's own setup is unchanged. `store` and `erase` are ignored.
- The pre-push hook, with no person present: if the remote's owner is mapped with an `agent` identity and the push URL is SSH (`git@…`, `ssh://…`, or an `~/.ssh/config` host alias that resolves to github.com), it refuses with `AGENT_PUSH_NEEDS_APP`. The message gives the HTTPS push form (`git push https://github.com/<owner>/<repo>.git <branch>`). The existing destination checks run first and are unchanged.
- An agent's commits are still authored by whatever `user.name`/`user.email` git has. Authorship is not identity; the push and the PR are what carry the bot's identity.

### 5.7 What does not change

- repo-aegis never runs `gh auth switch`. The active account still applies to unmapped owners and to calls with no literal owner.
- The egress rules a–h, public-repository approvals, markers and receipts are unchanged and decided before the identity.

## 6. Refusals (added to `doc/agent-guide.md`)

| Code | When | What the agent does |
|---|---|---|
| `GH_IDENTITY_UNAVAILABLE` | the mapped identity has no token on this machine, taaad cannot mint, the registry is unreadable, or the decision faulted on a mapped owner | stop; tell the user which identity failed (`repo-aegis identity check`) |
| `GH_IDENTITY_WRITE_NEEDS_HUMAN` | a write as a person's account with no person present, for an owner with no `agent` identity and no live approval minted for that login | tell the user what would be written where, as whom; they approve or run it |
| `GH_IDENTITY_TOKEN_SUPPLIED` | an agent's environment carries `GH_TOKEN`/`GITHUB_TOKEN` on a mapped call | run plain `gh` without setting a token |
| `GH_IDENTITY_TOKEN_MISMATCH` | a person's supplied token is not the mapped login's | the same |
| `GH_IDENTITY_INSTALLATION_MISMATCH` | the App's installation belongs to another account than the destination owner | stop; the registry maps the wrong App; tell the user |
| `GH_IDENTITY_ENV_REDIRECT` | `GH_HOST`, `GH_CONFIG_DIR`, an enterprise token or `http_unix_socket` would send the token elsewhere | run plain `gh` without them |
| `GH_BINARY_UNTRUSTED` | no trusted `gh` or pinned `taaad` to use | tell the user; they fix `PATH` or re-run `install shim` |
| `GH_AUTH_NEEDS_HUMAN` | `gh auth token`, `gh auth switch` or `gh auth status --show-token` with no person present | do not read or switch tokens; use plain `gh --repo <owner>/<repo>` |
| `TOKEN_MINT_NEEDS_HUMAN` | `taaad env|agent|credential-helper`, or `security find-*-password` for a gh/taaad service, with no person present | the same |
| `DOT_GH_OWNER_MAPPED` | `dot gh` targeting a mapped owner | re-issue the same arguments to plain `gh` |
| `AGENT_PUSH_NEEDS_APP` | an agent push over SSH to an owner with an `agent` identity | push over HTTPS: `git push https://github.com/<owner>/<repo>.git <branch>` |

## 7. Tests

Must-refuse cases first; each fails on today's code or on a naive implementation. The parked plan's T1–T20 carry over unchanged where their decision carries over (T1 → D4, T4 → N7 person path, T5 → D3, T9 → D5, T11 → D3, T12 → D3, T13/T14 → D4, T15 → D9, T16 → D7, T17 → D8, T18 → D1, T19 → D5, T20 → §5.1).

| # | Case | Expected |
|---|---|---|
| I1 | agent, owner mapped `{person: A, agent: bot}`, `gh pr create --repo o/r …` | the stub `gh` receives `GH_TOKEN` = the stub taaad's token for `bot`, narrowed to `o/r`; the D6 line names `bot (github-app)` |
| I2 | person present, same call | runs as login A |
| I3 | agent, owner `{person: A}` only, a write, no approval | `GH_IDENTITY_WRITE_NEEDS_HUMAN`; neither gh nor taaad is called |
| I4 | as I3 with an approval minted for A, then with an approval with no login, then with one minted for B | allowed as A; refused; refused |
| I5 | agent, owner `{person: A}` only, a read | runs as A while the active account is B |
| I6 | agent sets `GH_TOKEN=x` on a mapped call | `GH_IDENTITY_TOKEN_SUPPLIED`; no mint |
| I7 | the stub taaad reports `installationAccount: other-org` | `GH_IDENTITY_INSTALLATION_MISMATCH`; gh not run; the token appears in no output |
| I8 | taaad exits non-zero or prints nothing | `GH_IDENTITY_UNAVAILABLE`; gh not run |
| I9 | a `taaad` first on `PATH` that is not the pinned one | the pinned one is called; with the pinned one missing, `GH_BINARY_UNTRUSTED` |
| I10 | agent: `taaad env --app x`, `taaad agent …`, `security find-generic-password -s gh:github.com -w`, `gh auth status -t` | `TOKEN_MINT_NEEDS_HUMAN` / `GH_AUTH_NEEDS_HUMAN` at the hook |
| I11 | `node /p/dot.mjs gh --as bot pr create --repo o/r …` with `o` mapped | `DOT_GH_OWNER_MAPPED`; with `o` unmapped, the v0.11.1 behaviour |
| I12 | registry `agent:` pointing at a `gh-login` identity, a dangling reference, an unknown key | parse error naming the path |
| I13 | git helper, agent, mapped owner with an `agent` identity, `protocol=https host=github.com path=o/r.git` | returns `username=x-access-token` and a token narrowed to `contents: write` on `o/r` |
| I14 | git helper, person present, or an unmapped owner | prints nothing (the next helper answers) |
| I15 | pre-push, agent, remote `git@github.com:o/r.git` and the alias `github.com-personal:o/r.git`, `o` mapped with an agent identity | `AGENT_PUSH_NEEDS_APP` |
| I16 | the token never appears in stdout, stderr, the argv of any process, the audit log or the decision log, for both kinds, including with `BASH_ENV`, `SHELLOPTS=xtrace` and a fake `bash` first on `PATH` | asserted by capturing all of them |
| I17 | `GH_AUTH_TOKEN_NETWORK`: `gh auth token … ; git -C /x tag` | allowed; `… ; git push`, `… ; git fetch`, `… ; git <alias>`, `… ; git -c x=y tag` refused |

Property tests (fast-check), over arbitrary argument vectors, environments, presence values and registries:
- The injected identity is either the one the pinned registry names for the literal destination owner, in the column that presence selects, or none.
- With no person present and an owner that has an `agent` identity, the injected identity is never a `gh-login`.
- A refusal never runs `gh`, and a mapped call never runs `gh` without injecting.

## 8. taaad prerequisites (taaad repo, its own PRs)

1. `taaad mint --app <slug> --repo <owner>/<repo> [--permissions <read|write|contents-write>] --json`: mints an installation token through `POST /app/installations/{id}/access_tokens` with `repositories` and `permissions` in the body, and prints `{token, expiresAt, installationAccount, repositories, permissions}`. It refuses to print to a TTY, like `env`. It never logs the token.
2. Optionally, a keychain cache keyed by (app, repository, permissions) with an expiry 5 minutes under the token's own, only if phase 3 misses the latency budget.
3. `taaad doctor` reports the keychain ACL of each PEM item. N9 and §10 rely on PEMs being readable only by taaad's interpreter without a prompt; this item verifies that.

## 9. Phases and releases

Nothing changes behaviour for an owner until it is mapped, except D1 (every verb through the CLI), D7 and N9 (stricter for agents) and the `GH_AUTH_TOKEN_NETWORK` fix (looser).

| Phase | Content | Release |
|---|---|---|
| 1 | `GH_AUTH_TOKEN_NETWORK` git-subcommand fix (I17); D7 and N9 hook rules (I10) | v0.12.0, minor: stricter for agents |
| 2 | Registry v3, identities and mutators, `status`, `identity check` (I12, parked T20) | v0.13.0 |
| 3 | `core` `chooseIdentity` and the property tests; the CLI `gh` subcommand, the shim's `exec`, the token sources, the audit record; N7, N8; login-bound approvals (I1–I9, I11, I16, parked T1–T19) | v0.14.0. Needs §8.1 for N5, otherwise ships with `APP_TOKEN_NOT_NARROWED` |
| 4 | `git-credential` helper, its install and uninstall, the pre-push rule (I13–I15) | v0.15.0 |
| 5 | Docs: `configuration.md` (identities), `agent-guide.md` (§6 table, the `dot gh` retirement), `cli-reference.md`, `design/egress-guard.md`, CHANGELOG | with each phase |

Each phase gets an independent security review of its code against this spec before merging.

## 10. Accepted limits

- **Same-user, unsandboxed agents.** The pinned CLI, the registry and the drop-in are protected, but an agent running as the same user outside the sandbox can, for example, run `gh auth token` under a name the hook does not parse, or read a keychain item whose ACL allows any app. N9 is a speed bump. The keychain ACLs (§8.3) and the sandbox are the controls.
- **Presence is a heuristic outside the sandbox** (`process-ancestry.ts`, "THE BOUNDARY"). A forged presence selects the `person` column. The follow-up that closes this, a Touch ID / user-presence keychain item, is the existing open issue; this plan does not depend on it, but would gain from it.
- **App permissions are the App's.** Narrowing (N5) cannot add what the App lacks. An agent that needs a permission the App does not have (issues, secrets, workflow files) is refused by GitHub, and must stop and report it.
- **Renamed or transferred repositories** follow GitHub's redirect after the identity was chosen for the old owner; N6 catches the App case, not the person case. `repositories/<id>` paths and `gh api graphql` with the owner only in the body are unresolved: no injection, and rule h judges writes.
- **Latency:** one Node start on every `gh` call, and one mint per mapped call (§5.3).

## 11. Open questions for the owner

- Q1. N3 lets agents **read** as the person for owners with no App. Keep that, or require an `agent` identity for every mapped owner (reads included)? Recommended: keep it; it is today's behaviour with the right account, and `doctor` lists owners without an App.
- Q2. Phase 1 makes `taaad env` and `gh auth token` unavailable to agents everywhere, including for unmapped owners, before phases 2–3 give them a replacement. Ship phase 1 alone, or together with phase 3? Recommended: the `GH_AUTH_TOKEN_NETWORK` fix alone in v0.12.0, and D7/N9 together with phase 3.
- Q3. N8 retires `dot gh` for mapped owners. Is dot-work willing to follow (its docs and AGENTS.md proposal in the same cycle)?

## 12. Security review (2026-11-08)

An independent review (Fable `security-reviewer`) of the first draft found five high, six medium and seven low findings. None rejects the design. They are folded in as the amendments in §12.1, which **take precedence over any conflicting text above**. They will be merged into §4–§9 when the owner has answered the remaining questions (Q1–Q3, Q6; Q4 and Q5 are decided, §12.2). The reviewer rated these sound as written: D1, D2/§5.1, N2, D3's single trusted `gh`, D4, N6, N7, N8, N9 as labelled speed bumps, "no cache in repo-aegis", HTTPS + `x-access-token` with `AGENT_PUSH_NEEDS_APP`, the phasing, and the `GH_AUTH_TOKEN_NETWORK` fix direction. Prior findings H1–H5 and M1–M5 of the parked plan: all closed, except where the rows below reopen them (H1 → A3, H2 → A2, H3 → A4, M1 → A8).

### 12.1 Amendments

| # | Finding | Amendment |
|---|---|---|
| A1 | **H-1** Presence is steerable by text: `REPO_AEGIS_EGRESS_HUMAN=1 gh pr view --repo o/r` exits the hook before rule b′ (no egress intent), and `humanPresence()` returns *present* from that variable, and for `unrooted` and `undeterminable` chains, so a read runs as the person | N1 uses its own `identityPresence()`: no environment variable counts, and neither does an approval. `clear` → person; `agent` / `no-tty` → agent; `unrooted` / `undeterminable` → refusal `GH_IDENTITY_PRESENCE_UNKNOWN` (neither column; fix: run it from a terminal). The hook refuses `REPO_AEGIS_*` assignments and pty wrappers on **any** segment that runs `gh`, `git`, `taaad` or `security`, whatever its intent. D8 names `REPO_AEGIS_EGRESS_HUMAN` explicitly |
| A2 | **H-2** The injected token reaches what the `gh` child inherits: `GH_PAGER` with `GH_FORCE_TTY`, `GH_EDITOR` / `EDITOR`, `HTTPS_PROXY`, `SSL_CERT_FILE` (Linux), `pager:` / `editor:` in gh's `config.yml`, and the `git` children gh spawns, which read the agent-writable `.git/config` (`core.fsmonitor`, `credential.helper`, filters) | Step 9 spawns `gh` with an **allowlisted** environment: `HOME`, the pinned `PATH`, `TERM`, `LANG` / `LC_*`, `TMPDIR` and `GH_TOKEN`, plus fixed values `GH_PAGER=`, `GH_PROMPT_DISABLED=1`, `GH_NO_UPDATE_NOTIFIER=1`, `GH_NO_EXTENSION_UPDATE_NOTIFIER=1`, `GIT_TERMINAL_PROMPT=0`, and `GIT_CONFIG_COUNT` overrides for gh's git children: `core.fsmonitor=false`, `core.hooksPath=/dev/null`, `credential.helper=` and `core.sshCommand=ssh`. An injecting call refuses `--editor` / `-e`, `--web` / `-w`, `gh api --hostname`, full-URL endpoints, and any first word that is not a gh built-in (aliases and extensions run with the environment). I16 also captures a pager, an editor, a proxy listener, a repo-local `core.fsmonitor` program and gh's `config.yml` pager |
| A3 | **H-3** D5's and N11's "no injection" runs the call as the **active person account**: a cwd-only write, a `GH_REPO` write, a call naming two owners, or an owner whose mapping was lost | The owner is resolved the way rule h resolves it (literal, `GH_REPO`, cwd remote). For an owner mapped with an `agent` identity and no person present: a **write** without exactly one literal owner (`GH_REPO` counts as literal) is `GH_IDENTITY_NEEDS_LITERAL_TARGET`; a call naming several owners where any one is mapped is refused. Reads keep the hint. Every mutator round-trips identities, tested over a v3 fixture. Opt-in `requireIdentity` (§11 Q4) |
| A4 | **H-4** The reference taaad is a pipx venv under the home directory: its launcher, interpreter and package code are agent-writable, so pinning its path protects nothing, and the PEM's keychain ACL trusts agent-writable code. taaad's config (slug → installation) is reachable through `XDG_CONFIG_HOME`, and a swap between two Apps on the **same** org passes N6 | N4: `install shim` records the realpaths of taaad's launcher, interpreter and package directory; each must be root-owned and writable only by root, else `TAAAD_AGENT_WRITABLE` and `github-app` injection is refused (D4). The supported install is a root-owned prefix (§11 Q5), and the package directory joins the managed drop-in's deny rules. taaad is spawned with a fixed minimal environment (no caller `XDG_CONFIG_HOME` / `TAAAD_*`). §8.1 also returns `appId` and `installationId`; `identity add --app` records the `appId` seen at a person-present probe, and a differing mint is `GH_IDENTITY_APP_MISMATCH`. §8.3: `doctor` fails `APP_PEM_ACL_WEAK` when the PEM ACL trusts `/usr/bin/security` or a user-writable path |
| A5 | **H-5** git consults the next helper whenever one prints nothing, so every refusal in the repo-aegis helper falls through to `gh auth git-credential`, i.e. the person. After a push, `store` hands the token to **every** configured helper, including a repo-local one | Every refusal prints `quit=true` (git stops asking and does not prompt) and the code on stderr. Printing nothing is reserved for "person present" and "unmapped owner", and §5.6 says explicitly that an unmapped owner's agent push goes as the person (N11). Before minting, the helper runs `git config --show-scope --get-urlmatch credential <url>` and refuses with `quit=true` (`AGENT_PUSH_CREDENTIAL_CONFIG`) when a helper comes from `local`, `worktree` or `command` scope. It also refuses when any of `http.proxy`, `http.sslVerify=false`, `http.sslCAInfo` / `sslCAPath`, `http.extraHeader` or `http.sslBackend` is set at a non-system scope, or when `GIT_TRACE_CURL`, `GIT_CURL_VERBOSE`, `GIT_TRACE_PACKET`, `GIT_TRACE_REDACT=0`, `*_PROXY` or `GIT_SSL_*` is in its environment. Tests: a failing taaad yields exactly `quit=true` and the next helper never runs; a repo-local `credential.helper` never receives the token |
| A6 | **M-1** "Ahead of any existing helper" cannot be met. A `credential.https://github.com.helper = ""` reset (present on the reference machine) wipes entries before it, a system-scope `osxkeychain` runs first, and `gh auth setup-git` reorders the list | `install git-credential` checks the effective list with `git config --get-urlmatch`. The repo-aegis helper must be the first non-empty entry across all scopes: it is inserted after the last reset, and the install refuses with instructions when a system-scope helper comes first. New `doctor` failure `GIT_CREDENTIAL_HELPER_ORDER`; the pre-push hook re-checks the order for an agent HTTPS push to a mapped owner. Tests with the reset entry and a system `osxkeychain` |
| A7 | **M-2** The credential protocol carries no verb (fetch and push send the same `get`), and HTTPS authentication happens before pre-push runs | §5.6 states both facts. The helper reads its parent chain (`git-remote-https` ← `git push|fetch|…`, with the `process-ancestry.ts` reader) and mints the read class unless the parent is `push`; an unreadable chain is refused with `quit=true`. Tests: `git fetch` through the helper; a push to a repository the App is not installed on is refused, not passed through |
| A8 | **M-3** Object-form `personalOrgs` would hand objects to every existing string consumer (`registeredOwners`, `approvalScopeOf`, the deny set). The resulting `TypeError` in the hook is exit 1, which Claude Code treats as non-blocking (fail open) | The parsed `Registry` keeps `personalOrgs: string[]` (names) and adds a separate `identityMap: ReadonlyMap<owner, {person?, agent?}>` built at parse time; no existing consumer changes shape. The whole existing suite runs once more against a v3 fixture. An owner in two mapped entries is a parse error |
| A9 | **M-4** The interim path without narrowing gives agents the App's full installation token, flagged only by a `doctor` warning | The `github-app` path does not ship without §8.1 narrowing (§11 Q6). If it ever does, it needs a TTY-set registry flag `allowUnnarrowedAppTokens`, the D6 line says `UNNARROWED`, and `doctor` fails rather than warns |
| A10 | **M-5** D7 misses the `gh auth` verbs that change identity state, and N9 misses other keychain routes | D7: with no person present, every `gh auth` verb except `status` without `--show-token` / `-t`; plus `gh config set|clear-cache`, `gh alias set|import|delete` and `gh extension install|upgrade|exec` (`GH_AUTH_NEEDS_HUMAN`). N9: any `security find-*-password`, `dump-keychain`, `export` or `unlock-keychain`, and an interpreter one-liner that imports `keyring` or `Security`. On Linux there is no PEM ACL: `github-app` identities need a root-owned taaad with a root-readable secret store, or are unsupported |
| A11 | **M-6** Approvals must not leak into identity | Only `<org>/<repo>` and `<org>/*` approvals can carry a login; `approve '*'` records none and never satisfies `GH_IDENTITY_WRITE_NEEDS_HUMAN`. Property test: the column is a function of `identityPresence()` only, for every registry, environment and approval set |
| A12 | **L-1** Persons' non-terminal automation (cron, `dot gh`, whose piped stderr reads as "no person") loses `gh auth token` and hits N7 | Stated as a breaking change in Q2, Q3 and the CHANGELOG |
| A13 | **L-2** `GH_TOKEN` in the child's environment is visible to same-user processes (`ps -E`) while the call runs | Recorded in §10. It argues for answering Q1 the strict way |
| A14 | **L-3** `identity check`'s must-fail probe must not write | Must-fail is `GET /repos/<owner>/<uncovered repo>` with the narrowed token (404), and `GET /installation/repositories` lists exactly one repository |
| A15 | **L-4** The audit log is opt-in | D6 records go to the decision log unconditionally |
| A16 | **L-5** Name shapes | Identity name and slug: `^[a-z0-9][a-z0-9-]{0,62}$` (never a leading `-`, so a value cannot be read as an option); login: `^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$` |
| A17 | **L-6** A renamed repository makes git ask again for the new path, which may fall through | The helper remembers the first path of its invocation and refuses a differing second one with `quit=true`; also listed in §10 |
| A18 | **L-7** Arguments can redirect too | Covered by A2 (`--hostname`, full-URL endpoints refused on injecting calls) |

### 12.2 Questions the review adds for the owner

- **Q4** (A3). **Decided 2026-11-08, narrower than the review proposed.** `requireIdentity: true` is set by the first `set-identity` and can be cleared by a person (TTY-gated). While it is set, an agent write to a registered owner with **no identity entry at all** is refused (`GH_IDENTITY_UNMAPPED_OWNER`), and `OWNER_IDENTITY_UNMAPPED` is a `doctor` failure. An owner with only a `person` identity keeps N3 (login-bound approval for agent writes). The reviewer's version refused every owner without an `agent` App; it is not adopted, because organisations the user does not control (engagement orgs) usually cannot have the user's App installed, so agents could never write there, even with approval. The narrower rule still catches a lost mapping, which is what H-3 is about.
- **Q5** (A4). **Decided 2026-11-08: yes, in two steps.**
  1. Now, independent of this plan: taaad moves to a root-owned install (`sudo pipx install --global taaad`, under `/opt/pipx`, on `PATH` through `/usr/local/bin`), and the user-level copy is removed. Today any agent that can write the home directory can edit taaad's code and capture every App token `dot gh --as bot` mints. A4's `TAAAD_AGENT_WRITABLE` check enforces this from phase 3.
  2. Follow-up, required before `github-app` identities count as protected: root ownership protects taaad's *code*, not its PEM. macOS keychain ACLs trust the *binary* that asks, and the PEM item most likely trusts the Python interpreter that created it (to be confirmed by `taaad doctor`, §8.3). Any script run by that interpreter (`python3 -c 'import keyring; …'`) would then read the PEM without a prompt, however taaad is installed, and on Apple Silicon `/opt/homebrew` is user-owned too. The fix is a mint that needs proof of presence or a binary that can only mint: a Touch ID / user-presence keychain item with taaad caching the one-hour token after the prompt (ties in with issue #154), or a small compiled `taaad-mint` helper that is the only ACL entry. Until then `APP_PEM_ACL_WEAK` is a `doctor` failure, not a warning.
- **Q6** (A9). Ship the `github-app` path only after taaad's narrowed `mint` (§8.1)? Recommended: yes. Phase 3 can ship `gh-login` identities (the person column, plus N3 reads) first.
