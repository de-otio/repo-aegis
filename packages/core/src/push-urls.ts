// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// The URL(s) `git push <remote>` will actually write to
// (doc/plan-unregistered-owner-egress.md §3.3 item 5, §8.4 F7).
//
// `remote.<name>.url` is not where a push goes. `remote.<name>.pushurl`,
// `url.<base>.insteadOf` and `url.<base>.pushInsteadOf` all rewrite it, and a
// remote may have several push URLs. `git remote get-url --push --all` applies
// every one of those and prints each URL. (`git ls-remote --get-url` ignores
// `pushInsteadOf` and `pushurl`, which is why it is not used.)
//
// `git push <url>` names a URL directly. git applies the rewrites to that too,
// but `git remote get-url` only answers for a configured remote, so a URL given
// directly is rewritten here, following git's own rule: a matching
// `pushInsteadOf` (longest prefix) wins; otherwise the longest matching
// `insteadOf`.
//
// The pre-push hook needs none of this: git hands it the URL after all
// rewriting, once per push URL.
import { execFileSync } from "node:child_process";
import { looksLikeRemoteUrl } from "./remote-url.js";

function gitOut(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

interface Rewrite {
  base: string;
  prefix: string;
}

/** Parse `git config --get-regexp` output for `url.<base>.<key>` entries. */
function parseRewrites(out: string | null, key: "insteadof" | "pushinsteadof"): Rewrite[] {
  if (out === null) return [];
  const re = new RegExp(`^url\\.(.*)\\.${key} (.*)$`);
  const rewrites: Rewrite[] = [];
  for (const line of out.split("\n")) {
    const m = re.exec(line);
    if (m !== null) rewrites.push({ base: m[1]!, prefix: m[2]! });
  }
  return rewrites;
}

function applyLongest(url: string, rewrites: readonly Rewrite[]): string | null {
  let best: Rewrite | null = null;
  for (const r of rewrites) {
    if (r.prefix === "" || !url.startsWith(r.prefix)) continue;
    if (best === null || r.prefix.length > best.prefix.length) best = r;
  }
  return best === null ? null : best.base + url.slice(best.prefix.length);
}

/** `url` after git's push-time rewriting (`pushInsteadOf`, else `insteadOf`). */
function rewriteForPush(cwd: string, url: string): string {
  const out = gitOut(cwd, ["config", "--get-regexp", "^url\\..*\\.(push)?insteadof$"]);
  const viaPush = applyLongest(url, parseRewrites(out, "pushinsteadof"));
  if (viaPush !== null) return viaPush;
  return applyLongest(url, parseRewrites(out, "insteadof")) ?? url;
}

/**
 * Every URL `git push <remote>` writes to, run from `cwd`. `remote` is a
 * configured remote's name (which wins, as in git) or a URL. Returns `null`
 * when it is neither: a local path, or nothing git can read. Never throws.
 */
export function resolvePushUrls(cwd: string, remote: string): string[] | null {
  const configured = gitOut(cwd, ["remote", "get-url", "--push", "--all", "--", remote]);
  if (configured !== null) {
    const urls = configured
      .split("\n")
      .map(u => u.trim())
      .filter(u => u !== "");
    if (urls.length > 0) return urls;
  }
  if (!looksLikeRemoteUrl(remote.trim())) return null;
  return [rewriteForPush(cwd, remote.trim())];
}
