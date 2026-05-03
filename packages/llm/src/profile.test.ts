// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import {
  buildProfile,
  writeProfile,
  readProfile,
  diffManifest,
  cleanStaleProfileTemps,
  profileAgeDays,
  profilePath,
  profilesDir,
  type EngagementProfile,
  type SourceManifestEntry,
} from "./profile.js";
import type { OllamaConfig } from "./ollama-client.js";

let tmp: string;
let mockServer: Server;
let mockPort: number;
let serverEmbedding: number[] = [0.1, 0.2, 0.3];

function startMock(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", c => chunks.push(c));
      req.on("end", () => {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ embedding: serverEmbedding }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, port: addr.port });
    });
    server.on("error", reject);
  });
}

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), "repo-aegis-profile-test-"));
  const r = await startMock();
  mockServer = r.server;
  mockPort = r.port;
});

after(() => {
  mockServer.close();
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  serverEmbedding = [0.1, 0.2, 0.3];
});

function cfg(): OllamaConfig {
  return {
    endpoint: `http://127.0.0.1:${mockPort}`,
    model: "nomic-embed-text",
    timeoutMs: 5000,
    allowRemote: false,
  };
}

describe("buildProfile", () => {
  it("embeds each reference doc and records sha256 in manifest", async () => {
    const refDocs = [
      { path: "README.md", content: "Foo Corp readme" },
      { path: "docs/x.md", content: "Foo Corp docs" },
    ];
    const profile = await buildProfile("foo-corp", refDocs, cfg());
    assert.equal(profile.engagementId, "foo-corp");
    assert.equal(profile.modelId, "nomic-embed-text");
    assert.equal(profile.vectors.length, 2);
    assert.ok(profile.vectors[0] instanceof Float32Array);
    assert.equal(profile.sourceManifest.length, 2);
    assert.equal(profile.sourceManifest[0]!.path, "README.md");
    // sha256 should be deterministic given fixed content.
    assert.match(profile.sourceManifest[0]!.sha256, /^[0-9a-f]{64}$/);
    assert.equal(profile.threshold, 0.78);
  });

  it("respects threshold override", async () => {
    const profile = await buildProfile(
      "x",
      [{ path: "a.md", content: "x" }],
      cfg(),
      { threshold: 0.92 },
    );
    assert.equal(profile.threshold, 0.92);
  });

  it("[determinism] two builds of the same input produce equal vectors", async () => {
    serverEmbedding = [0.5, -0.3, 0.7, 0.1];
    const docs = [{ path: "a.md", content: "fixed content" }];
    const a = await buildProfile("x", docs, cfg());
    const b = await buildProfile("x", docs, cfg());
    assert.equal(a.vectors[0]!.length, b.vectors[0]!.length);
    for (let i = 0; i < a.vectors[0]!.length; i++) {
      assert.ok(Math.abs(a.vectors[0]![i]! - b.vectors[0]![i]!) < 1e-6);
    }
  });
});

