// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Registry schemaVersion 3: GitHub identities per owner (doc/plan-owner-identity.md §5.1, §12.1 A8, A16).
// Placeholders only: alice, example-org, example-bot, customer-a.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRegistryText } from "./registry.js";
import { RegistryParseError } from "./exceptions.js";
import { registeredOwners } from "./registered-owners.js";
import { approvalScopeOf } from "./egress-approval.js";
import { computeDenySet } from "./deny-set.js";
import { renderMarkers } from "./render.js";
import type { RepoConfig } from "./repo.js";

const IDENTITIES = `
identities:
  me: { kind: gh-login, login: alice }
  me-bot: { kind: github-app, app: example-bot }
  work: { kind: gh-login, login: alice-work }
  work-bot: { kind: github-app, app: example-work-agent }
`;

const V3 = `schemaVersion: 3
${IDENTITIES}
requireIdentity: true
personalOrgs:
  - example-org
  - { name: Other-Org, person: me, agent: me-bot }
engagements:
  - id: customer-a
    name: Customer A
    markers: [customer-a-marker]
    githubOrgs: [customer-a-org, customer-a-labs]
    person: work
    agent: work-bot
  - id: customer-b
    name: Customer B
    markers: [customer-b-marker]
    githubOrgs: [customer-b-org]
`.replace("Other-Org", "other-org");

/** The same owners and markers, with no identities at all. */
const V2 = `schemaVersion: 2
personalOrgs:
  - example-org
  - other-org
engagements:
  - id: customer-a
    name: Customer A
    markers: [customer-a-marker]
    githubOrgs: [customer-a-org, customer-a-labs]
  - id: customer-b
    name: Customer B
    markers: [customer-b-marker]
    githubOrgs: [customer-b-org]
`;

function parseError(text: string): string {
  try {
    parseRegistryText(text, "reg.yaml");
  } catch (err) {
    assert.ok(err instanceof RegistryParseError, "must be a fail-closed RegistryParseError");
    return err.message;
  }
  assert.fail("expected the registry to be rejected");
}

const v3 = (body: string, version = 3): string => `schemaVersion: ${version}\n${body}\nengagements: []\n`;

describe("registry v3: parsed shape", () => {
  it("keeps personalOrgs as names, and builds identityMap keyed by lower-cased owner", () => {
    const reg = parseRegistryText(V3);
    assert.deepEqual(reg.personalOrgs, ["example-org", "other-org"]);
    assert.equal(reg.requireIdentity, true);
    assert.equal(reg.schemaVersion, 3);
    assert.deepEqual([...reg.identityMap!.keys()].sort(), ["customer-a-labs", "customer-a-org", "other-org"]);
    assert.deepEqual(reg.identityMap!.get("other-org")!.person, { kind: "gh-login", login: "alice", name: "me" });
    assert.deepEqual(reg.identityMap!.get("other-org")!.agent, { kind: "github-app", app: "example-bot", name: "me-bot" });
    // an engagement's identities apply to ALL its githubOrgs
    for (const org of ["customer-a-org", "customer-a-labs"]) {
      assert.equal(reg.identityMap!.get(org)!.person!.name, "work");
      assert.equal(reg.identityMap!.get(org)!.agent!.name, "work-bot");
    }
    // unmapped owners are absent
    assert.equal(reg.identityMap!.has("example-org"), false);
    assert.equal(reg.identityMap!.has("customer-b-org"), false);
    assert.equal(reg.identities!.size, 4);
  });

  it("a v2 registry parses with empty identities and requireIdentity false", () => {
    const reg = parseRegistryText(V2);
    assert.equal(reg.identityMap!.size, 0);
    assert.equal(reg.identities!.size, 0);
    assert.equal(reg.requireIdentity, false);
  });

  it("a person-only owner maps only the person column", () => {
    const reg = parseRegistryText(v3(`${IDENTITIES}\npersonalOrgs:\n  - { name: example-org, person: me }`));
    const m = reg.identityMap!.get("example-org")!;
    assert.equal(m.person!.name, "me");
    assert.equal(m.agent, undefined);
  });

  it("an object entry with neither column maps nothing (but is still an owner)", () => {
    const reg = parseRegistryText(v3("personalOrgs:\n  - { name: example-org }"));
    assert.equal(reg.identityMap!.size, 0);
    assert.deepEqual(reg.personalOrgs, ["example-org"]);
  });
});

