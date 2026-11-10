// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// The emergency pause's one reader (complexity-review P1-E). Every entry point trusts `readPause` and nothing else, so
// each way a file can be wrong has a test that fails if the reader lets it through. The clock is pinned (`T0`).
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearPause,
  DEFAULT_PAUSE_MS,
  MAX_PAUSE_MS,
  mintPause,
  parsePauseRepo,
  pauseCovers,
  pauseNotice,
  readActivePause,
  readPause,
  type PauseState,
} from "./pause.js";

const T0 = new Date("2026-11-10T12:00:00.000Z");
const HOUR = 3_600_000;
const iso = (ms: number): string => new Date(T0.getTime() + ms).toISOString();

let root: string;
let n = 0;
before(() => {
  root = mkdtempSync(join(tmpdir(), "repo-aegis-pause-test-"));
});
after(() => rmSync(root, { recursive: true, force: true }));

function fresh(): string {
  const dir = join(root, `h${n++}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, "pause.json");
}

function raw(path: string, body: unknown, mode = 0o600): void {
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body), { mode });
  chmodSync(path, mode);
}

const good = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: 1,
  createdAt: iso(-60_000),
  expiresAt: iso(HOUR - 60_000),
  by: "alice",
  reasonLength: 0,
  ...over,
});

describe("pause: mint and read", () => {
  it("mints one hour by default, mode 0600, and reads back active", () => {
    const path = fresh();
    const s = mintPause({ path, now: T0, by: "alice" });
    assert.equal(s.expiresAt, iso(DEFAULT_PAUSE_MS));
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(readPause({ path, now: T0 }), { kind: "active", state: s });
  });

  it("clamps a longer request to the 8h cap, whatever the caller passes", () => {
    const path = fresh();
    const s = mintPause({ path, now: T0, durationMs: 100 * HOUR });
    assert.equal(Date.parse(s.expiresAt) - Date.parse(s.createdAt), MAX_PAUSE_MS);
  });

  it("is active until the expiry instant and expired from it (clock pinned at the boundary)", () => {
    const path = fresh();
    mintPause({ path, now: T0, durationMs: HOUR });
    assert.equal(readPause({ path, now: new Date(T0.getTime() + HOUR - 1) }).kind, "active");
    assert.equal(readPause({ path, now: new Date(T0.getTime() + HOUR) }).kind, "expired");
    assert.equal(readActivePause({ path, now: new Date(T0.getTime() + 2 * HOUR) }), null);
  });

  it("no file is no pause", () => {
    assert.deepEqual(readPause({ path: fresh(), now: T0 }), { kind: "none" });
  });

  it("stores the length of the reason and never its text", () => {
    const path = fresh();
    mintPause({ path, now: T0, reasonLength: 24 });
    const text = readFileSync(path, "utf8");
    assert.equal((JSON.parse(text) as { reasonLength: number }).reasonLength, 24);
    assert.equal(readActivePause({ path, now: T0 })?.reasonLength, 24);
  });

  it("clearPause removes it and says whether there was one", () => {
    const path = fresh();
    mintPause({ path, now: T0 });
    assert.equal(clearPause(path), true);
    assert.equal(clearPause(path), false);
    assert.equal(readPause({ path, now: T0 }).kind, "none");
  });
});

describe("pause: a file that fails a check is no pause (fail closed)", () => {
  it("accepts the well-formed file these cases corrupt (control)", () => {
    const path = fresh();
    raw(path, good());
    assert.equal(readPause({ path, now: T0 }).kind, "active");
  });

  it("a createdAt in the future is refused", () => {
    const path = fresh();
    raw(path, good({ createdAt: iso(10 * 60_000), expiresAt: iso(10 * 60_000 + HOUR) }));
    assert.equal(readPause({ path, now: T0 }).kind, "invalid");
  });

  it("a createdAt a few seconds ahead (clock skew) is tolerated, a minute ahead is not", () => {
    const a = fresh();
    raw(a, good({ createdAt: iso(3000), expiresAt: iso(3000 + HOUR) }));
    assert.equal(readPause({ path: a, now: T0 }).kind, "active");
    const b = fresh();
    raw(b, good({ createdAt: iso(60_000), expiresAt: iso(60_000 + HOUR) }));
    assert.equal(readPause({ path: b, now: T0 }).kind, "invalid");
  });

  it("a file owned by someone else is refused", () => {
    const path = fresh();
    raw(path, good());
    const uid = process.getuid?.() ?? 0;
    assert.equal(readPause({ path, now: T0, expectedUid: uid + 1 }).kind, "invalid");
    assert.equal(readPause({ path, now: T0, expectedUid: uid }).kind, "active");
  });

  it("a world-writable or group-writable file is refused; a read-only one is fine", () => {
    for (const mode of [0o666, 0o662, 0o620, 0o602]) {
      const path = fresh();
      raw(path, good(), mode);
      assert.equal(readPause({ path, now: T0 }).kind, "invalid", mode.toString(8));
    }
    const ro = fresh();
    raw(ro, good(), 0o444);
    assert.equal(readPause({ path: ro, now: T0 }).kind, "active");
  });

  it("a symlink to a good file is refused (lstat, not stat)", () => {
    const target = fresh();
    raw(target, good());
    const link = fresh();
    symlinkSync(target, link);
    assert.equal(readPause({ path: link, now: T0 }).kind, "invalid");
  });

  it("a case-variant name (Pause.json, PAUSE.JSON) is no pause, even where the file system opens it as pause.json", () => {
    for (const name of ["Pause.json", "PAUSE.JSON", "pause.JSON"]) {
      const dir = join(root, `h${n++}`);
      mkdirSync(dir, { recursive: true });
      raw(join(dir, name), good());
      // `lstat(.../pause.json)` succeeds on a case-insensitive file system and fails on a case-sensitive one:
      // either way the answer must not be `active`.
      assert.notEqual(readPause({ path: join(dir, "pause.json"), now: T0 }).kind, "active", name);
    }
    // control: the exact name is accepted
    const ok = fresh();
    raw(ok, good());
    assert.equal(readPause({ path: ok, now: T0 }).kind, "active");
  });

  it("a directory, an oversized file, and bad JSON are refused", () => {
    const dir = fresh();
    mkdirSync(dir);
    assert.equal(readPause({ path: dir, now: T0 }).kind, "invalid");
    const big = fresh();
    raw(big, JSON.stringify(good({ by: "x".repeat(5000) })));
    assert.equal(readPause({ path: big, now: T0 }).kind, "invalid");
    const bad = fresh();
    raw(bad, "{not json");
    assert.equal(readPause({ path: bad, now: T0 }).kind, "invalid");
  });

  it("a hand-edited long-lived file (over the 8h cap) is refused", () => {
    const path = fresh();
    raw(path, good({ createdAt: iso(-1000), expiresAt: iso(-1000 + MAX_PAUSE_MS + 60_000) }));
    assert.equal(readPause({ path, now: T0 }).kind, "invalid");
    const exactly = fresh();
    raw(exactly, good({ createdAt: iso(-1000), expiresAt: iso(-1000 + MAX_PAUSE_MS) }));
    assert.equal(readPause({ path: exactly, now: T0 }).kind, "active");
  });

  it("wrong shape: version, timestamps, order, by, reasonLength, repo", () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["version 2", good({ version: 2 })],
      ["no version", { ...good(), version: undefined }],
      ["non-ISO createdAt", good({ createdAt: "yesterday" })],
      ["non-ISO expiresAt", good({ expiresAt: 1788000000000 })],
      ["expires before created", good({ expiresAt: iso(-120_000) })],
      ["by not a string", good({ by: 7 })],
      ["negative reasonLength", good({ reasonLength: -1 })],
      ["fractional reasonLength", good({ reasonLength: 1.5 })],
      ["repo wildcard", good({ repo: "acme/*" })],
      ["repo owner-only", good({ repo: "acme" })],
      ["repo not lower-case as stored", good({ repo: "Acme/Svc" })],
      ["repo with a bad name", good({ repo: "acme/s v c" })],
      ["repo with three parts", good({ repo: "a/b/c" })],
    ];
    for (const [label, body] of cases) {
      const path = fresh();
      raw(path, body);
      assert.equal(readPause({ path, now: T0 }).kind, "invalid", label);
    }
  });

  it("an array or null body is refused", () => {
    for (const body of ["[]", "null", "42", '"x"']) {
      const path = fresh();
      raw(path, body);
      assert.equal(readPause({ path, now: T0 }).kind, "invalid", body);
    }
  });
});

describe("pause: scope", () => {
  const all: PauseState = { version: 1, createdAt: iso(0), expiresAt: iso(HOUR), by: "a", reasonLength: 0 };
  const scoped: PauseState = { ...all, repo: "acme/svc" };

  it("a machine-wide pause covers everything, even a command with no destination", () => {
    assert.equal(pauseCovers(all, []), true);
    assert.equal(pauseCovers(all, [null]), true);
    assert.equal(pauseCovers(all, [{ org: "anyone", repo: "anything" }]), true);
  });

  it("a scoped pause covers its repository, case-insensitively", () => {
    assert.equal(pauseCovers(scoped, [{ org: "acme", repo: "svc" }]), true);
    assert.equal(pauseCovers(scoped, [{ org: "ACME", repo: "Svc" }]), true);
  });

  it("a scoped pause does not cover another repository, another owner, a wildcard, or nothing", () => {
    assert.equal(pauseCovers(scoped, [{ org: "acme", repo: "other" }]), false);
    assert.equal(pauseCovers(scoped, [{ org: "other", repo: "svc" }]), false);
    assert.equal(pauseCovers(scoped, [{ org: "acme", repo: "*" }]), false);
    assert.equal(pauseCovers(scoped, [{ org: "*", repo: "*" }]), false);
    assert.equal(pauseCovers(scoped, [null]), false);
    assert.equal(pauseCovers(scoped, [undefined]), false);
    assert.equal(pauseCovers(scoped, []), false);
  });

  it("a command that reaches the repository AND another is not covered by a scoped pause", () => {
    assert.equal(pauseCovers(scoped, [{ org: "acme", repo: "svc" }, { org: "acme", repo: "other" }]), false);
    assert.equal(pauseCovers(scoped, [{ org: "acme", repo: "svc" }, null]), false);
  });

  it("a destination whose name is not plain ASCII is not the repository (Kelvin sign)", () => {
    assert.equal(pauseCovers({ ...scoped, repo: "korp/svc" }, [{ org: "Korp", repo: "svc" }]), true, "control: plain ASCII");
    assert.equal(pauseCovers({ ...scoped, repo: "korp/svc" }, [{ org: "Korp", repo: "svc" }]), false);
  });

  it("parsePauseRepo accepts owner/repo only", () => {
    assert.equal(parsePauseRepo("Acme/Svc"), "acme/svc");
    assert.equal(parsePauseRepo("acme/svc.git"), "acme/svc");
    for (const bad of ["acme", "acme/*", "*", "*/svc", "a/b/c", "", "acme/s v c"]) assert.equal(parsePauseRepo(bad), null, bad);
  });
});

describe("pause: notice", () => {
  const base: PauseState = { version: 1, createdAt: iso(0), expiresAt: iso(HOUR), by: "a", reasonLength: 0 };
  const at = new Date(base.expiresAt);
  const hhmm = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;

  it("a machine-wide pause says the expiry, that cross-org checks stay on, and the way out", () => {
    assert.equal(pauseNotice(base), `repo-aegis: paused until ${hhmm}, cross-org checks stay on (resume: repo-aegis resume)`);
  });

  it("a pause scoped to one repository lifts cross-org for it, and does not say otherwise", () => {
    assert.equal(pauseNotice({ ...base, repo: "acme/svc" }), `repo-aegis: paused until ${hhmm} (resume: repo-aegis resume)`);
  });
});
