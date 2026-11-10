// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Registry v3 identity mutators (doc/plan-owner-identity.md §5.1, §12.1 A3, A16): the TTY gate, the writes,
// the schemaVersion rule, and the round trip of identities through every other registry mutator.
// Placeholders only: alice, example-org, example-bot, customer-a.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addMarkerPatterns, addTopLevelPatterns, loadRegistry, managedHookCommand, pinnedHookCommand, renderHookScript, type Registry } from "@de-otio/repo-aegis-core";
import { captureOutput, captureOutputAsync, withEnv, withEnvAsync } from "../_test-utils.js";
import { init } from "./init.js";
import { makeFakeSystem } from "../_managed-test-utils.js";
import { managedPaths } from "./managed-dropin.js";
import { engagementsAdd, engagementsEnd, engagementsRemove } from "./engagements-mutate.js";
import { upstreamsAdd, upstreamsRemove } from "./upstreams.js";
import { engagementsSetIdentity, identityAdd, identityRemove, identityRequire } from "./identity.js";
import { summariseIdentities, identityLines, ENGAGEMENT_ONLY_LOGIN } from "./status.js";
import { ownerIdentityChecks } from "./doctor-owner-checks.js";

const V3 = `\
# my registry (comment must survive a round trip)
schemaVersion: 3
identities:
  me: { kind: gh-login, login: alice }
  me-bot: { kind: github-app, app: example-bot }
  work: { kind: gh-login, login: alice-work }
  work-bot: { kind: github-app, app: example-work-agent }
requireIdentity: true
personalOrgs:
  - plain-org # keep me
  - { name: mapped-org, person: me, agent: me-bot }
allowedUpstreams:
  - upstream-org/lib
engagements:
  - id: customer-a
    name: Customer A
    started: 2026-01-01
    markers:
      - customer-a-marker
    githubOrgs:
      - customer-a-org
    person: work
    agent: work-bot
  - id: customer-b
    name: Customer B
    started: 2026-01-01
    markers:
      - customer-b-marker
    githubOrgs:
      - customer-b-org
`;

const V2 = `\
# v2 registry
schemaVersion: 2
personalOrgs:
  - plain-org # keep me
engagements:
  - id: customer-a
    name: Customer A
    started: 2026-01-01
    markers:
      - customer-a-marker
    githubOrgs:
      - customer-a-org
`;

let tmp: string;
/** A Claude Code home with no settings.json: the guard must never read the real `~/.claude`. */
let NO_CLAUDE: string;
before(() => {
  NO_CLAUDE = join(tmpdir(), "repo-aegis-identity-no-claude-home");
  tmp = mkdtempSync(join(tmpdir(), "repo-aegis-identity-"));
});
after(() => rmSync(tmp, { recursive: true, force: true }));

interface Env {
  home: string;
  registryPath: string;
}
let counter = 0;
function setup(registry: string): Env {
  const home = join(tmp, `h${counter++}`);
  mkdirSync(join(home, "markers"), { recursive: true });
  mkdirSync(join(home, "state"), { recursive: true });
  const registryPath = join(home, "engagements.yaml");
  writeFileSync(registryPath, registry);
  return { home, registryPath };
}

/** Under a temp home, with both env escapes set (neither may lift a gate). */
function inHome<T>(env: Env, fn: () => T): T {
  return withEnv("REPO_AEGIS_HOME", env.home, () =>
    withEnv("REPO_AEGIS_EGRESS_HUMAN", "1", () => withEnv("REPO_AEGIS_WAIVE_NONINTERACTIVE", "1", fn)),
  );
}

const read = (env: Env): string => readFileSync(env.registryPath, "utf8");
const load = (env: Env): Registry => loadRegistry(env.registryPath);

/** Everything identity-related in a parsed registry, as plain data. */
function mappings(reg: Registry): unknown {
  return {
    identities: [...(reg.identities ?? new Map())].sort(),
    identityMap: [...(reg.identityMap ?? new Map())].sort(),
    requireIdentity: reg.requireIdentity,
    // Only engagements that carry an identity: a mutator may add or end others.
    engagementIds: reg.engagements.filter(e => e.person !== undefined || e.agent !== undefined).map(e => [e.id, e.person, e.agent]),
  };
}

function run(env: Env, fn: () => void) {
  return inHome(env, () => captureOutput(fn));
}

