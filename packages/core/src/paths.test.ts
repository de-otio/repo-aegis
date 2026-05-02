// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  repoAegisHome,
  registryPath,
  markersDir,
  flatMarkersPath,
  statePath,
  leakContextFlagPath,
  lockFilePath,
  isHomeOverridden,
} from "./paths.js";

let originalHome: string | undefined;
let originalRegistry: string | undefined;
let originalMarkersDir: string | undefined;

beforeEach(() => {
  originalHome = process.env["REPO_AEGIS_HOME"];
  originalRegistry = process.env["REPO_AEGIS_REGISTRY"];
  originalMarkersDir = process.env["REPO_AEGIS_MARKERS_DIR"];
  delete process.env["REPO_AEGIS_HOME"];
  delete process.env["REPO_AEGIS_REGISTRY"];
  delete process.env["REPO_AEGIS_MARKERS_DIR"];
});

afterEach(() => {
  if (originalHome !== undefined) process.env["REPO_AEGIS_HOME"] = originalHome;
  else delete process.env["REPO_AEGIS_HOME"];
  if (originalRegistry !== undefined) process.env["REPO_AEGIS_REGISTRY"] = originalRegistry;
  else delete process.env["REPO_AEGIS_REGISTRY"];
  if (originalMarkersDir !== undefined) process.env["REPO_AEGIS_MARKERS_DIR"] = originalMarkersDir;
  else delete process.env["REPO_AEGIS_MARKERS_DIR"];
});

describe("paths", () => {
  it("default home is ~/.config/repo-aegis", () => {
    const h = repoAegisHome();
    assert.match(h, /\.config\/repo-aegis$/);
  });

  it("REPO_AEGIS_HOME env overrides home", () => {
    process.env["REPO_AEGIS_HOME"] = "/tmp/custom";
    assert.equal(repoAegisHome(), "/tmp/custom");
  });

  it("REPO_AEGIS_REGISTRY overrides registry path", () => {
    process.env["REPO_AEGIS_REGISTRY"] = "/tmp/custom-registry.yaml";
    assert.equal(registryPath(), "/tmp/custom-registry.yaml");
  });

  it("registryPath defaults to home/engagements.yaml", () => {
    process.env["REPO_AEGIS_HOME"] = "/tmp/x";
    assert.equal(registryPath(), "/tmp/x/engagements.yaml");
  });

  it("REPO_AEGIS_MARKERS_DIR overrides markers path", () => {
    process.env["REPO_AEGIS_MARKERS_DIR"] = "/tmp/custom-markers";
    assert.equal(markersDir(), "/tmp/custom-markers");
  });

  it("markersDir defaults to home/markers", () => {
    process.env["REPO_AEGIS_HOME"] = "/tmp/x";
    assert.equal(markersDir(), "/tmp/x/markers");
  });

  it("flatMarkersPath is home/markers.txt", () => {
    process.env["REPO_AEGIS_HOME"] = "/tmp/x";
    assert.equal(flatMarkersPath(), "/tmp/x/markers.txt");
  });

  it("statePath is home/state", () => {
    process.env["REPO_AEGIS_HOME"] = "/tmp/x";
    assert.equal(statePath(), "/tmp/x/state");
  });

  it("leakContextFlagPath is home/state/leak-context-mode", () => {
    process.env["REPO_AEGIS_HOME"] = "/tmp/x";
    assert.equal(leakContextFlagPath(), "/tmp/x/state/leak-context-mode");
  });

  it("lockFilePath is home/state/.lock", () => {
    process.env["REPO_AEGIS_HOME"] = "/tmp/x";
    assert.equal(lockFilePath(), "/tmp/x/state/.lock");
  });

  it("isHomeOverridden reflects env var presence", () => {
    assert.equal(isHomeOverridden(), false);
    process.env["REPO_AEGIS_HOME"] = "/tmp/x";
    assert.equal(isHomeOverridden(), true);
  });
});
