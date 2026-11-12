// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// The identity hook rules of doc/plan-owner-identity.md §13.2 (A1, A10, N9), as pure functions over the command
// text. Placeholders only (`o/r`, `/x`). "No person" is `humanPresent = () => false`.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  checkIdentityHookRules,
  decideIdentityHookRules,
  ghVerbChangesIdentityState,
  type IdentityHookRuleCode,
} from "./egress-network-rules.js";

const NO_PERSON = (): boolean => false;
const PERSON = (): boolean => true;

/** The code the hook would refuse with, with no person present; null when it passes. */
function agentVerdict(command: string): IdentityHookRuleCode | null {
  return decideIdentityHookRules(command, NO_PERSON)?.code ?? null;
}
function personVerdict(command: string): IdentityHookRuleCode | null {
  return decideIdentityHookRules(command, PERSON)?.code ?? null;
}

function refuses(code: IdentityHookRuleCode, commands: readonly string[]): void {
  for (const c of commands) {
    assert.equal(agentVerdict(c), code, `agent: ${c}`);
  }
}
function allows(commands: readonly string[]): void {
  for (const c of commands) {
    assert.equal(agentVerdict(c), null, `agent: ${c}`);
    assert.equal(personVerdict(c), null, `person: ${c}`);
  }
}

describe("A1: a REPO_AEGIS_* variable on a gh / git / taaad / security command (EGRESS_ENV_OVERRIDE)", () => {
  it("refuses a prefix assignment, whatever the command does (no egress intent needed)", () => {
    refuses("EGRESS_ENV_OVERRIDE", [
      "REPO_AEGIS_EGRESS_HUMAN=1 gh pr view --repo o/r",
      "REPO_AEGIS_HOME=/x git status",
      "REPO_AEGIS_REGISTRY=/x taaad doctor",
      "REPO_AEGIS_X=1 security list-keychains",
      "REPO_AEGIS_X=1 /usr/bin/security list-keychains",
      "REPO_AEGIS_X=1 ~/.local/bin/taaad doctor",
      "FOO=1 REPO_AEGIS_X=1 gh pr view 1",
      "REPO_AEGIS_X=1 gh pr view 1 && echo done",
    ]);
  });

  it("refuses through env, sudo and env -S", () => {
    refuses("EGRESS_ENV_OVERRIDE", [
      "env REPO_AEGIS_X=1 gh pr view 1",
      "env -i REPO_AEGIS_X=1 gh pr view 1",
      "sudo env REPO_AEGIS_X=1 git log",
      "sudo -u someone REPO_AEGIS_X=1 gh pr view 1",
      "env -S 'REPO_AEGIS_X=1 gh pr view 1'",
      "nice env REPO_AEGIS_X=1 taaad doctor",
    ]);
  });

  it("refuses through sh -c, bash -c, eval, substitutions and heredoc-fed shells", () => {
    refuses("EGRESS_ENV_OVERRIDE", [
      "sh -c 'REPO_AEGIS_X=1 gh pr view 1'",
      'bash -c "REPO_AEGIS_X=1 git status"',
      "bash -lc 'REPO_AEGIS_X=1 taaad doctor'",
      "REPO_AEGIS_X=1 sh -c 'gh pr view 1'",
      "REPO_AEGIS_X=1 bash -c 'git status'",
      "eval 'REPO_AEGIS_X=1 gh pr view 1'",
      "echo $(REPO_AEGIS_X=1 gh pr view 1)",
      "echo `REPO_AEGIS_X=1 git status`",
      "sh <<'EOF'\nREPO_AEGIS_X=1 gh pr view 1\nEOF",
      "bash <<EOF\nREPO_AEGIS_X=1 git status\nEOF",
      "sh -c 'sh -c \"REPO_AEGIS_X=1 gh pr view 1\"'",
    ]);
  });

  it("refuses an earlier export or bare assignment in the same command", () => {
    refuses("EGRESS_ENV_OVERRIDE", [
      "export REPO_AEGIS_EGRESS_HUMAN=1; gh pr list",
      "export REPO_AEGIS_X=1 && git log",
      "declare -x REPO_AEGIS_X=1; gh pr view 1",
      "REPO_AEGIS_X=1; gh pr view 1",
      "export REPO_AEGIS_X=1\ngit status",
      "eval 'export REPO_AEGIS_X=1'; gh pr view 1",
      "export REPO_AEGIS_X=1; sh -c 'gh pr view 1'",
      "export REPO_AEGIS_X=1; echo $(git status)",
    ]);
  });

  it("covers dot gh, which runs gh with the caller's environment", () => {
    refuses("EGRESS_ENV_OVERRIDE", ["REPO_AEGIS_X=1 dot gh pr view 1"]);
  });

  it("is never lifted by a person present", () => {
    for (const c of ["REPO_AEGIS_EGRESS_HUMAN=1 gh pr view --repo o/r", "export REPO_AEGIS_X=1; git status"]) {
      assert.equal(personVerdict(c), "EGRESS_ENV_OVERRIDE", c);
    }
  });

  it("allows REPO_AEGIS_* on other programs, other variables on gh / git, and a mere mention", () => {
    allows([
      "REPO_AEGIS_HOME=/x repo-aegis status",
      "REPO_AEGIS_HOME=/x npm test",
      "FOO=1 gh pr view 1",
      "GH_REPO=o/r gh pr view 1",
      "gh pr view 1",
      "git status",
      "echo REPO_AEGIS_X=1",
      "echo REPO_AEGIS_X=1 gh pr view 1",
      "git commit -m 'REPO_AEGIS_X=1 gh pr view'",
      "REPO_AEGIS_X=1 echo hi; gh pr view 1",
    ]);
  });
});

