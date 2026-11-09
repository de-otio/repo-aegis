# Analysis: is repo-aegis still the right tool? (landscape, November 2026)

Status: research note, 2026-11-09. Six months after v0.1 (2026-05-01).
Follow-up work: [plan-landscape-recommendations.md](plan-landscape-recommendations.md).

## 1. Question

The AI-tooling ecosystem moved fast in 2026. Does something now exist that
solves repo-aegis's problem better, so that the project should shrink, merge
into something else, or stop?

The problem, restated so it can be compared:

> One machine, several concurrent customer engagements plus personal and OSS
> work. Customer A's identifying strings are legitimate inside A's
> repositories and must not appear anywhere else, including other customers'
> repositories and public ones. Agents write, commit and publish; the gate has
> to be deterministic, agent-readable, scoped per repository, and must also
> ask *where* bytes are going, not only *what* they are.

Three properties make the problem distinct:

1. **Engagement scoping**: one deny set per repository, computed from that
   repository's engagement. A flat list fails in the legitimate case.
2. **Destination awareness**: the egress guard judges the target (owner,
   visibility, irreversible verb), not just the payload.
3. **Identity follows the target**: the account that writes is chosen by the
   repository owner (v0.12).

## 2. Method and limits

Web research on 2026-11-09: about fifteen searches across vendor docs,
changelogs, open-source repositories and secondary roundups, plus a
second-pass check of the load-bearing claims against primary pages. Search
themes: AI-agent data-leak prevention and hooks; secret-scanning hooks for
coding agents; enterprise agent DLP; Claude Code managed settings and
inference hooks; agent push and egress guards; multi-account `gh` helpers;
PII redaction hooks; consultant multi-client confidentiality.

