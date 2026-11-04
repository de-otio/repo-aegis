// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `install claude-md` write protection for the code the enforcement pin points
// at (doc/plan-pin-enforcement-binary.md D4, T11): Edit deny rules for the
// pinned CLI's package directory and the pinned Node executable, in the same
// ledger and removed by the same `--uninstall` as the registry rules.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EnforcementPin } from "@de-otio/repo-aegis-core";
import { captureOutput, withEnv } from "../_test-utils.js";
import { checkRegistryAgentWritable, installClaudeMd, registryDenyPlan } from "./install-claude-md.js";

let tmp: string;
let n = 0;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "repo-aegis-pin-deny-"));
});
after(() => {
  rmSync(tmp, { recursive: true, force: true });
});

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

function inEnv<T>(e: Env, fn: () => T): T {
  return withEnv("REPO_AEGIS_MARKERS_DIR", undefined, () =>
    withEnv("REPO_AEGIS_REGISTRY", undefined, () => withEnv("REPO_AEGIS_HOME", e.aegisHome, fn)),
  );
}

/** A CLI package `<root>/<name>/node_modules/@de-otio/repo-aegis/dist/index.js` and a node file, outside any git tree. */
function makePin(name: string): { pin: EnforcementPin; pkgDir: string } {
  const root = join(tmp, `pin-${name}-${n++}`);
  const pkgDir = join(root, "lib", "node_modules", "@de-otio", "repo-aegis");
  mkdirSync(join(pkgDir, "dist"), { recursive: true });
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "@de-otio/repo-aegis", version: "0.0.0" }));
  const cli = join(pkgDir, "dist", "index.js");
  writeFileSync(cli, "// stub cli\n");
  mkdirSync(join(root, "bin"), { recursive: true });
  const node = join(root, "bin", "node");
  writeFileSync(node, "// stub node\n", { mode: 0o755 });
  return { pin: { node, cli }, pkgDir };
}

type Settings = { permissions?: { deny?: string[] } };
const readSettings = (e: Env): Settings => JSON.parse(readFileSync(e.settingsPath, "utf8")) as Settings;
const LEDGER = "state/claude-md-deny-rules.json";

function install(e: Env, opts: Record<string, unknown>): { stdout: string } {
  return inEnv(e, () => captureOutput(() => installClaudeMd({ claudeHome: e.claudeHome, userSettings: true, ...opts })));
}

describe("registryDenyPlan — the pinned code", () => {
  it("denies Edit on the pinned CLI's package directory and on the pinned Node executable", () => {
    const e = makeEnv("plan");
    const { pin, pkgDir } = makePin("plan");
    const plan = inEnv(e, () => registryDenyPlan(pin));
    assert.ok(plan.rules.includes(`Edit(/${pkgDir}/**)`), plan.rules.join("\n"));
    assert.ok(plan.rules.includes(`Edit(/${pin.node})`), plan.rules.join("\n"));
    assert.deepEqual(plan.warnings, []);
    // The registry rules are still there, and still the only others.
    assert.ok(plan.rules.includes(`Edit(/${e.aegisHome}/engagements.yaml)`));
    assert.ok(plan.rules.every(r => r.startsWith("Edit(")));
    // Sample targets cover both new rules (what `doctor` reads back).
    assert.ok(plan.sampleTargets.includes(pin.node));
    assert.ok(plan.sampleTargets.includes(join(pkgDir, "x")));
  });

  it("a package directory inside a git work tree is NOT denied (a dev checkout), with a warning; the node file still is", () => {
    const e = makeEnv("plan-dev");
    const repo = join(tmp, `dev-checkout-${n++}`);
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(repo, "packages", "cli", "dist"), { recursive: true });
    writeFileSync(join(repo, "packages", "cli", "package.json"), JSON.stringify({ name: "@de-otio/repo-aegis", version: "0.0.0" }));
    const cli = join(repo, "packages", "cli", "dist", "index.js");
    writeFileSync(cli, "// stub\n");
    const node = makePin("dev-node").pin.node;
    const plan = inEnv(e, () => registryDenyPlan({ node, cli }));
    assert.ok(plan.rules.every(r => !r.includes(`/${repo}/`)), "a work tree must not be locked");
    assert.ok(plan.rules.includes(`Edit(/${node})`));
    assert.match(plan.warnings.join("\n"), /pinned CLI.*git work tree/);
  });

  it("falls back to the CLI's grandparent directory when no package.json sits above it", () => {
    const e = makeEnv("plan-nopkg");
    const root = join(tmp, `nopkg-${n++}`);
    mkdirSync(join(root, "app", "dist"), { recursive: true });
    const cli = join(root, "app", "dist", "index.js");
    writeFileSync(cli, "// stub\n");
    const plan = inEnv(e, () => registryDenyPlan({ node: makePin("nopkg").pin.node, cli }));
    assert.ok(plan.rules.includes(`Edit(/${join(root, "app")}/**)`), plan.rules.join("\n"));
  });
});

