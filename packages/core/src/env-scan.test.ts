// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  scanEnvText,
  scanEnvSources,
  defaultEnvSources,
  hostToMarkerPattern,
  type EnvSource,
} from "./env-scan.js";

const PRIV = "npm.internal.example.com";

describe("scanEnvText — .npmrc", () => {
  it("extracts default and scoped registry hosts", () => {
    const text = [
      "# a comment",
      `registry=https://${PRIV}/npm/`,
      "@acme:registry=https://other.internal.example.com/npm/",
    ].join("\n");
    const f = scanEnvText("npmrc", "~/.npmrc", text);
    assert.deepEqual(f.map(x => x.host), [PRIV, "other.internal.example.com"]);
    assert.equal(f[1]?.field, "@acme:registry");
  });

  it("takes the host from an auth line but NEVER the token", () => {
    const text = `//${PRIV}/npm/:_authToken=super-secret-value`;
    const f = scanEnvText("npmrc", "~/.npmrc", text);
    assert.equal(f.length, 1);
    assert.equal(f[0]?.host, PRIV);
    // The token must not survive anywhere in the finding.
    assert.ok(!JSON.stringify(f).includes("super-secret-value"));
  });
});

describe("scanEnvText — pip.conf", () => {
  it("extracts index-url, extra-index-url and bare trusted-host", () => {
    const text = [
      "[global]",
      `index-url = https://${PRIV}/simple`,
      "extra-index-url = https://pypi.org/simple https://second.internal.example.com/simple",
      "trusted-host = third.internal.example.com",
    ].join("\n");
    const hosts = scanEnvText("pip-conf", "~/.config/pip/pip.conf", text).map(x => x.host);
    assert.deepEqual(hosts, [
      PRIV,
      "pypi.org",
      "second.internal.example.com",
      "third.internal.example.com",
    ]);
  });

  it("does not leak credentials embedded in an index URL", () => {
    const text = "index-url = https://user:tok3n@" + PRIV + "/simple";
    const f = scanEnvText("pip-conf", "pip.conf", text);
    assert.equal(f[0]?.host, PRIV);
    assert.ok(!JSON.stringify(f).includes("tok3n"));
    assert.ok(!JSON.stringify(f).includes("user"));
  });
});

describe("scanEnvText — docker config.json", () => {
  it("reads auths KEYS only, never the credential values", () => {
    const text = JSON.stringify({
      auths: {
        "registry.internal.example.com": { auth: "aGlkZGVuLXNlY3JldA==" },
        "https://index.docker.io/v1/": { auth: "b3RoZXItc2VjcmV0" },
      },
    });
    const f = scanEnvText("docker-config", "~/.docker/config.json", text);
    assert.deepEqual(f.map(x => x.host).sort(), [
      "index.docker.io",
      "registry.internal.example.com",
    ]);
    assert.ok(!JSON.stringify(f).includes("aGlkZGVuLXNlY3JldA"));
  });

  it("fails soft on malformed JSON", () => {
    assert.equal(scanEnvText("docker-config", "x", "{nope").length, 0);
  });
});

describe("scanEnvText — maven settings.xml / cargo config.toml / yarnrc", () => {
  it("extracts maven mirror + repository urls", () => {
    const xml = `<settings><mirrors><mirror>
      <url>https://maven.internal.example.com/repo</url>
    </mirror></mirrors></settings>`;
    const f = scanEnvText("maven-settings", "~/.m2/settings.xml", xml);
    assert.deepEqual(f.map(x => x.host), ["maven.internal.example.com"]);
  });

  it("extracts cargo registry index, stripping the sparse+ prefix", () => {
    const toml = [
      "[registries.internal]",
      'index = "sparse+https://cargo.internal.example.com/index/"',
    ].join("\n");
    const f = scanEnvText("cargo-config", "~/.cargo/config.toml", toml);
    assert.deepEqual(f.map(x => x.host), ["cargo.internal.example.com"]);
  });

  it("extracts yarn npmRegistryServer at top level and per scope", () => {
    const yml = [
      "npmRegistryServer: https://yarn.internal.example.com",
      "npmScopes:",
      "  acme:",
      "    npmRegistryServer: https://scoped.internal.example.com",
    ].join("\n");
    const hosts = scanEnvText("yarnrc", "~/.yarnrc.yml", yml).map(x => x.host).sort();
    assert.deepEqual(hosts, ["scoped.internal.example.com", "yarn.internal.example.com"]);
  });
});

describe("scanEnvSources", () => {
  const sources: EnvSource[] = [
    { path: "/fake/.npmrc", kind: "npmrc", label: "~/.npmrc" },
    { path: "/fake/missing", kind: "pip-conf", label: "~/.config/pip/pip.conf" },
    { path: "/fake/.yarnrc.yml", kind: "yarnrc", label: "~/.yarnrc.yml" },
  ];
  const files: Record<string, string> = {
    "/fake/.npmrc": `registry=https://${PRIV}/npm/\n//${PRIV}/npm/:_authToken=x\n`,
    "/fake/.yarnrc.yml": "npmRegistryServer: https://registry.npmjs.org\n",
  };
  const read = (p: string): string => {
    const t = files[p];
    if (t === undefined) throw new Error("ENOENT");
    return t;
  };

  it("filters public hosts, dedupes, and skips unreadable files", () => {
    const r = scanEnvSources(sources, read);
    // npmjs is public → filtered; the private host appears once despite two hits.
    assert.deepEqual(r.hosts.map(h => h.host), [PRIV]);
    assert.equal(r.publicHostCount, 1);
    // The missing pip.conf is not reported as scanned.
    assert.deepEqual(r.scanned, ["~/.npmrc", "~/.yarnrc.yml"]);
  });

  it("reports only labels, never absolute paths (they leak $HOME)", () => {
    const r = scanEnvSources(sources, read);
    assert.ok(r.scanned.every(s => !s.startsWith("/fake")));
    assert.ok(r.hosts.every(h => !h.source.startsWith("/")));
  });
});

describe("defaultEnvSources", () => {
  it("covers the documented toolchains and adds project-level configs", () => {
    const home = defaultEnvSources("/home/u");
    const kinds = new Set(home.map(s => s.kind));
    for (const k of ["npmrc", "yarnrc", "docker-config", "maven-settings", "cargo-config", "pip-conf"]) {
      assert.ok(kinds.has(k as never), `missing ${k}`);
    }
    assert.ok(home.every(s => s.path.startsWith("/home/u")));

    const withCwd = defaultEnvSources("/home/u", "/proj");
    assert.ok(withCwd.length > home.length);
    assert.ok(withCwd.some(s => s.path === "/proj/.npmrc" && s.label === "./.npmrc"));
  });
});

describe("hostToMarkerPattern", () => {
  it("escapes dots so the literal cannot act as a wildcard", () => {
    const p = hostToMarkerPattern("a.internal.example.com");
    assert.equal(p, "a\\.internal\\.example\\.com");
    // Sanity: the escaped pattern matches the host and not a dot-substituted one.
    assert.ok(new RegExp(p!, "i").test("a.internal.example.com"));
    assert.ok(!new RegExp(p!, "i").test("axinternalxexamplexcom"));
  });

  it("lower-cases and rejects hosts too short to match safely", () => {
    assert.equal(hostToMarkerPattern("A.EXAMPLE.COM"), "a\\.example\\.com");
    assert.equal(hostToMarkerPattern("a.io"), null);
  });
});
