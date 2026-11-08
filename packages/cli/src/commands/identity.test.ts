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
import { loadRegistry, type Registry } from "@de-otio/repo-aegis-core";
import { captureOutput, withEnv } from "../_test-utils.js";
import { engagementsAdd, engagementsEnd, engagementsRemove } from "./engagements-mutate.js";
import { upstreamsAdd, upstreamsRemove } from "./upstreams.js";
import { engagementsSetIdentity, identityAdd, identityRemove, identityRequire } from "./identity.js";
import { summariseIdentities } from "./status.js";
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
before(() => {
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
        assert.match(r.stderr, /doc\/agent-guide\.md#IDENTITY_CHANGE_NEEDS_TTY/);
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
    const r = run(env, () => identityAdd("me", { ghLogin: "alice", registryPath: env.registryPath, stderrIsTTY: true }));
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
      run(env, () => identityAdd("bot", { ...opts, registryPath: env.registryPath, stderrIsTTY: true, json: true }));
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
      const r = run(env, () => identityAdd(name, { ...opts, registryPath: env.registryPath, stderrIsTTY: true, json: true }));
      assert.equal(r.exitCode, 2, JSON.stringify([name, opts]));
      assert.equal(JSON.parse(r.stderr).code, "USAGE");
      assert.equal(read(env), before);
    }
  });

  it("remove is refused while a personal org or an engagement references the identity", () => {
    const env = setup(V3);
    const before = read(env);
    for (const name of ["me", "me-bot", "work", "work-bot"]) {
      const r = run(env, () => identityRemove(name, { registryPath: env.registryPath, stderrIsTTY: true, json: true }));
      assert.equal(r.exitCode, 2, name);
      assert.equal(JSON.parse(r.stderr).code, "IDENTITY_IN_USE");
      assert.equal(read(env), before);
    }
  });

  it("remove deletes an unreferenced identity and keeps the file at version 3; an unknown name is IDENTITY_NOT_FOUND", () => {
    const env = setup(V2);
    run(env, () => identityAdd("spare", { ghLogin: "alice", registryPath: env.registryPath, stderrIsTTY: true }));
    const r = run(env, () => identityRemove("spare", { registryPath: env.registryPath, stderrIsTTY: true }));
    assert.equal(r.exitCode, undefined, r.stderr);
    assert.equal(load(env).identities!.size, 0);
    assert.match(read(env), /schemaVersion: 3/);
    const gone = run(env, () => identityRemove("spare", { registryPath: env.registryPath, stderrIsTTY: true, json: true }));
    assert.equal(JSON.parse(gone.stderr).code, "IDENTITY_NOT_FOUND");
  });

  it("require --off clears requireIdentity (and needs --off); set-identity afterwards does not turn it back on", () => {
    const env = setup(V3);
    const bare = run(env, () => identityRequire({ registryPath: env.registryPath, stderrIsTTY: true, json: true }));
    assert.equal(bare.exitCode, 2);
    assert.equal(load(env).requireIdentity, true);
    const off = run(env, () => identityRequire({ off: true, registryPath: env.registryPath, stderrIsTTY: true }));
    assert.equal(off.exitCode, undefined, off.stderr);
    assert.equal(load(env).requireIdentity, false);
    assert.match(read(env), /requireIdentity: false/);
    const set = run(env, () =>
      engagementsSetIdentity("customer-b", { person: "work", registryPath: env.registryPath, stderrIsTTY: true, pathEnv: "" }),
    );
    assert.equal(set.exitCode, undefined, set.stderr);
    assert.equal(load(env).requireIdentity, false, "a person's --off is not undone");
  });

  it("require --off on a registry that never set it changes nothing (no version bump)", () => {
    const env = setup(V2);
    const before = read(env);
    const r = run(env, () => identityRequire({ off: true, registryPath: env.registryPath, stderrIsTTY: true }));
    assert.equal(r.exitCode, undefined, r.stderr);
    assert.equal(read(env), before);
  });
});

