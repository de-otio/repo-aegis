// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  scanRegistryEgress,
  egressParserFor,
  isEgressRelevant,
  isHostAllowed,
  defaultEgressPolicy,
  isPublicFacing,
  type EgressPolicy,
} from "./egress.js";

const CA = "dot-981025486549.d.codeartifact.eu-central-1.amazonaws.com";
const policy = defaultEgressPolicy();

describe("isHostAllowed", () => {
  it("allows the public hosts", () => {
    for (const h of ["registry.npmjs.org", "registry.yarnpkg.com"]) {
      assert.equal(isHostAllowed(h, policy), true);
    }
  });
  it("allows GitHub Packages and codeload by suffix", () => {
    assert.equal(isHostAllowed("npm.pkg.github.com", policy), true);
    assert.equal(isHostAllowed("codeload.github.com", policy), true);
    assert.equal(isHostAllowed("github.com", policy), true);
  });
  it("denies a private CodeArtifact host", () => {
    assert.equal(isHostAllowed(CA, policy), false);
  });
  it("honours an extra allowed host from policy", () => {
    const p: EgressPolicy = { allowedHosts: ["mirror.example.org"] };
    assert.equal(isHostAllowed("mirror.example.org", p), true);
    assert.equal(isHostAllowed(CA, p), false);
  });
});

describe("scanRegistryEgress — package-lock.json", () => {
  it("flags a v3 resolved URL from a private registry, allows public ones", () => {
    const lock = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { name: "x" },
        "node_modules/a": { resolved: `https://${CA}/npm/npm/a/-/a-1.0.0.tgz` },
        "node_modules/b": { resolved: "https://registry.npmjs.org/b/-/b-1.0.0.tgz" },
        "node_modules/c": { resolved: "https://npm.pkg.github.com/c/-/c-1.0.0.tgz" },
        "node_modules/local": { resolved: undefined },
      },
    });
    const f = scanRegistryEgress([{ path: "package-lock.json", text: lock }]);
    assert.equal(f.length, 1);
    assert.equal(f[0]?.host, CA);
    assert.equal(f[0]?.pkg, "node_modules/a");
    assert.equal(f[0]?.kind, "lockfile");
  });

  it("walks the v1 nested dependencies tree", () => {
    const lock = JSON.stringify({
      lockfileVersion: 1,
      dependencies: {
        a: {
          resolved: "https://registry.npmjs.org/a/-/a-1.0.0.tgz",
          dependencies: {
            b: { resolved: `https://${CA}/npm/npm/b/-/b-2.0.0.tgz` },
          },
        },
      },
    });
    const f = scanRegistryEgress([{ path: "package-lock.json", text: lock }]);
    assert.equal(f.length, 1);
    assert.equal(f[0]?.host, CA);
    assert.match(f[0]?.pkg ?? "", /a > b/);
  });

  it("ignores file:/link: and malformed JSON (fails soft)", () => {
    const lock = JSON.stringify({
      packages: { "node_modules/x": { resolved: "file:../x" } },
    });
    assert.equal(scanRegistryEgress([{ path: "package-lock.json", text: lock }]).length, 0);
    assert.equal(scanRegistryEgress([{ path: "package-lock.json", text: "{not json" }]).length, 0);
  });
});

describe("scanRegistryEgress — yarn.lock", () => {
  it("flags a private resolved URL, strips the #hash, allows public", () => {
    const yarn = [
      'a@^1.0.0:',
      '  version "1.0.0"',
      `  resolved "https://${CA}/npm/npm/a/-/a-1.0.0.tgz#abc123"`,
      'b@^1.0.0:',
      '  version "1.0.0"',
      '  resolved "https://registry.yarnpkg.com/b/-/b-1.0.0.tgz#def"',
    ].join("\n");
    const f = scanRegistryEgress([{ path: "yarn.lock", text: yarn }]);
    assert.equal(f.length, 1);
    assert.equal(f[0]?.host, CA);
    assert.ok(!f[0]?.value.includes("#"));
  });
});

describe("scanRegistryEgress — pnpm-lock.yaml", () => {
  it("flags a tarball URL and a top-level registry from a private host", () => {
    const pnpm = [
      `registry: https://${CA}/npm/npm/`,
      "packages:",
      "  /a@1.0.0:",
      "    resolution:",
      `      tarball: https://${CA}/npm/npm/a/-/a-1.0.0.tgz`,
      "  /b@1.0.0:",
      "    resolution:",
      "      integrity: sha512-deadbeef",
    ].join("\n");
    const f = scanRegistryEgress([{ path: "pnpm-lock.yaml", text: pnpm }]);
    assert.ok(f.length >= 1);
    assert.ok(f.every(x => x.host === CA));
  });
});

describe("scanRegistryEgress — .npmrc", () => {
  it("flags registry=, @scope:registry= and //host auth lines; allows public; redacts creds", () => {
    const npmrc = [
      "# comment",
      `registry=https://${CA}/npm/npm/`,
      `@de-otio:registry=https://${CA}/npm/npm/`,
      "//registry.npmjs.org/:_authToken=npm_public_ok",
      `//${CA}/npm/npm/:_authToken=secret-token-value`,
      "registry=https://registry.npmjs.org/",
    ].join("\n");
    const f = scanRegistryEgress([{ path: ".npmrc", text: npmrc }]);
    // two registry= lines for CA + one auth line for CA = 3; npmjs lines allowed
    assert.equal(f.length, 3);
    assert.ok(f.every(x => x.host === CA && x.kind === "npmrc"));
    const auth = f.find(x => x.value.includes("_authToken"));
    assert.ok(auth, "auth line flagged");
    assert.ok(!auth!.value.includes("secret-token-value"), "credential redacted");
  });
});

describe("parser dispatch", () => {
  it("selects parsers by basename and ignores irrelevant files", () => {
    assert.ok(egressParserFor("a/b/package-lock.json"));
    assert.ok(egressParserFor("yarn.lock"));
    assert.ok(egressParserFor("sub/.npmrc"));
    assert.equal(egressParserFor("README.md"), null);
    assert.equal(isEgressRelevant("npm-shrinkwrap.json"), true);
    assert.equal(isEgressRelevant("index.ts"), false);
  });
});

describe("isPublicFacing", () => {
  it("enforces for public-eligible without any visibility probe", () => {
    assert.equal(isPublicFacing({ class: "public-eligible", cwd: "/x" }), true);
  });
  it("enforces for a private-strict repo whose actual visibility is public", () => {
    assert.equal(
      isPublicFacing({ class: "private-strict", cwd: "/x" }, { visibility: "public" }),
      true,
    );
  });
  it("does NOT enforce for private/unknown (CodeArtifact URLs are intended there)", () => {
    assert.equal(
      isPublicFacing({ class: "private-strict", cwd: "/x" }, { visibility: "private" }),
      false,
    );
    assert.equal(
      isPublicFacing({ class: "private-strict", cwd: "/x" }, { visibility: "unknown" }),
      false,
    );
    assert.equal(
      isPublicFacing({ class: "customer-coupled", cwd: "/x" }, { visibility: "unknown" }),
      false,
    );
  });
});
