// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Toolchain-dotfile scanning: discover the private package-registry hosts this
// machine is configured to talk to, so they can become marker patterns.
//
// Rationale: the egress check (`egress.ts`) catches a private host once it has
// already reached a lockfile. This module addresses the *upstream* cause — the
// developer's own toolchain config is where those hosts live, and it is the
// authoritative list of private infrastructure for this machine. Turning it
// into the deny set closes the gap at its source and keeps markers
// self-maintaining, with no per-customer enumeration.
//
// Two hard rules, both security-relevant:
//   1. **Hosts only, never secrets.** These files are full of auth tokens and
//      passwords. Every parser extracts a hostname and nothing else; no code
//      path here may return, log, or persist a credential. Token-shaped strings
//      belong to the credential `always_block` patterns, not here.
//   2. **Pure parsers.** text in, hosts out. File discovery is a separate,
//      explicitly-called step, so the parsers are trivially testable and cannot
//      read a path the caller did not ask for.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { defaultEgressPolicy, isHostAllowed } from "./egress.js";

/** The toolchain config shapes this module understands. */
export type EnvSourceKind =
  | "npmrc"
  | "pip-conf"
  | "docker-config"
  | "maven-settings"
  | "cargo-config"
  | "yarnrc";

/** A private-registry host discovered in a toolchain config file. */
export interface EnvHostFinding {
  /** The bare host, lower-cased (matches `URL.host`). */
  host: string;
  /** Display label of the file it came from (never an absolute home path). */
  source: string;
  /** Which parser produced it. */
  kind: EnvSourceKind;
  /** What in the file pointed at it, e.g. `registry`, `@scope:registry`. */
  field: string;
}

/** Extract a lower-cased host from a URL; "" when not a parseable URL. */
function hostOf(url: string): string {
  try {
    return new URL(url.trim()).host.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Accept either a full URL or a bare `host[:port]` (docker's `auths` keys are
 * bare hosts; older entries are `https://…/v1/` URLs).
 */
function hostOfLoose(value: string): string {
  const direct = hostOf(value);
  if (direct !== "") return direct;
  const viaScheme = hostOf(`https://${value.trim()}`);
  return viaScheme;
}

// ---------------------------------------------------------------------------
// Parsers. Each takes raw text and yields (host, field) pairs.
// ---------------------------------------------------------------------------

function parseNpmrc(text: string): Array<{ host: string; field: string }> {
  const out: Array<{ host: string; field: string }> = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;

    const reg = /^((?:@[^:]+:)?registry)\s*=\s*(\S+)/.exec(line);
    if (reg) {
      const host = hostOf(reg[2] ?? "");
      if (host !== "") out.push({ host, field: reg[1] ?? "registry" });
      continue;
    }
    // `//host/path:_authToken=…` — take the host, never the token. The value
    // after `=` is deliberately never read.
    const auth = /^\/\/([^/]+)\//.exec(line);
    if (auth) {
      const host = hostOfLoose(auth[1] ?? "");
      if (host !== "") out.push({ host, field: "auth-scope" });
    }
  }
  return out;
}

function parsePipConf(text: string): Array<{ host: string; field: string }> {
  const out: Array<{ host: string; field: string }> = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const m = /^(index-url|extra-index-url|find-links|trusted-host)\s*=\s*(.+)$/i.exec(line);
    if (!m) continue;
    const field = (m[1] ?? "").toLowerCase();
    // A value may hold several whitespace-separated URLs.
    for (const token of (m[2] ?? "").split(/\s+/).filter(Boolean)) {
      // `trusted-host` takes a bare host, not a URL.
      const host = field === "trusted-host" ? hostOfLoose(token) : hostOf(token);
      if (host !== "") out.push({ host, field });
    }
  }
  return out;
}

function parseDockerConfig(text: string): Array<{ host: string; field: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== "object") return [];
  const out: Array<{ host: string; field: string }> = [];
  const auths = (parsed as { auths?: unknown }).auths;
  if (auths !== null && typeof auths === "object") {
    // Only the KEYS are read. The values hold base64 credentials and are never
    // touched.
    for (const key of Object.keys(auths as Record<string, unknown>)) {
      const host = hostOfLoose(key);
      if (host !== "") out.push({ host, field: "auths" });
    }
  }
  const proxy = (parsed as { credsStore?: unknown }).credsStore;
  if (typeof proxy === "string" && proxy.includes(".")) {
    const host = hostOfLoose(proxy);
    if (host !== "") out.push({ host, field: "credsStore" });
  }
  return out;
}

function parseMavenSettings(text: string): Array<{ host: string; field: string }> {
  const out: Array<{ host: string; field: string }> = [];
  // Deliberately regex rather than a full XML parse: we want `<url>` values and
  // nothing else, and adding an XML dependency to read one tag is not worth the
  // supply-chain surface (same reasoning as the TOML lockfiles in egress.ts).
  const re = /<url>\s*([^<]+?)\s*<\/url>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const host = hostOf(m[1] ?? "");
    if (host !== "") out.push({ host, field: "url" });
  }
  return out;
}

function parseCargoConfig(text: string): Array<{ host: string; field: string }> {
  const out: Array<{ host: string; field: string }> = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = /^(index|registry)\s*=\s*"([^"]+)"/.exec(line);
    if (!m) continue;
    const host = hostOf((m[2] ?? "").replace(/^(?:registry|sparse|git)\+/, ""));
    if (host !== "") out.push({ host, field: m[1] ?? "registry" });
  }
  return out;
}