describe("engagements set-identity", () => {
  const set = (env: Env, id: string | undefined, opts: object) =>
    run(env, () =>
      engagementsSetIdentity(id, { registryPath: env.registryPath, stderrIsTTY: true, json: true, pathEnv: "", ...opts }),
    );

  it("the first set-identity bumps to v3, sets requireIdentity, maps every org of the engagement", () => {
    const env = setup(V2);
    run(env, () => identityAdd("work", { ghLogin: "alice-work", registryPath: env.registryPath, stderrIsTTY: true }));
    run(env, () => identityAdd("work-bot", { app: "example-work-agent", registryPath: env.registryPath, stderrIsTTY: true }));
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

describe("set-identity is refused while another install on PATH is older (MULTIPLE_INSTALLS)", () => {
  function fakeInstall(dirName: string, version: string | null): string {
    const dir = join(tmp, dirName);
    mkdirSync(dir, { recursive: true });
    const exe = join(dir, "repo-aegis");
    writeFileSync(exe, "#!/bin/sh\nexit 0\n");
    chmodSync(exe, 0o755);
    if (version !== null) writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@de-otio/repo-aegis", version }));
    return dir;
  }
  const set = (env: Env, pathEnv: string, opts: object = { person: "work" }) =>
    run(env, () =>
      engagementsSetIdentity("customer-b", {
        registryPath: env.registryPath,
        stderrIsTTY: true,
        json: true,
        pathEnv,
        runningVersion: "0.13.0",
        ...opts,
      }),
    );

  it("an older install refuses, and the registry is byte-identical", () => {
    const env = setup(V3);
    const before = read(env);
    const r = set(env, fakeInstall("old", "0.11.4"));
    assert.equal(r.exitCode, 2);
    assert.equal(JSON.parse(r.stderr).code, "MULTIPLE_INSTALLS");
    assert.equal(read(env), before);
  });

  it("an install whose version cannot be read refuses too (it cannot be shown to be current)", () => {
    const env = setup(V3);
    assert.equal(JSON.parse(set(env, fakeInstall("unknown", null)).stderr).code, "MULTIPLE_INSTALLS");
  });

  it("the boundary: an install at the same version, or a newer one, does not refuse", () => {
    for (const [name, v] of [["same", "0.13.0"], ["newer", "0.14.0"]] as const) {
      const env = setup(V3);
      const r = set(env, fakeInstall(name, v));
      assert.equal(r.exitCode, undefined, `${v}: ${r.stderr}`);
    }
  });

  it("an older version compares numerically, not lexically (0.9.0 < 0.13.0)", () => {
    const env = setup(V3);
    assert.equal(JSON.parse(set(env, fakeInstall("nine", "0.9.0")).stderr).code, "MULTIPLE_INSTALLS");
  });

  it("--clear needs no check (it only removes mappings)", () => {
    const env = setup(V3);
    const r = set(env, fakeInstall("old2", "0.1.0"), { clear: true, person: undefined });
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

  it("OWNER_IDENTITY_UNMAPPED: one warning per unmapped owner, a failure when requireIdentity is set; owners only in names (--json)", () => {
    const warn = ownerIdentityChecks(loadRegistry(setup(V3.replace("requireIdentity: true\n", "")).registryPath));
    assert.deepEqual(warn.flatMap(c => c.names ?? []), ["customer-b-org", "plain-org"]);
    for (const c of warn) {
      assert.equal(c.code, "OWNER_IDENTITY_UNMAPPED");
      assert.equal(c.ok, false);
      assert.equal(c.severity, "warn");
      assert.ok(!c.detail.includes(c.names![0]!), "detail must not name the owner");
      assert.ok(!c.fix!.includes(c.names![0]!), "fix must not name the owner: text output lands in transcripts");
    }
    const fail = ownerIdentityChecks(loadRegistry(setup(V3).registryPath));
    assert.equal(fail.length, 2);
    for (const c of fail) assert.equal(c.severity, undefined, "no severity means fail");
  });

  it("a fully mapped registry has no findings; a v2 registry warns for every owner", () => {
    const mapped = V3.replace("plain-org # keep me", "{ name: plain-org, person: me }").replace(
      "    githubOrgs:\n      - customer-b-org\n",
      "    githubOrgs:\n      - customer-b-org\n    person: work\n",
    );
    assert.deepEqual(ownerIdentityChecks(loadRegistry(setup(mapped).registryPath)), []);
    const v2 = ownerIdentityChecks(loadRegistry(setup(V2).registryPath));
    assert.deepEqual(v2.flatMap(c => c.names ?? []), ["customer-a-org", "plain-org"]);
  });
});