describe("A1: gh / git / taaad / security under a pty wrapper (EGRESS_PTY_WRAPPER)", () => {
  it("refuses a wrapper around any of them, whatever the intent", () => {
    refuses("EGRESS_PTY_WRAPPER", [
      "script -q /dev/null gh pr view 1",
      "script -q /dev/null git status",
      'script -c "taaad doctor" /dev/null',
      "script -q /dev/null security list-keychains",
      "unbuffer git log",
      "unbuffer gh pr view 1",
      "expect -c 'spawn gh pr view 1; expect eof'",
      "socat - EXEC:'gh pr view 1',pty",
      "tmux new-session 'gh pr view 1'",
      "python3 -c 'import pty; pty.spawn([\"gh\", \"pr\", \"view\", \"1\"])'",
    ]);
  });

  it("refuses through sudo, sh -c, a heredoc and an absolute path", () => {
    refuses("EGRESS_PTY_WRAPPER", [
      "sudo script -q /dev/null gh pr view 1",
      "sh -c 'script -q /dev/null git status'",
      "bash -c 'unbuffer /usr/bin/security list-keychains'",
      "/usr/bin/script -q /dev/null /usr/local/bin/gh pr view 1",
      "script -q /dev/null sh <<'EOF'\ngh pr view 1\nEOF",
    ]);
  });

  it("is never lifted by a person present", () => {
    assert.equal(personVerdict("script -q /dev/null gh pr view 1"), "EGRESS_PTY_WRAPPER");
  });

  it("allows a wrapper around something else, and gh / git with no wrapper", () => {
    allows([
      "script -q /dev/null echo hi",
      "unbuffer ls",
      "expect -c 'spawn ls'",
      "gh pr view 1",
      "git status",
    ]);
  });
});

