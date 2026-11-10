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
  AGENT_DETACHED_SESSION: agent("Run the command in the foreground, or as a plain `nohup <command> &` for a dev server."),
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
  GH_IDENTITY_ARG_UNSAFE: agent("Do what the message names: drop the option, or run from a checkout without that git setting; only a person changes the setting."),
  GH_IDENTITY_PRESENCE_UNKNOWN: person("A person runs the command from a terminal they opened themselves."),
  GH_IDENTITY_UNMAPPED_OWNER: person("A person maps the owner to a GitHub identity from a terminal."),
  GH_IDENTITY_WRITE_NEEDS_HUMAN: person("A person approves the write from their own terminal, or runs the command themselves."),
  GH_IDENTITY_INSTALLATION_MISMATCH: person("A person corrects which GitHub App the registry maps to this owner."),
  GH_IDENTITY_UNAVAILABLE: person("A person fixes the owner or step the message names, and `repo-aegis doctor` shows why."),
  GH_BINARY_UNTRUSTED: person("A person puts a package-manager `gh` first on PATH and runs `repo-aegis install shim` again."),
  TAAAD_AGENT_WRITABLE: person("A person may reinstall taaad into a root-owned prefix; nothing is needed from an agent."),

  // ---- the owner and trust-boundary rules: a person decides, nothing an agent re-words can pass ----
  UNREGISTERED_OWNER_EGRESS: person("A person decides, from their own terminal, whether this owner is theirs to register."),
  PUBLIC_EGRESS_NEEDS_HUMAN: person("A person answers the prompt, or runs the command from their own terminal."),
  PUBLIC_PUSH_NEEDS_HUMAN: person("A person answers the prompt, or pushes from their own terminal."),
  SHIM_UNREACHABLE_NEEDS_HUMAN: person("A person approves the command from their own terminal, and the identical command is then re-issued."),
  CROSS_ORG_EGRESS: person("A person decides; the trust boundary is not widened to make a publish pass."),
  CROSS_ORG_PUSH: person("A person decides; the trust boundary is not widened to make a push pass."),
  CROSS_ORG_WRITE: person("A person looks at the offending path; the trust boundary is not widened to make a write pass."),
  AGENT_RAN_HUMAN_COMMAND: person("A person runs the command from their own terminal."),
  AGENT_PUSH_CREDENTIAL_CONFIG: person("A person fixes the setting the message names."),
  AGENT_PUSH_CREDENTIAL_STORE: person("A person scopes that credential helper away from https://github.com or reorders it."),
  AGENT_PUSH_GUARD_NOT_RUNNING: person("A person pushes from their own terminal, or chains repo-aegis's pre-push hook from the repository's own hooks."),
  GIT_CREDENTIAL_HELPER_ORDER: person("A person runs `repo-aegis install git-credential` from a terminal."),

  // ---- files an agent may not write ----
  GH_CONFIG_WRITE_REFUSED: person("A person edits gh's configuration, or runs `gh config set` or `gh auth`, from their own terminal."),
  PAUSE_FILE_WRITE_REFUSED: person("A person decides whether to pause, with `repo-aegis pause` from their own terminal."),
  APPROVALS_FILE_WRITE_REFUSED: person("A person mints an approval with `repo-aegis approve`, from their own terminal."),
  WAIVER_FILE_WRITE_REFUSED: person("A person writes a waiver with `repo-aegis waive`, from their own terminal."),
  // P1-I: the decision log and its switch. `repo-aegis log --on` is the one change an agent may make.
  DECISION_LOG_STATE_WRITE_REFUSED: agent("Leave the decision log's files alone; run `repo-aegis log --on` if recording is off."),
  // The fallback code when a check-write refusal carries none of its own: read the message printed with it.
  CHECK_WRITE_REFUSED: agent("Read the message printed with it; `repo-aegis doctor` shows whether the install is healthy."),

  // ---- commands that need a person's terminal ----
  APPROVE_NEEDS_TTY: person("A person runs the `repo-aegis approve` line from their own terminal."),
  PAUSE_NEEDS_TTY: person("A person runs `repo-aegis pause` from their own terminal, and only when a refusal is wrong."),
  LOG_OFF_NEEDS_TTY: person("A person runs `repo-aegis log --off` from their own terminal, if they want recording off."),
  IDENTITY_CHANGE_NEEDS_TTY: person("A person runs the identity command from their own terminal; the refusal prints it."),
  OWNER_ADD_NEEDS_TTY: person("A person runs the command from their own terminal; the refusal prints it."),
  OWNER_SET_EMPTY_NEEDS_TTY: person("A person runs the command from their own terminal; removing one owner among several needs none."),
  GIT_CREDENTIAL_NEEDS_TTY: person("A person runs `repo-aegis install git-credential` from their own terminal."),

  // ---- a person's repair of their own setup ----
  GIT_CREDENTIAL_ORDER_REFUSED: person("A person removes or reorders the other github.com credential helper the message names, then runs `repo-aegis install git-credential` again."),
  REGISTRY_ERROR: person("A person runs `repo-aegis status` in a terminal to see why the registry cannot be read."),
  PURGE_HOME_REFUSED: person("A person corrects `REPO_AEGIS_HOME` or deletes the directory by hand; the check is not bypassed."),
  PATTERN_VALIDATION: person("A person fixes the pattern the details name in the registry; `repo-aegis render` in a terminal shows the literal."),
  INVALID_ORG_NAME: person("A person corrects the owner name to a valid GitHub owner and runs the command again."),
  INVALID_UPSTREAM: person("A person corrects the value to a valid <owner>/<repo> and runs the command again."),
  FS_ERROR: person("A person fixes the permissions the details name and tries again."),
  PUBLISHED_ARCHIVE_ESCAPE: person("A person inspects the archive, which has an entry that escapes its directory, and rebuilds the package without it."),

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

  REGISTRY_NOT_FOUND: agent("Run `repo-aegis init`, after confirming with your human first when `REPO_AEGIS_HOME` is not the default."),
  REGISTRY_PARSE: person("A person runs `repo-aegis status` in a terminal and repairs the registry file it names."),
  REGISTRY_UNREADABLE: person("A person runs `repo-aegis status` in a terminal to see why the registry cannot be read."),
  REGISTRY_ENCRYPTED: agent("Ask your human for the age identity file path, then run `repo-aegis registry decrypt --identity <path>` with exactly that path."),
  REGISTRY_NOT_ENCRYPTED: person("A person looks at the leftover marker or file and resolves it."),
  REGISTRY_WOULD_BE_INVALID: person("A person fixes the duplicate (nothing was written) and runs `repo-aegis doctor`."),
  OUTSIDE_WORKING_TREE: person("A person checks which path was outside the repository; it is not re-run on another path."),
  CUSTOMER_COUPLED_NO_ENGAGEMENT: agent("Ask your human which engagement the repository references, then run `repo-aegis allow <id>`."),
  WAIVER_PARSE: person("A person fixes `.repo-aegis.yml`; the message names what is wrong."),
  REPO_OVERRIDE_PARSE_ERROR: person("A person fixes `.repo-aegis.yml`; the message names what is wrong."),
  GLOB_TOO_BROAD: person("A person narrows the glob in `.repo-aegis.yml` to something smaller than the whole repository."),
  NOT_WAIVABLE: agent("Ask your human which engagement the finding belongs to, then run `repo-aegis allow <engagement>`; only `_always` patterns can be waived."),
  WAIVE_NONINTERACTIVE: person("A person runs `repo-aegis waive` from their own terminal."),
  RULES_PARSE_ERROR: person("A person fixes the rules file the details name."),
  INVALID_RULES: person("A person fixes the rules the details name."),
  VISIBILITY_UNRESOLVED: person("A person runs `git config repo-aegis.class <class>`, or runs again with an account that can see the repository; nothing is guessed."),
  IDENTITY_EXISTS: person("A person chooses another identity name, or uses the existing one (`repo-aegis identity list` shows it)."),
  IDENTITY_NOT_FOUND: person("A person runs `repo-aegis identity list` and runs the command again with a name from it."),
  IDENTITY_IN_USE: person("A person unmaps the identity from its owners first, then removes it."),
  IDENTITY_KIND_MISMATCH: person("A person gives `--person` a person identity and `--agent` an App identity."),
  NOTHING_TO_REQUIRE: person("A person adds and maps an identity first; the registry has none."),
  ENGAGEMENT_HAS_NO_ORGS: person("A person adds a GitHub org to the engagement first, so the identity maps something."),
  PERSONAL_ORG_NOT_FOUND: person("A person registers the personal org first, from their own terminal."),
  MIGRATION_NOT_CONFIRMED: person("A person re-runs `repo-aegis init --migrate-classify` at a terminal and types `y` after reading the list."),
  MIGRATION_FAILED: person("A person fixes what the message names and runs `repo-aegis init --migrate-classify` again."),
  RENDER_ERROR: person("A person runs `repo-aegis render` in a terminal to see why."),
  MARKERS_WRITE_PROTECTED: person("A person runs `repo-aegis render` from their own terminal."),
  WORKFLOW_EXISTS: person("A person passes `--force` if the existing workflow should be overwritten."),
  WORKFLOW_MODIFIED: person("A person reviews the edited workflow and removes it by hand if it should go."),
  PIN_PATH_UNSUPPORTED: person("A person installs repo-aegis at an ordinary path; there is no override."),
  PIN_UNUSABLE: person("A person reinstalls repo-aegis at a stable path, then runs `repo-aegis install git-credential`."),
  SETTINGS_PARSE_ERROR: person("A person repairs `~/.claude/settings.json`; an agent does not edit it."),
  HOOKS_PATH_CONFLICT: person("A person decides whether to overwrite the prior `core.hooksPath` value with `--force`."),
  HOOKS_PATH_LOCAL_SHADOW: person("A person unsets the repository's own `core.hooksPath` that the details show."),
  GIT_CONFIG_ERROR: person("A person checks that `git config` works in their terminal and runs the command again."),
  GIT_CONFIG_WRITE_FAILED: person("A person checks that `git config --global` works in their terminal and runs the install again."),
  GIT_CONFIG_READ_FAILED: person("A person checks that `git config --global` works in their terminal and runs the install again."),
  SHIM_PATH_OCCUPIED: person("A person decides whether to overwrite the file in the way with `--force`."),
  MULTIPLE_INSTALLS: person("A person removes or upgrades the other repo-aegis on PATH."),
  PAUSE_TOO_LONG: person("A person chooses 8 hours or less and pauses again when it ends."),
  PAUSE_NOT_REMOVED: person("A person removes the pause with `repo-aegis resume` from their own terminal."),
  ENCRYPT_ERROR: person("A person checks the age recipient the message names and tries again."),
  DECRYPT_ERROR: person("A person checks the age identity file the message names and tries again."),
  AGE_NOT_FOUND: person("A person installs the `age` binary (https://age-encryption.org)."),
  AGE_ERROR: person("A person checks the age identity or recipient the message names and tries again."),
  WRITE_FAILED: person("A person checks the permissions of the file the message names and tries again."),
  DOCS_MISSING: person("A person reinstalls `@de-otio/repo-aegis`, or runs `npm run build` in a checkout."),
  EXPLAIN_DOCS_MISSING: person("A person reinstalls `@de-otio/repo-aegis`, or runs `npm run build` in a checkout."),
  PARSE_ERROR: person("A person fixes the query file the message names."),
  TOKEN_MISSING: person("A person exports `GH_TOKEN`, or the variable `--token` names."),
  QUERY_VALIDATION: person("A person fixes the queries the details list."),
  STATE_PARSE_ERROR: person("A person resolves the corrupt state file; it is not truncated."),
  // ---- removed in 0.15.0: the old command or flag now refuses with a pointer ----
  AUDIT_NETWORK_MOVED: agent("Run the replacement the message names: `repo-aegis-scan audit --org <org>` or `--published`."),
  REGISTRY_ENCRYPT_REMOVED: agent("Do not retry; an already-encrypted registry is migrated with `repo-aegis registry decrypt`."),
  REMOVED: agent("Drop the removed option or command; the message says which release removed it."),
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