describe("writeProfile / readProfile — round-trip", () => {
  it("[SEC M-5] writes via tmp+rename (atomic)", async () => {
    const home = join(tmp, "atomic-home");
    mkdirSync(home, { recursive: true });

    const profile: EngagementProfile = {
      schemaVersion: 1,
      engagementId: "round-trip",
      modelId: "nomic-embed-text",
      createdAt: "2026-05-01T00:00:00Z",
      threshold: 0.8,
      vectors: [Float32Array.from([0.1, 0.2, 0.3])],
      sourceManifest: [
        { path: "README.md", sha256: "a".repeat(64), bytes: 12 },
      ],
    };
    writeProfile(home, profile);

    const path = profilePath(home, "round-trip");
    assert.ok(existsSync(path));
    // No leftover tmp.
    const dir = profilesDir(home);
    const tmpFiles = (await import("node:fs"))
      .readdirSync(dir)
      .filter((n: string) => /\.tmp/.test(n));
    assert.equal(tmpFiles.length, 0);
    // Mode 0600.
    const mode = statSync(path).mode & 0o777;
    assert.equal(mode, 0o600);
  });

  it("round-trips identically", () => {
    const home = join(tmp, "round-trip-home");
    mkdirSync(home, { recursive: true });

    const profile: EngagementProfile = {
      schemaVersion: 1,
      engagementId: "rt",
      modelId: "m",
      createdAt: "2026-05-01T00:00:00Z",
      threshold: 0.8,
      vectors: [
        Float32Array.from([0.1, 0.2]),
        Float32Array.from([-0.5, 0.4]),
      ],
      sourceManifest: [{ path: "a.md", sha256: "b".repeat(64), bytes: 1 }],
    };
    writeProfile(home, profile);
    const loaded = readProfile(home, "rt");
    assert.ok(loaded);
    assert.equal(loaded!.engagementId, "rt");
    assert.equal(loaded!.vectors.length, 2);
    for (let i = 0; i < 2; i++) {
      assert.ok(Math.abs(loaded!.vectors[0]![i]! - profile.vectors[0]![i]!) < 1e-6);
    }
  });

  it("readProfile returns null for missing file", () => {
    const home = join(tmp, "missing-home");
    mkdirSync(home, { recursive: true });
    assert.equal(readProfile(home, "absent"), null);
  });

  it("rejects future schemaVersion with upgrade message", () => {
    const home = join(tmp, "future-home");
    mkdirSync(profilesDir(home), { recursive: true });
    writeFileSync(
      profilePath(home, "future"),
      JSON.stringify({
        schemaVersion: 99,
        engagementId: "future",
        modelId: "m",
        createdAt: "2026-05-01",
        threshold: 0.8,
        vectors: [],
        sourceManifest: [],
      }),
    );
    assert.throws(
      () => readProfile(home, "future"),
      /upgrade/i,
    );
  });

  it("rejects malformed JSON", () => {
    const home = join(tmp, "bad-json-home");
    mkdirSync(profilesDir(home), { recursive: true });
    writeFileSync(profilePath(home, "bad"), "not json {");
    assert.throws(() => readProfile(home, "bad"), /invalid JSON/i);
  });
});

describe("cleanStaleProfileTemps", () => {
  it("removes leftover *.tmp.* siblings, keeps real files", () => {
    const home = join(tmp, "stale-home");
    mkdirSync(profilesDir(home), { recursive: true });
    writeFileSync(profilePath(home, "real"), "{}");
    writeFileSync(join(profilesDir(home), "real.json.tmp.99999"), "{}");
    writeFileSync(join(profilesDir(home), "another.json.tmp.42"), "{}");
    const removed = cleanStaleProfileTemps(home);
    assert.equal(removed, 2);
    assert.ok(existsSync(profilePath(home, "real")));
  });

  it("returns 0 when profiles dir doesn't exist", () => {
    const home = join(tmp, "no-profiles-home");
    mkdirSync(home, { recursive: true });
    assert.equal(cleanStaleProfileTemps(home), 0);
  });
});

describe("[SEC H-3] diffManifest", () => {
  it("detects unchanged docs", () => {
    const old: SourceManifestEntry[] = [
      {
        path: "a.md",
        sha256: createHash("sha256").update("hello").digest("hex"),
        bytes: 5,
      },
    ];
    const diff = diffManifest(old, [{ path: "a.md", content: "hello" }]);
    assert.equal(diff.changed.length, 0);
    assert.equal(diff.added.length, 0);
    assert.equal(diff.removed.length, 0);
  });

  it("detects content changes", () => {
    const old: SourceManifestEntry[] = [
      {
        path: "a.md",
        sha256: createHash("sha256").update("old").digest("hex"),
        bytes: 3,
      },
    ];
    const diff = diffManifest(old, [{ path: "a.md", content: "new" }]);
    assert.equal(diff.changed.length, 1);
    assert.equal(diff.changed[0]!.path, "a.md");
  });

  it("detects added and removed paths", () => {
    const old: SourceManifestEntry[] = [
      { path: "a.md", sha256: "x".repeat(64), bytes: 1 },
    ];
    const diff = diffManifest(old, [
      { path: "a.md", content: "" }, // sha mismatch w/ "x"*64 → changed
      { path: "b.md", content: "new" }, // added
    ]);
    assert.ok(diff.added.includes("b.md"));
    // a.md sha won't match "x"*64 so it's changed
    assert.equal(diff.removed.length, 0);
  });
});