describe("A10: gh auth, config, alias and extension verbs that change identity state (GH_AUTH_NEEDS_HUMAN)", () => {
  it("refuses every gh auth verb except a plain status", () => {
    refuses("GH_AUTH_NEEDS_HUMAN", [
      "gh auth token",
      "gh auth login",
      "gh auth logout",
      "gh auth switch --user x",
      "gh auth refresh",
      "gh auth setup-git",
      "gh auth status --show-token",
      "gh auth status -t",
      "gh auth status --hostname github.com -t",
      "gh auth status -t --hostname github.com",
      "gh auth token --hostname github.com",
      "gh auth token --hostname=github.com",
      "gh auth status --show-token --hostname=github.com",
    ]);
  });

  it("recognises gh global flags before the group", () => {
    refuses("GH_AUTH_NEEDS_HUMAN", [
      "gh --hostname example.com auth token",
      "gh --hostname=example.com auth token",
      "gh -R o/r auth token",
      "gh --repo o/r auth login",
      "gh --repo=o/r config set editor vim",
      "gh --hostname example.com auth status --show-token",
    ]);
  });

  it("refuses the config, alias and extension verbs", () => {
    refuses("GH_AUTH_NEEDS_HUMAN", [
      "gh config set editor vim",
      "gh config set git_protocol ssh --host github.com",
      "gh config clear-cache",
      "gh alias set co 'pr checkout'",
      "gh alias import aliases.yml",
      "gh alias delete co",
      "gh extension install o/gh-x",
      "gh extension upgrade --all",
      "gh extension exec x",
      "gh extensions install o/gh-x",
      "gh ext install o/gh-x",
    ]);
  });

  it("refuses through wrappers, absolute paths and substitutions", () => {
    refuses("GH_AUTH_NEEDS_HUMAN", [
      "/usr/local/bin/gh auth token",
      "/opt/homebrew/bin/gh auth login",
      "sudo gh auth token",
      "env GH_HOST=example.com gh auth token",
      "sh -c 'gh auth token'",
      'bash -c "gh auth login"',
      "bash -lc 'gh config set editor vim'",
      "eval 'gh auth switch'",
      "eval gh alias set x y",
      "echo $(gh auth token)",
      "echo `gh auth token`",
      "X=$(gh auth token); echo done",
      "sh <<'EOF'\ngh auth token\nEOF",
      "cat <<EOF | sh\ngh extension install o/gh-x\nEOF",
    ]);
  });

  it("is lifted by a person present", () => {
    for (const c of ["gh auth login", "gh auth token", "gh config set editor vim", "sh -c 'gh alias set a b'"]) {
      assert.equal(personVerdict(c), null, c);
    }
  });

  it("allows read-only and unrelated verbs", () => {
    allows([
      "gh auth status",
      "gh auth status --hostname github.com",
      "gh auth status --active",
      "gh config get editor",
      "gh config list",
      "gh alias list",
      "gh extension list",
      "gh extension remove x",
      "gh pr view 1",
      "gh api user",
      "gh --repo o/r pr view 1",
      "echo gh auth token",
      "git commit -m 'gh auth token'",
      "grep 'gh config set' README.md",
    ]);
  });

  it("exports the predicate over gh arguments", () => {
    assert.equal(ghVerbChangesIdentityState(["auth", "token"]), true);
    assert.equal(ghVerbChangesIdentityState(["--hostname", "x", "auth", "token"]), true);
    assert.equal(ghVerbChangesIdentityState(["auth", "status"]), false);
    assert.equal(ghVerbChangesIdentityState(["auth", "status", "-t"]), true);
    assert.equal(ghVerbChangesIdentityState(["config", "get", "editor"]), false);
    assert.equal(ghVerbChangesIdentityState(["extension", "list"]), false);
    assert.equal(ghVerbChangesIdentityState([]), false);
  });
});