describe("the TTY gate (same path as `engagements add --personal-org`)", () => {
  const COMMANDS: ReadonlyArray<readonly [label: string, fn: (env: Env) => void, refused: string]> = [
    ["identity add", env => identityAdd("new-id", { ghLogin: "alice", registryPath: env.registryPath, stderrIsTTY: false }), "identity add new-id"],
    ["identity remove", env => identityRemove("work", { registryPath: env.registryPath, stderrIsTTY: false }), "identity remove work"],
    ["identity require --off", env => identityRequire({ off: true, registryPath: env.registryPath, stderrIsTTY: false }), "identity require --off"],
    [
      "engagements set-identity (engagement)",
      env => engagementsSetIdentity("customer-b", { person: "work", registryPath: env.registryPath, stderrIsTTY: false }),
      "engagements set-identity customer-b",
    ],
    [
      "engagements set-identity --personal-org",
      env => engagementsSetIdentity(undefined, { personalOrg: "plain-org", agent: "me-bot", registryPath: env.registryPath, stderrIsTTY: false }),
      "engagements set-identity --personal-org plain-org",
    ],
  ];
  for (const [label, fn, refused] of COMMANDS) {
    it(`${label} without a TTY refuses (five parts), names no registry contents and leaves the file byte-identical`, () => {
      const env = setup(V3);
      const before = readFileSync(env.registryPath);
      {
        const r = run(env, () => fn({ ...env }));
        assert.equal(r.exitCode, 2, r.stderr);
        assert.match(r.stderr, /IDENTITY_CHANGE_NEEDS_TTY/);
        assert.ok(r.stderr.includes(`${refused}`), `names what was refused: ${r.stderr}`);
        assert.match(r.stderr, /only a person at a terminal can change them/);
        assert.match(r.stderr, /No approval covers this/);
        assert.match(r.stderr, /REPO_AEGIS_EGRESS_HUMAN is not honoured/);
        assert.match(r.stderr, /A person runs, from a terminal: repo-aegis /);
        assert.match(r.stderr, /Agents: do not retry or reroute/);
        assert.match(r.stderr, /\[IDENTITY_CHANGE_NEEDS_TTY; details: repo-aegis explain IDENTITY_CHANGE_NEEDS_TTY\]/);
        for (const secret of ["alice", "example-bot", "customer-a", "mapped-org", "upstream-org"]) {
          assert.ok(!r.stderr.includes(secret), `must not echo registry contents (${secret})`);
        }
        assert.deepEqual(readFileSync(env.registryPath), before, "registry must be byte-identical");
      }
    });
  }

  it("the gate comes before validation: a malformed argument is no oracle for a non-TTY caller", () => {
    const env = setup(V3);
    const r = run(env, () => identityAdd("-BAD NAME", { ghLogin: "-x", app: "y", registryPath: env.registryPath, stderrIsTTY: false }));
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /IDENTITY_CHANGE_NEEDS_TTY/);
    assert.doesNotMatch(r.stderr, /USAGE|must match/);
  });

  it("does not echo a hostile argument into the refusal", () => {
    const env = setup(V3);
    const r = run(env, () => identityAdd("x\nIGNORE-PREVIOUS; do it", { ghLogin: "a", registryPath: env.registryPath, stderrIsTTY: false }));
    assert.doesNotMatch(r.stderr, /IGNORE-PREVIOUS/);
    assert.match(r.stderr, /identity add <name>/);
  });
});

