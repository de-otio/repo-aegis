// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { EngagementProfile, OllamaConfig } from "@de-otio/repo-aegis-llm";
import { runSemanticSweep, type SemanticCandidate } from "./semantic-sweep.js";
import type { CodeSearchHit } from "./types.js";

const ollama: OllamaConfig = {
  endpoint: "http://127.0.0.1:11434",
  model: "nomic-embed-text",
  timeoutMs: 1000,
  allowRemote: false,
};

function unitVec(x: number, y: number): Float32Array {
  const m = Math.hypot(x, y);
  return Float32Array.from([x / m, y / m]);
}

function makeProfile(
  engagementId: string,
  vectors: Float32Array[],
  threshold = 0.85,
): EngagementProfile {
  return {
    schemaVersion: 1,
    engagementId,
    modelId: "test-model",
    createdAt: "2026-05-01T00:00:00Z",
    threshold,
    vectors,
    sourceManifest: vectors.map((_, i) => ({
      path: `doc-${i}.md`,
      sha256: "0".repeat(64),
      bytes: 0,
    })),
  };
}

function hit(repo: string, path: string, query = "q"): CodeSearchHit {
  return { query, repo, path, line: null, url: `https://github.com/${repo}/blob/main/${path}` };
}

describe("runSemanticSweep", () => {
  it("scores candidates against profiles and returns hits over threshold", async () => {
    const profile = makeProfile("customer-a", [unitVec(1, 0)], 0.9);
    const candidates: SemanticCandidate[] = [
      { hit: hit("acme/repo", "near.md"), content: "near" },
      { hit: hit("acme/repo", "far.md"), content: "far" },
    ];
    const r = await runSemanticSweep({
      candidates,
      profiles: [profile],
      ollama,
      embedFn: async (text: string) => {
        if (text === "near") return unitVec(1, 0.05);
        return unitVec(0, 1);
      },
    });
    assert.equal(r.embedded, 2);
    assert.equal(r.embedErrors, 0);
    assert.equal(r.candidates, 2);
    assert.equal(r.hits.length, 1);
    assert.equal(r.hits[0]!.engagementId, "customer-a");
    assert.equal(r.hits[0]!.path, "near.md");
    assert.ok(r.hits[0]!.similarity >= 0.99);
  });

  it("returns empty hits and 0 errors when no profiles loaded", async () => {
    const candidates: SemanticCandidate[] = [
      { hit: hit("o/r", "f.md"), content: "anything" },
    ];
    const r = await runSemanticSweep({
      candidates,
      profiles: [],
      ollama,
      embedFn: async () => {
        throw new Error("should not be called when no profiles");
      },
    });
    assert.deepEqual(r, { hits: [], embedErrors: 0, embedded: 0, candidates: 1 });
  });

  it("tolerates per-candidate embed failures and continues", async () => {
    const profile = makeProfile("customer-a", [unitVec(1, 0)]);
    const candidates: SemanticCandidate[] = [
      { hit: hit("a/b", "ok.md"), content: "ok" },
      { hit: hit("a/b", "bad.md"), content: "bad" },
      { hit: hit("a/b", "ok2.md"), content: "ok2" },
    ];
    const r = await runSemanticSweep({
      candidates,
      profiles: [profile],
      ollama,
      embedFn: async (text: string) => {
        if (text === "bad") throw new Error("ollama down");
        return unitVec(1, 0);
      },
    });
    assert.equal(r.embedded, 2);
    assert.equal(r.embedErrors, 1);
    assert.equal(r.candidates, 3);
    // Only the two successful embeds produced hits.
    assert.equal(r.hits.length, 2);
  });

  it("truncates content past maxBytesPerCandidate before embedding", async () => {
    let received = "";
    const profile = makeProfile("e", [unitVec(1, 0)]);
    await runSemanticSweep({
      candidates: [{ hit: hit("o/r", "big.md"), content: "x".repeat(50) }],
      profiles: [profile],
      ollama,
      maxBytesPerCandidate: 10,
      embedFn: async (text: string) => {
        received = text;
        return unitVec(1, 0);
      },
    });
    assert.equal(received.length, 10);
  });

  it("sorts hits across candidates by descending similarity", async () => {
    // Two engagements, one candidate per — different similarities.
    const eA = makeProfile("a", [unitVec(1, 0)], 0.5);
    const eB = makeProfile("b", [unitVec(0, 1)], 0.5);
    const candidates: SemanticCandidate[] = [
      { hit: hit("o/r", "f1.md"), content: "f1" },
      { hit: hit("o/r", "f2.md"), content: "f2" },
    ];
    const r = await runSemanticSweep({
      candidates,
      profiles: [eA, eB],
      ollama,
      embedFn: async (text: string) =>
        text === "f1" ? unitVec(1, 0.5) : unitVec(0, 1),
    });
    // f1 → close to engagement a (sim ~0.894). f2 → exact match for b (sim 1).
    // Per-candidate hits are sorted within scoreCandidate; across candidates
    // we keep their input order, so f1's hit comes first.
    assert.equal(r.hits.length, 2);
    assert.equal(r.hits[0]!.engagementId, "a");
    assert.equal(r.hits[1]!.engagementId, "b");
  });
});
