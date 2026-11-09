# Plan: let agents run `dot gh`, and make `--as bot` the way they write

Status: shipped in v0.11.1 (#160). Supersedes `doc/plan-gh-identity-selection.md`, which was never merged to `main` (it exists only on the local branch `plan/gh-identity-selection`, so there is no file to link to); `doc/plan-owner-identity.md` later revived its decisions and shipped them in v0.12.0.

## 0. Threat model, in one sentence

repo-aegis stops **accidental** leaks: into public repositories, and from one customer to another. It is not a wall against an agent that sets out to get around it. The egress guard's existing non-goal already says so ("client-side controls are advisory by construction", `doc/design/egress-guard.md`). This plan is judged against that sentence. A finding that only defeats a *deliberate* bypass is out of scope, and §6 lists the ones this plan accepts.

## 1. Problem

`dot gh` is a small wrapper (`node <path>/scripts/dot.mjs gh [--as <identity>] [--explain] <gh args…>`) that runs `gh` with the token of the identity its target needs. It reads a person's token with `gh auth token --user <login>`, or mints a GitHub App installation token for `--as bot`. It never uses or switches the active `gh` account, which other sessions share.

Since v0.11.0, rule h refuses `node <script> gh …` from an agent. The parser cannot take an interpreter call apart, so the backstop marks it `unparsed-shape`, and the call is refused as `UNREGISTERED_OWNER_EGRESS`. So an agent that follows its org's rule and opens a PR as the bot (`dot gh --as bot pr create --repo <owner>/<repo> …`) is stopped. Its only remaining path is plain `gh`, which writes as whichever **person** is the active account. That is worse on both counts.

The earlier plan (choosing the account inside the shim) would have moved token handling and App-token minting into repo-aegis, and a security review asked for eight more hardening items, almost all of them against a deliberate agent. That is the wrong cost for the threat model in §0.

## 2. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | The hook **recognises** one shape (§3.1) as a `gh` call: it strips the wrapper and `dot gh`'s own leading options, and judges the rest exactly as it judges plain `gh` (rules a–h, public-repo approval, markers). Nothing else about `dot gh` is modelled | A parser rule, no new component. The destination check is what prevents leaks, and it works on the `gh` arguments unchanged |
| D2 | **With no person present, a write through `dot gh` needs `--as bot`**, given as `dot gh`'s own leading option. Otherwise it is refused with `DOT_GH_WRITE_NEEDS_BOT`, whose message gives the corrected command. Reads may use any identity or none | Without `--as`, `dot gh` picks the identity from the owner, and for the user's own org that is the **person**. An agent that forgets `--as bot` would publish as the user. That is the accident this catches |
| D3 | `bot` is a fixed name: the identity `dot gh`'s table declares for the agent's GitHub App. repo-aegis does not read the table | One literal is easy to document and to test. Reading dot-work's table would make it a second input to the guard |
| D4 | `dot gh --explain …` is no egress (it runs no `gh` and reads no token) | It prints what it would do and stops |
| D5 | Any other wrapper shape stays `unparsed-shape` and refused, as today: node options before the script (`-r`, `--import`, `-e`), `NODE_OPTIONS`/`NODE_PATH` set on the segment, a script not named `dot.mjs`, a target in a variable | Keeps the recognised shape small enough to document in one line |
| D6 | No change to the shim. The `gh` that `dot gh` spawns reaches the shim with literal arguments and is judged there as plain `gh`. One consequence for persons is an accepted limit (§6): `dot gh` pipes `gh`'s stderr, so the shim's terminal test never sees a person | Defence in depth already exists. The shim cannot see `--as`, so D2 lives at the hook |

## 3. Design

### 3.1 The recognised shape

One shell segment (after the existing handling of `cd`, `&&`, env assignments and redirections), whose words are:

```
node <path ending in /dot.mjs> gh [--as <id> | --as=<id> | --explain]… <gh args…>
dot gh [--as <id> | --as=<id> | --explain]… <gh args…>
```

- `node` is the bare word or an absolute path whose last component is `node`. No word starting with `-` may come between `node` and the script.
- The script is a literal word (no `$`, glob or substitution) whose last path component is `dot.mjs`.
- `dot`'s own options are read **only at the front**, as `dot gh` itself reads them (`splitOwnOptions` in dot-work `scripts/dot-gh.mjs`; dot-work is a private repository, so this reference cannot be checked from here). `dot gh pr create --as bot …` passes `--as bot` to `gh`, so for D2 there is no `--as`. The refusal says to move it to the front.
- `--as` with a missing, empty (`--as=`) or `-`-leading value is a refusal by `dot gh` itself (`splitOwnOptions` checks the same three), and it runs no `gh`: no intent, like `--explain`.
- The remainder goes to the existing plain-`gh` parser as an argument vector, unchanged, with the same context a plain `gh` on that segment gets (`GH_REPO` in the prefix or the environment, an earlier `GH_REPO` change, the user's aliases). The intent carries `wrapper: { kind: "dot-gh", as: <id> | null }`, and `precededByCd`, `joinedBy` and the other segment facts as for any intent.

### 3.2 The decision

For a `dot-gh` intent, in this order:

1. `--explain` given: no intent (D4).
2. No person present, the call is a write, and `as !== "bot"`: refuse `DOT_GH_WRITE_NEEDS_BOT` (D2). A write is any intent the parser returns for the remainder, resolved or unresolved (`gh-unknown` / `unknown-shape` included): that is the set rule h judges, and reads yield none.
3. Otherwise: the plain-`gh` decision on the remainder, unchanged.

Step 2 comes before step 3 because its fix belongs to the agent (add `--as bot`), while most step-3 refusals belong to a person. It also comes before the shape rules, deliberately: `cd … && dot gh pr create …` with no `--as` gets `DOT_GH_WRITE_NEEDS_BOT` first, and `EGRESS_AFTER_CD` only once `--as bot` is there.

### 3.3 Refusal text

```
repo-aegis: dot gh write without --as bot: refused. With no person present, a write through dot gh must run as the bot. Without --as, dot gh picks the account from the repository's owner, which for your user's own organisation is the user themself, so the agent would publish as them. Re-issue with --as bot as dot gh's first option:
  dot gh --as bot <the same gh arguments>
If the bot lacks the permission (it has no issues, secrets, Actions or workflow-file access), stop and report it to your human; do not switch to --as owner or plain gh. [DOT_GH_WRITE_NEEDS_BOT]
```

Static text; the gh arguments are not echoed (the hook already avoids echoing command text).

## 4. Tests

Fixtures in `packages/core/src/egress-intent*.test.ts` and `egress-policy*.test.ts`. "Agent" means no person present; `o` is a registered private owner.

| # | Command | Expected |
|---|---|---|
| T1 | `node /p/scripts/dot.mjs gh --as bot pr create --repo o/r --title t --body-file /s/b.md` | allowed. Parser: exactly one intent, verb `gh-pr-create`, `wrapper: { kind: "dot-gh", as: "bot" }`, `repoFlag` `o/r`, `payloadFiles` `["/s/b.md"]`. With a marker in the payload file: refused as for plain `gh` (`PAYLOAD_MARKER_HIT`) |
| T2 | same without `--as` | `DOT_GH_WRITE_NEEDS_BOT` |
| T3 | same with `--as owner`, and with `--as work` | `DOT_GH_WRITE_NEEDS_BOT` |
| T4 | `--as=bot` | allowed |
| T5 | `dot gh pr create --as bot --repo o/r …` (`--as` after a gh word) | `DOT_GH_WRITE_NEEDS_BOT` |
| T6 | `dot gh --as bot pr create --repo o/r …` (bare `dot`) | allowed |
| T7 | `dot gh --repo o/r pr view 1` and `dot gh --as owner api repos/o/r` (reads) | allowed |
| T8 | `dot gh --as bot pr create --repo pub/r …`, `pub` registered and public, no approval | `PUBLIC_EGRESS_NEEDS_HUMAN`, as for plain `gh` |
| T9 | `dot gh --as bot pr create --repo stranger/r …`, owner unregistered | `UNREGISTERED_OWNER_EGRESS` |
| T10 | `dot gh --as bot pr merge 3 --repo o/r` | the plain-`gh` decision for `pr merge` |
| T11 | `node --require x /p/dot.mjs gh …`, `NODE_OPTIONS=--require=x node /p/dot.mjs gh …`, `node /p/other.mjs gh …`, `node "$S" gh …` | `unparsed-shape` → refused, as today |
| T12 | `dot gh --explain --repo o/r pr create …` | no intent |
| T13 | person present: `dot gh --as owner pr create --repo o/r …` | allowed |
| T14 | `cd /x && node /p/dot.mjs gh --as bot pr create --repo o/r …` | `EGRESS_AFTER_CD` (rule b), as for plain `gh`: the intent carries `precededByCd`. Without `--as bot`, `DOT_GH_WRITE_NEEDS_BOT` (D2 comes first) |
| T15 | the refusal of T2 contains `dot gh --as bot` literally and no gh argument | asserted |

| T16 | `dot gh --as owner project item-add --repo o/r …` (an unresolved write) | `DOT_GH_WRITE_NEEDS_BOT`; with `--as bot`, the plain-`gh` decision for the same call (unknown shape, refused by rule h) |
| T17 | `GH_REPO=o/r dot gh --as bot pr create --title t --body-file /s/b.md` | allowed (the remainder gets plain `gh`'s context), not `GH_PR_CREATE_IMPLICIT_TARGET` |
| T18 | `dot gh --as`, `dot gh --as= …`, `dot gh --as --explain …`, `dot gh --as -x …` | no intent (`dot gh` refuses its own options) |

T2, T3, T5, T6 and T1 fail on today's code (T1 and T6 are refused as `unparsed-shape`, T2/T3/T5 are refused for the wrong reason, with a message that says to report to the human instead of naming the fix).

## 5. Documentation: `--as bot`

The owner asked for `--as bot` to be documented thoroughly. An agent should learn it from the first place it looks, and the refusal should teach it again. The text below is part of this spec and lands verbatim (adjusted only for links) in the same PR as the code.

### 5.1 repo-aegis `doc/agent-guide.md`: new section, after the egress refusals

> ### Writing to GitHub through `dot gh`: always `--as bot`
>
> Some setups provide `dot gh`, a wrapper that runs `gh` with the token of the right identity for each command and never touches the shared active `gh` account. repo-aegis recognises it in exactly this form:
>
> ```
> node <path>/scripts/dot.mjs gh [--as <identity>] [--explain] <gh args…>
> dot gh [--as <identity>] [--explain] <gh args…>
> ```
>
> **Every write you make through it carries `--as bot`, as its first option.** A write is anything that creates, changes or deletes something on GitHub: `pr create`, `pr edit`, `pr comment`, `pr review`, `pr close`/`reopen`, `issue …` writes, `release …`, `repo …` writes, `api -X POST|PATCH|PUT|DELETE`, and `api -f`/`-F` (which imply POST).
>
> ```
> dot gh --as bot pr create --repo <owner>/<repo> --base main --head <branch> --title "…" --body-file <abs path>
> dot gh --as bot pr comment 12 --repo <owner>/<repo> --body-file <abs path>
> dot gh --as bot api -X POST repos/<owner>/<repo>/pulls/12/requested_reviewers -f "reviewers[]=<login>"
> ```
>
> Why: without `--as`, `dot gh` chooses the identity from the repository's owner, and for your user's own organisation that is **your user's personal account**. A write as that account is your user publishing, with nobody at the keyboard. As the bot, the write is attributed to an agent, holds only the bot's narrow permissions, and leaves your user's approval meaningful.
>
> - **First option, or it does not count.** `dot gh pr create --as bot …` hands `--as bot` to `gh`, not to `dot gh`; repo-aegis refuses it as a write without the bot.
> - **Reads need nothing.** `dot gh --repo <owner>/<repo> pr view 12` picks the right account itself. `--as bot` on a read is fine too.
> - **Check before you act:** `dot gh --as bot --explain --repo <owner>/<repo> pr create …` prints the identity and target and runs nothing.
> - **Read the receipt.** Every run prints `dot gh: as bot (…) for <owner>/<repo>` on stderr. If it names any other identity on a write, stop.
> - **Everything else still applies.** `--as bot` does not lift any other rule: public repositories still need your user's approval, unregistered owners are still refused, markers are still scanned. A refusal there is for your user, not for you to route around.
> - **When the bot lacks a permission** (it has no access to issues, secrets, Actions or workflow files), `dot gh` says so. Stop and report it. Never retry as `--as owner`, `--as work` or plain `gh`: that is the accident this rule exists to stop.
> - Any other way of running a wrapper (node options, `NODE_OPTIONS`, a different script name, a script path in a variable) is not recognised and stays refused.

The row for `node …/wrapper.mjs gh …` in the refusals-by-shape table changes to say that `dot gh` in the form above is recognised and every other wrapper is refused. A new row in the refusal-code table:

> | `DOT_GH_WRITE_NEEDS_BOT` | egress guard, at the hook: a write through `dot gh` with no person present and no leading `--as bot` | **Fix it yourself:** re-issue as `dot gh --as bot <same gh arguments>`, with `--as bot` first. If the bot then lacks the permission, stop and report it; do not switch identity. |

### 5.2 repo-aegis, the CLAUDE.md block written by `install claude-md`

One line, with an assertion in the existing `install-claude-md` tests:

> - Writes through `dot gh` carry `--as bot` as the first option (`dot gh --as bot pr create --repo <owner>/<repo> …`); a write without it is refused (`DOT_GH_WRITE_NEEDS_BOT`).

### 5.3 repo-aegis, other pages

- `doc/design/README.md` "Threat model" and `doc/design/egress-guard.md` "Non-goals": the §0 sentence.
- `doc/design/egress-guard.md`: the recognised shape and D2 next to rule h.
- `CHANGELOG.md`: *Added*: `dot gh` is recognised; *Changed*: a `dot gh` call with a person present is now judged as plain `gh` instead of as an unparsed shape. Agent calls were all refused before, so nothing is stricter for agents except the wording of the refusal.

### 5.4 dot-work (private repo, its own PR, after the release)

- `scripts/README.md`, section "`dot gh`": a subsection **"Agents: every write is `--as bot`"** with the same rule, the three examples, and the "first option" trap.
- `docs/identity-and-authority.md`, "Minting, probing, and using a token": one paragraph saying that agents on the host write through `dot gh --as bot`, and that repo-aegis enforces it.
- `scripts/dot-gh.mjs` / the identity table must declare the agent's GitHub App identity under the name `bot` (D3): repo-aegis trusts the word and does not read the table.
- `AGENTS.md` §2 is control plane: **propose** one line to the founder ("On the host, write to GitHub with `dot gh --as bot …`"); do not edit it.

## 6. Accepted limits

Under §0, these are out of scope and are written down, not designed around:

- `dot.mjs` and its identity table are files an agent can edit. A changed wrapper, a different `dot.mjs`, or a table that maps `bot` to a person's account would pass the hook. Each of those is a deliberate act and visible in the transcript. The table is already marked control plane in dot-work.
- `--as bot` is trusted as a word; repo-aegis does not check that the token really is the App's.
- Plain `gh` writes from an agent still run as the active account, as today. Only `dot gh` writes are steered to the bot.
- D2 is enforced at the hook only. A framework without the hook falls back to the shim, which judges the inner `gh` call but cannot see `--as`.
- A person's own public write or merge through `dot gh` is judged at the shim (rule g). `dot gh` pipes `gh`'s stderr (`scripts/dot-gh.mjs`), so the shim's terminal test never sees a person: such a call needs `REPO_AEGIS_EGRESS_HUMAN=1`, or plain `gh`. Reads and private writes are unaffected.

## 7. Work breakdown

1. repo-aegis, one PR: parser recognition (§3.1), the D2 rule (§3.2), the refusal text (§3.3), T1–T15, docs §5.1–§5.3.
2. dot-work, one PR after the release: docs §5.4, and the AGENTS.md proposal to the founder.