describe("registry v3: no existing consumer changes (A8)", () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "repo-aegis-v3-equiv-"));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("registeredOwners() and approvalScopeOf() equal those of the equivalent v2 registry", () => {
    const a = parseRegistryText(V3);
    const b = parseRegistryText(V2);
    assert.deepEqual([...registeredOwners(a)].sort(), [...registeredOwners(b)].sort());
    assert.ok(registeredOwners(a).size >= 5, "guard against comparing two empty sets");
    const sa = approvalScopeOf(a);
    const sb = approvalScopeOf(b);
    assert.deepEqual([...sa.personalOrgs].sort(), [...sb.personalOrgs].sort());
    assert.deepEqual([...sa.personalOrgs].sort(), ["example-org", "other-org"]);
    assert.deepEqual([...(sa.upstreams ?? [])], [...(sb.upstreams ?? [])]);
  });

  it("the deny set equals that of the equivalent v2 registry", () => {
    const repo: RepoConfig = {
      cwd: dir,
      isGitRepo: false,
      class: "customer-coupled",
      classExplicit: true,
      engagements: ["customer-a"],
    };
    const compute = (name: string, text: string) => {
      const markersDir = join(dir, name, "markers");
      mkdirSync(markersDir, { recursive: true });
      renderMarkers(parseRegistryText(text), {
        markersDir,
        flatPath: join(dir, name, "flat.txt"),
        validatePatterns: false,
      });
      return computeDenySet(repo, { markersDir, cachePath: null });
    };
    const a = compute("v3", V3);
    const b = compute("v2", V2);
    assert.deepEqual(a.patterns, b.patterns);
    // The repo is coupled to customer-a, so the OTHER engagement's markers are what is denied.
    assert.ok(a.patterns.includes("customer-b-marker"), "the comparison must not be vacuous");
    assert.deepEqual(a.files.map(f => f.stem), b.files.map(f => f.stem));
  });
});

