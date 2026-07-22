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
  egressPolicyFromRegistry,
  isPublicFacing,
  type EgressPolicy,
} from "./egress.js";

// A CodeArtifact-shaped host that is NOT on the public allowlist. The account
// id MUST stay synthetic: this package publishes `src` to npm, so anything
// written here is world-readable. Never paste a real host from a machine's
// `~/.npmrc` — the value only has to be non-allowlisted, not real.
const CA = "example-000000000000.d.codeartifact.eu-central-1.amazonaws.com";
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

describe("egressPolicyFromRegistry", () => {
  const MIRROR = "registry.internal.example.com";

  it("keeps the built-in defaults when publicRegistries is absent", () => {
    const p = egressPolicyFromRegistry({});
    assert.equal(isHostAllowed("registry.npmjs.org", p), true);
    assert.equal(isHostAllowed(CA, p), false);
  });

  it("allows a configured mirror while still denying other private hosts", () => {
    const p = egressPolicyFromRegistry({ publicRegistries: [MIRROR] });
    assert.equal(isHostAllowed(MIRROR, p), true);
    // The point of the allowlist is that it is narrow: one mirror does not
    // open the door to every private host.
    assert.equal(isHostAllowed(CA, p), false);
    assert.equal(isHostAllowed("other.internal.example.com", p), false);
  });

  it("lower-cases entries so they match URL.host", () => {
    const p = egressPolicyFromRegistry({ publicRegistries: ["Registry.Internal.EXAMPLE.com"] });
    assert.equal(isHostAllowed(MIRROR, p), true);
  });

  it("a configured mirror suppresses what would otherwise be a lockfile finding", () => {
    const lock = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "node_modules/a": { resolved: `https://${MIRROR}/a/-/a-1.0.0.tgz` },
        "node_modules/b": { resolved: `https://${CA}/npm/npm/b/-/b-1.0.0.tgz` },
      },
    });
    const inputs = [{ path: "package-lock.json", text: lock }];

    // Default policy: both hosts are non-public → two findings.
    assert.equal(scanRegistryEgress(inputs).length, 2);

    // With the mirror allowed, only the genuinely private host remains.
    const f = scanRegistryEgress(inputs, egressPolicyFromRegistry({ publicRegistries: [MIRROR] }));
    assert.equal(f.length, 1);
    assert.equal(f[0]?.host, CA);
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

describe("scanRegistryEgress — Cargo.lock", () => {
  const PRIV = "cargo.internal.example.com";

  it("flags a private registry+/sparse+ source, allows the crates.io index", () => {
    const lock = [
      "[[package]]",
      'name = "public-dep"',
      'version = "1.0.0"',
      'source = "registry+https://github.com/rust-lang/crates.io-index"',
      "",
      "[[package]]",
      'name = "private-dep"',
      'version = "2.0.0"',
      `source = "sparse+https://${PRIV}/index/"`,
    ].join("\n");
    const f = scanRegistryEgress([{ path: "Cargo.lock", text: lock }]);
    assert.equal(f.length, 1);
    assert.equal(f[0]?.host, PRIV);
    assert.equal(f[0]?.pkg, "private-dep", "attributes the finding to the right package");
    // The `sparse+` prefix must be stripped before host extraction, else the
    // URL would not parse and the finding would be silently dropped.
    assert.ok(!f[0]?.value.startsWith("sparse+"));
  });

  it("ignores vendored/path packages that carry no source", () => {
    const lock = ['[[package]]', 'name = "local"', 'version = "0.1.0"'].join("\n");
    assert.equal(scanRegistryEgress([{ path: "Cargo.lock", text: lock }]).length, 0);
  });
});

describe("scanRegistryEgress — poetry.lock", () => {
  const PRIV = "pypi.internal.example.com";

  it("flags a [package.source] url from a private index", () => {
    const lock = [
      "[[package]]",
      'name = "requests"',
      'version = "2.31.0"',
      "",
      "[[package]]",
      'name = "internal-lib"',
      'version = "1.0.0"',
      "",
      "[package.source]",
      `url = "https://${PRIV}/simple"`,
      'reference = "internal"',
    ].join("\n");
    const f = scanRegistryEgress([{ path: "poetry.lock", text: lock }]);
    assert.equal(f.length, 1);
    assert.equal(f[0]?.host, PRIV);
    assert.equal(f[0]?.pkg, "internal-lib");
  });
});

describe("scanRegistryEgress — Pipfile.lock", () => {
  it("flags a private _meta source, allows pypi.org", () => {
    const lock = JSON.stringify({
      _meta: {
        sources: [
          { name: "pypi", url: "https://pypi.org/simple", verify_ssl: true },
          { name: "internal", url: "https://pypi.internal.example.com/simple" },
        ],
      },
      default: {},
    });
    const f = scanRegistryEgress([{ path: "Pipfile.lock", text: lock }]);
    assert.equal(f.length, 1);
    assert.equal(f[0]?.host, "pypi.internal.example.com");
    assert.equal(f[0]?.pkg, "internal");
  });

  it("fails soft on malformed JSON", () => {
    assert.equal(scanRegistryEgress([{ path: "Pipfile.lock", text: "{nope" }]).length, 0);
  });
});

describe("scanRegistryEgress — requirements.txt", () => {
  it("flags private index flags, allows PyPI, ignores plain pins and comments", () => {
    const reqs = [
      "# internal deps",
      "--index-url https://pypi.internal.example.com/simple",
      "--extra-index-url https://pypi.org/simple",
      "requests==2.31.0",
      "-i https://other.internal.example.com/simple",
    ].join("\n");
    const f = scanRegistryEgress([{ path: "requirements.txt", text: reqs }]);
    assert.equal(f.length, 2);
    assert.deepEqual(
      f.map(x => x.host).sort(),
      ["other.internal.example.com", "pypi.internal.example.com"],
    );
    assert.ok(f.every(x => x.kind === "requirements"));
    assert.equal(f[0]?.line, 2, "reports a 1-based line number");
  });

  it("redacts credentials embedded in an index URL", () => {
    const reqs = "--index-url https://ci-user:s3cr3t-token@pypi.internal.example.com/simple";
    const f = scanRegistryEgress([{ path: "requirements.txt", text: reqs }]);
    assert.equal(f.length, 1);
    assert.equal(f[0]?.host, "pypi.internal.example.com");
    assert.ok(!f[0]?.value.includes("s3cr3t-token"), "credential must not be echoed");
    assert.ok(!f[0]?.value.includes("ci-user"), "userinfo must not be echoed");
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

  it("selects the pip/cargo parsers, including nested paths", () => {
    assert.ok(egressParserFor("Cargo.lock"));
    assert.ok(egressParserFor("crates/inner/Cargo.lock"));
    assert.ok(egressParserFor("poetry.lock"));
    assert.ok(egressParserFor("Pipfile.lock"));
    assert.ok(egressParserFor("requirements.txt"));
    assert.ok(egressParserFor("requirements-dev.txt"));
    assert.ok(egressParserFor("requirements/base.txt"));
  });

  it("does NOT treat every .txt as a requirements file", () => {
    // A broad `*.txt` match would drag prose files through a URL scanner and
    // produce noise on any doc that happens to mention a host.
    assert.equal(egressParserFor("notes.txt"), null);
    assert.equal(egressParserFor("LICENSE.txt"), null);
    assert.equal(isEgressRelevant("doc/requirements-for-vendors.md"), false);
  });

  it("leaves go.sum alone (GOPROXY lives in the env, not the file)", () => {
    assert.equal(egressParserFor("go.sum"), null);
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
