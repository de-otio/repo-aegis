// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `install git-credential` (A6), its uninstall, `doctor`'s order check and the pre-push rule
// (doc/plan-owner-identity.md §5.6, §12.1 A6, I14b, I15). Real git against temp global and system config files;
// placeholder names only.
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliBuilt, cliPath } from "../_subprocess-utils.js";
import { hermeticGitEnv, scrubGitEnv } from "../_test-utils.js";
import { helperOrder, readCredentialConfig, effectiveHelpers, withHelperInstalled, parseShowScopeList } from "../git-credential-config.js";
import { loadRegistry } from "@de-otio/repo-aegis-core";
import { gitCredentialOrderChecks } from "./doctor-git-credential-checks.js";
import {
  doInstall,
  doUninstall,
  GIT_CREDENTIAL_NEEDS_TTY,
  GIT_CREDENTIAL_ORDER_REFUSED,
  gitCredentialInstalled,
  helperCommand,
  installGitCredential,
  ledgerPath,
} from "./install-git-credential.js";

const PIN = { node: "/opt/example/bin/node", cli: "/opt/example/lib/repo-aegis/dist/index.js" };

const GH = "!/opt/example/bin/gh auth git-credential";
const REFERENCE = `[user]
\tname = Example
[credential "https://github.com"]
\thelper =
\thelper = ${GH}
[credential "https://gist.github.com"]
\thelper =
\thelper = ${GH}
[core]
\teditor = vi
`;

let tmp: string;
let home: string;
let globalCfg: string;
let systemCfg: string;
let work: string;
let n = 0;
let m = 0;
let restoreEnv: () => void;
const saved: Record<string, string | undefined> = {};

