// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Issue #151, PR 2a — the parser's new facts (GH_REPO, positional targets,
// attached flags, aliases, unresolved) reach the destination the policy
// judges. Real git config in a temp checkout whose origin is registered
// (`acme/svc`); the commands name a stranger. Before this change each of them
// resolved to `acme/svc`.
import { afterEach, before, after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEgressIntents, type ParseEgressOptions } from "./egress-intent.js";
import { decideEgress, resolveDestinationOffline } from "./egress-policy.js";
import { egressParseOptions, ghConfigDir, loadGhAliases } from "./gh-env.js";
import type { Registry } from "./registry.js";

const REGISTRY = {
  engagements: [],
  alwaysBlock: [],
  personalOrgs: ["acme"],
  schemaVersion: 2,
} as unknown as Registry;

describe("resolveDestinationOffline — what the parser now sees", () => {
  let root: string;
  let repo: string;
  let priorHome: string | undefined;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "egress-intent-resolve-"));
    repo = join(root, "svc");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/svc.git"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["config", "repo-aegis.class", "private-strict"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["config", "repo-aegis.visibility", "private"], { cwd: repo, stdio: "ignore" });
    priorHome = process.env["REPO_AEGIS_HOME"];
    process.env["REPO_AEGIS_HOME"] = join(root, "home");
  });

  after(() => {
    if (priorHome === undefined) delete process.env["REPO_AEGIS_HOME"];
    else process.env["REPO_AEGIS_HOME"] = priorHome;
    rmSync(root, { recursive: true, force: true });
  });

  function resolve(command: string, opts?: ParseEgressOptions) {
    const intent = parseEgressIntents(command, opts)[0];
    assert.ok(intent, `no intent for ${command}`);
    return resolveDestinationOffline(intent, repo, REGISTRY);
  }

  it("the registered checkout is the baseline: an implicit target is acme/svc", () => {
    const d = resolve("gh issue create --body x");
    assert.equal(`${d?.org}/${d?.repo}`, "acme/svc");
    assert.equal(d?.unresolved, undefined);
  });

  it("each named bypass resolves to the stranger, not the checkout", () => {
    const commands = [
      "gh issue create -Rstranger/r --body x", // F1 attached short flag
      "gh issue create -R=stranger/r --body x",
      "gh issue create --repo=stranger/r --body x",
      "gh issue --repo stranger/r create --body x", // cobra: flag between group and verb
      "GH_REPO=stranger/r gh issue create --body x", // S2
      "env GH_REPO=stranger/r gh issue create --body x",
      "gh pr comment https://github.com/stranger/r/pull/5 --body x", // S3
      "gh issue comment https://github.com/stranger/r/issues/5 -b x",
      "gh repo edit stranger/r --visibility public",
      "gh repo sync stranger/r",
      "gh issue transfer 5 stranger/r",
      "gh api -XPOST repos/stranger/r/issues -fbody=hi", // F1: was no intent at all
      "gh api -X POST repos/stranger/r/issues -f body=hi",
      "gh api -X POST 'repos/stranger/r/issues?ref={branch}' -f title=x -f body=x", // placeholder in the query
      "gh api -X PATCH 'repos/stranger/r/git/refs/heads/{branch}' -f sha=abc", // placeholder in the path tail
      "gh api -X POST 'repos/stranger/r/issues?x={owner}'",
    ];
    for (const c of commands) {
      const d = resolve(c);
      assert.equal(`${d?.org}/${d?.repo}`, "stranger/r", c);
      assert.equal(d?.unresolved, undefined, c);
    }
  });

  it("the legitimate {owner}/{repo} placeholder form still resolves to the checkout", () => {
    const d = resolve("gh api -X POST 'repos/{owner}/{repo}/issues?ref={branch}' -f title=x");
    assert.equal(`${d?.org}/${d?.repo}`, "acme/svc");
    assert.equal(d?.unresolved, undefined);
  });

  it("an org-level target resolves to the org", () => {
    const d = resolve("gh secret set TOKEN --org stranger");
    assert.equal(d?.org, "stranger");
    assert.equal(d?.repo, "*");
  });

  it("the caller's GH_REPO (the shim's environment) applies, and --repo still beats it", () => {
    const opts = { envRepo: "stranger/r" };
    assert.equal(resolve("gh issue create --body x", opts)?.org, "stranger");
    assert.equal(resolve("gh issue create --repo acme/svc --body x", opts)?.org, "acme");
  });

  it("an alias to a write verb resolves like the verb", () => {
    const d = resolve("gh ic -Rstranger/r --body x", { ghAliases: new Map([["ic", "issue create"]]) });
    assert.equal(d?.org, "stranger");
  });

  it("an unresolvable target is an unresolved destination, never the checkout", () => {
    const cases: Array<[string, string, ParseEgressOptions?]> = [
      ["export GH_REPO=stranger/r && gh issue create --body x", "env-override"],
      ['gh issue create --repo "$REPO" --body x', "opaque-repo"],
      ["gh pr merge 5 -R svc", "opaque-repo"],
      ["gh sh", "gh-alias", { ghAliases: new Map([["sh", "!gh issue create"]]) }],
      ["gh run delete 5", "unknown-shape"],
      ["gh api -X POST 'repos/{branch}/r/issues' -f title=x", "opaque-repo"],
      ["gh issue transfer 5 stranger/r --repo acme/svc", "ambiguous-target"],
      ["gh pr comment https://github.com/stranger/r/pull/5 --repo acme/svc -b x", "ambiguous-target"],
    ];
    for (const [c, reason, opts] of cases) {
      const d = resolve(c, opts);
      assert.equal(d?.unresolved, reason, c);
      assert.equal(d?.org, "*", c);
      assert.equal(d?.publicFacing, true, c);
    }
  });

  it("the same repository named three ways is one target, not an ambiguity", () => {
    const d = resolve("GH_REPO=acme/svc gh pr comment https://github.com/ACME/svc/pull/5 --repo acme/svc -b x");
    assert.equal(d?.unresolved, undefined);
    assert.equal(`${d?.org}/${d?.repo}`, "acme/svc");
  });

  it("git push and npm publish are untouched by GH_REPO", () => {
    const d = resolve("git push origin main", { envRepo: "stranger/r" });
    assert.equal(`${d?.org}/${d?.repo}`, "acme/svc");
    assert.equal(resolve("npm publish", { envRepo: "stranger/r" }), null);
  });

  it("decideEgress judges the stranger, not the registered checkout (shell: no person, no ask)", () => {
    const stranger = decideEgress({
      intents: parseEgressIntents("gh issue create -Rstranger/r --body x"),
      cwd: repo,
      registry: REGISTRY,
      registryState: "loaded",
      humanPresent: false,
      capabilities: { ask: false },
      scanPayload: () => 0,
      findApproval: () => null,
      lookupVisibility: () => null,
    });
    assert.equal(stranger.action, "deny");
    assert.equal(stranger.action === "deny" && stranger.destination?.org, "stranger");

    // The unresolved ones are refused too, naming no repository.
    const unresolved = decideEgress({
      intents: parseEgressIntents("export GH_REPO=stranger/r && gh issue create --body x"),
      cwd: repo,
      registry: REGISTRY,
      registryState: "loaded",
      humanPresent: false,
      capabilities: { ask: false },
      scanPayload: () => 0,
      findApproval: () => null,
    });
    assert.equal(unresolved.action, "deny");
    assert.equal(unresolved.action === "deny" && unresolved.destination?.unresolved, "env-override");
  });
});