No competitor was installed or tested. Unless a claim links a primary page,
treat it as **vendor-stated**. Several roundups are vendor- or
affiliate-authored and count as weak evidence. Absence claims ("no tool
found") mean *not found in this search*, not "does not exist".

## 3. Findings by category

### 3.1 Secret-scanning hooks for coding agents

**GitGuardian ggshield AI hooks** (vendor-stated, as of 2026-11). The hooks
install into Claude Code, Cursor, Codex, Copilot CLI, VS Code, Kiro, Junie CLI
and others ([integration docs](https://docs.gitguardian.com/ggshield-docs/integrations/ai-coding-tools/secret-scanning-for-ai-coding-tools)),
and `ggshield machine setup` configures every detected assistant plus git
hooks. They scan at prompt submission, pre-tool and post-tool. GitGuardian
claims 500+ secret types ([showcase, April 2026](https://www.helpnetsecurity.com/2026/04/15/product-showcase-gitguardian-ggshield-ai-hook/),
vendor-authored).

- Overlap: `hook scan-bash-output` (universal secret shapes) and part of the
  pre-commit gate.
- Not a replacement: it is built for credentials. Custom detectors are
  created in the SaaS dashboard and implemented by GitGuardian's team
  ([customize detection](https://docs.gitguardian.com/secrets-detection/detect/customize-detection)).
  During the beta they were limited to the Business plan, and PII-type
  patterns were not accepted ([beta post](https://blog.gitguardian.com/detecting-custom-secrets-patterns-is-in-public-beta/);
  current terms unverified). There is no notion of an engagement or of
  per-repository scoping.

**GitHub** custom patterns can be defined at **repository**, organisation or
enterprise level, and push protection is optional per pattern
([about push protection](https://docs.github.com/en/code-security/secret-scanning/introduction/about-push-protection),
[custom patterns](https://docs.github.com/en/code-security/concepts/secret-security/custom-patterns)).
Repository-level push protection requires GitHub Secret Protection. User
push protection is on by default for public repositories.

- Not a replacement, even at repository level: the patterns live in the
  hosting service's settings. Anyone with admin rights on repository B could
  read customer A's markers there, so configuring them is itself a
  disclosure. A consultant would also have to maintain the same list in
  every repository they touch. It runs only at push, never on agent writes.

**gitleaks / trufflehog** custom rules: flat rule files, no scoping, and a
committed `.gitleaks.toml` listing customer names would publish the list
([gitleaks](https://github.com/gitleaks/gitleaks)).

### 3.2 Enterprise agent DLP and runtime control

All vendor-stated: Nightfall (desktop agent hooks for Claude Code, Cursor and
VS Code; dictionary, regex and prompt-defined entity detectors;
[custom detectors](https://help.nightfall.ai/detection_platform/custom_detectors)),
Pillar for AI Coding Agents ([launch, Feb 2026](https://www.pillar.security/blog/introducing-pillar-for-ai-coding-agents);
endpoint discovery plus pre-execution tool-call evaluation), Knostic Kirin
([product page](https://www.knostic.ai/coding-assistants-agents-mcp);
IDE-as-endpoint guardrails), dope.security.

- Overlap: the same hook points, and dictionary detectors could hold
  customer names.
- Not a replacement: they model one organisation's policy, delivered as SaaS.
  For a consultant, sending every customer's identifying strings to a
  third-party classifier is a confidentiality problem of its own. None of the
  pages read documents per-repository engagement scoping or destination
  checks on `git push` / `gh`.

### 3.3 Platform-native controls

**Claude Enterprise inference hooks** (beta, launched 2026-08-05). The
organisation's own server returns allow or deny for two events: `prompt`,
before inference, and `tool_call`, when Claude's response contains tool
calls, before any of them run. `tool_call` is opt-in ("Validate tool calls").
Tool responses, including those from MCP, skills and plugins, are checked
before they return to the model
([announcement](https://claude.com/resources/articles/claude-enterprise-inference-hooks),
[platform docs](https://platform.claude.com/docs/en/manage-claude/inference-hooks)).
Some built-in claude.ai tools are excluded, and field names may change before
GA. Managed settings (`allowManagedHooksOnly`,
`allowManagedPermissionRulesOnly`) let an admin pin local hooks
([Claude Code settings](https://code.claude.com/docs/en/settings)).

- Closer than it first looked: with `tool_call` validation on, an
  organisation's DLP server sees a pending `Bash` command such as `git push`,
  or a pending `Write` with its content, before it runs. In principle that
  server could host repo-aegis-like logic.
- Still not a replacement for the consultant case: it covers Claude
  Enterprise only, governed by **one organisation's** server, and it
  requires Owner-level configuration. A consultant does not own their
  customers' Claude organisations, and a customer's DLP server knows nothing
  about the consultant's other customers. It does not cover git hooks, other
  agents or human commits.
- Hosting repo-aegis's decision function behind an inference-hook endpoint
  is now a concrete option for a consultancy that owns its own Enterprise
  organisation. That would complement the local hooks, not replace them.

### 3.4 PII redaction hooks

noirdoc ([write-up](https://chatgate.ai/post/noirdoc); Presidio plus local
NER, PreToolUse), Cloakroom (placeholder substitution),
[hush](https://github.com/aictrl-dev/hush),
[claude-code-redaction-hooks](https://github.com/l-mb/claude-code-redaction-hooks)
(mapping file, manual term list), DataFog.

- Different goal: keep data out of the model's context. Inside customer A's
  own repository that blocks legitimate work, and none of them knows which
  repository belongs to which engagement.

### 3.5 Open-source agent push guards

[git-agent-guard](https://github.com/sabilmakbar/git-agent-guard) (refuses
`gh pr merge`; opt-in user.email ↔ remote check),
[agent-hook-guards](https://github.com/Adrian-I-lab/agent-hook-guards)
(remote allowlist), [git-warden](https://github.com/pihme/git-warden) (guard
remote plus backups), [agent-git-guard](https://github.com/martinfrancois/agent-git-guard)
(no agent push to main or history discard), force-push guards, AgentGuard.
Descriptions are from each project's README.

- Overlap: a slice of the egress guard.
- Not a replacement: none of the READMEs describes judging destination
  visibility or ownership against an engagement registry, scanning a PR body
  against the destination's deny set, or covering the `gh` CLI's write verbs
  systematically.

### 3.6 Multi-account `gh` / git helpers

gh-autoswitch (a credential helper that, per its
[listing](https://wingetly.io/apps/pbrouillet/gh-autoswitch), runs
`gh auth switch` by remote owner; project repository not checked), gwitch,
direnv recipes, per-URL credential helpers
([gh multiple accounts](https://docs.github.com/en/github-cli/github-cli/using-multiple-accounts)).

- Overlap: v0.12 "identity follows the target owner".
- These switch identity but apply no policy. If gh-autoswitch works as
  listed, it changes the global active account, which is the shared-state
  hazard v0.12 avoids.

### 3.7 Agent hosts

- **Gemini CLI was retired in favour of Antigravity CLI** (`agy`), announced
  2026-05-19, with a reported cutoff of 2026-06-18 for individual accounts
  ([Google announcement](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/)).
  Antigravity keeps hooks, but its hook format is not confirmed against
  official docs. repo-aegis documents a Gemini CLI hook (`--agent gemini`)
  that may now serve few users.
- **Codex** hooks: `PreToolUse` deny works. `permissionDecision: "ask"` is
  parsed but not yet supported. Non-managed hooks must be reviewed and
  trusted through `/hooks` before they run
  ([Codex hooks](https://developers.openai.com/codex/hooks)).
- **Cursor** hooks: `beforeShellExecution` can deny; `afterFileEdit` is
  reported to be observe-only ([Cursor hooks](https://cursor.com/docs/hooks)).

## 4. Assessment

**No tool found in this search combines engagement-scoped deny sets,
destination-aware egress and owner-following identity.** The closest
suggestion in the material read is "build a pre-commit denylist yourself".
The products found sell to single organisations; repo-aegis's user is a
consultant with many.

**The architecture is now common.** Deterministic hooks at pre/post tool use
across several agent hosts is how ggshield, Nightfall, Pillar and Claude
Enterprise's managed hooks all work. That is evidence the design is sound,
not that repo-aegis was first.

**What changed:**

| # | Change | Consequence for repo-aegis |
|---|---|---|
| C1 | Secret detection for agents is a commodity (ggshield claims more hosts and types) | `scan-bash-output` should not grow; document a companion scanner |
| C2 | Cursor, Copilot CLI, Kiro and others now have hooks; commercial tools wire into all of them. Gemini CLI became Antigravity CLI | repo-aegis wires Claude Code (write and egress) and Codex/Gemini (egress, by hand). Cursor has no wiring: `packages/core/src/process-ancestry.ts:265` labels Cursor processes "VS Code". Gemini support needs an Antigravity check |
| C3 | Owner-switching helpers exist | The identity layer is the newest, costliest part to maintain and the most likely to be partly superseded |
| C4 | Claude Enterprise inference hooks gained a pre-execution `tool_call` event and tool-response checks | A possible server-side host for the decision function in an organisation the consultant owns. Still single-organisation and Claude-only, so no replacement |
| C5 | repo-aegis is hard to discover: a web search for `"repo-aegis" de-otio` on 2026-11-09 returned no matching result. npm reported 1,140 downloads for 2026-10-10 to 2026-11-08 ([npm API](https://api.npmjs.org/downloads/point/last-month/@de-otio/repo-aegis)). Who those downloads are is unknown; the author's own CI and machines are a plausible share | If adoption matters, publication matters more than features. The README still says the background guide will be linked "once published" |

**Observed in this session:** a read-only `gh repo view` was refused with
`GH_IDENTITY_UNAVAILABLE` because the identity token helper exited with a
failure. The refusal named the helper failure and told a person to run
`repo-aegis doctor`. The root cause was not diagnosed here, so this is one
data point, not evidence of a defect.

## 5. Verdict

Keep repo-aegis, and narrow it to what only it does: per-engagement deny
scoping, destination-aware egress, and owner-following identity. Leave commodity
secret detection to ggshield or gitleaks. Spend the next effort on agent-host
coverage (Cursor, Copilot CLI, and Antigravity in place of Gemini) and on
discoverability. Freeze the identity layer's scope and judge any further
hardening by the "honest mistakes, not perfection" rule (threat model in
`doc/plan-recognise-dot-gh.md` §0).

Reassess in about six months, or earlier when one of these happens:

- Claude Enterprise inference hooks reach GA with a stable `tool_call` contract.
  At that point, evaluate hosting the decision function there.
- A hosting service offers per-repository secret patterns that stay out of
  view of the repository's own admins, or a local per-repository dictionary
  (ggshield, Nightfall).
- Any agent host ships a native "this workspace belongs to engagement X"
  concept.

## 6. Sources

Primary pages are linked inline in §3. Secondary and vendor-authored material
consulted:

- [GitGuardian AI Hooks blog](https://blog.gitguardian.com/ai-hooks-ai-coding-assistants/), [Pillar 2026 roundup](https://www.pillar.security/blog/best-ai-coding-agent-security-tools-for-the-enterprise-2026), [Nightfall platforms](https://www.nightfall.ai/blog/ai-agent-security-platforms-securing-claude-code)
- [dope.security on managed settings](https://dope.security/post/claude-code-security-enterprise-controls), [digitalapplied on inference hooks](https://www.digitalapplied.com/blog/claude-enterprise-inference-hooks-dlp-guide) (predates the `tool_call` event)
- [GitButler on Cursor hooks](https://blog.gitbutler.com/cursor-hooks-deep-dive), [Elephas consultant guide](https://elephas.app/resources/how-consultants-use-ai-without-exposing-client-data)