before(() => {
  restoreEnv = scrubGitEnv();
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "repo-aegis-install-gitcred-")));
});
after(() => {
  restoreEnv();
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  n++;
  home = join(tmp, `home${n}`);
  mkdirSync(join(home, "state"), { recursive: true });
  globalCfg = join(tmp, `global${n}`);
  systemCfg = join(tmp, `system${n}`);
  writeFileSync(systemCfg, "");
  work = join(tmp, `work${n}`);
  mkdirSync(work);
  for (const k of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM"]) saved[k] = process.env[k];
  process.env["GIT_CONFIG_GLOBAL"] = globalCfg;
  process.env["GIT_CONFIG_SYSTEM"] = systemCfg;
  process.env["GIT_CONFIG_NOSYSTEM"] = "1";
});

/** Turn the system file on. (Apple's git also reads its bundled gitconfig, scope `unknown`, with osxkeychain: treated as system.) */
const systemOn = (): void => {
  delete process.env["GIT_CONFIG_NOSYSTEM"];
};

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const person = { stderrIsTTY: true, silent: true } as const;
const opts = (extra: object = {}) => ({ ...person, pin: PIN, home, cwd: work, ...extra });
const ours = (): string => helperCommand(PIN, home);
const verdict = () => helperOrder(readCredentialConfig(work) ?? [], ours());
const read = (): string => (existsSync(globalCfg) ? readFileSync(globalCfg, "utf8") : "");

describe("install git-credential", () => {
  it("a config with the reference shape (reset, then gh): inserted after the reset, before gh; first overall", () => {
    writeFileSync(globalCfg, REFERENCE);
    writeFileSync(systemCfg, "[credential]\n\thelper = osxkeychain\n");
    systemOn();
    const r = doInstall(opts());
    assert.equal(r.changed, true);
    assert.deepEqual(verdict(), { kind: "first" });
    const list = effectiveHelpers(readCredentialConfig(work) ?? [], { path: null }).map(e => e.value);
    assert.deepEqual(list, [ours(), GH], "ours, then the person's gh helper");
    assert.match(read(), /useHttpPath = true/);
    assert.match(read(), /editor = vi/, "unrelated lines are untouched");
  });

  it("round trip: uninstall leaves the global config byte-identical (reference shape, empty file, no credential section)", () => {
    for (const original of [REFERENCE, "", "[user]\n\tname = Example\n", `[credential "https://github.com"]\n\thelper = \n\thelper = ${GH}\n`, `[credential "https://github.com"]\n\thelper = \n\thelper = ${GH}\n\thelper = !/opt/example/bin/other\n[core]\n\teditor = vi\n`]) {
      writeFileSync(globalCfg, original);
      rmSync(join(home, "state", "git-credential-install.json"), { force: true });
      doInstall(opts());
      assert.notEqual(read(), original, "the install changed something");
      assert.ok(gitCredentialInstalled(home));
      const u = doUninstall(opts());
      assert.equal(u.changed, true);
      assert.equal(read(), original, `byte-identical after uninstall for:\n${original}`);
      assert.equal(existsSync(ledgerPath(home)), false);
    }
  });

  it("a previously set useHttpPath is restored, and a true one is left alone", () => {
    writeFileSync(globalCfg, `[credential "https://github.com"]\n\tuseHttpPath = false\n`);
    doInstall(opts());
    assert.match(read(), /useHttpPath = true/);
    doUninstall(opts());
    assert.equal(read(), `[credential "https://github.com"]\n\tuseHttpPath = false\n`);

    const withTrue = `[credential "https://github.com"]\n\tuseHttpPath = true\n`;
    writeFileSync(globalCfg, withTrue);
    doInstall(opts());
    doUninstall(opts());
    assert.equal(read(), withTrue, "the person's own setting survives");
  });

  it("installing twice changes nothing the second time; uninstalling twice is idempotent", () => {
    writeFileSync(globalCfg, REFERENCE);
    doInstall(opts());
    const once = read();
    assert.equal(doInstall(opts()).changed, false);
    assert.equal(read(), once);
    doUninstall(opts());
    assert.equal(doUninstall(opts()).changed, false);
    assert.equal(read(), REFERENCE);
  });

  it("a moved pin replaces the old line instead of adding a second", () => {
    writeFileSync(globalCfg, REFERENCE);
    doInstall(opts());
    doInstall(opts({ pin: { node: PIN.node, cli: "/opt/example/lib/repo-aegis-2/dist/index.js" } }));
    const list = effectiveHelpers(readCredentialConfig(work) ?? [], { path: null }).map(e => e.value);
    assert.equal(list.length, 2);
    assert.match(list[0]!, /repo-aegis-2/);
  });

  it("gh auth setup-git appending its helper again behind ours is repaired by a re-run", () => {
    writeFileSync(globalCfg, REFERENCE);
    doInstall(opts());
    // the person's tooling re-adds a reset and its own helper after ours
    spawnSync("git", ["config", "--global", "--add", "credential.https://github.com.helper", ""], { env: process.env });
    spawnSync("git", ["config", "--global", "--add", "credential.https://github.com.helper", GH], { env: process.env });
    assert.equal(verdict().kind, "missing", "the new reset wiped ours from the effective list");
    doInstall(opts());
    assert.deepEqual(verdict(), { kind: "first" });
  });

  it("I14b: a system-scope osxkeychain helper with no reset in front: refused with instructions, config byte-identical", () => {
    writeFileSync(systemCfg, "[credential]\n\thelper = osxkeychain\n");
    systemOn();
    const original = `[credential "https://gist.github.com"]\n\thelper = ${GH}\n`;
    writeFileSync(globalCfg, original);
    assert.throws(
      () => doInstall(opts()),
      (e: unknown) => (e as { code?: string }).code === GIT_CREDENTIAL_ORDER_REFUSED && /system/.test((e as Error).message) && /--add credential\.https:\/\/github\.com\.helper ""/.test((e as Error).message),
    );
    assert.equal(read(), original, "nothing changed");
    assert.equal(existsSync(ledgerPath(home)), false);
  });

  it("I14b: the same system helper behind a global reset entry is fine", () => {
    writeFileSync(systemCfg, "[credential]\n\thelper = osxkeychain\n");
    writeFileSync(globalCfg, `[credential "https://github.com"]\n\thelper = \n`);
    systemOn();
    doInstall(opts());
    assert.deepEqual(verdict(), { kind: "first" });
  });

  it("a global generic helper ahead of the github.com section, with no reset: refused", () => {
    const original = `[credential]\n\thelper = store\n`;
    writeFileSync(globalCfg, original);
    assert.throws(() => doInstall(opts()), (e: unknown) => (e as { code?: string }).code === GIT_CREDENTIAL_ORDER_REFUSED);
    assert.equal(read(), original);
  });

  it("duplicate helper lines after the reset cannot be shifted unambiguously: refused, unchanged", () => {
    const original = `[credential "https://github.com"]\n\thelper = \n\thelper = ${GH}\n\thelper = ${GH}\n`;
    writeFileSync(globalCfg, original);
    assert.throws(() => doInstall(opts()), (e: unknown) => (e as { code?: string }).code === GIT_CREDENTIAL_ORDER_REFUSED);
    assert.equal(read(), original);
  });

  it("needs a person: without a terminal nothing changes (install and uninstall)", () => {
    writeFileSync(globalCfg, REFERENCE);
    assert.throws(() => installGitCredential(opts({ stderrIsTTY: false })), (e: unknown) => (e as { code?: string }).code === GIT_CREDENTIAL_NEEDS_TTY);
    assert.equal(read(), REFERENCE);
    doInstall(opts());
    const installed = read();
    assert.throws(() => installGitCredential(opts({ stderrIsTTY: false, uninstall: true })), (e: unknown) => (e as { code?: string }).code === GIT_CREDENTIAL_NEEDS_TTY);
    assert.equal(read(), installed, "an agent cannot remove the helper");
  });

  it("uninstall with no ledger removes nothing, even if a line looks like ours", () => {
    writeFileSync(globalCfg, `[credential "https://github.com"]\n\thelper = ${ours()}\n`);
    const r = doUninstall(opts());
    assert.equal(r.changed, false);
    assert.match(read(), /git-credential --home/);
  });

  it("the ledger records only what was added", () => {
    writeFileSync(globalCfg, REFERENCE);
    doInstall(opts());
    const ledger = JSON.parse(readFileSync(ledgerPath(home), "utf8")) as { value: string; helperAdded: boolean; useHttpPath: { set: boolean; previous: string | null } };
    assert.equal(ledger.value, ours());
    assert.equal(ledger.helperAdded, true);
    assert.deepEqual(ledger.useHttpPath, { set: true, previous: null });
  });

  it("the helper line quotes its paths for the shell", () => {
    const line = helperCommand({ node: "/opt/it's here/node", cli: "/opt/a b/index.js" }, "/home/x y");
    assert.equal(line, `!'/opt/it'\\''s here/node' '/opt/a b/index.js' git-credential --home '/home/x y'`);
  });
});

describe("config model", () => {
  it("withHelperInstalled predicts the order the real install produces", () => {
    writeFileSync(globalCfg, REFERENCE);
    writeFileSync(systemCfg, "[credential]\n\thelper = osxkeychain\n");
    systemOn();
    const before = readCredentialConfig(work) ?? [];
    const predicted = effectiveHelpers(withHelperInstalled(before, ours()), { path: null }).map(e => e.value);
    doInstall(opts());
    const real = effectiveHelpers(readCredentialConfig(work) ?? [], { path: null }).map(e => e.value);
    assert.deepEqual(real, predicted);
  });

  it("path-specific and user-specific patterns, wildcards and other hosts", () => {
    const e = parseShowScopeList(
      [
        "global\tcredential.https://github.com/o.helper !path-scoped",
        "global\tcredential.https://someone@github.com.helper !user-scoped",
        "global\tcredential.https://*.github.com.helper !wild",
        "global\tcredential.https://example.com.helper !other-host",
        "global\tcredential.github.com.helper !schemeless",
      ].join("\n"),
    );
    assert.deepEqual(effectiveHelpers(e, { path: null }).map(x => x.value), ["!path-scoped", "!schemeless"], "a probe assumes a path pattern applies");
    assert.deepEqual(effectiveHelpers(e, { path: "p/r" }).map(x => x.value), ["!schemeless"]);
    assert.deepEqual(effectiveHelpers(e, { path: "o/r" }).map(x => x.value), ["!path-scoped", "!schemeless"]);
  });
});

describe("doctor: GIT_CREDENTIAL_HELPER_ORDER", () => {
  const registry = (agent: boolean) => {
    writeFileSync(
      join(home, "engagements.yaml"),
      `schemaVersion: 3\nidentities:\n  me: { kind: gh-login, login: example-user }\n  bot: { kind: github-app, app: example-bot }\npersonalOrgs:\n  - { name: o, ${agent ? "agent: bot" : "person: me"} }\nengagements: []\n`,
    );
    return loadRegistry(join(home, "engagements.yaml"));
  };

  it("no owner mapped to an agent identity: no check", () => {
    assert.deepEqual(gitCredentialOrderChecks(registry(false), { entries: [] }), []);
  });

  it("an agent identity and no helper installed: a failure", () => {
    const checks = gitCredentialOrderChecks(registry(true), { entries: [], helper: ours() });
    assert.equal(checks.length, 1);
    assert.equal(checks[0]!.code, "GIT_CREDENTIAL_HELPER_ORDER");
    assert.equal(checks[0]!.ok, false);
    assert.notEqual(checks[0]!.severity, "warn");
  });

  it("another helper first (global generic ahead; or the wrong order): a failure; first: ok", () => {
    const reg = registry(true);
    const behind = parseShowScopeList(`global\tcredential.helper !store\nglobal\tcredential.https://github.com.helper ${ours()}`);
    const c = gitCredentialOrderChecks(reg, { entries: behind, helper: ours() })[0]!;
    assert.equal(c.ok, false);
    assert.match(c.detail, /global scope/);
    const first = parseShowScopeList(`global\tcredential.helper !store\nglobal\tcredential.https://github.com.helper \nglobal\tcredential.https://github.com.helper ${ours()}`);
    assert.equal(gitCredentialOrderChecks(reg, { entries: first, helper: ours() })[0]!.ok, true);
    const stale = parseShowScopeList(`global\tcredential.https://github.com.helper !'/old/node' '/old/cli.js' git-credential --home '/h'`);
    const s = gitCredentialOrderChecks(reg, { entries: stale, helper: ours() })[0]!;
    assert.equal(s.ok, false);
    assert.match(s.detail, /different install/);
  });

  it("first, but a later osxkeychain would persist the token: a warn note under the same code; gh's helper is fine", () => {
    const reg = registry(true);
    const lines = (later: string) => parseShowScopeList(`global\tcredential.https://github.com.helper \nglobal\tcredential.https://github.com.helper ${ours()}\nglobal\tcredential.https://github.com.helper ${later}`);
    const c = gitCredentialOrderChecks(reg, { entries: lines("osxkeychain"), helper: ours() })[0]!;
    assert.equal(c.code, "GIT_CREDENTIAL_HELPER_ORDER");
    assert.equal(c.ok, false);
    assert.equal(c.severity, "warn");
    assert.match(c.detail, /osxkeychain/);
    assert.equal(gitCredentialOrderChecks(reg, { entries: lines(GH), helper: ours() })[0]!.ok, true);
  });

  it("an unreadable git configuration is reported as skipped, not as a pass without a trace", () => {
    const c = gitCredentialOrderChecks(registry(true), { entries: null })[0]!;
    assert.equal(c.skipped, true);
  });
});

describe("pre-push: AGENT_PUSH_NEEDS_APP (I15)", { skip: !cliBuilt() }, () => {
  let repo: string;

  function setupRepo(agent: boolean): void {
    writeFileSync(
      join(home, "engagements.yaml"),
      `schemaVersion: 3\nidentities:\n  me: { kind: gh-login, login: example-user }\n  bot: { kind: github-app, app: example-bot }\npersonalOrgs:\n  - { name: o, ${agent ? "agent: bot" : "person: me"} }\nengagements: []\n`,
    );
    mkdirSync(join(home, "markers"), { recursive: true });
    repo = join(tmp, `repo${n}-${++m}`);
    mkdirSync(repo);
    spawnSync("git", ["init", "-q", "-b", "main", "."], { cwd: repo, env: hermeticGitEnv() });
  }

  function prePush(url: string): { status: number | null; stderr: string } {
    const r = spawnSync(process.execPath, [cliPath, "check", "--push-ref", "refs/heads/main", "--remote-url", url], {
      cwd: repo,
      encoding: "utf8",
      // The legacy gate is told a person is present (so it does not stop first); the identity rule ignores that variable (A1).
      env: hermeticGitEnv({ REPO_AEGIS_HOME: home, REPO_AEGIS_EGRESS_HUMAN: "1", REPO_AEGIS_VISIBILITY_LOOKUP: "0", GIT_CONFIG_GLOBAL: globalCfg, GIT_CONFIG_SYSTEM: systemCfg, GIT_CONFIG_NOSYSTEM: "1" }),
    });
    return { status: r.status, stderr: r.stderr };
  }

  it("SSH forms (scp-like, ssh://, the github.com-<alias> convention) are refused with the HTTPS form", () => {
    setupRepo(true);
    for (const url of ["git@github.com:o/r.git", "ssh://git@github.com/o/r.git", "git@github.com-personal:o/r.git"]) {
      const r = prePush(url);
      assert.equal(r.status, 2, `${url}\n${r.stderr}`);
      assert.ok(r.stderr.includes("AGENT_PUSH_NEEDS_APP"), url);
      assert.ok(r.stderr.includes("git push https://github.com/o/r.git <branch>"), r.stderr);
    }
  });

  it("an owner with only a person identity, or an unmapped one: SSH is not refused by this rule", () => {
    setupRepo(false);
    assert.ok(!prePush("git@github.com:o/r.git").stderr.includes("AGENT_PUSH_NEEDS_APP"));
    setupRepo(true);
    assert.ok(!prePush("git@github.com:q/r.git").stderr.includes("AGENT_PUSH_NEEDS_APP"));
  });

  it("HTTPS with the helper missing: GIT_CREDENTIAL_HELPER_ORDER; with it first: not refused by this rule", () => {
    setupRepo(true);
    writeFileSync(globalCfg, "");
    const bad = prePush("https://github.com/o/r.git");
    assert.equal(bad.status, 2, bad.stderr);
    assert.ok(bad.stderr.includes("GIT_CREDENTIAL_HELPER_ORDER"), bad.stderr);

    const pin = { node: realpathSync(process.execPath), cli: realpathSync(cliPath) };
    writeFileSync(globalCfg, `[credential "https://github.com"]\n\thelper = \n\thelper = ${helperCommand(pin, home)}\n`);
    const good = prePush("https://github.com/o/r.git");
    assert.ok(!good.stderr.includes("GIT_CREDENTIAL_HELPER_ORDER"), good.stderr);
    assert.ok(!good.stderr.includes("AGENT_PUSH_NEEDS_APP"), good.stderr);
  });
});
