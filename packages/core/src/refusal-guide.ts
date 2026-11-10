// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// The one place that says, for every refusal code, what the single next step is and whether only a person can
// take it (complexity-review X-10). The shared formatter (`refusalTrailer` in ./refusal.ts) reads this table and
// prints the running repo-aegis version beside it, so a refusal reaching an agent in any repository states:
//
//   - which repo-aegis refused (the version: a refusal from an older install explains a stale hook),
//   - exactly one next step, and
//   - whether only a person can run it (an agent must not try).
//
// Call sites do not repeat any of this. A code that is missing here still renders a generic line, but the lint
// test (packages/cli/src/refusal-lint.test.ts) derives every refusal code from the source and fails when one has
// no entry here or no row in doc/agent-guide.md's error table (which `repo-aegis explain` prints).
//
// `next` is ONE sentence, imperative, ending in a full stop. It names the honest mistake's way out, not every
// option: the refusal's own text and `repo-aegis explain <CODE>` carry the rest. Never put a customer, owner or
// repository name in it: it is shown to agents.
import { readFileSync } from "node:fs";

export interface RefusalGuideEntry {
  /** The single next step, one sentence ending in a full stop. */
  readonly next: string;
  /**
   * True when only a person at a terminal can take `next` (an agent must stop and report it). False when the
   * agent itself can take it (re-issue the command another way, or fix its own input).
   */
  readonly personOnly: boolean;
}

const person = (next: string): RefusalGuideEntry => ({ next, personOnly: true });
const agent = (next: string): RefusalGuideEntry => ({ next, personOnly: false });

/**
 * Every refusal code and its next step. Keyed by code; the key set is checked against the source and the guide
 * by packages/cli/src/refusal-lint.test.ts.
 */
