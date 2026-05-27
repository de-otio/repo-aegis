# repo-aegis `check-write` PreToolUse hook — intermittent spurious block

**Status:** fixed 2026-05-27 (unreleased). Two distinct bugs (one deterministic
symptom, one cwd-dependent cause); see "Resolution" below.
**Dates observed:** 2026-05-26 / 2026-05-27.
**Component:** `repo-aegis hook check-write` wired as a Claude Code `PreToolUse`
hook on `Write|Edit|MultiEdit`.

## Symptom

An `Edit` against a clean file is blocked by the PreToolUse hook with:

```
PreToolUse:Edit hook error: [repo-aegis hook check-write]: No stderr output
```

The hook exits non-zero but writes nothing to stderr, so the agent gets no
marker-hit detail and no redaction guidance — only the bare "No stderr output"
wrapper that Claude Code emits when a hook fails opaquely.

The block is **intermittent**: re-issuing the *identical* edit a moment later
succeeds. Observed both as fail-once-then-succeed (one repo) and
fail-twice-then-succeed (another repo) in the same session. The Write of this
very file was also blocked several times, then succeeded on retry.

## What it is NOT

The edited content is clean against the repo's scoped deny set. Verified two
independent ways at the moment of the block:

1. **Static scan of the exact new text:**
   ```
   repo-aegis check --path <file> --verbose
   → repo-aegis: clean (6 patterns checked)
   ```
2. **Running the hook itself manually** with a representative `tool_input`
   JSON on stdin:
   ```
   echo '{"tool_name":"Edit","tool_input":{"file_path":"…","old_string":"x","new_string":"…clean content…"}}' \
     | repo-aegis hook check-write
   → EXIT=0
   ```

So the deny-set logic returns clean for this content. The failure is in the
hook invocation path, not in marker detection. This is a false positive
(spurious block), not a real leak catch.

> The manual run exits 0 because it is invoked **with cwd inside the target
> repo** — which, per the root cause below, is exactly the condition under
> which the hook does *not* refuse. That is why the manual check could never
> reproduce it.

## Environment

- Two repos affected, both repo-aegis class `private-strict`, deny set =
  6 active patterns + 6 always-block, regex engine `re2`, 0 populated
  engagement markers (one engagement present but empty).
- Edits were ordinary code/doc changes reusing identifiers already present
  and committed in the target files (i.e. introducing no new tokens that
  could match a pattern).

## Impact

- Legitimate, verifiably-clean edits are blocked at random.
- The opaque "No stderr output" gives the agent nothing to act on. Per the
  repo-aegis guidance in CLAUDE.md the agent is told NOT to retry a blocked
  write with the marker still present — but here there is no marker, so the
  correct action (retry) is the opposite of the marker-hit playbook. An agent
  following the playbook literally would stall.
- Erodes trust in the hook: a guardrail that false-positives intermittently
  trains operators to reflexively retry, which is exactly the wrong habit if a
  real hit ever occurs.

---

## Root cause

Two independent defects, both in
`packages/cli/src/commands/hook-check-write.ts`. They are deterministic once
you control the hidden variable (the hook process's cwd); the "intermittent"
framing is an artifact of that variable drifting between invocations.

### Bug A — diagnostic goes to stdout, so the agent sees "No stderr output"

`check-write`'s `emitJsonAndExit` writes the payload to **stdout**
unconditionally:

```ts
function emitJsonAndExit(value: unknown, exitCode: number): never {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
  process.exit(exitCode);
}
```

Claude Code forwards **stderr** (not stdout) to the agent when a PreToolUse
hook exits non-zero. So *every* block — legitimate or spurious — reaches the
agent as the bare "No stderr output" wrapper.

The sibling PostToolUse hook already fixed this exact issue and documents it:
`hook-scan-after-write.ts`'s `emitJsonAndExit` routes non-zero exits to
stderr (`const stream = exitCode === 0 ? process.stdout : process.stderr`).
`check-write`, added later (v0.3.0), never picked up the same treatment.

The test suite **masks** this: the subprocess helper `runCli`
(`_subprocess-utils.ts`) parses JSON from *either* stream, so assertions on
`r.json` pass regardless of which channel the hook used — even though the
helper's own comment claims non-zero exits land on stderr.

### Bug B — source boundary is derived from `process.cwd()`

`check-write` passes `launcherCwd: process.cwd()`, and `decideHookAction`
derives the **source** trust boundary from that cwd. When the hook process's
cwd is *not inside the edited file's repo*, `destTree !== srcTree`, the policy
computes a cross-tree decision, and if the cwd's tree has a different (or
absent) remote org the boundaries don't overlap → `refuse` → exit 2 →
`CROSS_ORG_WRITE`.

The asymmetry that makes this fire on clean edits: an empty **dest** boundary
fails *open* (`DEST_UNCLASSIFIED` warning, scan proceeds), but an empty
**source** boundary fails *closed* — `trustBoundariesOverlap` returns false
whenever either set is empty, and the policy reads non-empty-dest +
empty/disjoint-src as `refuse`. "I cannot determine the launcher's boundary"
is thus treated as "block," which is the wrong default for a guardrail.

The two affected repos are `private-strict` with empty engagements, so their
boundary is derived **solely from the git remote**. Any hook cwd in a tree
whose remote org differs from the file's repo — *including a non-git scratch
dir like `/tmp` or `$HOME`, whose source boundary is empty* — refuses the
write.

### Why it is intermittent