describe("install claude-md — the pinned code", () => {
  it("T11: --dry-run lists the deny rules for the pinned package directory and Node executable", () => {
    const e = makeEnv("dry");
    const { pin, pkgDir } = makePin("dry");
    const out = install(e, { dryRun: true, pin });
    assert.ok(out.stdout.includes(`Edit(/${pkgDir}/**)`), out.stdout);
    assert.ok(out.stdout.includes(`Edit(/${pin.node})`), out.stdout);
    assert.equal(existsSync(e.settingsPath), false, "a dry run writes nothing");
    assert.equal(existsSync(join(e.aegisHome, LEDGER)), false);
  });

  it("T11: --dry-run --json carries them in registryDeny.rules", () => {
    const e = makeEnv("dry-json");
    const { pin, pkgDir } = makePin("dry-json");
    const out = install(e, { dryRun: true, json: true, pin });
    const parsed = JSON.parse(out.stdout) as { registryDeny: { rules: string[]; wouldAdd: string[] } };
    for (const rule of [`Edit(/${pkgDir}/**)`, `Edit(/${pin.node})`]) {
      assert.ok(parsed.registryDeny.rules.includes(rule), rule);
      assert.ok(parsed.registryDeny.wouldAdd.includes(rule), rule);
    }
  });

  it("writes them to settings.json and the ledger, and --uninstall removes exactly those, keeping the user's", () => {
    const e = makeEnv("roundtrip");
    const { pin, pkgDir } = makePin("roundtrip");
    writeFileSync(e.settingsPath, JSON.stringify({ permissions: { deny: ["Read(//secrets/**)"] } }));
    install(e, { pin });
    const deny = readSettings(e).permissions!.deny!;
    assert.ok(deny.includes(`Edit(/${pkgDir}/**)`) && deny.includes(`Edit(/${pin.node})`));
    const ledger = JSON.parse(readFileSync(join(e.aegisHome, LEDGER), "utf8")) as { settings: Record<string, string[]> };
    assert.ok(ledger.settings[e.settingsPath]!.includes(`Edit(/${pin.node})`));

    install(e, { uninstall: true, pin });
    assert.deepEqual(readSettings(e).permissions?.deny, ["Read(//secrets/**)"]);
  });

  it("uninstall after the pin changed (a Node upgrade) still removes the rules recorded for the old pin", () => {
    const e = makeEnv("repin");
    const oldPin = makePin("old");
    const newPin = makePin("new");
    install(e, { pin: oldPin.pin });
    assert.ok(readSettings(e).permissions!.deny!.includes(`Edit(/${oldPin.pin.node})`), "install did not add the old pin's rule");
    install(e, { uninstall: true, pin: newPin.pin });
    assert.equal(readSettings(e).permissions, undefined, "rules for the old pin were left behind");
  });

  it("a rule the user wrote for the node executable is never removed by uninstall", () => {
    const e = makeEnv("user-node");
    const { pin } = makePin("user-node");
    const mine = `Edit(/${pin.node})`;
    writeFileSync(e.settingsPath, JSON.stringify({ permissions: { deny: [mine] } }));
    install(e, { pin });
    install(e, { uninstall: true, pin });
    assert.deepEqual(readSettings(e).permissions?.deny, [mine]);
  });
});

describe("doctor: REGISTRY_AGENT_WRITABLE reads the pinned-code rules back", () => {
  it("warns when settings.json has the registry rules but not the pinned-code ones, clean after install", () => {
    const e = makeEnv("check");
    const { pin } = makePin("check");
    const plan = inEnv(e, () => registryDenyPlan(pin));
    const registryOnly = plan.rules.filter(r => !r.includes("/lib/node_modules/") && !r.endsWith("/bin/node)"));
    writeFileSync(e.settingsPath, JSON.stringify({ permissions: { deny: registryOnly } }));
    assert.equal(inEnv(e, () => checkRegistryAgentWritable(e.claudeHome, plan)).ok, false);

    install(e, { pin });
    assert.equal(inEnv(e, () => checkRegistryAgentWritable(e.claudeHome, plan)).ok, true);
  });
});