export const REFUSAL_GUIDE: Readonly<Record<string, RefusalGuideEntry>> = {
  // ---- egress shape rules: nothing is wrong with the destination, only with how the command is written ----
  PUSH_IMPLICIT_TARGET: agent("Re-issue as `git push <remote> <branch>`, naming both."),
  EGRESS_AFTER_CD: agent("Re-issue with `git -C <abs-path>` or `gh --repo <owner>/<repo>`, as its own tool call."),
  EGRESS_UNGUARDED_CHAIN: agent("Re-issue the publishing command as its own call, or chain it with `&&`."),
  PAYLOAD_MODE_DEPENDENT_PATH: agent("Write the payload to an absolute, session-unique path in the session scratchpad and pass that path."),
  EGRESS_ENV_OVERRIDE: agent("Re-issue the command without the environment variable or option it set."),
  EGRESS_AFTER_STATE_CHANGE: agent("Run the state change as its own call, then re-issue the publish alone."),
  EGRESS_PTY_WRAPPER: agent("Re-issue the command directly, without the terminal wrapper."),
  GH_PR_CREATE_IMPLICIT_TARGET: agent("Re-issue as `gh pr create --repo <owner>/<repo> ...`."),
  DOT_GH_WRITE_NEEDS_BOT: agent("Re-issue as `dot gh --as bot <same arguments>`, with `--as bot` first."),
  DOT_GH_OWNER_MAPPED: agent("Re-issue the same arguments to plain `gh`, without `dot`."),
  GITHUB_API_VIA_HTTP_CLIENT: agent("Use `gh api -X <METHOD> repos/<owner>/<repo>/...` instead of curl or wget."),
  GH_AUTH_TOKEN_NETWORK: agent("Use `gh api ...`, which carries its own credential, and never put a token in a command."),
  GH_AUTH_NEEDS_HUMAN: agent("Use plain `gh <verb> --repo <owner>/<repo> ...` and leave gh's credentials and configuration alone."),
  TOKEN_MINT_NEEDS_HUMAN: agent("Use plain `gh <verb> --repo <owner>/<repo> ...` and do not mint or read tokens or keychain secrets."),
  PAYLOAD_MARKER_HIT: agent("Run `repo-aegis check --path <file>` from the destination repository, redact what it names, and re-run."),
  HOOK_INPUT_TOO_LARGE: agent("Put the large content in a file and pass the file, or write it in smaller parts."),
  AGENT_DETACHED_SESSION: agent("Run the command in the foreground, or ask your human to start the long-lived session."),
  PATH_NOT_SCANNED: agent("Fix the path or the size limit and re-run; never report the file as clean."),
  READBACK_UNAVAILABLE: agent("Tell your human the published body was not verified and offer to show it."),
  AGENT_PUSH_NEEDS_APP: agent("Push over HTTPS: `git push https://github.com/<owner>/<repo>.git <branch>`."),
  AGENT_PUSH_CREDENTIAL_PATH: agent("Retry the push once; if it repeats, stop and tell your human."),

  // ---- repo-aegis gh: the identity layer ----
  GH_IDENTITY_NEEDS_LITERAL_TARGET: agent("Re-issue with `--repo <owner>/<repo>`."),
  GH_IDENTITY_SEVERAL_OWNERS: agent("Split the call into one `gh` call per owner and repository, each with `--repo <owner>/<repo>`."),
  GH_IDENTITY_SEVERAL_REPOS: agent("Split the call into one `gh` call per owner and repository, each with `--repo <owner>/<repo>`."),
  GH_IDENTITY_TOKEN_SUPPLIED: agent("Re-run plain `gh` with `GH_TOKEN` and `GITHUB_TOKEN` unset."),
  GH_IDENTITY_TOKEN_MISMATCH: agent("Re-run plain `gh` with `GH_TOKEN` and `GITHUB_TOKEN` unset."),
  GH_IDENTITY_ENV_REDIRECT: agent("Re-run the same command with the variable the message names unset."),
  GH_IDENTITY_ARG_UNSAFE: agent("Re-issue on github.com with a built-in command and none of the options the message names."),
  GH_IDENTITY_PRESENCE_UNKNOWN: person("Ask your human to run the command from a terminal they opened themselves."),
  GH_IDENTITY_UNMAPPED_OWNER: person("Ask your human to map the owner to a GitHub identity from a terminal."),
  GH_IDENTITY_WRITE_NEEDS_HUMAN: person("Ask your human to approve the write from their own terminal, or to run the command themselves."),
  GH_IDENTITY_INSTALLATION_MISMATCH: person("Stop and tell your human that the registry maps the wrong GitHub App to this owner."),
  GH_IDENTITY_UNAVAILABLE: person("Stop and tell your human which owner failed and the step the message names; do not retry with another account."),
  GH_BINARY_UNTRUSTED: person("Ask your human to put a package-manager `gh` first on PATH and re-run `repo-aegis install shim`."),
  TAAAD_AGENT_WRITABLE: person("Leave taaad alone; your human may reinstall it into a root-owned prefix."),

  // ---- the owner and trust-boundary rules: a person decides, nothing an agent re-words can pass ----
  UNREGISTERED_OWNER_EGRESS: person("Stop and tell your human, who decides from their own terminal whether this owner is theirs to register."),
  PUBLIC_EGRESS_NEEDS_HUMAN: person("Tell your human what would be published where; they answer the prompt or run the command themselves."),
  PUBLIC_PUSH_NEEDS_HUMAN: person("Tell your human what would be pushed where; they answer the prompt or push from their own terminal."),
  SHIM_UNREACHABLE_NEEDS_HUMAN: person("Ask your human to approve the command from their own terminal, then re-issue the identical command."),
  CROSS_ORG_EGRESS: person("Stop and name the destination to your human; do not widen the trust boundary."),
  CROSS_ORG_PUSH: person("Stop and name the destination to your human; do not widen the trust boundary."),
  CROSS_ORG_WRITE: person("Stop and name the offending path to your human; do not retry or widen the trust boundary."),
  AGENT_RAN_HUMAN_COMMAND: person("Stop and give your human the exact line to run in their own terminal; do not re-word it."),
  AGENT_PUSH_CREDENTIAL_CONFIG: person("Tell your human which setting was named so they can fix it; do not work around it."),
  AGENT_PUSH_CREDENTIAL_STORE: person("Tell your human; they scope that credential helper away from https://github.com or reorder it."),
  AGENT_PUSH_GUARD_NOT_RUNNING: person("Tell your human; they push from a terminal or chain repo-aegis's pre-push hook from the repository's hooks."),
  GIT_CREDENTIAL_HELPER_ORDER: person("Ask your human to run `repo-aegis install git-credential` from a terminal."),

  // ---- files an agent may not write ----
  GH_CONFIG_WRITE_REFUSED: person("Tell your human what needs changing in gh's configuration; a person edits it."),
  PAUSE_FILE_WRITE_REFUSED: person("Tell your human what is wrong; only a person sets a pause, with `repo-aegis pause` in a terminal."),
  APPROVALS_FILE_WRITE_REFUSED: person("Tell your human what you need; only `repo-aegis approve`, run by a person in a terminal, mints an approval."),
  WAIVER_FILE_WRITE_REFUSED: person("Surface the finding to your human; `repo-aegis waive` is a person's command."),

  // ---- commands that need a person's terminal ----
  APPROVE_NEEDS_TTY: person("Ask your human to run the `repo-aegis approve` line from their own terminal."),
  PAUSE_NEEDS_TTY: person("Ask your human to run `repo-aegis pause` from their own terminal, and only when a refusal is wrong."),
  IDENTITY_CHANGE_NEEDS_TTY: person("Ask your human to run the identity command from their own terminal; the refusal prints it."),
  OWNER_ADD_NEEDS_TTY: person("Ask your human to run the command from their own terminal; the refusal prints it."),
  OWNER_SET_EMPTY_NEEDS_TTY: person("Ask your human to run the command from their own terminal; removing one owner among several needs none."),
  GIT_CREDENTIAL_NEEDS_TTY: person("Ask your human to run `repo-aegis install git-credential` from their own terminal."),
  REGISTRY_ENCRYPT_NEEDS_TTY: person("Ask your human to run the command from their own terminal, if they want encryption at rest."),
  MANAGED_NEEDS_TTY: person("Ask your human to run `repo-aegis install claude-md` from their own terminal."),
  MANAGED_NOT_CONFIRMED: person("Ask your human to re-run `repo-aegis install claude-md` in a terminal and type `y` at the prompt."),
  PRIVILEGED_TOOL_UNSAFE: person("Ask your human to fix the tool or directory the message names, or to use `--user-settings`."),
  SYSTEM_DIR_UNSAFE: person("Ask your human to fix the directory the message names, or to use `--user-settings`."),

  // ---- a person's repair of their own setup ----
  GIT_CREDENTIAL_ORDER_REFUSED: person("Remove or reorder the other github.com credential helper the message names, then run `repo-aegis install git-credential` again."),
  REGISTRY_ERROR: person("Ask your human to run `repo-aegis status` in a terminal to see why the registry cannot be read."),
  PURGE_HOME_REFUSED: person("Ask your human to correct `REPO_AEGIS_HOME` or delete the directory by hand; do not bypass the check."),
  PATTERN_VALIDATION: person("Ask your human to fix the pattern the details name in the registry; `repo-aegis render` in a terminal shows the literal."),
  INVALID_ORG_NAME: person("Correct the owner name to a valid GitHub owner and run the command again from a terminal."),
  INVALID_UPSTREAM: person("Correct the value to a valid <owner>/<repo> and run the command again from a terminal."),
  FS_ERROR: person("Ask your human to fix the permissions the details name, then retry."),
  PUBLISHED_ARCHIVE_ESCAPE: person("Tell your human the archive has an entry that escapes its directory; do not bypass the refusal."),
  SUDO_NOPASSWD: person("Leave it; your human decides whether `sudo` should ask for a password."),
};

