// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `install claude-md` registry write protection (doc/plan-unregistered-owner-
// egress.md §8.2, R1): Edit deny rules for the files whose tampering bypasses
// the guard, the ledger that lets `--uninstall` remove exactly what install
// added, and the doctor check REGISTRY_AGENT_WRITABLE that reads them back.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EnforcementPin } from "@de-otio/repo-aegis-core";
import { captureOutput, withEnv } from "../_test-utils.js";
import {
  checkRegistryAgentWritable,
  denyRuleCoversPath,
  installClaudeMd,
  registryDenyPlan,
  registryDenyRules,
} from "./install-claude-md.js";

let tmp: string;
let n = 0;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "repo-aegis-registry-deny-"));
});
after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * A pin whose CLI package directory and node file sit under the temp dir, outside any git
 * work tree. The default pin is this checkout's own build, which is inside one (and would add
 * a warning, and drop the package-directory rule, to every exact-list assertion below).
 */
function outsideGitPin(): EnforcementPin {
  const root = join(tmp, `pin-${n++}`);
  mkdirSync(join(root, "pkg", "dist"), { recursive: true });
  writeFileSync(join(root, "pkg", "package.json"), JSON.stringify({ name: "@de-otio/repo-aegis" }));
  writeFileSync(join(root, "pkg", "dist", "index.js"), "// stub\n");
  return { node: join(root, "node"), cli: join(root, "pkg", "dist", "index.js") };
}

interface Env {
  claudeHome: string;
  aegisHome: string;
  settingsPath: string;
}

function makeEnv(name: string): Env {
  const base = join(tmp, `${name}-${n++}`);
  const claudeHome = join(base, "claude");
  const aegisHome = join(base, "aegis");
  mkdirSync(claudeHome, { recursive: true });
  mkdirSync(aegisHome, { recursive: true });
  return { claudeHome, aegisHome, settingsPath: join(claudeHome, "settings.json") };
}

/** Run `fn` with the registry resolved from `e.aegisHome` (and no REPO_AEGIS_REGISTRY override). */
function inEnv<T>(e: Env, fn: () => T): T {
  return withEnv("REPO_AEGIS_MARKERS_DIR", undefined, () =>
    withEnv("REPO_AEGIS_REGISTRY", undefined, () => withEnv("REPO_AEGIS_HOME", e.aegisHome, fn)),
  );
}

type Settings = { permissions?: { deny?: string[]; allow?: string[] }; hooks?: unknown; [k: string]: unknown };

function readSettings(e: Env): Settings {
  return JSON.parse(readFileSync(e.settingsPath, "utf8")) as Settings;
}

function install(e: Env, opts: Record<string, unknown> = {}): { stdout: string } {
  return inEnv(e, () => captureOutput(() => installClaudeMd({ claudeHome: e.claudeHome, userSettings: true, ...opts })));
}

const LEDGER = "state/claude-md-deny-rules.json";