describe("registry v3: validation fails closed and names the path", () => {
  const cases: ReadonlyArray<readonly [label: string, text: string, expect: RegExp]> = [
    ["agent -> gh-login", v3(`${IDENTITIES}\npersonalOrgs:\n  - { name: o, agent: me }`), /personalOrgs\[0\]\.agent: .*github-app/],
    ["person -> github-app", v3(`${IDENTITIES}\npersonalOrgs:\n  - { name: o, person: me-bot }`), /personalOrgs\[0\]\.person: .*gh-login/],
    ["dangling personal ref", v3("personalOrgs:\n  - { name: o, agent: nope }"), /personalOrgs\[0\]\.agent: .*"nope".*not defined/],
    ["dangling engagement ref", `schemaVersion: 3\n${IDENTITIES}\nengagements:\n  - { id: e, name: E, markers: [], agent: nope }\n`, /engagements\[0\]\.agent: .*"nope"/],
    ["engagement agent -> gh-login", `schemaVersion: 3\n${IDENTITIES}\nengagements:\n  - { id: e, name: E, markers: [], agent: me }\n`, /engagements\[0\]\.agent: .*github-app/],
    ["engagement person -> github-app", `schemaVersion: 3\n${IDENTITIES}\nengagements:\n  - { id: e, name: E, markers: [], person: me-bot }\n`, /engagements\[0\]\.person: .*gh-login/],
    ["unknown key in an identity", v3("identities:\n  me: { kind: gh-login, login: alice, extra: 1 }"), /identities\.me: .*"extra"/],
    ["unknown key in a personal org object", v3(`${IDENTITIES}\npersonalOrgs:\n  - { name: o, person: me, zz: 1 }`), /personalOrgs\[0\]: .*"zz"/],
    ["unknown kind", v3("identities:\n  me: { kind: pat, login: alice }"), /identities\.me\.kind: /],
    ["gh-login with an app field", v3("identities:\n  me: { kind: gh-login, app: example-bot }"), /identities\.me/],
    ["a non-string, non-object entry", v3("personalOrgs:\n  - 5"), /personalOrgs\[0\]: /],
    ["a bad org name in an object entry", v3("personalOrgs:\n  - { name: Bad_Org }"), /personalOrgs\[0\]\.name: /],
  ];
  for (const [label, text, expect] of cases) {
    it(label, () => assert.match(parseError(text), expect));
  }

  describe("name shapes (A16)", () => {
    const id = (name: string, body: string) => v3(`identities:\n  ${name}: ${body}`);
    it("identity name: leading hyphen, uppercase, underscore and 64 characters are rejected; 63 is accepted", () => {
      for (const bad of ["-me", "Me", "m_e", "a".repeat(64)]) {
        assert.match(parseError(id(bad, "{ kind: gh-login, login: alice }")), /identities\./, bad);
      }
      parseRegistryText(id("a".repeat(63), "{ kind: gh-login, login: alice }"));
      parseRegistryText(id("0a", "{ kind: gh-login, login: alice }"));
    });
    it("login: leading hyphen, empty and 40 characters are rejected; 39 (and one char) are accepted", () => {
      for (const bad of ["-alice", "al.ice", "a".repeat(40), '""']) {
        assert.match(parseError(id("me", `{ kind: gh-login, login: ${bad} }`)), /identities\.me\.login/, bad);
      }
      parseRegistryText(id("me", `{ kind: gh-login, login: ${"A".repeat(39)} }`));
      parseRegistryText(id("me", "{ kind: gh-login, login: a }"));
      parseRegistryText(id("me", "{ kind: gh-login, login: alice-work }"));
    });
    it("Enterprise Managed User logins (handle_shortcode) are accepted, kept tight", () => {
      for (const ok of ["alice_ab12", "alice-work_corp1", "a_b", `a_${"z".repeat(20)}`, `${"A".repeat(39)}_x`]) {
        parseRegistryText(id("me", `{ kind: gh-login, login: ${ok} }`));
      }
      for (const bad of ["_alice", "alice_", "alice__ab", "alice_a_b", "alice_ab-c", `a_${"z".repeat(21)}`, `${"a".repeat(40)}_x`, "-alice_ab", "alice_-ab"]) {
        assert.match(parseError(id("me", `{ kind: gh-login, login: ${bad} }`)), /identities\.me\.login/, bad);
      }
    });
    it("app slug: leading hyphen, uppercase and 64 characters are rejected; 63 is accepted", () => {
      for (const bad of ["-bot", "Bot", "a".repeat(64)]) {
        assert.match(parseError(id("b", `{ kind: github-app, app: ${bad} }`)), /identities\.b\.app/, bad);
      }
      parseRegistryText(id("b", `{ kind: github-app, app: ${"a".repeat(63)} }`));
    });
    it("a reference to a name that violates the shape is rejected at the reference", () => {
      assert.match(parseError(v3(`${IDENTITIES}\npersonalOrgs:\n  - { name: o, person: -me }`)), /personalOrgs\[0\]\.person/);
    });
  });

  describe("owners in only one mapped entry", () => {
    it("an object entry and a plain entry for the same org are duplicates", () => {
      assert.match(parseError(v3(`${IDENTITIES}\npersonalOrgs:\n  - o\n  - { name: o, person: me }`)), /personalOrgs\[1\]: duplicate org "o"/);
    });
    it("two object entries for the same org are duplicates", () => {
      assert.match(parseError(v3(`${IDENTITIES}\npersonalOrgs:\n  - { name: o, person: me }\n  - { name: o, person: work }`)), /duplicate org "o"/);
    });
    it("an object personal org and an engagement githubOrgs entry stay mutually exclusive", () => {
      const text = `schemaVersion: 3\n${IDENTITIES}\npersonalOrgs:\n  - { name: shared, person: me }\nengagements:\n  - { id: e, name: E, markers: [], githubOrgs: [shared], person: work }\n`;
      assert.match(parseError(text), /engagements\[0\]\.githubOrgs\[0\]: org "shared" appears in personalOrgs/);
    });
    it("an org in two engagements stays an error with identities present", () => {
      const text = `schemaVersion: 3\n${IDENTITIES}\nengagements:\n  - { id: a, name: A, markers: [], githubOrgs: [shared], person: me }\n  - { id: b, name: B, markers: [], githubOrgs: [shared], person: work }\n`;
      assert.match(parseError(text), /at most one engagement/);
    });
  });

  describe("version gate", () => {
    for (const v of [1, 2]) {
      it(`identities with schemaVersion ${v} names the version`, () => {
        assert.match(parseError(v3("identities:\n  me: { kind: gh-login, login: alice }", v)), new RegExp(`identities: .*requires schemaVersion 3.*declares schemaVersion ${v}`));
      });
      it(`an object-form personalOrgs entry with schemaVersion ${v} names the version`, () => {
        assert.match(parseError(v3("personalOrgs:\n  - { name: o }", v)), new RegExp(`personalOrgs\\[0\\]: .*schemaVersion ${v}`));
      });
      it(`requireIdentity with schemaVersion ${v} names the version`, () => {
        assert.match(parseError(v3("requireIdentity: false", v)), new RegExp(`requireIdentity: .*schemaVersion ${v}`));
      });
      it(`an engagement's person/agent with schemaVersion ${v} names the version (the reference itself is valid)`, () => {
        // `me` and `me-bot` are defined with the right kinds, so the only thing wrong with the engagement's key is the version.
        for (const [col, name] of [["person", "me"], ["agent", "me-bot"]] as const) {
          const text = `schemaVersion: ${v}\n${IDENTITIES}\nengagements:\n  - { id: e, name: E, markers: [], ${col}: ${name} }\n`;
          const msg = parseError(text);
          assert.match(msg, new RegExp(`engagements\\[0\\]\\.${col}: [^;]*schemaVersion ${v}`));
          assert.doesNotMatch(msg, /not defined|must refer to/, "the reference resolves; only the gate fires for it");
        }
      });
    }
    it("a missing schemaVersion counts as 1", () => {
      assert.match(parseError("identities:\n  me: { kind: gh-login, login: alice }\nengagements: []\n"), /declares schemaVersion 1/);
    });
    it("plain-string personalOrgs stay valid at schemaVersion 2", () => {
      parseRegistryText(V2);
    });
  });
});