describe("N9: token and keychain routes (TOKEN_MINT_NEEDS_HUMAN)", () => {
  it("refuses taaad env, agent, credential-helper and mint", () => {
    refuses("TOKEN_MINT_NEEDS_HUMAN", [
      "taaad env --app example-bot",
      "taaad agent",
      "taaad credential-helper get",
      "taaad mint --app example-bot --repo o/r --json",
      "taaad --config-dir /x mint --app example-bot",
      "taaad mint --app=example-bot --repo=o/r",
      "~/.local/bin/taaad mint --app example-bot",
      "/opt/pipx/bin/taaad env --app example-bot",
      "sudo taaad env --app example-bot",
      "env TAAAD_CONFIG_DIR=/x taaad mint --app example-bot",
    ]);
  });

  it("refuses the security keychain readers", () => {
    refuses("TOKEN_MINT_NEEDS_HUMAN", [
      "security find-generic-password -s example-service -w",
      "security find-generic-password -w -s example-service",
      "security find-internet-password -s example.com",
      "security dump-keychain -d",
      "security export -k login.keychain -t certs",
      "security unlock-keychain -p x login.keychain",
      "security -q find-generic-password -s example-service",
      "/usr/bin/security find-generic-password -s example-service -w",
      "sudo security find-generic-password -s example-service",
      "security find-generic-password -s example-service -w | pbcopy",
    ]);
  });

  it("refuses an interpreter text that imports keyring or names SecItemCopyMatching", () => {
    refuses("TOKEN_MINT_NEEDS_HUMAN", [
      "python3 -c 'import keyring; print(keyring.get_password(\"s\", \"u\"))'",
      "python -c 'from keyring import get_password'",
      "python3.12 -c 'import keyring'",
      "/usr/bin/python3 -c 'import keyring'",
      "python3 -c'import keyring'",
      "python3 -m keyring get s u",
      "python3 <<EOF\nimport keyring\nprint(keyring.get_password('s', 'u'))\nEOF",
      "node -e 'SecItemCopyMatching'",
      "node --eval='SecItemCopyMatching'",
      "perl -e 'SecItemCopyMatching(1)'",
      "ruby -e 'SecItemCopyMatching'",
      "osascript -e 'use framework \"Security\"' -e 'SecItemCopyMatching(q, r)'",
      "osascript -l JavaScript -e 'ObjC.import(\"Security\"); $.SecItemCopyMatching(q, r)'",
    ]);
  });

  it("refuses through sh -c, bash -c, eval, substitutions and heredoc-fed shells", () => {
    refuses("TOKEN_MINT_NEEDS_HUMAN", [
      "sh -c 'taaad mint --app example-bot'",
      'bash -c "security find-generic-password -s s"',
      "eval 'taaad env --app example-bot'",
      "T=$(security dump-keychain); echo done",
      "echo `taaad agent`",
      "sh <<'EOF'\ntaaad credential-helper get\nEOF",
      "sh -c \"python3 -c 'import keyring'\"",
    ]);
  });

  it("is lifted by a person present", () => {
    for (const c of ["taaad mint --app example-bot", "security find-generic-password -s s -w", "python3 -c 'import keyring'"]) {
      assert.equal(personVerdict(c), null, c);
    }
  });

  it("allows the harmless neighbours", () => {
    allows([
      "taaad doctor",
      "taaad --version",
      "taaad status",
      "security list-keychains",
      "security find-identity -v",
      "security find-certificate -a",
      "security import cert.pem",
      "python3 -c 'print(1)'",
      "python3 -c 'import json; print(json.dumps({}))'",
      "python3 script.py",
      "node -e 'console.log(1)'",
      "node app.js",
      "perl -e 'print 1'",
      "osascript -e 'display dialog \"x\"'",
      "echo taaad mint",
      "grep mint README.md",
      "git commit -m 'taaad mint'",
      "echo keyring",
    ]);
  });
});