describe("[P3-B-1] scoreCandidate", () => {
  function profileFixture(
    id: string,
    vectors: number[][],
    threshold: number,
  ): EngagementProfile {
    return {
      schemaVersion: 1,
      engagementId: id,
      modelId: "nomic-embed-text",
      createdAt: "2026-05-01T00:00:00Z",
      threshold,
      vectors: vectors.map(v => Float32Array.from(v)),
      sourceManifest: [],
    };
  }

  it("returns hits with similarity >= threshold, sorted descending", async () => {
    const { scoreCandidate } = await import("./profile.js");
    const profiles = [
      profileFixture("a", [[1, 0, 0]], 0.7),
      profileFixture("b", [[0, 1, 0]], 0.7),
      profileFixture("c", [[0.7, 0.7, 0]], 0.7), // ~0.99 against [1,1,0] candidate
    ];
    const candidate = Float32Array.from([1, 1, 0]);
    const hits = scoreCandidate(candidate, profiles);
    // a's similarity to [1,1,0] = 1/sqrt(2) ≈ 0.707, just barely meets threshold
    // b's similarity = 1/sqrt(2) ≈ 0.707
    // c's similarity = (0.7+0.7)/(sqrt(0.98)*sqrt(2)) ≈ 1.0 (exact match direction)
    assert.ok(hits.length >= 2, `expected hits, got ${hits.length}`);
    // Sorted descending — first hit has highest similarity.
    for (let i = 1; i < hits.length; i++) {
      assert.ok(hits[i - 1]!.similarity >= hits[i]!.similarity);
    }
    // Each hit names an engagement and includes the threshold.
    for (const h of hits) {
      assert.ok(["a", "b", "c"].includes(h.engagementId));
      assert.equal(h.threshold, 0.7);
    }
  });

  it("returns empty when no profile clears its threshold", async () => {
    const { scoreCandidate } = await import("./profile.js");
    const profiles = [
      profileFixture("a", [[1, 0, 0]], 0.99), // very high threshold
    ];
    const candidate = Float32Array.from([0.7, 0.7, 0]); // ~0.7 cosine
    const hits = scoreCandidate(candidate, profiles);
    assert.equal(hits.length, 0);
  });

  it("ignores reference vectors of mismatched dimension (no crash)", async () => {
    const { scoreCandidate } = await import("./profile.js");
    const profiles = [
      profileFixture(
        "mixed",
        [
          [1, 0, 0], // mismatch
          [0.9, 0.4], // matches candidate dim
        ],
        0.5,
      ),
    ];
    const candidate = Float32Array.from([1, 0]);
    const hits = scoreCandidate(candidate, profiles);
    // The 2-dim ref is ~0.91 cosine to candidate, above threshold.
    assert.ok(hits.length === 1);
    assert.ok(hits[0]!.similarity > 0.7);
  });

  it("never includes the candidate or reference vector in the hit", async () => {
    const { scoreCandidate } = await import("./profile.js");
    const profiles = [profileFixture("a", [[1, 0, 0]], 0.5)];
    const candidate = Float32Array.from([1, 0, 0]);
    const hits = scoreCandidate(candidate, profiles);
    assert.equal(hits.length, 1);
    const hit = hits[0]!;
    assert.deepEqual(Object.keys(hit).sort(), ["engagementId", "similarity", "threshold"]);
  });
});

describe("profileAgeDays", () => {
  it("returns ~0 for a just-created profile", () => {
    const p: EngagementProfile = {
      schemaVersion: 1,
      engagementId: "x",
      modelId: "m",
      createdAt: new Date().toISOString(),
      threshold: 0.8,
      vectors: [],
      sourceManifest: [],
    };
    assert.ok(profileAgeDays(p) < 1);
  });

  it("returns N days for a created-N-days-ago profile", () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const p: EngagementProfile = {
      schemaVersion: 1,
      engagementId: "x",
      modelId: "m",
      createdAt: tenDaysAgo.toISOString(),
      threshold: 0.8,
      vectors: [],
      sourceManifest: [],
    };
    assert.ok(Math.abs(profileAgeDays(p) - 10) < 0.1);
  });
});