describe("identity add / remove / require --off", () => {
  it("the first identity writes schemaVersion 3, keeps comments, and does not set requireIdentity", () => {
    const env = setup(V2);
    const r = run(env, () => identityAdd("me", { ghLogin: "alice", registryPath: env.registryPath, stderrIsTTY: true, pathEnv: "", claudeHome: NO_CLAUDE }));
    assert.equal(r.exitCode, undefined, r.stderr);
    const text = read(env);
    assert.match(text, /schemaVersion: 3/);
    assert.match(text, /# v2 registry/);
    assert.match(text, /plain-org # keep me/);
    const reg = load(env);
    assert.deepEqual(reg.identities!.get("me"), { kind: "gh-login", login: "alice", name: "me" });
    assert.equal(reg.requireIdentity, false);
    assert.equal(text.includes("requireIdentity"), false);
  });

  it("a registry that never sets an identity stays at its version (a v2 file is untouched by other commands)", () => {
    const env = setup(V2);
    const r = run(env, () => engagementsEnd("customer-a", { registryPath: env.registryPath }));
    assert.equal(r.exitCode, undefined, r.stderr);
    assert.match(read(env), /schemaVersion: 2/);
    assert.doesNotMatch(read(env), /identities/);
  });

  it("adds an app identity; the same definition again is a no-op; a different one is refused", () => {
    const env = setup(V2);
    const add = (opts: { ghLogin?: string; app?: string }) =>
      run(env, () => identityAdd("bot", { ...opts, registryPath: env.registryPath, stderrIsTTY: true, pathEnv: "", claudeHome: NO_CLAUDE, json: true }));
    assert.equal(add({ app: "example-bot" }).exitCode, undefined);
    const once = read(env);
    const again = add({ app: "example-bot" });
    assert.equal(again.exitCode, undefined);
    assert.equal(JSON.parse(again.stdout).added, false);
    assert.equal(read(env), once);
    const clash = add({ ghLogin: "alice" });
    assert.equal(clash.exitCode, 2);
    assert.match(clash.stderr, /IDENTITY_EXISTS/);
    assert.equal(read(env), once);
  });

  it("rejects bad shapes and wrong flag combinations, writing nothing", () => {
    const env = setup(V2);
    const before = read(env);
    const attempts: ReadonlyArray<readonly [string, { ghLogin?: string; app?: string }]> = [
      ["me", {}],
      ["me", { ghLogin: "alice", app: "example-bot" }],
      ["me", { ghLogin: "-alice" }],
      ["me", { ghLogin: "a".repeat(40) }],
      ["me", { app: "-bot" }],
      ["me", { app: "a".repeat(64) }],
      ["-me", { ghLogin: "alice" }],
      ["a".repeat(64), { ghLogin: "alice" }],
    ];
    for (const [name, opts] of attempts) {
      const r = run(env, () => identityAdd(name, { ...opts, registryPath: env.registryPath, stderrIsTTY: true, pathEnv: "", claudeHome: NO_CLAUDE, json: true }));
      assert.equal(r.exitCode, 2, JSON.stringify([name, opts]));
      assert.equal(JSON.parse(r.stderr).code, "USAGE");
      assert.equal(read(env), before);
    }
  });

  it("remove is refused while a personal org or an engagement references the identity", () => {
    const env = setup(V3);
    const before = read(env);
    for (const name of ["me", "me-bot", "work", "work-bot"]) {
      const r = run(env, () => identityRemove(name, { registryPath: env.registryPath, stderrIsTTY: true, pathEnv: "", claudeHome: NO_CLAUDE, json: true }));
      assert.equal(r.exitCode, 2, name);
      assert.equal(JSON.parse(r.stderr).code, "IDENTITY_IN_USE");
      assert.equal(read(env), before);
    }
  });

  it("remove deletes an unreferenced identity and keeps the file at version 3; an unknown name is IDENTITY_NOT_FOUND", () => {
    const env = setup(V2);
    run(env, () => identityAdd("spare", { ghLogin: "alice", registryPath: env.registryPath, stderrIsTTY: true, pathEnv: "", claudeHome: NO_CLAUDE }));
    const r = run(env, () => identityRemove("spare", { registryPath: env.registryPath, stderrIsTTY: true, pathEnv: "", claudeHome: NO_CLAUDE }));
    assert.equal(r.exitCode, undefined, r.stderr);
    assert.equal(load(env).identities!.size, 0);
    assert.match(read(env), /schemaVersion: 3/);
    const gone = run(env, () => identityRemove("spare", { registryPath: env.registryPath, stderrIsTTY: true, pathEnv: "", claudeHome: NO_CLAUDE, json: true }));
    assert.equal(JSON.parse(gone.stderr).code, "IDENTITY_NOT_FOUND");
  });

  it("require --off clears requireIdentity (and needs --off); set-identity afterwards does not turn it back on", () => {
    const env = setup(V3);
    const bare = run(env, () => identityRequire({ registryPath: env.registryPath, stderrIsTTY: true, pathEnv: "", claudeHome: NO_CLAUDE, json: true }));
    assert.equal(bare.exitCode, 2);
    assert.equal(load(env).requireIdentity, true);
    const off = run(env, () => identityRequire({ off: true, registryPath: env.registryPath, stderrIsTTY: true, pathEnv: "", claudeHome: NO_CLAUDE }));
    assert.equal(off.exitCode, undefined, off.stderr);
    assert.equal(load(env).requireIdentity, false);
    assert.match(read(env), /requireIdentity: false/);
    const set = run(env, () =>
      engagementsSetIdentity("customer-b", { person: "work", registryPath: env.registryPath, stderrIsTTY: true, pathEnv: "", claudeHome: NO_CLAUDE }),
    );
    assert.equal(set.exitCode, undefined, set.stderr);
    assert.equal(load(env).requireIdentity, false, "a person's --off is not undone");
  });

  it("require --off on a registry that never set it changes nothing (no version bump)", () => {
    const env = setup(V2);
    const before = read(env);
    const r = run(env, () => identityRequire({ off: true, registryPath: env.registryPath, stderrIsTTY: true, pathEnv: "", claudeHome: NO_CLAUDE }));
    assert.equal(r.exitCode, undefined, r.stderr);
    assert.equal(read(env), before);
  });
});

describe("engagements set-identity", () => {
  const set = (env: Env, id: string | undefined, opts: object) =>
    run(env, () =>
      engagementsSetIdentity(id, { registryPath: env.registryPath, stderrIsTTY: true, json: true, pathEnv: "", claudeHome: NO_CLAUDE, ...opts }),
    );

  it("the first set-identity bumps to v3, sets requireIdentity, maps every org of the engagement", () => {
    const env = setup(V2);
    run(env, () => identityAdd("work", { ghLogin: "alice-work", registryPath: env.registryPath, stderrIsTTY: true, pathEnv: "", claudeHome: NO_CLAUDE }));
    run(env, () => identityAdd("work-bot", { app: "example-work-agent", registryPath: env.registryPath, stderrIsTTY: true, pathEnv: "", claudeHome: NO_CLAUDE }));
    assert.equal(load(env).requireIdentity, false);
    const r = set(env, "customer-a", { person: "work", agent: "work-bot" });
    assert.equal(r.exitCode, undefined, r.stderr);
    assert.equal(JSON.parse(r.stdout).requireIdentitySet, true);
    const reg = load(env);
    assert.equal(reg.requireIdentity, true);
    assert.equal(reg.schemaVersion, 3);
    assert.equal(reg.identityMap!.get("customer-a-org")!.person!.name, "work");
    assert.equal(reg.identityMap!.get("customer-a-org")!.agent!.name, "work-bot");
    assert.match(read(env), /plain-org # keep me/);
  });

  it("--person leaves the agent column alone, and the reverse", () => {
    const env = setup(V3);
    set(env, "customer-b", { person: "work" });
    set(env, "customer-b", { agent: "work-bot" });
    const m = load(env).identityMap!.get("customer-b-org")!;
    assert.equal(m.person!.name, "work");
    assert.equal(m.agent!.name, "work-bot");
    set(env, "customer-b", { person: "me" });
    const m2 = load(env).identityMap!.get("customer-b-org")!;
    assert.equal(m2.person!.name, "me");
    assert.equal(m2.agent!.name, "work-bot");
  });

  it("refuses an agent that is a gh-login, a person that is an app, and an undefined name, writing nothing", () => {
    const env = setup(V3);
    const before = read(env);
    for (const [opts, code] of [
      [{ agent: "me" }, "IDENTITY_KIND_MISMATCH"],
      [{ person: "me-bot" }, "IDENTITY_KIND_MISMATCH"],
      [{ person: "nobody" }, "IDENTITY_NOT_FOUND"],
      [{ agent: "nobody" }, "IDENTITY_NOT_FOUND"],
    ] as const) {
      const r = set(env, "customer-b", opts);
      assert.equal(r.exitCode, 2);
      assert.equal(JSON.parse(r.stderr).code, code);
      assert.equal(read(env), before);
    }
  });

  it("usage errors: nothing to set, --clear with a column, no target, both targets, unknown engagement", () => {
    const env = setup(V3);
    const before = read(env);
    const cases: ReadonlyArray<readonly [string | undefined, object, string]> = [
      ["customer-b", {}, "USAGE"],
      ["customer-b", { clear: true, person: "me" }, "USAGE"],
      [undefined, { person: "me" }, "USAGE"],
      ["customer-b", { personalOrg: "plain-org", person: "me" }, "USAGE"],
      ["no-such-engagement", { person: "me" }, "ENGAGEMENT_NOT_FOUND"],
      [undefined, { personalOrg: "not-registered", person: "me" }, "PERSONAL_ORG_NOT_FOUND"],
    ];
    for (const [id, opts, code] of cases) {
      const r = set(env, id, opts);
      assert.equal(r.exitCode, 2, JSON.stringify([id, opts]));
      assert.equal(JSON.parse(r.stderr).code, code, r.stderr);
      assert.equal(read(env), before);
    }
  });

  it("--clear removes both columns; clearing an unmapped engagement is a no-op", () => {
    const env = setup(V3);
    const r = set(env, "customer-a", { clear: true });
    assert.equal(r.exitCode, undefined, r.stderr);
    assert.equal(load(env).identityMap!.has("customer-a-org"), false);
    const text = read(env);
    const again = set(env, "customer-a", { clear: true });
    assert.equal(JSON.parse(again.stdout).changed, false);
    assert.equal(read(env), text);
    assert.equal(load(env).identityMap!.get("mapped-org")!.person!.name, "me", "other mappings untouched");
  });

  it("--agent none clears only the agent column; --person none clears only the person column", () => {
    const env = setup(V3);
    const a = set(env, "customer-a", { agent: "none" });
    assert.equal(a.exitCode, undefined, a.stderr);
    assert.equal(JSON.parse(a.stdout).changed, true);
    const m = load(env).identityMap!.get("customer-a-org")!;
    assert.equal(m.person!.name, "work");
    assert.equal(m.agent, undefined);
    assert.doesNotMatch(read(env), /agent: work-bot/);

    const env2 = setup(V3);
    const p = set(env2, "customer-a", { person: "none" });
    assert.equal(p.exitCode, undefined, p.stderr);
    const m2 = load(env2).identityMap!.get("customer-a-org")!;
    assert.equal(m2.person, undefined);
    assert.equal(m2.agent!.name, "work-bot");
    // other owners are untouched
    assert.equal(load(env2).identityMap!.get("mapped-org")!.person!.name, "me");
  });

  it("`none` is case-insensitive and can be combined with a set on the other column (move an owner from App to person)", () => {
    const env = setup(V3);
    const r = set(env, "customer-a", { person: "me", agent: "NONE" });
    assert.equal(r.exitCode, undefined, r.stderr);
    const m = load(env).identityMap!.get("customer-a-org")!;
    assert.equal(m.person!.name, "me");
    assert.equal(m.agent, undefined);
  });

  it("both none is the same as --clear (the entry ends with no identity at all)", () => {
    const env = setup(V3);
    const r = set(env, "customer-a", { person: "none", agent: "none" });
    assert.equal(r.exitCode, undefined, r.stderr);
    assert.equal(JSON.parse(r.stdout).changed, true);
    assert.equal(load(env).identityMap!.has("customer-a-org"), false);
    const env2 = setup(V3);
    set(env2, "customer-a", { clear: true });
    assert.equal(read(env), read(env2));
  });

  it("`none` clears a personal org column; clearing the last one returns the entry to a plain string", () => {
    const env = setup(V3);
    set(env, undefined, { personalOrg: "mapped-org", agent: "none" });
    const m = load(env).identityMap!.get("mapped-org")!;
    assert.equal(m.person!.name, "me");
    assert.equal(m.agent, undefined);
    set(env, undefined, { personalOrg: "mapped-org", person: "none" });
    assert.equal(load(env).identityMap!.has("mapped-org"), false);
    assert.deepEqual(load(env).personalOrgs, ["plain-org", "mapped-org"]);
  });

  it("--agent none on an entry with no agent column is unchanged, writes nothing, and says how to clear", () => {
    const env = setup(V3);
    const before = read(env);
    const r = set(env, "customer-b", { agent: "none" });
    assert.equal(r.exitCode, undefined, r.stderr);
    assert.equal(JSON.parse(r.stdout).changed, false);
    assert.equal(read(env), before);
    // a plain-string personal org has no columns either
    const plain = set(env, undefined, { personalOrg: "plain-org", person: "none" });
    assert.equal(JSON.parse(plain.stdout).changed, false);
    assert.equal(read(env), before);
    // none on a v2 file with nothing mapped does not raise the schema version
    const v2 = setup(V2);
    const v2before = read(v2);
    set(v2, "customer-a", { agent: "none" });
    assert.equal(read(v2), v2before);
  });

  it("the text message for an unchanged result names `--agent none`, `--person none` and `--clear`", () => {
    const env = setup(V3);
    const r = set(env, "customer-a", { person: "work", json: false });
    assert.equal(r.exitCode, undefined, r.stderr);
    assert.match(r.stdout, /customer-a: identities unchanged/);
    assert.match(r.stdout, /--agent none/);
    assert.match(r.stdout, /--person none/);
    assert.match(r.stdout, /--clear/);
    // a successful change does not carry the hint
    const changed = set(env, "customer-a", { person: "me", json: false });
    assert.match(changed.stdout, /identities set/);
    assert.doesNotMatch(changed.stdout, /--clear/);
  });

  it("`none` is never an identity name: identity add refuses it, so a mapping can never be shadowed", () => {
    const env = setup(V2);
    const before = read(env);
    const r = run(env, () => identityAdd("none", { ghLogin: "alice", registryPath: env.registryPath, stderrIsTTY: true, pathEnv: "", claudeHome: NO_CLAUDE, json: true }));
    assert.equal(r.exitCode, 2);
    assert.equal(JSON.parse(r.stderr).code, "USAGE");
    assert.match(r.stderr, /reserved/);
    assert.equal(read(env), before);
  });

  it("`none` clearing needs the same terminal as every set-identity call", () => {
    const env = setup(V3);
    const before = read(env);
    const r = run(env, () => engagementsSetIdentity("customer-a", { agent: "none", registryPath: env.registryPath, stderrIsTTY: false }));
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /IDENTITY_CHANGE_NEEDS_TTY/);
    assert.equal(read(env), before);
  });

  it("a personal org: a plain entry becomes an object (comment kept), and clearing returns it to a plain string", () => {
    const env = setup(V3);
    set(env, undefined, { personalOrg: "plain-org", person: "me", agent: "me-bot" });
    let text = read(env);
    assert.match(text, /\{ name: plain-org, person: me, agent: me-bot \}.*# keep me/);
    assert.equal(load(env).identityMap!.get("plain-org")!.agent!.name, "me-bot");
    assert.deepEqual(load(env).personalOrgs, ["plain-org", "mapped-org"]);
    set(env, undefined, { personalOrg: "plain-org", clear: true });
    text = read(env);
    assert.match(text, /- plain-org # keep me/);
    assert.equal(load(env).identityMap!.has("plain-org"), false);
    // an object entry keeps its other column when one is changed
    set(env, undefined, { personalOrg: "mapped-org", agent: "me-bot" });
    assert.equal(load(env).identityMap!.get("mapped-org")!.person!.name, "me");
  });

  it("set-identity never registers an owner: an unregistered personal org is refused", () => {
    const env = setup(V3);
    const r = set(env, undefined, { personalOrg: "brand-new-org", person: "me" });
    assert.equal(JSON.parse(r.stderr).code, "PERSONAL_ORG_NOT_FOUND");
    assert.deepEqual(load(env).personalOrgs, ["plain-org", "mapped-org"]);
  });
});

describe("raising the schema version is refused while an install cannot read it (MULTIPLE_INSTALLS)", () => {
  /** A fake install: a `repo-aegis` file, optionally a package.json and the core package it loads. */
  function fakeInstall(dirName: string, opts: { version?: string | null; max?: number | null }): string {
    const dir = join(tmp, dirName);
    mkdirSync(dir, { recursive: true });
    const exe = join(dir, "repo-aegis");
    writeFileSync(exe, "#!/bin/sh\nexit 0\n");
    chmodSync(exe, 0o755);
    if (opts.version !== null && opts.version !== undefined) {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@de-otio/repo-aegis", version: opts.version }));
    }
    if (opts.max !== null && opts.max !== undefined) {
      const core = join(dir, "node_modules", "@de-otio", "repo-aegis-core", "dist");
      mkdirSync(core, { recursive: true });
      writeFileSync(join(core, "registry.js"), `export const MAX_SUPPORTED_REGISTRY_SCHEMA_VERSION = ${opts.max};\n`);
    }
    return dir;
  }
  /** Pin the hooks and shim of `env`'s home to the CLI of a fake install. */
  function pinHooksTo(env: Env, installDir: string): void {
    const cli = join(installDir, "index.js");
    writeFileSync(cli, "// stub\n");
    mkdirSync(join(env.home, "hooks"), { recursive: true });
    writeFileSync(join(env.home, "hooks", "pre-push"), renderHookScript("pre-push", { node: process.execPath, cli }), { mode: 0o755 });
  }
  const add = (env: Env, pathEnv: string, extra: object = {}) =>
    run(env, () =>
      identityAdd("me", { ghLogin: "alice", registryPath: env.registryPath, stderrIsTTY: true, json: true, pathEnv, claudeHome: NO_CLAUDE, runningVersion: "0.13.0", ...extra }),
    );
  const setId = (env: Env, pathEnv: string, opts: object = { person: "work" }) =>
    run(env, () =>
      engagementsSetIdentity("customer-b", { registryPath: env.registryPath, stderrIsTTY: true, json: true, pathEnv, claudeHome: NO_CLAUDE, runningVersion: "0.13.0", ...opts }),
    );
  const code = (r: { stderr: string }): string => (JSON.parse(r.stderr) as { code: string }).code;

  it("identity add on a v2 file: an install on PATH that reads only version 2 refuses, and the file is byte-identical", () => {
    const env = setup(V2);
    const before = read(env);
    const r = add(env, fakeInstall("old-path", { version: "0.11.4", max: 2 }));
    assert.equal(r.exitCode, 2);
    assert.equal(code(r), "MULTIPLE_INSTALLS");
    assert.match(r.stderr, /fails OPEN/);
    assert.equal(read(env), before);
  });

  it("identity add on a v2 file: only the PINNED hook is old (nothing old on PATH): refuses", () => {
    const env = setup(V2);
    const before = read(env);
    pinHooksTo(env, fakeInstall("old-pin", { version: "0.11.4", max: 2 }));
    const r = add(env, "");
    assert.equal(code(r), "MULTIPLE_INSTALLS");
    assert.match(r.stderr, /pinned hook or shim/);
    assert.equal(read(env), before);
  });

  it("the same call goes through once the pinned install can read 3 (judged by what it reads, not its version)", () => {
    const env = setup(V2);
    pinHooksTo(env, fakeInstall("new-pin", { version: "0.11.4", max: 3 }));
    const r = add(env, fakeInstall("new-path", { version: "0.1.0", max: 3 }));
    assert.equal(r.exitCode, undefined, r.stderr);
    assert.match(read(env), /schemaVersion: 3/);
  });

  it("when the supported version cannot be read, the package version decides: older refuses, same or newer passes", () => {
    for (const [name, version, ok] of [["fb-old", "0.9.0", false], ["fb-same", "0.13.0", true], ["fb-new", "0.14.0", true]] as const) {
      const env = setup(V2);
      const r = add(env, fakeInstall(name, { version }));
      assert.equal(r.exitCode === undefined, ok, `${version}: ${r.stderr}`);
    }
  });

  it("an install with neither a readable supported version nor a package version refuses", () => {
    const env = setup(V2);
    assert.equal(code(add(env, fakeInstall("opaque", {}))), "MULTIPLE_INSTALLS");
  });

  it("set-identity on a file that is already v3 raises nothing, so it is not guarded", () => {
    const env = setup(V3);
    const before = read(env);
    // Already v3: an old install on PATH cannot read it either way, so no NEW harm: not refused here.
    const r = setId(env, fakeInstall("old-but-already-v3", { version: "0.1.0", max: 2 }));
    assert.equal(r.exitCode, undefined, r.stderr);
    assert.notEqual(read(env), before);
  });

  it("identity add: the CLI pinned by Claude Code's settings.json (the one that runs check-write) is old: refuses", () => {
    const env = setup(V2);
    const before = read(env);
    const cli = join(fakeInstall("old-claude-settings", { version: "0.11.4", max: 2 }), "index.js");
    writeFileSync(cli, "// stub\n");
    const claudeHome = join(tmp, "claude-with-old-pin");
    mkdirSync(claudeHome, { recursive: true });
    const command = pinnedHookCommand({ node: process.execPath, cli }, "hook check-write");
    writeFileSync(
      join(claudeHome, "settings.json"),
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Write|Edit|MultiEdit", hooks: [{ type: "command", command }] }] } }),
    );
    const r = add(env, "", { claudeHome });
    assert.equal(code(r), "MULTIPLE_INSTALLS");
    assert.match(r.stderr, /pinned Claude Code hook/);
    assert.equal(read(env), before);
  });

  it("identity add: the CLI pinned by the managed drop-in is old: refuses; a pin that can read 3 passes", () => {
    for (const [name, max, refused] of [["drop-old", 2, true], ["drop-new", 3, false]] as const) {
      const env = setup(V2);
      const before = read(env);
      const sys = makeFakeSystem({ platform: "linux", uid: 1000 });
      const paths = managedPaths("linux", 1000)!;
      const cli = join(fakeInstall(name, { version: "0.11.4", max }), "index.js");
      writeFileSync(cli, "// stub\n");
      const command = managedHookCommand({ node: process.execPath, cli }, "hook check-write", { uid: "1000", dropinPath: paths.file });
      mkdirSync(sys.at(paths.dropinDir), { recursive: true });
      writeFileSync(
        sys.at(paths.file),
        JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Write|Edit|MultiEdit", hooks: [{ type: "command", command }] }] } }),
      );
      const r = add(env, "", { managedEnv: sys.env });
      if (refused) {
        assert.equal(code(r), "MULTIPLE_INSTALLS");
        assert.match(r.stderr, /pinned Claude Code hook/);
        assert.equal(read(env), before);
      } else {
        assert.equal(r.exitCode, undefined, r.stderr);
      }
    }
  });

  it("--clear is never guarded (it only removes mappings)", () => {
    const env = setup(V3);
    const r = setId(env, fakeInstall("old3", { version: "0.1.0", max: 2 }), { clear: true });
    assert.equal(r.exitCode, undefined, r.stderr);
  });
});

describe("every other mutator round-trips identities and object entries (A3)", () => {
  // The CLI mutators write through yaml's comment-preserving document, so a mapping can only be lost by a
  // mutator that rebuilds a list. Each one below must leave every mapping exactly as it was.
  const run1 = (env: Env, fn: () => void) => {
    const r = run(env, fn);
    assert.equal(r.exitCode, undefined, r.stderr);
  };
  const same = (env: Env, fn: () => void): void => {
    const before = mappings(load(env));
    run1(env, fn);
    assert.deepEqual(mappings(load(env)), before);
    assert.match(read(env), /schemaVersion: 3/);
    assert.match(read(env), /\{ name: mapped-org, person: me, agent: me-bot \}/);
    assert.match(read(env), /plain-org # keep me/);
  };

  it("engagements add (a new engagement with its own githubOrgs)", () => {
    const env = setup(V3);
    same(env, () =>
      engagementsAdd("customer-c", { githubOrg: ["customer-c-org"], marker: ["customer-c-marker"], registryPath: env.registryPath, stderrIsTTY: true }),
    );
    assert.equal(load(env).identityMap!.has("customer-c-org"), false, "a new owner starts unmapped");
  });

  it("engagements add --personal-org adds an unmapped entry and leaves the object entries alone", () => {
    const env = setup(V3);
    same(env, () => engagementsAdd(undefined, { personalOrg: ["another-org"], registryPath: env.registryPath, stderrIsTTY: true }));
    assert.deepEqual(load(env).personalOrgs, ["plain-org", "mapped-org", "another-org"]);
  });

  it("engagements add --personal-org for an org that is already an object entry adds no duplicate", () => {
    const env = setup(V3);
    same(env, () => engagementsAdd(undefined, { personalOrg: ["mapped-org"], registryPath: env.registryPath, stderrIsTTY: true }));
    assert.deepEqual(load(env).personalOrgs, ["plain-org", "mapped-org"]);
  });

  it("engagements end", () => {
    const env = setup(V3);
    same(env, () => engagementsEnd("customer-b", { registryPath: env.registryPath }));
  });

  it("engagements remove --hard (of an unmapped engagement) leaves the others' mappings", () => {
    const env = setup(V3);
    const before = mappings(load(env)) as { engagementIds: unknown[] };
    run1(env, () => engagementsRemove("customer-b", { registryPath: env.registryPath, hard: true }));
    const after = mappings(load(env)) as { engagementIds: unknown[] };
    assert.deepEqual({ ...after, engagementIds: [] }, { ...before, engagementIds: [] });
    assert.deepEqual(after.engagementIds, [["customer-a", "work", "work-bot"]]);
  });

  it("engagements remove --hard of the mapped engagement drops only its own mapping", () => {
    const env = setup(V3);
    run1(env, () => engagementsRemove("customer-a", { registryPath: env.registryPath, hard: true }));
    const reg = load(env);
    assert.equal(reg.identityMap!.has("customer-a-org"), false);
    assert.equal(reg.identityMap!.get("mapped-org")!.agent!.name, "me-bot");
    assert.equal(reg.identities!.size, 4, "identities themselves stay defined");
  });

  it("upstreams add and upstreams remove", () => {
    const env = setup(V3);
    same(env, () => upstreamsAdd("other-upstream/lib", { registryPath: env.registryPath, stderrIsTTY: true }));
    same(env, () => upstreamsRemove("other-upstream/lib", { registryPath: env.registryPath }));
  });

  it("object entries count as owners: removing the last engagement owner without a terminal is allowed while one object entry remains", () => {
    // Before the fix, an object entry was invisible to the owner-set gate, so this registry looked owner-less
    // after the removal and the change was refused (and, the other way round, the last owner could vanish unnoticed).
    const only = `schemaVersion: 3
identities:
  me: { kind: gh-login, login: alice }
personalOrgs:
  - { name: mapped-org, person: me }
engagements:
  - id: customer-a
    name: Customer A
    markers: [m]
    githubOrgs: [customer-a-org]
`;
    const env = setup(only);
    const r = run(env, () => engagementsRemove("customer-a", { registryPath: env.registryPath, hard: true, stderrIsTTY: false }));
    assert.equal(r.exitCode, undefined, r.stderr);
    assert.deepEqual(load(env).personalOrgs, ["mapped-org"]);
  });

  it("the owner-set gate still fires when the only remaining owners are removed", () => {
    const only = `schemaVersion: 3
identities:
  me: { kind: gh-login, login: alice }
engagements:
  - id: customer-a
    name: Customer A
    markers: [m]
    githubOrgs: [customer-a-org]
    person: me
`;
    const env = setup(only);
    const r = run(env, () => engagementsRemove("customer-a", { registryPath: env.registryPath, hard: true, stderrIsTTY: false }));
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /OWNER_SET_EMPTY_NEEDS_TTY/);
  });
});

describe("status and doctor see identities", () => {
  it("summariseIdentities lists names, kinds, logins and slugs; engagements by id, never by org", () => {
    const sum = summariseIdentities(loadRegistry(setup(V3).registryPath));
    assert.deepEqual(sum.identities.map(i => i.name).sort(), ["me", "me-bot", "work", "work-bot"]);
    assert.deepEqual(sum.identities.find(i => i.name === "me"), { name: "me", kind: "gh-login", login: "alice" });
    assert.deepEqual(sum.identities.find(i => i.name === "me-bot"), { name: "me-bot", kind: "github-app", app: "example-bot" });
    assert.equal(sum.requireIdentity, true);
    assert.deepEqual(sum.mappings, [
      { target: "mapped-org", kind: "personal-org", person: "me", agent: "me-bot" },
      { target: "customer-a", kind: "engagement", person: "work", agent: "work-bot" },
    ]);
    assert.ok(!JSON.stringify(sum).includes("customer-a-org"), "an engagement's org names stay out of status");
  });

  it("OWNER_IDENTITY_UNMAPPED: one finding for all unmapped owners, a failure when requireIdentity is set; owners only in names (--json)", () => {
    const warn = ownerIdentityChecks(loadRegistry(setup(V3.replace("requireIdentity: true\n", "")).registryPath));
    assert.equal(warn.length, 1, "one finding, not one identical line per owner");
    const w = warn[0]!;
    assert.deepEqual(w.names, ["customer-b-org", "plain-org"]);
    assert.equal(w.code, "OWNER_IDENTITY_UNMAPPED");
    assert.equal(w.ok, false);
    assert.equal(w.severity, "warn");
    assert.match(w.detail, /^2 registered owner\(s\) have no identity entry/);
    for (const owner of w.names!) {
      assert.ok(!w.detail.includes(owner), "detail must not name an owner");
      assert.ok(!w.fix!.includes(owner), "fix must not name an owner: text output lands in transcripts");
    }
    const fail = ownerIdentityChecks(loadRegistry(setup(V3).registryPath));
    assert.equal(fail.length, 1);
    assert.match(fail[0]!.detail, /^2 registered owner\(s\) are still unmapped/);
    assert.equal(fail[0]!.severity, undefined, "no severity means fail");
  });

  it("a fully mapped registry has no findings; a registry that defines no identity (v2) has none either (P3-C)", () => {
    const mapped = V3.replace("plain-org # keep me", "{ name: plain-org, person: me }").replace(
      "    githubOrgs:\n      - customer-b-org\n",
      "    githubOrgs:\n      - customer-b-org\n    person: work\n",
    );
    assert.deepEqual(ownerIdentityChecks(loadRegistry(setup(mapped).registryPath)), []);
    // "Unmapped" is every owner when no identity exists at all, and says nothing: the person has not opted in.
    assert.deepEqual(ownerIdentityChecks(loadRegistry(setup(V2).registryPath)), []);
  });
});

describe("identity require --on (only tightens: no terminal, agent-runnable)", () => {
  it("sets requireIdentity on a v3 file without a terminal", () => {
    const env = setup(V3.replace("requireIdentity: true\n", "requireIdentity: false\n"));
    const r = run(env, () => identityRequire({ on: true, registryPath: env.registryPath, stderrIsTTY: false, json: true }));
    assert.equal(r.exitCode, undefined, r.stderr);
    assert.equal(load(env).requireIdentity, true);
    const again = run(env, () => identityRequire({ on: true, registryPath: env.registryPath, stderrIsTTY: false, json: true }));
    assert.equal(JSON.parse(again.stdout).changed, false);
  });

  it("refuses on a registry below version 3 (nothing to require) and writes nothing", () => {
    const env = setup(V2);
    const before = read(env);
    const r = run(env, () => identityRequire({ on: true, registryPath: env.registryPath, stderrIsTTY: false, json: true }));
    assert.equal(JSON.parse(r.stderr).code, "NOTHING_TO_REQUIRE");
    assert.equal(read(env), before);
  });

  it("--on and --off together is a usage error; --off still needs the terminal", () => {
    const env = setup(V3);
    const both = run(env, () => identityRequire({ on: true, off: true, registryPath: env.registryPath, stderrIsTTY: true, json: true }));
    assert.equal(JSON.parse(both.stderr).code, "USAGE");
    const off = run(env, () => identityRequire({ off: true, registryPath: env.registryPath, stderrIsTTY: false, json: true }));
    assert.equal(JSON.parse(off.stderr).code, "IDENTITY_CHANGE_NEEDS_TTY");
  });
});

describe("set-identity maps nothing for an engagement without githubOrgs (L3)", () => {
  const NO_ORGS = V3.replace("    githubOrgs:\n      - customer-b-org\n", "");
  it("is refused (and nothing is written); --clear is still allowed", () => {
    const env = setup(NO_ORGS);
    const before = read(env);
    const r = run(env, () =>
      engagementsSetIdentity("customer-b", { person: "work", registryPath: env.registryPath, stderrIsTTY: true, json: true, pathEnv: "", claudeHome: NO_CLAUDE }),
    );
    assert.equal(JSON.parse(r.stderr).code, "ENGAGEMENT_HAS_NO_ORGS");
    assert.equal(read(env), before);
    const clear = run(env, () =>
      engagementsSetIdentity("customer-b", { clear: true, registryPath: env.registryPath, stderrIsTTY: true, json: true, pathEnv: "", claudeHome: NO_CLAUDE }),
    );
    assert.equal(clear.exitCode, undefined, clear.stderr);
  });
});

describe("more A3 round trips: marker helpers and init --migrate-classify (L2)", () => {
  const same = (env: Env, fn: () => void): void => {
    const before = mappings(load(env));
    fn();
    assert.deepEqual(mappings(load(env)), before);
    assert.match(read(env), /schemaVersion: 3/);
    assert.match(read(env), /\{ name: mapped-org, person: me, agent: me-bot \}/);
    assert.match(read(env), /plain-org # keep me/);
  };

  it("addMarkerPatterns (a new marker on a mapped engagement)", () => {
    const env = setup(V3);
    same(env, () => {
      inHome(env, () => addMarkerPatterns("customer-a", ["another-marker"], { registryPath: env.registryPath }));
    });
    assert.ok(load(env).engagements[0]!.markers.includes("another-marker"));
  });

  it("addTopLevelPatterns (always_block, privateInfra, selfIdentity)", () => {
    const env = setup(V3);
    same(env, () => {
      for (const field of ["always_block", "privateInfra", "selfIdentity"] as const) {
        inHome(env, () => addTopLevelPatterns(field, ["some-pattern-here"], { registryPath: env.registryPath }));
      }
    });
  });

  it("init --migrate-classify adds the new owner and leaves every mapping alone", async () => {
    const env = setup(V3);
    writeFileSync(join(env.home, "classify.yml"), `rules:\n  - match: "github\\\\.com[:/]new-handle/"\n    class: public-eligible\n`);
    const before = mappings(load(env));
    await withEnvAsync("REPO_AEGIS_HOME", env.home, () =>
      captureOutputAsync(() =>
        init({ withHooks: false, withClaude: false, migrateClassify: true, stderrIsTTY: true, stdinIsTTY: true, readAnswer: () => "y" }),
      ),
    );
    assert.deepEqual(mappings(load(env)), before);
    assert.deepEqual(load(env).personalOrgs, ["plain-org", "mapped-org", "new-handle"]);
    assert.match(read(env), /\{ name: mapped-org, person: me, agent: me-bot \}/);
  });
});

describe("init --force counts identities as content (L1)", () => {
  for (const [label, text] of [
    ["identities only", "schemaVersion: 3\nidentities:\n  me: { kind: gh-login, login: alice }\nengagements: []\n"],
    ["requireIdentity only", "schemaVersion: 3\nrequireIdentity: false\nengagements: []\n"],
  ] as const) {
    it(`${label}: refused without a terminal and byte-identical`, async () => {
      const env = setup(text);
      const before = readFileSync(env.registryPath);
      const r = await withEnvAsync("REPO_AEGIS_HOME", env.home, () =>
        captureOutputAsync(() => init({ force: true, withHooks: false, withClaude: false, stderrIsTTY: false, json: true })),
      );
      assert.equal(r.exitCode, 2, r.stderr);
      assert.match(r.stderr, /OWNER_SET_EMPTY_NEEDS_TTY/);
      assert.deepEqual(readFileSync(env.registryPath), before);
    });
  }
});

describe("Enterprise Managed User logins stay out of text output unless a personal org uses them", () => {
  const EMU = `schemaVersion: 3
identities:
  emu-eng: { kind: gh-login, login: emuhandle_zzcorp }
  emu-own: { kind: gh-login, login: ownhandle_yyshort }
  emu-idle: { kind: gh-login, login: idlehandle_xxidle }
  bot: { kind: github-app, app: example-bot }
personalOrgs:
  - { name: mine, person: emu-own, agent: bot }
engagements:
  - { id: customer-a, name: Customer A, markers: [m], githubOrgs: [customer-a-org], person: emu-eng, agent: bot }
`;
  const sum = () => summariseIdentities(loadRegistry(setup(EMU).registryPath));

  it("the EMU login is accepted by `identity add`", () => {
    const env = setup(V2);
    const r = run(env, () => identityAdd("emu", { ghLogin: "emuhandle_zzcorp", registryPath: env.registryPath, stderrIsTTY: true, pathEnv: "", claudeHome: NO_CLAUDE }));
    assert.equal(r.exitCode, undefined, r.stderr);
    assert.equal(load(env).identities!.get("emu")!.name, "emu");
  });

  it("text output contains no part of an engagement-only (or unreferenced) login", () => {
    const text = identityLines(sum()).join("\n");
    for (const part of ["emuhandle", "zzcorp", "idlehandle", "xxidle", "emuhandle_zzcorp"]) {
      assert.ok(!text.includes(part), `text must not contain ${part}: ${text}`);
    }
    assert.ok(text.includes(ENGAGEMENT_ONLY_LOGIN));
    assert.match(text, /emu-eng: gh-login <engagement-only login>/);
  });

  it("a login used by a personal org is still printed; app slugs are not logins", () => {
    const text = identityLines(sum()).join("\n");
    assert.match(text, /emu-own: gh-login ownhandle_yyshort/);
    assert.match(text, /bot: github-app example-bot/);
  });

  it("the JSON summary carries every login", () => {
    const logins = sum().identities.flatMap(i => (i.kind === "gh-login" ? [i.login] : []));
    assert.deepEqual(logins.sort(), ["emuhandle_zzcorp", "idlehandle_xxidle", "ownhandle_yyshort"]);
  });

  it("doctor text carries no login either (the finding names neither login nor owner)", () => {
    const checks = ownerIdentityChecks(loadRegistry(setup(EMU).registryPath));
    const text = JSON.stringify(checks.map(c => [c.detail, c.fix]));
    for (const part of ["emuhandle", "zzcorp", "ownhandle", "idlehandle"]) assert.ok(!text.includes(part), part);
  });
});
