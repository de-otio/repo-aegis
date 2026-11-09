// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// `repo-aegis identity list` (read-only; an agent may run it) and the `set-identity --person` login warning.
// Placeholders only: alice, example-org, example-bot, customer-a.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { loadRegistry, type Registry } from "@de-otio/repo-aegis-core";
import { captureOutput, withEnv } from "../_test-utils.js";
import { buildIdentityList, identityList, identityListLines, NOT_A_VALID_LOGIN } from "./identity-list.js";
import { engagementsSetIdentity, identityLoginWarning, loginWarning } from "./identity.js";
import { ENGAGEMENT_ONLY_LOGIN } from "./status.js";

const REGISTRY = `\
schemaVersion: 3
identities:
  alice: { kind: gh-login, login: alice }
  work: { kind: gh-login, login: alice_corpx }
  idle: { kind: gh-login, login: idle-login }
  work-bot: { kind: github-app, app: example-work-agent }
  bot: { kind: github-app, app: example-bot }
requireIdentity: true
personalOrgs:
  - plain-org
  - { name: example-org, person: alice, agent: bot }
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
`;

let tmp: string;
before(() => {
  tmp = mkdtempSync(join(tmpdir(), "repo-aegis-identity-list-"));
});
after(() => rmSync(tmp, { recursive: true, force: true }));

let counter = 0;
function setup(registry: string | null): { home: string; registryPath: string } {
  const home = join(tmp, `h${counter++}`);
  mkdirSync(join(home, "markers"), { recursive: true });
  mkdirSync(join(home, "state"), { recursive: true });
  const registryPath = join(home, "engagements.yaml");
  if (registry !== null) writeFileSync(registryPath, registry);
  return { home, registryPath };
}

describe("buildIdentityList", () => {
  const list = buildIdentityList(loadRegistry(setup(REGISTRY).registryPath));

  it("lists every identity, sorted by name, with its kind and login or App slug", () => {
    assert.deepEqual(
      list.identities.map(i => [i.name, i.kind, i.login ?? i.app]),
      [
        ["alice", "gh-login", "alice"],
        ["bot", "github-app", "example-bot"],
        ["idle", "gh-login", "idle-login"],
        ["work", "gh-login", "alice_corpx"],
        ["work-bot", "github-app", "example-work-agent"],
      ],
    );
    assert.equal(list.requireIdentity, true);
  });

  it("says where each identity is the person and where it is the agent; engagements by id, an unused one by nothing", () => {
    const by = Object.fromEntries(list.identities.map(i => [i.name, i]));
    assert.deepEqual(by["alice"]!.person, [{ kind: "personal-org", target: "example-org" }]);
    assert.deepEqual(by["alice"]!.agent, []);
    assert.deepEqual(by["bot"]!.agent, [{ kind: "personal-org", target: "example-org" }]);
    assert.deepEqual(by["work"]!.person, [{ kind: "engagement", target: "customer-a" }]);
    assert.deepEqual(by["work-bot"]!.agent, [{ kind: "engagement", target: "customer-a" }]);
    assert.deepEqual([by["idle"]!.person, by["idle"]!.agent], [[], []]);
    // an engagement's orgs never appear: only its id
    assert.ok(!JSON.stringify(list).includes("customer-a-org"));
  });

  it("flags no login of a valid registry (EMU handle_shortcode included)", () => {
    for (const i of list.identities) assert.equal(i.loginProblem, undefined, i.name);
  });

  it("an empty or malformed login is flagged and never printed in text; JSON carries the problem", () => {
    for (const [login, problem] of [["", "empty"], ["  ", "empty"], ["-alice", "invalid"], ["al ice", "invalid"], ["a".repeat(40), "invalid"]] as const) {
      const reg: Registry = {
        engagements: [],
        alwaysBlock: [],
        personalOrgs: ["example-org"],
        identities: new Map([["alice", { name: "alice", kind: "gh-login", login }]]),
        identityMap: new Map([["example-org", { person: { name: "alice", kind: "gh-login", login } }]]),
      };
      const bad = buildIdentityList(reg);
      assert.equal(bad.identities[0]!.loginProblem, problem, JSON.stringify(login));
      const text = identityListLines(bad).join("\n");
      assert.match(text, new RegExp(`alice: gh-login ${NOT_A_VALID_LOGIN.replace(/[()]/g, "\\$&")}`), text);
      assert.ok(login.trim() === "" || !text.includes(login), "the bad login is not echoed");
    }
  });
});

describe("identityListLines (text redaction follows `status`)", () => {
  const text = identityListLines(buildIdentityList(loadRegistry(setup(REGISTRY).registryPath))).join("\n");
  it("prints a login only when a personal org uses the identity", () => {
    assert.match(text, /alice: gh-login alice/);
    assert.match(text, new RegExp(`work: gh-login ${ENGAGEMENT_ONLY_LOGIN}`));
    assert.match(text, new RegExp(`idle: gh-login ${ENGAGEMENT_ONLY_LOGIN}`));
    for (const hidden of ["alice_corpx", "idle-login"]) assert.ok(!text.includes(hidden), hidden);
  });
  it("shows the person and agent columns, and App slugs", () => {
    assert.match(text, /bot: github-app example-bot\n {4}person: -\n {4}agent: {2}personal-org example-org/);
    assert.match(text, /work: gh-login .*\n {4}person: engagement customer-a\n {4}agent: {2}-/);
  });
  it("an empty registry of identities says how to add one", () => {
    assert.match(identityListLines({ requireIdentity: false, identities: [] })[0]!, /no identities defined/);
  });
});

