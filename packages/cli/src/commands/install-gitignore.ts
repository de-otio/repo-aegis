import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { emitJson, emitText, emitError, type OutputOptions } from "../format.js";

const BEGIN_MARKER = "# repo-aegis: managed gitignore block — do not edit between markers";
const END_MARKER = "# repo-aegis: end managed block";

const MANAGED_BLOCK = `${BEGIN_MARKER}
# These patterns are appended by \`repo-aegis install gitignore\`. Remove
# both markers and the lines between them to opt out; rerunning install
# will re-append.
.env
.env.*
.envrc
*.pem
*.p12
*.key
id_rsa
id_rsa_*
id_dsa
id_dsa_*
id_ecdsa
id_ecdsa_*
id_ed25519
id_ed25519_*
.netrc
.npmrc
.pypirc
*credentials*.json
service-account*.json
${END_MARKER}
`;

interface InstallGitignoreOptions extends OutputOptions {
  gitignorePath?: string;
  /**
   * When true, strip the managed block (BEGIN_MARKER..END_MARKER,
   * inclusive) from the target file. Idempotent — if the markers are
   * absent, the call is a no-op with a clear message. The target file
   * itself is not removed even if it ends up empty (other entries may
   * have been there before install).
   */
  uninstall?: boolean;
}

function defaultGitignorePath(): string {
  const xdg = process.env["XDG_CONFIG_HOME"];
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
  return join(base, "git", "ignore");
}

/**
 * Remove the managed block (BEGIN_MARKER through END_MARKER, inclusive)
 * from `existing`. If a single trailing newline immediately follows the
 * end marker, it is also dropped so the surrounding content collapses
 * cleanly. Returns the new content; if no block is present, returns
 * `null` to signal a no-op to the caller.
 */
function stripManagedBlock(existing: string): string | null {
  const beginIdx = existing.indexOf(BEGIN_MARKER);
  if (beginIdx === -1) return null;
  const endIdx = existing.indexOf(END_MARKER, beginIdx);
  if (endIdx === -1) return null;
  let cutEnd = endIdx + END_MARKER.length;
  if (existing[cutEnd] === "\n") cutEnd += 1;
  return existing.slice(0, beginIdx) + existing.slice(cutEnd);
}

export function installGitignore(opts: InstallGitignoreOptions): void {
  const target = opts.gitignorePath ?? defaultGitignorePath();

  if (opts.uninstall) {
    uninstallGitignore(target, opts);
    return;
  }

  mkdirSync(dirname(target), { recursive: true });

  let existing = "";
  if (existsSync(target)) {
    existing = readFileSync(target, "utf8");
  }

  const alreadyPresent = existing.includes(BEGIN_MARKER);

  if (alreadyPresent) {
    if (opts.json) {
      emitJson({
        action: "install-gitignore",
        target,
        appended: false,
        alreadyPresent: true,
      });
      return;
    }
    emitText(`repo-aegis block already present in ${target}`);
    return;
  }

  if (existsSync(target)) {
    const needsLeadingNewline = existing.length > 0 && !existing.endsWith("\n");
    appendFileSync(target, (needsLeadingNewline ? "\n" : "") + MANAGED_BLOCK);
  } else {
    writeFileSync(target, MANAGED_BLOCK);
  }

  if (opts.json) {
    emitJson({
      action: "install-gitignore",
      target,
      appended: true,
      alreadyPresent: false,
    });
    return;
  }
  emitText(`appended repo-aegis block to ${target}`);
}

function uninstallGitignore(target: string, opts: InstallGitignoreOptions): void {
  if (!existsSync(target)) {
    if (opts.json) {
      emitJson({
        action: "uninstall-gitignore",
        target,
        removed: false,
        reason: "target file does not exist",
      });
      return;
    }
    emitText(`no gitignore at ${target} — nothing to remove`);
    return;
  }

  const existing = readFileSync(target, "utf8");
  const next = stripManagedBlock(existing);

  if (next === null) {
    if (opts.json) {
      emitJson({
        action: "uninstall-gitignore",
        target,
        removed: false,
        reason: "managed block not present",
      });
      return;
    }
    emitText(`no repo-aegis block in ${target} — nothing to remove`);
    return;
  }

  try {
    writeFileSync(target, next);
  } catch (err) {
    emitError(
      {
        code: "FS_ERROR",
        error: `failed to write ${target}: ${(err as Error).message}`,
      },
      opts,
    );
  }

  if (opts.json) {
    emitJson({
      action: "uninstall-gitignore",
      target,
      removed: true,
    });
    return;
  }
  emitText(`removed repo-aegis block from ${target}`);
}
