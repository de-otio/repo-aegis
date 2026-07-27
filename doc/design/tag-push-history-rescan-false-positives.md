# Design: tag-push / new-ref full-history rescan false positives

**Status:** proposed
**Author:** (drafted with Claude Code)
**Scope:** `@de-otio/repo-aegis-core`, `@de-otio/repo-aegis` (CLI), the pre-push hook

## Problem

The pre-push hook runs `check --range <remote>..<local>` so it scans only the
*additions a push introduces*. That works well for pushing commits to an
already-tracked branch: the range is incremental, and only genuinely-new
content is scanned.

It breaks for **a newly-created ref that the remote has never seen** — most
commonly a **release tag**. Git reports no remote-side value for a brand-new
ref, so the effective range degrades to *empty-tree → ref*, i.e. **the entire
reachable history**. Every always-block match anywhere in history now blocks
the push, even when:

- the matched content is a **benign false positive** (see below), and
- the content is **already on the remote** via another ref (e.g. `main`), so the
  tag introduces **zero new exposure** — a tag is just a pointer to a commit the
  remote already has.

### Live incident

Publishing `@de-otio/trellis` is tag-triggered (`git push origin v<version>` →
OIDC Trusted Publishing). The release tag pointed at a commit **already pushed to
`main` moments earlier** (its incremental range scanned clean). The tag push then
failed: the new-ref scan walked the whole history and re-flagged an always-block
`-----BEGIN … PRIVATE KEY-----` match in the repo's root commit.

The match was a **unit-test fixture keypair** (`mockUser.privateKey` in a
Fedify/ActivityPub test-fixtures file, surrounded by `testuser` /
`test@example.com` / `example.com`) — a throwaway key by construction, not a
credential. It had been public in the repo since its root commit.

Net effect: **every release-tag push is blocked**, the only escape is
`git push --no-verify` (which security tooling / agent classifiers correctly
refuse to run), and the operator is pushed toward a blanket hook bypass to ship a
routine release.

### Why the current behaviour produces this

| Aspect | Current behaviour | Consequence |
|---|---|---|
| New-ref range | falls back to empty-tree → ref (full history) | benign historical matches re-block a push that adds nothing new |
| Already-remote content | not distinguished from net-new content | a tag to an already-pushed commit is treated like a first-time leak |
| `_always` secret-shape patterns | fire on any path | test-fixture / example keys in `**/test/**` trip the private-key rule |
| `_always` engagement | (correctly) not allowlist-able via `allow <engagement>` | no clean per-repo waiver for a reviewed benign match |
| Only escape hatch | `--no-verify` | bypasses the *entire* hook, not just the one benign finding |

## Design

Four independent improvements; A and B remove the recurring friction, C and D are
the durable "reviewed-benign" and "known-non-secret" paths.

### A. Compute an incremental range for new refs

For a ref the remote has never seen, do **not** fall back to full history. Scan
only additions not already reachable from any ref the remote already has:

```
git rev-list <local-ref> --not --remotes=<remote>
```

i.e. "commits in the pushed ref that no remote-tracking ref already contains."
For a tag pointing at an already-pushed `main` commit this range is **empty** →
nothing to scan → the push proceeds, correctly, because the tag exposes nothing
new. A tag that *does* carry never-pushed commits still gets those commits
scanned.

Fallback: if remote-tracking refs are unavailable (fresh clone, detached CI),
fall back to today's full-history scan but treat its findings under rule C
(warn-not-block for already-public content).

### B. Path-scoped exemptions for secret-*shape* patterns

`_always` patterns are **heuristic secret shapes** (`AKIA…`, `ghp_…`,
`BEGIN … PRIVATE KEY`), categorically different from customer-marker *literals*.
Secret-shape heuristics have well-known benign homes; customer markers do not.
Add a config knob that applies **only** to the secret-shape (`_always`) class:

```yaml
alwaysBlock:
  exemptPaths:
    - "**/test/**"
    - "**/tests/**"
    - "**/__fixtures__/**"
    - "**/*.fixture.*"
    - "**/*.test.*"
```

Customer-marker deny sets are **never** path-exempt — a customer name in a test
fixture is still a leak. This asymmetry is the load-bearing point: the exemption
is scoped to the pattern *class*, not applied globally.

### C. Distinguish "already-public" from "new leak"

When the repo is **public** and a match lies on content already reachable from the
remote's default branch, it is not a *new* exposure. Downgrade such a finding from
**block** to **warn-once** (surfaced, logged, non-fatal). A first-time addition of
the same shape still blocks. This makes the common case — "I already pushed this
commit to `main`, now I'm tagging it" — non-blocking without weakening first-push
protection.

### D. Reviewed-benign waivers (the clean `--no-verify` alternative)

Provide a finding-scoped waiver so a human-reviewed benign match can be dismissed
**without** bypassing the whole hook and **without** weakening the pattern
globally:

```
repo-aegis waive --pattern _always/private-key \
  --blob <sha> --reason "fedify test-fixture keypair"
```

Store waivers as `(patternId, blobSha, reason, approver, date)` in the repo's
repo-aegis config (committed, auditable). `check` skips a finding whose
`(patternId, blobSha)` matches an active waiver. Keying on the **blob sha**
(not a line number) means the waiver survives history rewrites and re-scans, and
narrowly covers exactly the reviewed bytes — a new key in a new blob is not
covered. This is the mechanism `--no-verify` should never be a substitute for.

### E. Ship a built-in known-non-secret exception list

Well-known documentation/example secrets are non-secrets by definition and should
never block:

- AWS's documented example access key (`AKIA…EXAMPLE`, the `…IOSFODNN7…` key
  from the AWS docs) and its paired example secret (`wJalrX…EXAMPLEKEY`)
  — written de-fanged here so this very doc doesn't trip the `AKIA…` rule
- RFC 7515 / RFC 8037 example JWK/PEM keys
- Placeholder tokens that are literally the string `EXAMPLE`, `REDACTED`, etc.

Match these before emitting an `_always` finding. (Independent of A–D; reduces
noise for everyone.)

## Priority

1. **A** — kills the recurring release-tag failure outright (highest value,
   smallest surface: it's a range computation change in the pre-push path).
2. **B** — stops test-fixture private keys tripping the private-key rule.
3. **D** — the auditable escape hatch that replaces `--no-verify`.
4. **C**, **E** — noise reduction; nice-to-have alongside the above.

## Non-goals

- Weakening the customer-marker deny set. Marker literals stay block-on-sight,
  path-independent — B/C apply to secret-*shape* (`_always`) patterns only.
- Auto-remediating historical matches (history rewrite stays an explicit,
  human-driven operation).

## Test cases

- Tag pointing at an already-pushed `main` commit → **push succeeds** (A: empty
  incremental range).
- Tag carrying a never-pushed commit that adds a real marker → **push blocked**
  (A scans the new commit; deny set fires).
- Test-fixture private key under `**/test/**` → **not flagged** (B).
- Same private-key shape in `src/` → **flagged** (B exemption is path-scoped).
- Customer marker in a test fixture → **flagged** (B never exempts marker
  literals).
- Waived `(pattern, blob)` → skipped; a *different* blob of the same shape →
  flagged (D is blob-scoped).
- AWS's documented example access key (`AKIA…EXAMPLE`) anywhere → **not
  flagged** (E).