describe("registryDenyPlan", () => {
  it("denies Edit on the registry, its .age, the approvals store, the pause file, the destination cache, the two trusted state files, hooks/**, bin/**, prompt-approvals/**, markers/** and the pinned code — and nothing else", () => {
    const e = makeEnv("plan");
    const h = e.aegisHome;
    const pin = outsideGitPin();
    const plan = inEnv(e, () => registryDenyPlan(pin));
    assert.deepEqual(plan.rules, [
      `Edit(/${h}/engagements.yaml)`,
      `Edit(/${h}/engagements.yaml.age)`,
      `Edit(/${h}/egress-approvals.json)`,
      // the emergency pause: an agent that could write it would have switched repo-aegis off for itself
      `Edit(/${h}/pause.json)`,
      // the decision log's on/off switch: an agent that could write it would remove the data its next refusal needs
      `Edit(/${h}/state/decision-log.json)`,
      // ...and the log itself with its rotations: deleting it is switching it off by another route
      `Edit(/${h}/state/decisions.jsonl)`,
      `Edit(/${h}/state/decisions.jsonl.1)`,
      `Edit(/${h}/state/decisions.jsonl.2)`,
      `Edit(/${h}/state/decisions.jsonl.3)`,
      `Edit(/${h}/destinations.json)`,
      `Edit(/${h}/state/deny-set.cache.json)`,
      `Edit(/${h}/state/claude-md-deny-rules.json)`,
      `Edit(/${h}/hooks/**)`,
      `Edit(/${h}/bin/**)`,
      // an agent that could write a prompt approval would have minted one for itself
      `Edit(/${h}/prompt-approvals/**)`,
      `Edit(/${h}/markers/**)`,
      `Edit(/${pin.node})`,
      `Edit(/${join(pin.cli, "..", "..")}/**)`,
    ]);
    assert.deepEqual(plan.warnings, []);
    // Claude Code never matches a Write(path) rule: none is written.
    assert.ok(plan.rules.every(r => r.startsWith("Edit(")));
    // The run-time state stays writable (audit log, lock, flags); only the two files an enforcement
    // path TRUSTS are denied: the deny-set cache (a forged empty entry switches the scanner off) and
    // the ledger uninstall reads.
    assert.deepEqual(
      plan.rules.filter(r => r.includes("/state")),
      [
        `Edit(/${h}/state/decision-log.json)`,
        `Edit(/${h}/state/decisions.jsonl)`,
        `Edit(/${h}/state/decisions.jsonl.1)`,
        `Edit(/${h}/state/decisions.jsonl.2)`,
        `Edit(/${h}/state/decisions.jsonl.3)`,
        `Edit(/${h}/state/deny-set.cache.json)`, `Edit(/${h}/state/claude-md-deny-rules.json)`],
    );
    assert.ok(plan.rules.every(r => !r.includes("/state/**") && !r.includes("audit")));
    assert.ok(plan.rules.every(r => r !== `Edit(/${h}/**)`), "the whole home must not be denied");
  });

  it("a relocated registry is denied as a FILE, never as its directory", () => {
    const e = makeEnv("relocated");
    const elsewhere = join(tmp, `elsewhere-${n++}`);
    mkdirSync(elsewhere, { recursive: true });
    const plan = withEnv("REPO_AEGIS_REGISTRY", join(elsewhere, "reg.yaml"), () =>
      withEnv("REPO_AEGIS_HOME", e.aegisHome, () => registryDenyPlan()),
    );
    assert.ok(plan.rules.includes(`Edit(/${elsewhere}/reg.yaml)`));
    assert.ok(plan.rules.includes(`Edit(/${elsewhere}/reg.yaml.age)`));
    assert.ok(plan.rules.every(r => !r.includes(`/${elsewhere}/**`)));
  });

  it("the markers directory follows REPO_AEGIS_MARKERS_DIR; a risky one is not denied, with a warning", () => {
    const e = makeEnv("markers-override");
    const elsewhere = join(tmp, `markers-elsewhere-${n++}`);
    mkdirSync(elsewhere, { recursive: true });
    const moved = withEnv("REPO_AEGIS_MARKERS_DIR", elsewhere, () =>
      withEnv("REPO_AEGIS_REGISTRY", undefined, () => withEnv("REPO_AEGIS_HOME", e.aegisHome, () => registryDenyPlan())),
    );
    assert.ok(moved.rules.includes(`Edit(/${elsewhere}/**)`));
    assert.ok(!moved.rules.includes(`Edit(/${e.aegisHome}/markers/**)`), "the default location is not the one in use");

    const repo = join(tmp, `markers-repo-${n++}`);
    mkdirSync(join(repo, ".git"), { recursive: true });
    const risky = withEnv("REPO_AEGIS_MARKERS_DIR", join(repo, "markers"), () =>
      withEnv("REPO_AEGIS_REGISTRY", undefined, () => withEnv("REPO_AEGIS_HOME", e.aegisHome, () => registryDenyPlan())),
    );
    assert.ok(risky.rules.every(r => !r.includes(`/${repo}/`)));
    assert.match(risky.warnings.join("\n"), /markers directory .*git work tree/);
  });

  it("a registry inside a git work tree is still denied as a file, with a warning", () => {
    const e = makeEnv("in-git");
    const repo = join(tmp, `repo-${n++}`);
    mkdirSync(join(repo, ".git"), { recursive: true });
    const plan = withEnv("REPO_AEGIS_REGISTRY", join(repo, "engagements.yaml"), () =>
      withEnv("REPO_AEGIS_HOME", e.aegisHome, () => registryDenyPlan(outsideGitPin())),
    );
    assert.ok(plan.rules.includes(`Edit(/${repo}/engagements.yaml)`));
    assert.equal(plan.warnings.length, 1);
    assert.match(plan.warnings[0]!, /inside a git work tree/);
  });

  it("a home that is $HOME, or inside a work tree, STILL denies hooks/**, bin/** and markers/** (narrow subdirectories)", () => {
    const e = makeEnv("home-is-home");
    const atHome = withEnv("HOME", e.aegisHome, () =>
      withEnv("REPO_AEGIS_MARKERS_DIR", undefined, () =>
        withEnv("REPO_AEGIS_REGISTRY", undefined, () => withEnv("REPO_AEGIS_HOME", e.aegisHome, () => registryDenyPlan())),
      ),
    );
    for (const sub of ["hooks", "bin", "markers"]) {
      assert.ok(atHome.rules.includes(`Edit(/${e.aegisHome}/${sub}/**)`), `${sub}/** must be denied`);
    }
    // And it is never the BROAD rule over the home itself.
    assert.ok(atHome.rules.every(r => r !== `Edit(/${e.aegisHome}/**)`));

    const g = makeEnv("home-in-git");
    mkdirSync(join(g.aegisHome, ".git"), { recursive: true });
    const inGit = inEnv(g, () => registryDenyPlan());
    for (const sub of ["hooks", "bin", "markers"]) {
      assert.ok(inGit.rules.includes(`Edit(/${g.aegisHome}/${sub}/**)`), `${sub}/** must be denied in a work tree`);
    }
    assert.ok(inGit.rules.some(r => r.endsWith("engagements.yaml)")), "the files are still denied");
  });
});