describe("registry v3: a mistyped key is an error, not a silent no-op (M1)", () => {
  const eng = (extra: string): string => `schemaVersion: 3\n${IDENTITIES}\nengagements:\n  - { id: e, name: E, markers: [], githubOrgs: [o], ${extra} }\n`;
  it("engagement typos: agnet, persn, and any other unknown key", () => {
    for (const key of ["agnet: work-bot", "persn: work", "agent2: work-bot", "color: red"]) {
      assert.match(parseError(eng(key)), /engagements\[0\]: unknown key "\w+" in a schemaVersion 3 engagement/, key);
    }
  });
  it("known engagement keys all pass in v3", () => {
    parseRegistryText(
      `schemaVersion: 3\n${IDENTITIES}\nengagements:\n  - { id: e, name: E, started: 2026-01-01, ended: null, reposActive: [r], markers: [], notes: n, githubOrgs: [o], person: work, agent: work-bot }\n`,
    );
  });
  it("engagements stay passthrough below version 3 (an old file's extra key is not newly rejected)", () => {
    parseRegistryText("schemaVersion: 2\nengagements:\n  - { id: e, name: E, markers: [], color: red }\n");
  });
  it("top-level near-misses: requireIdentiy, identites, personalOrg, persnalOrgs", () => {
    for (const [key, near] of [["requireIdentiy: true", "requireIdentity"], ["identites: {}", "identities"], ["personalOrg: []", "personalOrgs"], ["persnalOrgs: []", "personalOrgs"]] as const) {
      const msg = parseError(`schemaVersion: 3\n${key}\nengagements: []\n`);
      assert.match(msg, new RegExp(`unknown top-level key "\\w+" looks like a misspelling of "${near}"`), key);
    }
  });
  it("a far-away unknown top-level key stays allowed (passthrough), and the near-miss rule is v3 only", () => {
    parseRegistryText("schemaVersion: 3\nsomethingElseEntirely: 1\nengagements: []\n");
    parseRegistryText("schemaVersion: 2\nrequireIdentiy: true\nengagements: []\n");
  });
});

