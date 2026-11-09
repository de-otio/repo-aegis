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

  /** The global `credential.https://github.com.helper` list, in order, empty entries as "". */
  const globalList = (): string[] => {
    const r = spawnSync("git", ["config", "--global", "--get-all", "credential.https://github.com.helper"], { env: process.env, encoding: "utf8" });
    return r.status === 0 ? r.stdout.replace(/\n$/, "").split("\n") : [];
  };
  const STOCK_SYSTEM = "[credential]\n\thelper = osxkeychain\n";

  it("I14b: stock macOS (a system osxkeychain, an empty global list): the install writes the reset, ours and osxkeychain, in that order", () => {
    writeFileSync(systemCfg, STOCK_SYSTEM);
    systemOn();
    const original = `[credential "https://gist.github.com"]\n\thelper = ${GH}\n`;
    writeFileSync(globalCfg, original);
    const r = doInstall(opts());
    assert.equal(r.changed, true);
    assert.equal(r.resetAdded, true);
    assert.deepEqual(r.readded, ["osxkeychain"]);
    assert.deepEqual(globalList(), ["", ours(), "osxkeychain"]);
    assert.deepEqual(verdict(), { kind: "first" });
    assert.match(read(), /useHttpPath = true/);
    // The ledger is v2 and records what was added.
    const ledger = JSON.parse(readFileSync(ledgerPath(home), "utf8")) as { version: number; value: string; helperAdded: boolean; resetAdded: boolean; readded: string[] };
    assert.equal(ledger.version, 2);
    assert.equal(ledger.value, ours());
    assert.equal(ledger.helperAdded, true);
    assert.equal(ledger.resetAdded, true);
    assert.deepEqual(ledger.readded, ["osxkeychain"]);
    // Uninstall removes exactly that: the config is byte-identical to before.
    const u = doUninstall(opts());
    assert.equal(u.changed, true);
    assert.equal(read(), original, "byte-identical after uninstall");
    assert.equal(existsSync(ledgerPath(home)), false);
  });

  it("I14b: stock macOS with no global file at all: installs, and uninstall leaves an empty config", () => {
    writeFileSync(systemCfg, STOCK_SYSTEM);
    systemOn();
    doInstall(opts());
    assert.deepEqual(globalList(), ["", ours(), "osxkeychain"]);
    doUninstall(opts());
    assert.equal(read().trim(), "");
  });

  it("I14b: a NON-empty global list with a system helper in front, and no reset, is still refused: config byte-identical, no ledger", () => {
    writeFileSync(systemCfg, STOCK_SYSTEM);
    systemOn();
    const original = `[credential "https://github.com"]\n\thelper = ${GH}\n`;
    writeFileSync(globalCfg, original);
    assert.throws(
      () => doInstall(opts()),
      (e: unknown) =>
        (e as { code?: string }).code === GIT_CREDENTIAL_ORDER_REFUSED &&
        /system/.test((e as Error).message) &&
        /--add credential\.https:\/\/github\.com\.helper ""/.test((e as Error).message) &&
        !/needs an administrator/.test((e as Error).message),
    );
    assert.equal(read(), original, "nothing changed");
    assert.equal(existsSync(ledgerPath(home)), false);
  });

  it("I14b: the same system helper behind a global reset entry is fine, and no extra reset is written", () => {
    writeFileSync(systemCfg, STOCK_SYSTEM);
    writeFileSync(globalCfg, `[credential "https://github.com"]\n\thelper = \n`);
    systemOn();
    const r = doInstall(opts());
    assert.deepEqual(verdict(), { kind: "first" });
    assert.equal(r.resetAdded, false);
    assert.deepEqual(globalList(), ["", ours()]);
    doUninstall(opts());
    assert.equal(read(), `[credential "https://github.com"]\n\thelper = \n`, "the person's own reset stays");
  });

  it("a global generic helper ahead of the github.com section, with no reset: hidden by a reset and put back after ours; uninstall restores the file", () => {
    const original = `[credential]\n\thelper = store\n`;
    writeFileSync(globalCfg, original);
    const r = doInstall(opts());
    assert.deepEqual(r.readded, ["store"]);
    assert.deepEqual(verdict(), { kind: "first" });
    assert.deepEqual(effectiveHelpers(readCredentialConfig(work) ?? [], { path: null }).map(e => e.value), [ours(), "store"]);
    doUninstall(opts());
    assert.equal(read(), original);
  });

  it("a helper set under another URL pattern cannot be put back under the github.com key, so that install is refused, unchanged", () => {
    writeFileSync(systemCfg, STOCK_SYSTEM);
    systemOn();
    const original = `[credential "https://github.com/example-org"]\n\thelper = !example-path-helper\n`;
    writeFileSync(globalCfg, original);
    assert.throws(() => doInstall(opts()), (e: unknown) => (e as { code?: string }).code === GIT_CREDENTIAL_ORDER_REFUSED);
    assert.equal(read(), original);
    assert.equal(existsSync(ledgerPath(home)), false);
  });

  it("stock macOS: re-running changes nothing; a moved pin keeps the reset and osxkeychain in place; uninstall restores the file", () => {
    writeFileSync(systemCfg, STOCK_SYSTEM);
    systemOn();
    const original = `[user]\n\tname = Example\n`;
    writeFileSync(globalCfg, original);
    doInstall(opts());
    const once = read();
    const again = doInstall(opts());
    assert.equal(again.changed, false);
    assert.equal(read(), once);
    doInstall(opts({ pin: { node: PIN.node, cli: "/opt/example/lib/repo-aegis-2/dist/index.js" } }));
    const moved = globalList();
    assert.equal(moved.length, 3, moved.join(" | "));
    assert.equal(moved[0], "");
    assert.match(moved[1]!, /repo-aegis-2/);
    assert.equal(moved[2], "osxkeychain");
    const ledger = JSON.parse(readFileSync(ledgerPath(home), "utf8")) as { resetAdded: boolean; readded: string[] };
    assert.equal(ledger.resetAdded, true);
    assert.deepEqual(ledger.readded, ["osxkeychain"], "an earlier run's additions are still recorded");
    doUninstall(opts({ pin: { node: PIN.node, cli: "/opt/example/lib/repo-aegis-2/dist/index.js" } }));
    assert.equal(read(), original);
  });

  it("uninstall leaves the reset when the person added a helper of their own under the key since", () => {
    writeFileSync(systemCfg, STOCK_SYSTEM);
    systemOn();
    writeFileSync(globalCfg, "");
    doInstall(opts());
    spawnSync("git", ["config", "--global", "--add", "credential.https://github.com.helper", "!example-own-helper"], { env: process.env });
    doUninstall(opts());
    assert.deepEqual(globalList(), ["", "!example-own-helper"], "ours and the re-added osxkeychain are gone; the reset stays");
  });

  it("a version 1 ledger is still read: uninstall removes the helper line it names and nothing else", () => {
    writeFileSync(globalCfg, `[credential "https://github.com"]\n\thelper = \n\thelper = ${ours()}\n\thelper = ${GH}\n\tuseHttpPath = true\n`);
    writeFileSync(
      ledgerPath(home),
      JSON.stringify({ version: 1, key: "credential.https://github.com.helper", value: ours(), helperAdded: true, useHttpPath: { set: false, previous: null } }),
    );
    const u = doUninstall(opts());
    assert.equal(u.changed, true);
    assert.deepEqual(globalList(), ["", GH], "the person's reset and gh helper stay; useHttpPath stays");
    assert.match(read(), /useHttpPath = true/);
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
    const ledger = JSON.parse(readFileSync(ledgerPath(home), "utf8")) as { version: number; value: string; helperAdded: boolean; resetAdded: boolean; readded: string[]; useHttpPath: { set: boolean; previous: string | null } };
    assert.equal(ledger.version, 2);
    assert.equal(ledger.value, ours());
    assert.equal(ledger.helperAdded, true);
    assert.equal(ledger.resetAdded, false, "the person's own reset was not ours to remove");
    assert.deepEqual(ledger.readded, []);
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
      // U7: the cause (an SSH remote goes as the person's key), who created the mapping, and that no approval helps.
      assert.match(r.stderr, /this push's remote is an SSH one, which goes out as the person's SSH key/, url);
      assert.match(r.stderr, /a person mapped it; repo-aegis maps none by itself/, url);
      assert.match(r.stderr, /No approval covers this: an approval cannot make an SSH push use the App's token/, url);
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
    // U7: the cause, that repo-aegis only puts its helper first when `install git-credential` runs, the fix line,
    // and that no approval changes which helper git asks first.
    assert.match(bad.stderr, /not the first helper git runs for https:\/\/github\.com/);
    assert.match(bad.stderr, /puts its helper first only when `install git-credential` runs/);
    assert.match(bad.stderr, /repo-aegis install git-credential \(it adds only repo-aegis's own helper entry, so re-running it is safe/);
    assert.match(bad.stderr, /No approval covers this: an approval cannot change which helper git asks first/);

    const pin = { node: realpathSync(process.execPath), cli: realpathSync(cliPath) };
    writeFileSync(globalCfg, `[credential "https://github.com"]\n\thelper = \n\thelper = ${helperCommand(pin, home)}\n`);
    const good = prePush("https://github.com/o/r.git");
    assert.ok(!good.stderr.includes("GIT_CREDENTIAL_HELPER_ORDER"), good.stderr);
    assert.ok(!good.stderr.includes("AGENT_PUSH_NEEDS_APP"), good.stderr);
  });
});