/** The version of the repo-aegis that is running this code, read once from the package that holds it. */
let cachedVersion: string | undefined;
export function repoAegisVersion(): string {
  if (cachedVersion !== undefined) return cachedVersion;
  let version = "unknown";
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
    if (typeof pkg.version === "string" && /^[0-9A-Za-z.+-]{1,40}$/.test(pkg.version)) version = pkg.version;
  } catch {
    /* an unreadable package.json must never break a refusal: the version is then "unknown" */
  }
  cachedVersion = version;
  return version;
}

/** What a code with no table entry says: the lint test makes this unreachable for a code in the source. */
const FALLBACK: RefusalGuideEntry = {
  next: "Run `repo-aegis explain` with the code below and follow its recovery column.",
  personOnly: false,
};

export function refusalGuideEntry(code: string): RefusalGuideEntry {
  return Object.prototype.hasOwnProperty.call(REFUSAL_GUIDE, code) ? REFUSAL_GUIDE[code]! : FALLBACK;
}

/**
 * The line every refusal carries before its `[CODE; details: …]` token:
 * `repo-aegis 0.13.2. Next step: <next> Only a person can run it: yes.`
 */
export function refusalGuideLine(code: string): string {
  const e = refusalGuideEntry(code);
  return `repo-aegis ${repoAegisVersion()}. Next step: ${e.next} Only a person can run it: ${e.personOnly ? "yes" : "no"}.`;
}
