// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// The root-owned managed drop-in feature was deleted (complexity review, decision D4). Nothing may import
// its modules again, and the files must stay gone. Only `legacy-managed-remover.ts` knows the drop-in exists,
// and only to detect it and print how to remove it (delete that file, and this assertion, in 0.17).
//
// Walks the checked-in sources, not `dist/`: a stale build directory on a developer machine would keep a
// compiled copy of a deleted module and fail this for the wrong reason.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const DELETED_MODULES = [
  "install-claude-md-managed",
  "managed-dropin",
  "managed-heartbeat-check",
  "managed-ledger",
  "managed-privileged",
  "managed-shadow-checks",
  "doctor-managed-checks",
  "hook-managed-heartbeat",
  "_managed-test-utils",
] as const;

/** Names the core package no longer exports. */
const DELETED_EXPORTS = ["managedHookCommand", "isManagedHookCommand", "MANAGED_ID_PATH", "ManagedHookContext"] as const;

function findRepoRoot(): string {
  let cur = process.cwd();
  for (let i = 0; i < 10; i++) {
    const pkg = join(cur, "package.json");
    if (existsSync(pkg) && (JSON.parse(readFileSync(pkg, "utf8")) as { name?: string }).name === "repo-aegis-monorepo") return cur;
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  throw new Error(`repo root not found from ${process.cwd()}`);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === ".git") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|mts|js|mjs|cjs|sh|yml|yaml|json)$/.test(name) && !/package-lock\.json$/.test(name)) out.push(p);
  }
  return out;
}

/** The module specifiers of `text` (static, dynamic and re-exports) that name a deleted module. */
function importsOfDeleted(text: string): string[] {
  const hits: string[] = [];
  const re = /(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g;
  for (const m of text.matchAll(re)) {
    const base = m[1]!.replace(/\.(?:js|ts)$/, "").split("/").pop()!;
    if ((DELETED_MODULES as readonly string[]).includes(base)) hits.push(m[1]!);
  }
  return hits;
}

describe("the managed drop-in modules are gone and nothing imports them", () => {
  const root = findRepoRoot();
  const files = [...walk(join(root, "packages")), ...walk(join(root, "tests")), ...walk(join(root, ".github")), ...walk(join(root, "scripts"))].filter(
    f => !f.endsWith("no-managed-dropin.test.ts"),
  );

  it("the detector itself catches static, dynamic and re-export forms (so a clean result means something)", () => {
    assert.deepEqual(importsOfDeleted('import { x } from "./managed-dropin.js";'), ["./managed-dropin.js"]);
    assert.deepEqual(importsOfDeleted('const m = await import("./commands/hook-managed-heartbeat.js");'), ["./commands/hook-managed-heartbeat.js"]);
    assert.deepEqual(importsOfDeleted('export { y } from "../_managed-test-utils.js"'), ["../_managed-test-utils.js"]);
    assert.deepEqual(importsOfDeleted('import { z } from "./managed-dropin-notes.js";'), []);
    assert.deepEqual(importsOfDeleted('import { z } from "./legacy-managed-remover.js";'), []);
  });

  it("no source file imports a deleted module", () => {
    const offenders = files.flatMap(f => importsOfDeleted(readFileSync(f, "utf8")).map(s => `${relative(root, f)} imports ${s}`));
    assert.deepEqual(offenders, []);
  });

  it("no deleted module's source file is back", () => {
    const back = files.filter(f => (DELETED_MODULES as readonly string[]).includes(f.split("/").pop()!.replace(/\.(?:test\.)?(?:ts|js)$/, "")));
    assert.deepEqual(back.map(f => relative(root, f)), []);
  });

  it("the managed e2e script and its CI job are gone", () => {
    assert.equal(existsSync(join(root, "tests", "managed-dropin-e2e.sh")), false);
    const ci = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8");
    assert.doesNotMatch(ci, /managed-dropin/);
  });

  it("the core package does not export the managed hook wrapper", () => {
    const index = readFileSync(join(root, "packages", "core", "src", "index.ts"), "utf8");
    const pin = readFileSync(join(root, "packages", "core", "src", "enforcement-pin.ts"), "utf8");
    for (const name of DELETED_EXPORTS) {
      assert.ok(!index.includes(name), `core index still names ${name}`);
      assert.ok(!pin.includes(name), `enforcement-pin still names ${name}`);
    }
  });
});
