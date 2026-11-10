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

  // ---- plain CLI errors (exit 2 with `{ code, error }`): a wrong flag, a missing file, a registry or config a person must repair.
  // The agent's own mistakes are `agent`; anything that needs a decision, a terminal or an edit to a person's files is `person`.
  USAGE: agent("Re-read the command's flags with `repo-aegis <command> --help` and re-issue it correctly; do not retry blindly."),
  NOT_IMPLEMENTED: agent("Use a command that `repo-aegis --help` lists; this one does not exist in this version."),
  UNKNOWN_CODE: agent("Run `repo-aegis explain --list` and ask again with a code from it."),
  UNKNOWN_DOC_TOPIC: agent("Run `repo-aegis docs` with one of the topics the message lists."),
  UNKNOWN_PROFILE: agent("Re-run with `--profile pr`, `--profile strict` or `--profile all`."),
  NOT_GIT_REPO: agent("Run the command inside a git repository, or scan a directory with `repo-aegis check --path <dir>`."),
  GIT_ERROR: agent("Read the git message in the details and fix what it names (a missing ref, remote or repository), then re-run."),
  PATH_TOO_MANY_FILES: agent("Scan a narrower directory, or pass a higher `--max-files`; nothing was scanned."),
  AMBIGUOUS_QUERY: agent("Re-issue with the exact engagement id; `repo-aegis engagements list --json` shows them."),
  ENGAGEMENT_NOT_FOUND: agent("Run `repo-aegis engagements list --json` and re-issue with an id from it."),
  ENGAGEMENT_EXISTS: agent("Inspect it with `repo-aegis engagements show <id>`, or choose another id."),
  RESERVED_ID: agent("Choose another id; `_always` is reserved (its markers live in the registry's `always_block` field)."),
  REMOVE_REQUIRES_HARD: agent("For a soft removal run `repo-aegis engagements end <id> --purge`; `--hard` is erasure and your human's call."),
  LOCK_TIMEOUT: agent("Wait a moment and retry once; if it repeats, tell your human there may be a stale lockfile."),
  BUNDLE_FENCE_COLLISION: agent("Re-run once (a fresh delimiter is chosen); if it fails again, tell your human."),

  REGISTRY_NOT_FOUND: person("Ask your human to run `repo-aegis init`, or to point `REPO_AEGIS_HOME` at the right directory."),
  REGISTRY_PARSE: person("Ask your human to run `repo-aegis status` in a terminal and repair the registry file it names."),
  REGISTRY_UNREADABLE: person("Ask your human to run `repo-aegis status` in a terminal to see why the registry cannot be read."),
  REGISTRY_LOAD_ERROR: person("Ask your human to repair the registry file, or to point `--registry` at a valid one."),
  REGISTRY_ENCRYPTED: person("Ask your human for the age identity path and to run `repo-aegis registry decrypt --identity <path>` themselves."),
  REGISTRY_ALREADY_ENCRYPTED: person("Tell your human; a leftover marker or ciphertext needs their look, and you must not resolve it."),
  REGISTRY_NOT_ENCRYPTED: person("Tell your human; a leftover marker or file needs their look, and you must not resolve it."),
  REGISTRY_WOULD_BE_INVALID: person("Tell your human that nothing was written; they fix the duplicate and run `repo-aegis doctor`."),
  OUTSIDE_WORKING_TREE: person("Tell your human which path was outside the repository; do not re-run it on another path."),
  CUSTOMER_COUPLED_NO_ENGAGEMENT: person("Confirm with your human which engagement the repository references, then they run `repo-aegis allow <id>`."),
  DENY_SET_BELOW_FLOOR: person("Ask your human to make the engagement registry available and re-run; never lower the floor."),
  WAIVER_PARSE: person("Ask your human to fix `.repo-aegis.yml`; the message names what is wrong."),
  REPO_OVERRIDE_PARSE_ERROR: person("Ask your human to fix `.repo-aegis.yml`; the message names what is wrong."),
  GLOB_TOO_BROAD: person("Ask your human to narrow the glob in `.repo-aegis.yml` to something smaller than the whole repository."),
  NOT_WAIVABLE: person("Ask your human which engagement to allow with `repo-aegis allow <engagement>`; only `_always` patterns can be waived."),
  WAIVE_NONINTERACTIVE: person("Ask your human to run `repo-aegis waive` from their own terminal."),
  RULES_PARSE_ERROR: person("Ask your human to fix the rules file the details name."),
  INVALID_RULES: person("Ask your human to fix the rules the details name."),
  VISIBILITY_UNRESOLVED: person("Ask your human to run `git config repo-aegis.class <class>` or to re-run with an account that can see the repository; do not guess."),
  IDENTITY_EXISTS: person("Ask your human to choose another identity name, or to use the existing one (`repo-aegis identity list` shows it)."),
  IDENTITY_NOT_FOUND: person("Run `repo-aegis identity list` and ask your human to re-run with a name from it."),
  IDENTITY_IN_USE: person("Ask your human to unmap the identity from its owners first, then remove it."),
  IDENTITY_KIND_MISMATCH: person("Ask your human to give `--person` a person identity and `--agent` an App identity."),
  NOTHING_TO_REQUIRE: person("Ask your human to add and map an identity first; the registry has none."),
  ENGAGEMENT_HAS_NO_ORGS: person("Ask your human to add a GitHub org to the engagement first, so the identity maps something."),
  PERSONAL_ORG_NOT_FOUND: person("Ask your human to register the personal org first, from their own terminal."),
  MIGRATION_NOT_CONFIRMED: person("A person re-runs `repo-aegis init --migrate-classify` at a terminal and types `y` after reading the list."),
  MIGRATION_FAILED: person("Tell your human what the message names; they re-run `repo-aegis init --migrate-classify` once it is fixed."),
  RENDER_ERROR: person("Tell your human; they run `repo-aegis render` in a terminal to see why."),
  MARKERS_WRITE_PROTECTED: person("Ask your human to run `repo-aegis render` from their own terminal."),
  WORKFLOW_EXISTS: person("Ask your human to pass `--force` if they want the existing workflow overwritten."),
  WORKFLOW_MODIFIED: person("Ask your human to review the edited workflow and remove it by hand if they want it gone."),
  DROPIN_INVALID: person("Ask your human to fix the path the message names; there is no override."),
  PIN_PATH_UNSUPPORTED: person("Ask your human to install repo-aegis at an ordinary path; there is no override."),
  PIN_UNUSABLE: person("Ask your human to reinstall repo-aegis at a stable path, then run `repo-aegis install git-credential`."),
  SETTINGS_PARSE_ERROR: person("Ask your human to repair `~/.claude/settings.json`; do not edit it yourself."),
  HOOKS_PATH_CONFLICT: person("Tell your human the prior `core.hooksPath` value; they decide whether to overwrite it with `--force`."),
  HOOKS_PATH_LOCAL_SHADOW: person("Ask your human to unset the repository's own `core.hooksPath` that the details show."),
  GIT_CONFIG_ERROR: person("Ask your human to check that `git config` works in their terminal, then re-run."),
  GIT_CONFIG_WRITE_FAILED: person("Ask your human to check that `git config --global` works in their terminal, then re-run the install."),
  GIT_CONFIG_READ_FAILED: person("Ask your human to check that `git config --global` works in their terminal, then re-run the install."),
  SHIM_PATH_OCCUPIED: person("Tell your human the path of the file that is in the way; they decide whether to overwrite it with `--force`."),
  MULTIPLE_INSTALLS: person("Ask your human to remove or upgrade the other repo-aegis on PATH."),
  PAUSE_TOO_LONG: person("Ask the person to choose 8 hours or less and pause again when it ends."),
  PAUSE_NOT_REMOVED: person("A person removes the pause with `repo-aegis resume` from their own terminal."),
  ENCRYPT_ERROR: person("Ask your human to check the age recipient the message names, then retry."),
  DECRYPT_ERROR: person("Ask your human to check the age identity file the message names, then retry."),
  AGE_NOT_FOUND: person("Ask your human to install the `age` binary (https://age-encryption.org)."),
  AGE_ERROR: person("Ask your human to check the age identity or recipient the message names, then retry."),
  WRITE_FAILED: person("Ask your human to check the permissions of the file the message names, then retry."),
  DOCS_MISSING: person("Ask your human to reinstall `@de-otio/repo-aegis`, or to run `npm run build` in a checkout."),
  EXPLAIN_DOCS_MISSING: person("Ask your human to reinstall `@de-otio/repo-aegis`, or to run `npm run build` in a checkout."),
  REMOTE_DISALLOWED: person("Do not add the opt-in flag; ask your human whether that Ollama endpoint is allowed."),
  OLLAMA_ERROR: person("Ask your human to start `ollama serve` and pull the model, then re-run; do not retry blindly."),
  PROSE_EXTRACTION_FAILED: person("Tell your human what the message names; do not retry blindly."),
  TOKEN_EXTRACTION_FAILED: person("Tell your human what the message names; do not retry blindly."),
  BUNDLE_TOO_LARGE: person("Ask your human whether to shrink the corpus; the details carry the size."),
  ROOT_CONTAINMENT: person("Stop and tell your human that a path resolved into a protected directory; do not bypass it."),
  PARSE_ERROR: person("Ask your human to fix the query file the message names."),
  TOKEN_MISSING: person("Ask your human to export `GH_TOKEN`, or the variable `--token` names."),
  QUERY_VALIDATION: person("Ask your human to fix the queries the details list."),
  STATE_PARSE_ERROR: person("Ask your human to resolve the corrupt state file; do not truncate it."),
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