function parseYarnrc(text: string): Array<{ host: string; field: string }> {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch {
    return [];
  }
  if (doc === null || typeof doc !== "object") return [];
  const out: Array<{ host: string; field: string }> = [];
  // Walk for any `npmRegistryServer` (top level and per-scope under npmScopes).
  const stack: unknown[] = [doc];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== "object") continue;
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === "npmRegistryServer" && typeof v === "string") {
        const host = hostOf(v);
        if (host !== "") out.push({ host, field: "npmRegistryServer" });
      } else if (v !== null && typeof v === "object") {
        stack.push(v);
      }
    }
  }
  return out;
}

const PARSERS: Record<EnvSourceKind, (text: string) => Array<{ host: string; field: string }>> = {
  npmrc: parseNpmrc,
  "pip-conf": parsePipConf,
  "docker-config": parseDockerConfig,
  "maven-settings": parseMavenSettings,
  "cargo-config": parseCargoConfig,
  yarnrc: parseYarnrc,
};

/** Parse one config file's text into host findings. Pure. */
export function scanEnvText(
  kind: EnvSourceKind,
  source: string,
  text: string,
): EnvHostFinding[] {
  return PARSERS[kind](text).map(({ host, field }) => ({ host, source, kind, field }));
}

// ---------------------------------------------------------------------------
// Discovery.
// ---------------------------------------------------------------------------

export interface EnvSource {
  /** Absolute path to read. */
  path: string;
  /** Parser to apply. */
  kind: EnvSourceKind;
  /** Display label used in output — never the absolute path (it leaks $HOME). */
  label: string;
}

/**
 * The default set of toolchain configs to inspect: the user's home-level
 * configs plus the project-level equivalents under `cwd`.
 *
 * Paths are returned, not read — the caller decides what to open, which keeps
 * this function pure and makes the scanned set visible/testable.
 */
export function defaultEnvSources(home: string, cwd?: string): EnvSource[] {
  const sources: EnvSource[] = [
    { path: join(home, ".npmrc"), kind: "npmrc", label: "~/.npmrc" },
    { path: join(home, ".yarnrc.yml"), kind: "yarnrc", label: "~/.yarnrc.yml" },
    { path: join(home, ".docker", "config.json"), kind: "docker-config", label: "~/.docker/config.json" },
    { path: join(home, ".m2", "settings.xml"), kind: "maven-settings", label: "~/.m2/settings.xml" },
    { path: join(home, ".cargo", "config.toml"), kind: "cargo-config", label: "~/.cargo/config.toml" },
    { path: join(home, ".config", "pip", "pip.conf"), kind: "pip-conf", label: "~/.config/pip/pip.conf" },
    { path: join(home, ".pip", "pip.conf"), kind: "pip-conf", label: "~/.pip/pip.conf" },
  ];
  if (cwd !== undefined) {
    sources.push(
      { path: join(cwd, ".npmrc"), kind: "npmrc", label: "./.npmrc" },
      { path: join(cwd, ".yarnrc.yml"), kind: "yarnrc", label: "./.yarnrc.yml" },
      { path: join(cwd, "pip.conf"), kind: "pip-conf", label: "./pip.conf" },
      { path: join(cwd, ".cargo", "config.toml"), kind: "cargo-config", label: "./.cargo/config.toml" },
    );
  }
  return sources;
}

export interface ScanEnvResult {
  /** Non-public hosts, deduped by host, in discovery order. */
  hosts: EnvHostFinding[];
  /** Labels of files that existed and were parsed. */
  scanned: string[];
  /** Public hosts that were found and filtered out (count only — not a leak). */
  publicHostCount: number;
}

/**
 * Read and parse the given sources, returning the **non-public** hosts.
 *
 * Public registries (npmjs, PyPI, crates.io, …) are filtered out via the same
 * allowlist the egress check uses: they are not private infrastructure and
 * blocking them would be actively harmful. Missing/unreadable files are skipped
 * silently — most developers have only a few of these.
 */
export function scanEnvSources(
  sources: readonly EnvSource[],
  readFile: (path: string) => string = p => readFileSync(p, "utf8"),
): ScanEnvResult {
  const policy = defaultEgressPolicy();
  const seen = new Set<string>();
  const hosts: EnvHostFinding[] = [];
  const scanned: string[] = [];
  let publicHostCount = 0;

  for (const src of sources) {
    let text: string;
    try {
      text = readFile(src.path);
    } catch {
      continue; // absent or unreadable: nothing to scan
    }
    scanned.push(src.label);
    for (const finding of scanEnvText(src.kind, src.label, text)) {
      if (isHostAllowed(finding.host, policy)) {
        publicHostCount++;
        continue;
      }
      if (seen.has(finding.host)) continue;
      seen.add(finding.host);
      hosts.push(finding);
    }
  }

  return { hosts, scanned, publicHostCount };
}

// ---------------------------------------------------------------------------
// Host -> marker pattern.
// ---------------------------------------------------------------------------

/**
 * Minimum host length eligible to become a marker. Mirrors the reasoning behind
 * `MIN_AUTO_BLOCK_IDENTIFIER_LENGTH`: a very short literal matched
 * case-insensitively as a substring would flood unrelated content.
 */
export const MIN_ENV_HOST_LENGTH = 6;

/** Escape a string so it matches literally when used as a regex pattern. */
function escapeRegexLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Convert a discovered host into a marker pattern: an escaped, case-insensitive
 * literal, exactly like every other marker. Returns null for hosts too short to
 * be safe.
 *
 * The host is escaped rather than used raw because a hostname's dots are regex
 * wildcards — an unescaped `a.example.com` would also match `axexample!com`
 * and, more importantly, read as a deliberately broad pattern to anyone
 * reviewing the registry.
 */
export function hostToMarkerPattern(host: string): string | null {
  const h = host.trim().toLowerCase();
  if (h.length < MIN_ENV_HOST_LENGTH) return null;
  return escapeRegexLiteral(h);
}