describe("registry v3: identity keys are checked raw (L4)", () => {
  it("__proto__ is rejected, not silently dropped", () => {
    assert.match(
      parseError("schemaVersion: 3\nidentities:\n  __proto__: { kind: gh-login, login: alice }\nengagements: []\n"),
      /identities\.__proto__: identity name must match/,
    );
  });
  it("other regex-failing keys are rejected raw as well, while `constructor` is a legal name that works as a Map key", () => {
    assert.match(parseError("schemaVersion: 3\nidentities:\n  _x: { kind: gh-login, login: alice }\nengagements: []\n"), /identities\._x/);
    const reg = parseRegistryText("schemaVersion: 3\nidentities:\n  constructor: { kind: gh-login, login: alice }\nengagements: []\n");
    assert.equal(reg.identities!.get("constructor")!.name, "constructor");
  });
});

// ---------------------------------------------------------------------------
// M2: identities are ADDITIVE. Stripping them from a v3 registry must leave exactly the parse of the v2 one.
// ---------------------------------------------------------------------------

type Parsed = ReturnType<typeof parseRegistryText>;

/** The parse with every identity-related field removed (and the version, which the v3 file raises). */
function stripIdentities(reg: Parsed): unknown {
  const { identities: _i, identityMap: _m, requireIdentity: _r, schemaVersion: _s, ...rest } = reg;
  void _i; void _m; void _r; void _s;
  return {
    ...rest,
    engagements: reg.engagements.map(({ person: _p, agent: _a, ...e }) => {
      void _p; void _a;
      return e;
    }),
  };
}

describe("registry v3: identities are additive (M2)", () => {
  it("the V3 fixture, stripped, deep-equals the parse of the equivalent V2", () => {
    assert.deepEqual(stripIdentities(parseRegistryText(V3)), stripIdentities(parseRegistryText(V2)));
  });

  it("holds over seeded random small v2 registries with random identity decoration", () => {
    // Seeded LCG (numerical recipes constants): the same 200 registries on every run.
    let state = 0x2f6e2b1;
    const next = (n: number): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state % n;
    };
    let decorated = 0;
    for (let round = 0; round < 200; round++) {
      let orgCounter = 0;
      const org = (): string => `org-${round}-${orgCounter++}`;
      const personal = Array.from({ length: next(4) }, org);
      const engagements = Array.from({ length: next(4) }, (_, i) => ({
        id: `eng-${i}`,
        name: `Engagement ${i}`,
        markers: Array.from({ length: next(3) }, (_, k) => `marker-${round}-${i}-${k}`),
        ...(next(2) === 0 ? {} : { githubOrgs: Array.from({ length: 1 + next(2) }, org) }),
      }));
      const v2 = { schemaVersion: 2, personalOrgs: personal, engagements };
      const identities = {
        p1: { kind: "gh-login", login: "alice" },
        p2: { kind: "gh-login", login: "alice-work" },
        a1: { kind: "github-app", app: "example-bot" },
      };
      const pick = (kind: "person" | "agent"): string | undefined =>
        next(3) === 0 ? undefined : kind === "person" ? (next(2) === 0 ? "p1" : "p2") : "a1";
      const v3 = {
        schemaVersion: 3,
        identities,
        ...(next(2) === 0 ? { requireIdentity: next(2) === 0 } : {}),
        personalOrgs: personal.map(name => {
          const person = pick("person");
          const agent = pick("agent");
          return person === undefined && agent === undefined && next(2) === 0 ? name : { name, ...(person && { person }), ...(agent && { agent }) };
        }),
        engagements: engagements.map(e => ({ ...e, ...(pick("person") && { person: pick("person") }), ...(pick("agent") && { agent: pick("agent") }) })),
      };
      const a = parseRegistryText(JSON.stringify(v2));
      const b = parseRegistryText(JSON.stringify(v3));
      if (b.identityMap!.size > 0) decorated++;
      assert.deepEqual(stripIdentities(b), stripIdentities(a), `round ${round}`);
      assert.deepEqual([...registeredOwners(b)].sort(), [...registeredOwners(a)].sort(), `owners, round ${round}`);
      assert.deepEqual(approvalScopeOf(b).personalOrgs, approvalScopeOf(a).personalOrgs, `scope, round ${round}`);
    }
    assert.ok(decorated > 50, `the generator must actually decorate registries (decorated ${decorated})`);
  });
});