describe("install claude-md — registry deny rules", () => {
  it("adds only Edit rules, keeps the user's own, and is idempotent", () => {
    const e = makeEnv("install");
    writeFileSync(
      e.settingsPath,
      JSON.stringify({ permissions: { deny: ["Read(//secrets/**)"], allow: ["Bash(ls)"] }, model: "x" }),
    );
    install(e);
    const first = readSettings(e);
    const rules = inEnv(e, () => registryDenyRules());
    assert.deepEqual(first.permissions?.deny, ["Read(//secrets/**)", ...rules]);
    assert.ok(first.permissions!.deny!.every(r => !r.startsWith("Write(")));
    assert.deepEqual(first.permissions?.allow, ["Bash(ls)"]);
    assert.equal(first["model"], "x");

    install(e);
    assert.deepEqual(readSettings(e).permissions?.deny, first.permissions?.deny, "re-running must not duplicate");
  });

  it("prints that Edit rules reach the sandbox, and a sandboxed `touch` to verify it; no denyWrite instruction", () => {
    const e = makeEnv("advice");
    const out = install(e);
    assert.match(out.stdout, /merges Edit deny rules into the sandbox/);
    assert.match(out.stdout, /touch .*engagements\.yaml/);
    assert.doesNotMatch(out.stdout, /denyWrite/);
    assert.match(out.stdout, /state\/ .* deliberately not denied/);
    assert.equal((readSettings(e) as { sandbox?: unknown }).sandbox, undefined, "sandbox settings are never edited");
  });

  it("--dry-run shows the rules and writes neither settings nor ledger", () => {
    const e = makeEnv("dry");
    const out = install(e, { dryRun: true });
    assert.match(out.stdout, /Edit\(\/\//);
    assert.equal(existsSync(e.settingsPath), false);
    assert.equal(existsSync(join(e.aegisHome, LEDGER)), false);
  });

  it("--json reports the rules, warnings and how to verify", () => {
    const e = makeEnv("json");
    const out = install(e, { json: true });
    const parsed = JSON.parse(out.stdout) as {
      registryDeny: { rules: string[]; added: string[]; warnings: string[]; verifyWith: string };
    };
    assert.equal(parsed.registryDeny.added.length, parsed.registryDeny.rules.length);
    assert.match(parsed.registryDeny.verifyWith, /^touch .*engagements\.yaml$/);
  });

  it("--uninstall removes exactly the rules install added, and drops empty stubs", () => {
    const e = makeEnv("uninstall");
    writeFileSync(e.settingsPath, JSON.stringify({ permissions: { deny: ["Read(//secrets/**)"] } }));
    install(e);
    assert.ok(existsSync(join(e.aegisHome, LEDGER)), "install records what it added");
    install(e, { uninstall: true });
    assert.deepEqual(readSettings(e).permissions?.deny, ["Read(//secrets/**)"]);
    assert.equal(existsSync(join(e.aegisHome, LEDGER)), false, "the record goes with the rules");

    const f = makeEnv("uninstall-clean");
    install(f);
    install(f, { uninstall: true });
    assert.equal(readSettings(f).permissions, undefined);
  });

  it("never removes a rule the user already had before install (even one install would also write)", () => {
    const e = makeEnv("user-had-it");
    const mine = inEnv(e, () => registryDenyRules())[0]!;
    writeFileSync(e.settingsPath, JSON.stringify({ permissions: { deny: [mine, "Read(//secrets/**)"] } }));
    const out = install(e, { json: true });
    const parsed = JSON.parse(out.stdout) as { registryDeny: { added: string[]; alreadyPresent: string[] } };
    assert.deepEqual(parsed.registryDeny.alreadyPresent, [mine]);
    assert.ok(!parsed.registryDeny.added.includes(mine));
    install(e, { uninstall: true });
    assert.deepEqual(readSettings(e).permissions?.deny, [mine, "Read(//secrets/**)"], "the user's own rule survives uninstall");
  });

  it("the markers rule is recorded and uninstall removes it; an install that predates it gains it on re-run", () => {
    const e = makeEnv("markers-ledger");
    const markersRule = `Edit(/${e.aegisHome}/markers/**)`;
    install(e);
    assert.ok(readSettings(e).permissions!.deny!.includes(markersRule));
    assert.ok((JSON.parse(readFileSync(join(e.aegisHome, LEDGER), "utf8")) as { settings: Record<string, string[]> })
      .settings[e.settingsPath]!.includes(markersRule));
    install(e, { uninstall: true });
    assert.equal(readSettings(e).permissions, undefined);

    // An install from before the markers rule existed: ledger and settings hold the other four.
    const f = makeEnv("markers-upgrade");
    const old = inEnv(f, () => registryDenyRules()).filter(r => !r.includes("/markers/"));
    writeFileSync(f.settingsPath, JSON.stringify({ permissions: { deny: ["Read(//secrets/**)", ...old] } }));
    mkdirSync(join(f.aegisHome, "state"), { recursive: true });
    writeFileSync(join(f.aegisHome, LEDGER), JSON.stringify({ version: 1, settings: { [f.settingsPath]: old } }));
    const out = install(f, { json: true });
    const parsed = JSON.parse(out.stdout) as { registryDeny: { added: string[]; alreadyPresent: string[] } };
    assert.deepEqual(parsed.registryDeny.added, [`Edit(/${f.aegisHome}/markers/**)`]);
    assert.equal(parsed.registryDeny.alreadyPresent.length, old.length);
    install(f, { uninstall: true });
    assert.deepEqual(readSettings(f).permissions?.deny, ["Read(//secrets/**)"], "all five go, the user's rule stays");
  });

  it("the destination-cache rule is recorded and removed by uninstall like the others", () => {
    const e = makeEnv("dest-cache");
    const rule = `Edit(/${e.aegisHome}/destinations.json)`;
    install(e);
    assert.ok(readSettings(e).permissions!.deny!.includes(rule));
    install(e, { uninstall: true });
    assert.equal(readSettings(e).permissions, undefined);
  });

  it("a second install keeps remembering what the first added", () => {
    const e = makeEnv("twice");
    install(e);
    install(e);
    install(e, { uninstall: true });
    assert.equal(readSettings(e).permissions, undefined);
  });

  it("upgrade: an earlier build's whole-directory Edit AND Write pair is replaced, not kept", () => {
    const e = makeEnv("legacy");
    const old = [`Edit(/${e.aegisHome}/**)`, `Write(/${e.aegisHome}/**)`, "Read(//secrets/**)"];
    writeFileSync(e.settingsPath, JSON.stringify({ permissions: { deny: old } }));
    const out = install(e, { json: true });
    const parsed = JSON.parse(out.stdout) as { registryDeny: { rules: string[] } };
    const deny = readSettings(e).permissions!.deny!;
    assert.ok(!deny.includes(old[0]!) && !deny.includes(old[1]!), "the broad rules must go");
    assert.ok(deny.includes("Read(//secrets/**)"));
    for (const r of parsed.registryDeny.rules) assert.ok(deny.includes(r));
  });

  it("a user's OWN rule over the registry directory is never removed on a first install (one of the pair alone is not ours)", () => {
    const e = makeEnv("legacy-single");
    const mine = `Edit(/${e.aegisHome}/**)`;
    writeFileSync(e.settingsPath, JSON.stringify({ permissions: { deny: [mine] } }));
    install(e);
    assert.ok(readSettings(e).permissions!.deny!.includes(mine), "install must not remove a lone user rule");
    install(e, { uninstall: true });
    assert.deepEqual(readSettings(e).permissions?.deny, [mine], "nor may uninstall");

    const f = makeEnv("legacy-single-write");
    const writeOnly = `Write(/${f.aegisHome}/**)`;
    writeFileSync(f.settingsPath, JSON.stringify({ permissions: { deny: [writeOnly] } }));
    install(f, { uninstall: true });
    assert.deepEqual(readSettings(f).permissions?.deny, [writeOnly]);
  });

  it("uninstall of an earlier build's install (no ledger) removes its Edit+Write pair and keeps the user's rules", () => {
    const e = makeEnv("legacy-uninstall");
    const old = [`Edit(/${e.aegisHome}/**)`, `Write(/${e.aegisHome}/**)`];
    writeFileSync(e.settingsPath, JSON.stringify({ permissions: { deny: [...old, "Read(//secrets/**)"] } }));
    const out = install(e, { uninstall: true });
    assert.match(out.stdout, /removed 2 registry permissions\.deny rule/);
    assert.deepEqual(readSettings(e).permissions?.deny, ["Read(//secrets/**)"]);
  });

  it("a forged or corrupted ledger cannot make uninstall delete rules that are not ours", () => {
    const e = makeEnv("forged-ledger");
    const mine = [
      "Read(//secrets/**)",
      "Edit(//home/me/.ssh/**)",
      "Edit(//home/me/work/hooks/**)", // right basename, wrong place: not under the repo-aegis home
      `Edit(/${e.aegisHome}/state/audit.log)`, // under the home, but not one of the files install protects
      "Bash(rm -rf /)",
    ];
    const ours = inEnv(e, () => registryDenyRules());
    writeFileSync(e.settingsPath, JSON.stringify({ permissions: { deny: [...mine, ...ours] } }));
    mkdirSync(join(e.aegisHome, "state"), { recursive: true });
    writeFileSync(join(e.aegisHome, LEDGER), JSON.stringify({ version: 1, settings: { [e.settingsPath]: [...mine, ...ours] } }));
    install(e, { uninstall: true });
    assert.deepEqual(readSettings(e).permissions?.deny, mine, "only rules shaped like ours go; every user rule stays");
  });
});

describe("denyRuleCoversPath", () => {
  const file = "/home/u/.config/repo-aegis/engagements.yaml";
  it("accepts the exact file, a directory glob above it, ~ paths, and a bare Edit", () => {
    assert.equal(denyRuleCoversPath("Edit(//home/u/.config/repo-aegis/engagements.yaml)", file), true);
    assert.equal(denyRuleCoversPath("Edit(//home/u/.config/repo-aegis/**)", file), true);
    assert.equal(denyRuleCoversPath("Edit(//home/u/.config/**)", file), true);
    assert.equal(denyRuleCoversPath("Edit(//home/u/.config/repo-aegis/*)", file), true);
    assert.equal(denyRuleCoversPath("Edit(~/.config/repo-aegis/engagements.yaml)", file, "/home/u"), true);
    assert.equal(denyRuleCoversPath("Edit", file), true);
  });
  it("rejects other files, Write and Read rules, relative patterns, look-alike prefixes and non-strings", () => {
    assert.equal(denyRuleCoversPath("Edit(//home/u/.config/repo-aegis/engagements.yaml.age)", file), false);
    assert.equal(denyRuleCoversPath("Edit(//home/u/.config/repo-aeg/**)", file), false);
    assert.equal(denyRuleCoversPath("Write(//home/u/.config/repo-aegis/**)", file), false, "Write(path) is never matched by Claude Code");
    assert.equal(denyRuleCoversPath("Write", file), false);
    assert.equal(denyRuleCoversPath("Read(//home/u/.config/repo-aegis/**)", file), false);
    assert.equal(denyRuleCoversPath("Edit(./.config/repo-aegis/**)", file), false);
    assert.equal(denyRuleCoversPath("Edit(/.config/repo-aegis/**)", file), false);
    assert.equal(denyRuleCoversPath(42, file), false);
  });
  it("a state/ file is not covered by what install writes", () => {
    const e = makeEnv("state-writable");
    const rules = inEnv(e, () => registryDenyRules());
    const audit = join(e.aegisHome, "state", "audit.log");
    assert.equal(rules.some(r => denyRuleCoversPath(r, audit)), false);
    assert.equal(rules.some(r => denyRuleCoversPath(r, join(e.aegisHome, "state", "deny-set.cache.json"))), true);
    assert.equal(rules.some(r => denyRuleCoversPath(r, join(e.aegisHome, "destinations.json"))), true);
    assert.equal(rules.some(r => denyRuleCoversPath(r, join(e.aegisHome, "state", "leak-context-mode"))), false);
    assert.equal(rules.some(r => denyRuleCoversPath(r, join(e.aegisHome, "hooks", "pre-push"))), true);
    assert.equal(rules.some(r => denyRuleCoversPath(r, join(e.aegisHome, "markers", "customer-a.txt"))), true);
  });
});

describe("checkRegistryAgentWritable", () => {
  it("warns (never fails) with no settings.json, an empty one, or a settings.json that covers only some paths", () => {
    const e = makeEnv("check-warn");
    const none = inEnv(e, () => checkRegistryAgentWritable(e.claudeHome));
    assert.equal(none.ok, false);
    assert.equal(none.severity, "warn");
    assert.match(none.fix ?? "", /install claude-md/);
    assert.match(none.fix ?? "", /touch /);
    assert.doesNotMatch(none.fix ?? "", /denyWrite/);

    const registryOnly = `Edit(/${e.aegisHome}/engagements.yaml)`;
    writeFileSync(e.settingsPath, JSON.stringify({ permissions: { deny: [registryOnly] } }));
    assert.equal(inEnv(e, () => checkRegistryAgentWritable(e.claudeHome)).ok, false, "the registry alone is not enough");

    writeFileSync(e.settingsPath, "{ not json");
    const bad = inEnv(e, () => checkRegistryAgentWritable(e.claudeHome));
    assert.equal(bad.ok, false);
    assert.equal(bad.severity, "warn");
  });

  it("an install that predates the markers rule is flagged until re-run", () => {
    const e = makeEnv("check-no-markers");
    const old = inEnv(e, () => registryDenyRules()).filter(r => !r.includes("/markers/"));
    writeFileSync(e.settingsPath, JSON.stringify({ permissions: { deny: old } }));
    assert.equal(inEnv(e, () => checkRegistryAgentWritable(e.claudeHome)).ok, false);
    install(e);
    assert.equal(inEnv(e, () => checkRegistryAgentWritable(e.claudeHome)).ok, true);
  });

  it("a Write-only deny does not satisfy it (Claude Code never matches Write(path))", () => {
    const e = makeEnv("check-write-only");
    writeFileSync(e.settingsPath, JSON.stringify({ permissions: { deny: [`Write(/${e.aegisHome}/**)`] } }));
    assert.equal(inEnv(e, () => checkRegistryAgentWritable(e.claudeHome)).ok, false);
  });

  it("is clean once `install claude-md` has run, and warns again after `--uninstall`", () => {
    const e = makeEnv("check-roundtrip");
    install(e);
    assert.equal(inEnv(e, () => checkRegistryAgentWritable(e.claudeHome)).ok, true);
    install(e, { uninstall: true });
    assert.equal(inEnv(e, () => checkRegistryAgentWritable(e.claudeHome)).ok, false);
  });
});