describe("precedence and plumbing", () => {
  it("an A1 hit wins over a person-liftable one, and presence is not read for it", () => {
    let reads = 0;
    const hit = decideIdentityHookRules("REPO_AEGIS_X=1 gh auth token", () => (reads++, true));
    assert.equal(hit?.code, "EGRESS_ENV_OVERRIDE");
    assert.equal(reads, 0);
  });

  it("presence is read at most once, and only for a liftable hit", () => {
    let reads = 0;
    assert.equal(decideIdentityHookRules("gh auth token; taaad mint", () => (reads++, false))?.code, "GH_AUTH_NEEDS_HUMAN");
    assert.equal(reads, 1);
    reads = 0;
    assert.equal(decideIdentityHookRules("gh pr view 1", () => (reads++, false)), null);
    assert.equal(reads, 0);
  });

  it("a command with no hits yields none, and the refusals are five-part texts that name their code", () => {
    assert.deepEqual(checkIdentityHookRules("ls -la"), []);
    for (const [c, code] of [
      ["REPO_AEGIS_X=1 gh pr view 1", "EGRESS_ENV_OVERRIDE"],
      ["script -q /dev/null gh pr view 1", "EGRESS_PTY_WRAPPER"],
      ["gh auth token", "GH_AUTH_NEEDS_HUMAN"],
      ["taaad mint", "TOKEN_MINT_NEEDS_HUMAN"],
    ] as const) {
      const hit = checkIdentityHookRules(c)[0]!;
      assert.equal(hit.code, code);
      assert.match(hit.reason, /refused\./);
      assert.match(hit.reason, new RegExp(`\\[${code}; details: repo-aegis explain ${code}\\]`));
      assert.match(hit.reason, /No approval covers this/);
    }
  });

  it("never echoes the command's own text, values or paths", () => {
    const reason = checkIdentityHookRules("REPO_AEGIS_X=secret-value-1 gh pr view --repo some-owner/some-repo")[0]!.reason;
    assert.ok(!reason.includes("secret-value-1"));
    assert.ok(!reason.includes("some-owner"));
  });
});

describe("quoting decides what runs: substitutions and wrapper words in data are not invocations", () => {
  it("backticks inside single quotes (a commit message) run nothing: no refusal", () => {
    allows([
      "git commit -m 'docs: never run `gh auth token` in an agent'",
      "git commit -m $'docs: never run `gh auth token`'",
      "git commit -m 'note $(gh auth token) is refused'",
    ]);
  });

  it("… but double quotes, an unquoted heredoc, and a redirection target do run them", () => {
    refuses("GH_AUTH_NEEDS_HUMAN", [
      'git commit -m "docs: never run `gh auth token`"',
      "git commit -F - <<EOF\ndocs: never run `gh auth token`\nEOF",
      "cat <<EOF > /x/notes.md\ntoken: $(gh auth token)\nEOF",
      "echo hi > \"$(gh auth token)\"",
      // a literal and a real occurrence of the same text: the real one still counts
      "echo '`gh auth token`' `gh auth token`",
      // the text of `bash -c '…'` is a program of its own, so its backticks run
      "bash -c 'echo `gh auth token`'",
    ]);
  });

  it("a quoted heredoc delimiter keeps the body literal", () => {
    allows([
      "git commit -F - <<'EOF'\ndocs: never run `gh auth token`\nEOF",
      'git commit -F - <<"EOF"\ndocs: never run $(gh auth token)\nEOF',
      "git commit -F - <<\\EOF\ndocs: never run `gh auth token`\nEOF",
    ]);
  });

  it("`expect`, `script` and the like named in interpreter code are not a pty wrapper", () => {
    allows([
      "python3 - <<'EOF'\nimport re\nexpect = 'git status'\nEOF",
      "node -e \"expect(run('git', ['push'])).toBe(1)\"",
      "node -e \"const script = 'git log'; console.log(script.length)\"",
    ]);
  });

  it("… while a wrapper the interpreter runs still is", () => {
    refuses("EGRESS_PTY_WRAPPER", [
      "python3 -c \"import os; os.system('script -q /dev/null git push')\"",
      "python3 -c \"import subprocess; subprocess.run(['expect', '-c', 'spawn git push'])\"",
      "python3 - <<'EOF'\nimport os\nos.system(\"unbuffer gh pr create --fill\")\nEOF",
      "expect -c 'spawn git push'",
    ]);
  });
});
