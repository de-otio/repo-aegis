// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Which write targets are the person-only state files (`pause.json`, `egress-approvals.json`), judged by what the
// path IS: case, a symlinked directory, and a symlinked FILE, including one whose target does not exist yet (a
// dangling link: a write through it CREATES the target, so `realpath` alone cannot see where it lands).
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { protectedStateFile } from "./state-file-guard.js";

let tmp: string;
let n = 0;
before(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "repo-aegis-state-file-guard-")));
});
after(() => rmSync(tmp, { recursive: true, force: true }));

function homeDir(): string {
  const home = join(tmp, `home${n++}`);
  mkdirSync(home, { recursive: true });
  return home;
}

/** A scratch directory outside the home, where the "agent" makes its links. */
function workDir(): string {
  const dir = join(tmp, `work${n++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const guard = (file: string, home: string, cwd: string = tmp): ReturnType<typeof protectedStateFile> => protectedStateFile(file, cwd, home);

describe("protectedStateFile: direct paths", () => {
  it("the two files, by name, in the home; anything else is null", () => {
    const home = homeDir();
    assert.equal(guard(join(home, "pause.json"), home), "pause");
    assert.equal(guard(join(home, "egress-approvals.json"), home), "approvals");
    assert.equal(guard(join(home, "PAUSE.JSON"), home), "pause");
    assert.equal(guard(join(home, "engagements.yaml"), home), null);
    assert.equal(guard(join(workDir(), "pause.json"), home), null);
  });
});

describe("protectedStateFile: a dangling symlink to a state file is refused", () => {
  for (const [name, kind] of [["pause.json", "pause"], ["egress-approvals.json", "approvals"]] as const) {
    it(`a link to a ${name} that does not exist yet (absolute target)`, () => {
      const home = homeDir();
      const link = join(workDir(), "x");
      symlinkSync(join(home, name), link);
      assert.equal(guard(link, home), kind);
    });

    it(`a link to a ${name} that does not exist yet (relative target)`, () => {
      const home = homeDir();
      const dir = workDir();
      symlinkSync(join(relative(dir, home), name), join(dir, "x"));
      assert.equal(guard(join(dir, "x"), home), kind);
    });

    it(`a link to a ${name} through a differently-cased name`, () => {
      const home = homeDir();
      const link = join(workDir(), "x");
      symlinkSync(join(home, name.toUpperCase()), link);
      assert.equal(guard(link, home), kind);
    });

    it(`a link to a ${name} in a home directory that does not exist yet`, () => {
      const home = join(tmp, `later${n++}`);
      const link = join(workDir(), "x");
      symlinkSync(join(home, name), link);
      assert.equal(guard(link, home), kind);
    });
  }

  it("a two-hop chain: x -> y -> <home>/pause.json, with nothing at the end", () => {
    const home = homeDir();
    const dir = workDir();
    symlinkSync(join(home, "pause.json"), join(dir, "y"));
    symlinkSync(join(dir, "y"), join(dir, "x"));
    assert.equal(guard(join(dir, "x"), home), "pause");
  });

  it("a three-hop chain mixing absolute and relative links, ending at the approvals file", () => {
    const home = homeDir();
    const dir = workDir();
    symlinkSync(join(home, "egress-approvals.json"), join(dir, "c"));
    symlinkSync("c", join(dir, "b"));
    symlinkSync(join(dir, "b"), join(dir, "a"));
    assert.equal(guard(join(dir, "a"), home), "approvals");
  });

  it("a chain through a symlinked directory", () => {
    const home = homeDir();
    const dir = workDir();
    const viaDir = join(dir, "viadir");
    symlinkSync(home, viaDir);
    symlinkSync(join(viaDir, "pause.json"), join(dir, "x"));
    assert.equal(guard(join(dir, "x"), home), "pause");
  });

  /** `<dir>/<prefix>0 -> <prefix>1 -> ... -> <prefix>(count-1) -> target`: `count` links in all. */
  function chain(dir: string, prefix: string, count: number, target: string): string {
    symlinkSync(target, join(dir, `${prefix}${count - 1}`));
    for (let i = count - 2; i >= 0; i--) symlinkSync(`${prefix}${i + 1}`, join(dir, `${prefix}${i}`));
    return join(dir, `${prefix}0`);
  }

  it("eight links are followed to the end and the end is judged; a longer chain is read as protected", () => {
    const home = homeDir();
    const dir = workDir();
    // the answer is the TARGET's (approvals), not the loop answer (pause): the whole chain was walked
    assert.equal(guard(chain(dir, "a", 8, join(home, "egress-approvals.json")), home), "approvals");
    assert.equal(guard(chain(dir, "b", 8, join(dir, "harmless.txt")), home), null, "eight links to an ordinary file");
    // nine or more: given up on, refused, even where the end is harmless: no honest write goes through such a chain
    assert.equal(guard(chain(dir, "c", 9, join(dir, "harmless.txt")), home), "pause");
    assert.equal(guard(chain(dir, "d", 14, join(dir, "harmless.txt")), home), "pause");
  });

  it("a loop is read as protected: a self-link and a two-link cycle", () => {
    const home = homeDir();
    const loops = workDir();
    symlinkSync("self", join(loops, "self"));
    symlinkSync("q", join(loops, "p"));
    symlinkSync("p", join(loops, "q"));
    assert.equal(guard(join(loops, "self"), home), "pause");
    assert.equal(guard(join(loops, "p"), home), "pause");
  });
});

describe("protectedStateFile: links that are NOT to a state file stay ordinary writes", () => {
  it("a dangling link to a file in the work directory, a link to a pause.json outside the home, and a link into the home to another name", () => {
    const home = homeDir();
    const dir = workDir();
    symlinkSync(join(dir, "not-yet.txt"), join(dir, "dangling"));
    assert.equal(guard(join(dir, "dangling"), home), null);
    symlinkSync(join(dir, "pause.json"), join(dir, "to-other-pause"));
    assert.equal(guard(join(dir, "to-other-pause"), home), null);
    symlinkSync(join(home, "engagements.yaml"), join(dir, "to-registry"));
    assert.equal(guard(join(dir, "to-registry"), home), null);
    // a short chain that ends harmlessly
    symlinkSync(join(dir, "dangling"), join(dir, "two-hop"));
    assert.equal(guard(join(dir, "two-hop"), home), null);
  });
});