describe("gh-env — GH_REPO and the gh alias file", () => {
  let root: string;
  const made: string[] = [];

  function configDir(files: Record<string, string>): string {
    root ??= mkdtempSync(join(tmpdir(), "gh-env-"));
    const dir = mkdtempSync(join(root, "cfg-"));
    made.push(dir);
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    return dir;
  }

  afterEach(() => {
    made.length = 0;
  });

  after(() => {
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  });

  it("reads aliases from $GH_CONFIG_DIR/config.yml", () => {
    const dir = configDir({ "config.yml": "git_protocol: ssh\naliases:\n    ic: issue create\n    sh: '!echo hi'\n" });
    const aliases = loadGhAliases({ GH_CONFIG_DIR: dir }, "/nonexistent");
    assert.equal(aliases.get("ic"), "issue create");
    assert.equal(aliases.get("sh"), "!echo hi");
    assert.equal(aliases.size, 2);
  });

  it("config directory precedence: GH_CONFIG_DIR, then XDG_CONFIG_HOME/gh, then ~/.config/gh", () => {
    assert.equal(ghConfigDir({ GH_CONFIG_DIR: "/a", XDG_CONFIG_HOME: "/b" }, "/h"), "/a");
    assert.equal(ghConfigDir({ XDG_CONFIG_HOME: "/b" }, "/h"), join("/b", "gh"));
    assert.equal(ghConfigDir({}, "/h"), join("/h", ".config", "gh"));
    assert.equal(ghConfigDir({ GH_CONFIG_DIR: "" }, "/h"), join("/h", ".config", "gh"));
  });

  it("the legacy aliases.yml is read, and config.yml wins over it", () => {
    const dir = configDir({
      "aliases.yml": "ic: old\nonly-legacy: issue close\n",
      "config.yml": "aliases:\n  ic: issue create\n",
    });
    const aliases = loadGhAliases({ GH_CONFIG_DIR: dir }, "/nonexistent");
    assert.equal(aliases.get("ic"), "issue create");
    assert.equal(aliases.get("only-legacy"), "issue close");
  });

  it("a missing, broken or non-map file contributes nothing and never throws", () => {
    assert.equal(loadGhAliases({ GH_CONFIG_DIR: join(tmpdir(), "does-not-exist-gh") }, "/x").size, 0);
    for (const text of [": : :\n  - [", "just a string", "- a\n- b\n", "aliases: [1, 2]\n", "aliases:\n  n: 5\n"]) {
      const dir = configDir({ "config.yml": text });
      assert.doesNotThrow(() => loadGhAliases({ GH_CONFIG_DIR: dir }, "/x"), text);
      assert.equal(loadGhAliases({ GH_CONFIG_DIR: dir }, "/x").size, 0, text);
    }
  });

  it("(H1) a config that cannot be read means aliases are unknown: a non-built-in word is unresolved, never 'no aliases'", () => {
    const bomb =
      "a: &a [x, x, x, x, x, x, x, x, x, x]\n" +
      Array.from({ length: 200 }, (_, k) => `k${k}: *a`).join("\n") +
      "\naliases:\n  ic: issue create\n";
    const oversize = "aliases:\n  ic: issue create\n# " + "x".repeat(1024 * 1024 + 10) + "\n";
    for (const [name, text] of [
      ["oversize", oversize],
      ["unparseable", "aliases: [\n  ic: : issue create\n"],
      ["yaml alias bomb", bomb],
    ] as const) {
      const dir = configDir({ "config.yml": text });
      const opts = egressParseOptions({ GH_CONFIG_DIR: dir });
      const i = parseEgressIntents("gh ic -Rstranger/r --body x", opts)[0];
      assert.equal(i?.verb, "gh-unknown", name);
      assert.equal(i?.unresolved, "gh-alias", name);
      // Built-in commands never needed the file.
      assert.equal(parseEgressIntents("gh issue create -Rstranger/r --body x", opts)[0]?.verb, "gh-issue-create", name);
    }
    // Control: the same alias in a readable config resolves.
    const ok = configDir({ "config.yml": "aliases:\n  ic: issue create\n" });
    assert.equal(parseEgressIntents("gh ic -Rstranger/r --body x", egressParseOptions({ GH_CONFIG_DIR: ok }))[0]?.verb, "gh-issue-create");
  });

  it("egressParseOptions: GH_REPO from the environment, aliases from its config dir, loaded lazily", () => {
    const dir = configDir({ "config.yml": "aliases:\n  ic: issue create\n" });
    const opts = egressParseOptions({ GH_REPO: "stranger/r", GH_CONFIG_DIR: dir });
    assert.equal(opts.envRepo, "stranger/r");
    const i = parseEgressIntents("gh ic --body x", opts)[0];
    assert.equal(i?.verb, "gh-issue-create");
    assert.equal(i?.envRepo, "stranger/r");
    assert.equal("envRepo" in egressParseOptions({}), false);
    assert.equal("envRepo" in egressParseOptions({ GH_REPO: "" }), false);
  });
});
