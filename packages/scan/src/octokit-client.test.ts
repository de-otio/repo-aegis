// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeOctokitClient } from "./octokit-client.js";

describe("makeOctokitClient", () => {
  it("returns an object exposing the four expected methods", () => {
    const client = makeOctokitClient({ token: "test-token" });
    assert.equal(typeof client.searchCode, "function");
    assert.equal(typeof client.findOpenIssueByTitle, "function");
    assert.equal(typeof client.createIssue, "function");
    assert.equal(typeof client.addComment, "function");
  });

  it("accepts a custom user-agent without throwing", () => {
    const client = makeOctokitClient({
      token: "test-token",
      userAgent: "custom-ua/1.0",
    });
    assert.equal(typeof client.searchCode, "function");
  });
});
