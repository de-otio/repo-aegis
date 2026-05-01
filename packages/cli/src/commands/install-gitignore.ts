import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { emitJson, emitText, type OutputOptions } from "../format.js";

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
}

function defaultGitignorePath(): string {
  const xdg = process.env["XDG_CONFIG_HOME"];
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
  return join(base, "git", "ignore");
}

export function installGitignore(opts: InstallGitignoreOptions): void {
  const target = opts.gitignorePath ?? defaultGitignorePath();
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