describe("repo-aegis identity list (the command)", () => {
  const run = (home: string, registryPath: string, opts: { json?: boolean } = {}) =>
    withEnv("REPO_AEGIS_HOME", home, () => captureOutput(() => identityList({ ...opts, registryPath } as never)));

  it("needs no terminal and writes nothing", () => {
    const env = setup(REGISTRY);
    const before = readFileSync(env.registryPath);
    const r = run(env.home, env.registryPath);
    assert.equal(r.exitCode, undefined, r.stderr);
    assert.match(r.stdout, /identities \(requireIdentity\):/);
    assert.deepEqual(readFileSync(env.registryPath), before);
  });

  it("--json carries every login and the mapping", () => {
    const env = setup(REGISTRY);
    const r = run(env.home, env.registryPath, { json: true });
    const body = JSON.parse(r.stdout) as ReturnType<typeof buildIdentityList>;
    assert.deepEqual(body.identities.map(i => i.login).filter(Boolean).sort(), ["alice", "alice_corpx", "idle-login"]);
    assert.deepEqual(body.identities.find(i => i.name === "work")!.person, [{ kind: "engagement", target: "customer-a" }]);
  });

  it("a missing registry is REGISTRY_NOT_FOUND (exit 2), not a crash", () => {
    const env = setup(null);
    const r = run(env.home, env.registryPath, { json: true });
    assert.equal(r.exitCode, 2);
    assert.equal((JSON.parse(r.stderr) as { code: string }).code, "REGISTRY_NOT_FOUND");
  });

  it("a registry that does not load says only that, never the parse error (which names orgs)", () => {
    const env = setup("schemaVersion: 3\nidentities: {}\nengagements:\n  - id: customer-a\n    githubOrgs: [secret-org]\n    person: nobody\n");
    const r = run(env.home, env.registryPath, { json: true });
    assert.equal(r.exitCode, 2);
    const err = JSON.parse(r.stderr) as { code: string; error: string };
    assert.equal(err.code, "REGISTRY_UNREADABLE");
    assert.ok(!r.stderr.includes("secret-org") && !r.stderr.includes("customer-a"), r.stderr);
  });
});

describe("set-identity --person: the login warning", () => {
  it("loginWarning is null for a valid login and warns, without the login, for an empty or malformed one", () => {
    for (const ok of ["alice", "alice-work", "alice_corpx", "a"]) assert.equal(loginWarning("work", ok), null, ok);
    for (const bad of [undefined, "", "   ", "-alice", "al ice", "alice__x", "a".repeat(40)]) {
      const w = loginWarning("work", bad);
      assert.ok(w !== null, JSON.stringify(bad));
      assert.match(w, /identity "work" has a login that is empty or not a valid GitHub login/);
      assert.match(w, /writes through it will be refused until the login is fixed/);
      assert.match(w, /identity add work --gh-login <login>/); // the fix line
      assert.ok(bad === undefined || bad.trim() === "" || !w.includes(bad), "the login is never echoed");
    }
  });

  it("reads the login from the document: empty and malformed warn, a valid one and an App do not", () => {
    const doc = parseDocument(
      "identities:\n  empty: { kind: gh-login, login: '' }\n  bad: { kind: gh-login, login: -x }\n  ok: { kind: gh-login, login: alice }\n  app: { kind: github-app, app: example-bot }\n",
    );
    assert.match(identityLoginWarning(doc, "empty") ?? "", /identity "empty" has a login that is empty/);
    assert.match(identityLoginWarning(doc, "bad") ?? "", /identity "bad" has a login that is empty or not a valid/);
    assert.equal(identityLoginWarning(doc, "ok"), null);
    assert.equal(identityLoginWarning(doc, "app"), null);
    assert.equal(identityLoginWarning(doc, "missing"), null);
  });

  it("a valid identity maps with no warning on stderr or in the JSON (and the command exit is clean)", () => {
    const env = setup(REGISTRY);
    for (const json of [false, true]) {
      const r = withEnv("REPO_AEGIS_HOME", env.home, () =>
        captureOutput(() =>
          engagementsSetIdentity("customer-a", { person: "alice", registryPath: env.registryPath, stderrIsTTY: true, pathEnv: "", claudeHome: join(tmp, "no-claude"), json }),
        ),
      );
      assert.equal(r.exitCode, undefined, r.stderr);
      assert.doesNotMatch(r.stderr, /warning/);
      if (json) assert.equal("warning" in (JSON.parse(r.stdout) as object), false);
    }
  });
});