The hook process's `process.cwd()` is not pinned to the edited file's repo. In
a multi-root Claude Code session (working dirs spanning several repos plus
`$HOME` and `/tmp`), the cwd Claude Code spawns the hook with varies across
invocations. The same logical edit therefore alternates between the same-tree
branch (exit 0) and the cross-tree branch (exit 2). That is the
"fail-then-succeed-on-retry" signature.

### Hypotheses from the original report, resolved

1. **Resource/lock contention — confirmed as a secondary amplifier.** Both
   `getRemoteOrg` (`working-tree.ts`) and `readRepoConfig` (`repo.ts`) shell
   out to git via `execFileSync` and swallow *every* failure as `null` /
   "not a git repo." One `check-write` call spawns ~8–12 git subprocesses;
   under fork/exec pressure (EAGAIN/EMFILE) a transient failure on the
   *source* tree empties its boundary → no overlap → refuse. An independent
   intermittency source layered on top of the cwd drift.
2. **cwd-dependence — confirmed, primary cause.** See Bug B.
3. **stdin parse race — ruled out as a cause of *blocks*.** A truncated/empty
   stdin makes `extractFilePath` return undefined → `process.exit(0)`, which
   *allows* the write. It can never produce a block. (It is its own latent
   bug — a dropped payload silently disables the guard — but unrelated to
   this symptom.)

## Reproduction

Deterministic once cwd is controlled. Two repos, different GitHub orgs, both
unclassified `private-strict` (boundary from remote only), empty registry.

**Bug A — exit 2 puts the payload on stdout, leaving stderr empty:**

```
$ cd <repo-org-a>
$ printf '{"tool_input":{"file_path":"<repo-org-b>/clean.ts","old_string":"x","new_string":"y"}}' \
    | repo-aegis hook check-write >out.stdout 2>out.stderr ; echo "EXIT=$?"
EXIT=2
--- STDOUT bytes: 359 ---   { "code": "CROSS_ORG_WRITE", ... }
--- STDERR bytes: 0   ---
```

**Bug B — identical edit, identical content, only the hook cwd changes:**

```
cwd=<the file's own repo>   ->  EXIT=0   (same tree)
cwd=<a different-org repo>  ->  EXIT=2   (disjoint boundaries → refuse)
cwd=/tmp                    ->  EXIT=2   (no git tree → empty src → never overlaps → refuse)
cwd=$HOME (not a git tree)  ->  EXIT=2   (same as /tmp)
cwd=<the file's own repo>   ->  EXIT=0   (succeeds again on "retry")
```

A neutral scratch/home cwd refusing a write into the file's *own* classified
repo is the field failure in miniature.

## Fix

1. **Bug A (no open questions).** Route `check-write`'s non-zero
   `emitJsonAndExit` to stderr, matching `scan-after-write`. Reserve a
   distinct exit/code for "hook internal error" vs "policy refuse" and never
   exit non-zero with empty stderr (report suggestions 1–2). Tighten the test
   helper / add a test that asserts the block reason lands on **stderr** so
   the channel can't silently regress again.

2. **Bug B.** Stop deriving the source boundary from `process.cwd()`:
   - Read the launcher cwd from the hook-input JSON `cwd` field (the session's
     cwd as Claude Code sees it) rather than the spawned process's cwd, with
     `process.cwd()` only as a last-resort fallback.
   - **Fail open when the source boundary is empty/unknowable.** Refuse only
     on a *positive* source boundary that *positively* disjoints from the
     destination — mirroring how an empty *dest* boundary already fails open.
     A guardrail must not block on its own inability to determine context.

3. **Harden git shell-outs** to distinguish "git failed" from "no remote / not
   a git repo," so contention can't masquerade as an empty boundary (report
   suggestion 5). Add a per-invocation hook log (report suggestion 3) to make
   future live failures self-diagnosing.

4. **Tests:** assert the block reason is on stderr; add a cwd-drift regression
   (neutral/cross-org cwd must not refuse a write into the file's own repo).

## Resolution

Landed (unreleased; see `CHANGELOG.md` `[Unreleased]`):

- **Bug A** — `hook-check-write.ts`'s `emitJsonAndExit` now routes non-zero
  exits to **stderr** (mirroring `scan-after-write`), so a block is
  self-explaining instead of arriving as "No stderr output." A regression
  test asserts the block reason is on stderr with stdout empty.
- **Bug B** — the launcher boundary is read from the hook payload's `cwd`
  field, not `process.cwd()`; and `decideHookAction` now **fails open** when
  the source boundary is empty (refuses only on a positive, disjoint source
  boundary). `scan-after-write.ts` reads the payload `cwd` too, for
  consistency. Regression tests cover the cwd-precedence and the
  `/tmp`/`$HOME` fail-open cases at both the policy and subprocess layers.
- **Exit codes** — `2` = policy block (`CROSS_ORG_WRITE`), `1` = internal
  error (fail-open, tool proceeds), per report suggestions 1–2.

Not done (deliberate follow-ups):

- The git shell-out hardening (report suggestion 5 — distinguish "git failed"
  from "no remote") and the per-invocation hook log (suggestion 3) are not in
  this change. With Bug B failing open, contention can now only cause a missed
  cross-org *detection* (fail-open), never a spurious block, so the urgency is
  lower; the log is still worth adding to make any future live failure
  self-diagnosing.
- The user-level CLAUDE.md still describes the hook as PostToolUse-only and
  tells the agent never to retry a blocked write. That guidance predates the
  PreToolUse split and is out of scope for this repo; flagged separately.

## Reproduction notes

The original report's note still holds for capturing *new* live failures: add
the file-logging from fix (3) and diff a failing invocation against a
succeeding one (same file, same content) — the divergence is the resolved
`srcTree` / source boundary, which the cwd controls.