/**
 * A call site that knows more than the code does may replace the table's step, or just its person-only answer, for
 * one refusal (the code, and so the `[CODE; …]` token, stays the same: `--json` consumers match on it). Used where
 * one code has two causes with different next steps.
 */
export interface RefusalGuideOverride {
  readonly next?: string;
  readonly personOnly?: boolean;
}

/**
 * `USAGE` raised AFTER a command's terminal gate (`approve`, `pause`, `identity …`): the reader is then a person,
 * and re-running one of those commands is a person's step, not an agent's.
 */
export const USAGE_AFTER_TERMINAL_GATE: RefusalGuideOverride = {
  next: "A person corrects the command's flags (`--help` shows them) and runs it again.",
  personOnly: true,
};

/**
 * `HOOK_INPUT_TOO_LARGE` after a write that was NOT scanned: the file is already on disk, so splitting it is moot.
 */
export const HOOK_INPUT_TOO_LARGE_AFTER_WRITE: RefusalGuideOverride = {
  next: "Tell your human which file you wrote, so they can run `repo-aegis check --path <file>` on it.",
  personOnly: false,
};

export function refusalGuideEntry(code: string, override?: RefusalGuideOverride): RefusalGuideEntry {
  const base = Object.prototype.hasOwnProperty.call(REFUSAL_GUIDE, code) ? REFUSAL_GUIDE[code]! : FALLBACK;
  if (override === undefined) return base;
  return { next: override.next ?? base.next, personOnly: override.personOnly ?? base.personOnly };
}

/**
 * The line every refusal carries before its `[CODE; details: …]` token:
 * `repo-aegis 0.13.2. Next step: <next> Only a person can run it: yes.`
 */
export function refusalGuideLine(code: string, override?: RefusalGuideOverride): string {
  const e = refusalGuideEntry(code, override);
  return `repo-aegis ${repoAegisVersion()}. Next step: ${e.next} Only a person can run it: ${e.personOnly ? "yes" : "no"}.`;
}
