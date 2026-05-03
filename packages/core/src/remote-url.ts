// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Pure parser for git remote URLs. Used by `classify` to derive the
// engagement (or personal-org) attribution from `git remote get-url
// origin`.
//
// The parser is total: malformed input returns `null` rather than
// throwing. This is load-bearing — `parseRemoteUrl` runs in the JIT
// classify path, and a thrown exception there would surface to the
// agent as a tool-failure rather than the intended `skipped` status.
//
// Phase 1 scope: github.com only (including multi-account ssh aliases
// like `git@github.com-personal:`). Non-github hosts return `null`;
// extending to gitlab/bitbucket is a deliberate follow-up.

export interface ParsedRemote {
  /** Always `"github.com"` in v1; ssh-alias suffixes are stripped. */
  host: string;
  /** Lowercased GitHub org name. */
  org: string;
  /** Lowercased GitHub repo name (no `.git` suffix). */
  repo: string;
}

// SSH form: `git@github.com[-<alias>]:<org>/<repo>[.git][/]`
// The optional `-<alias>` segment is the multi-account ssh pattern
// recommended by GitHub for users with multiple accounts on one
// machine — e.g. `git@github.com-personal:foo/bar.git`. The alias
// is stripped and the host normalised back to `github.com`.
const SSH_RE =
  /^git@github\.com(?:-[a-zA-Z0-9_-]+)?:([a-zA-Z0-9][a-zA-Z0-9-]*)\/([a-zA-Z0-9._-]+?)(?:\.git)?\/?$/;

// URL forms: `(http|https|ssh)://[user[:pw]@]github.com/<org>/<repo>[.git][/]`
// Credential prefix (`user@` or `user:pw@`) is stripped. We do not
// validate password content; the gate path never sees this URL.
const URL_RE =
  /^(?:https?|ssh):\/\/(?:[^@/]+@)?github\.com\/([a-zA-Z0-9][a-zA-Z0-9-]*)\/([a-zA-Z0-9._-]+?)(?:\.git)?\/?$/;

/**
 * Parse a git remote URL into `{ host, org, repo }`. Returns `null`
 * for malformed input or non-github hosts. Never throws.
 *
 * Org and repo are lowercased in the output. The original casing is
 * not preserved — callers that need the casing-as-typed must read
 * the raw remote themselves.
 */
export function parseRemoteUrl(raw: unknown): ParsedRemote | null {
  if (typeof raw !== "string") return null;
  const url = raw.trim();
  if (url.length === 0) return null;

  const sshMatch = SSH_RE.exec(url);
  if (sshMatch) {
    const org = sshMatch[1];
    const repo = sshMatch[2];
    if (org === undefined || repo === undefined) return null;
    return {
      host: "github.com",
      org: org.toLowerCase(),
      repo: repo.toLowerCase(),
    };
  }

  const urlMatch = URL_RE.exec(url);
  if (urlMatch) {
    const org = urlMatch[1];
    const repo = urlMatch[2];
    if (org === undefined || repo === undefined) return null;
    return {
      host: "github.com",
      org: org.toLowerCase(),
      repo: repo.toLowerCase(),
    };
  }

  return null;
}
