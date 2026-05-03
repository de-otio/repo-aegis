// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { parseDocument, YAMLSeq, YAMLMap, Scalar, isMap } from "yaml";
import {
  registryPath as defaultRegistryPath,
  loadRegistry,
  validatePatterns,
  isActive,
  renderMarkers,
  withLockSync,
  PatternValidationError,
  RegistryNotFoundError,
  LockTimeoutError,
  ALWAYS_BLOCK_RESERVED_ID,
  ORG_NAME_REGEX,
  appendAuditRecord,
} from "@de-otio/repo-aegis-core";
import { emitJson, emitText, emitError, type OutputOptions } from "../format.js";

interface EngagementsAddOptions extends OutputOptions {
  name?: string;
  started?: string;
  marker?: string[];
  registryPath?: string;
  /**
   * Phase 1 onboarding: GitHub orgs to map to this engagement. Repeatable
   * (`--github-org a --github-org b`). Mutually exclusive with `personalOrg`.
   * Lowercased and validated against ORG_NAME_REGEX before persisting.
   */
  githubOrg?: string[];
  /**
   * Phase 1 onboarding: GitHub orgs to add to top-level `personalOrgs`.
   * Repeatable. Mutually exclusive with `githubOrg`. When set, the
   * engagement-creation path is skipped — the command writes only to
   * `personalOrgs`.
   */
  personalOrg?: string[];
}

interface EngagementsEndOptions extends OutputOptions {
  purge?: boolean;
  registryPath?: string;
}

interface EngagementsShowOptions extends OutputOptions {
  registryPath?: string;
}

interface EngagementsRemoveOptions extends OutputOptions {
  registryPath?: string;
  /**
   * Required confirmation. Without it, refuses to delete the entry.
   * The flag name is intentional: removing an engagement record is a
   * data-subject-erasure operation; we want the operator's explicit
   * acknowledgement that registry-resident customer-derived data is
   * being deleted.
   */
  hard?: boolean;
}

type Doc = ReturnType<typeof parseDocument>;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function backdated13MonthsIso(): string {
  const d = new Date();
  d.setMonth(d.getMonth() - 13);
  return d.toISOString().slice(0, 10);
}

function loadDoc(path: string): Doc {
  if (!existsSync(path)) throw new RegistryNotFoundError(path);
  const raw = readFileSync(path, "utf8");
  return parseDocument(raw);
}

function saveDoc(doc: Doc, path: string): void {
  writeFileSync(path, doc.toString(), { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* platform-restricted */
  }
}

function findEngagementNode(doc: Doc, id: string): YAMLMap | null {
  const seq = doc.get("engagements") as YAMLSeq | null;
  if (!seq || !seq.items) return null;
  for (const item of seq.items) {
    if (!isMap(item)) continue;
    const idNode = item.get("id");
    if (typeof idNode === "string" && idNode === id) return item as YAMLMap;
    if (idNode instanceof Scalar && idNode.value === id) return item as YAMLMap;
  }
  return null;
}

// --------------------------------------------------------------------------
// Phase 1 helpers: org-name validation + schemaVersion v1→v2 bump
// --------------------------------------------------------------------------

interface OrgValidationResult {
  ok: true;
  orgs: string[];
}
interface OrgValidationFailure {
  ok: false;
  invalid: Array<{ org: string; reason: string }>;
}

/**
 * Lowercase + validate org-name strings before persisting. Lowercases
 * silently (since GitHub org names are case-insensitive); rejects with
 * a typed reason for any other shape violation. Used by both
 * `--github-org` and `--personal-org` paths to give one consistent
 * error message regardless of which list the entry is being added to.
 */
function normalizeOrgs(input: string[]): OrgValidationResult | OrgValidationFailure {
  const orgs: string[] = [];
  const invalid: Array<{ org: string; reason: string }> = [];
  for (const raw of input) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      invalid.push({ org: raw, reason: "org name must be non-empty" });
      continue;
    }
    const lower = trimmed.toLowerCase();
    if (!ORG_NAME_REGEX.test(lower)) {
      invalid.push({
        org: raw,
        reason:
          "org name must start with [a-z0-9] and contain only lowercase letters, digits, or hyphens",
      });
      continue;
    }
    orgs.push(lower);
  }
  return invalid.length > 0 ? { ok: false, invalid } : { ok: true, orgs };
}

/**
 * Read the `schemaVersion` field from the YAML document. Returns `1`
 * when the field is absent (legacy registry; per the reader policy
 * this is treated as schemaVersion: 1). Throws nothing — non-numeric
 * values fall back to 1 with the assumption the load path will reject
 * the registry on the next read. The bump warning is best-effort
 * notification, not a gate.
 */
function readSchemaVersion(doc: Doc): number {
  const v = doc.get("schemaVersion");
  if (typeof v === "number") return v;
  if (v instanceof Scalar && typeof v.value === "number") return v.value;
  return 1;
}

/**
 * Ensure the document's schemaVersion is at least the required version.
 * Returns `true` if a bump occurred (caller should emit the user-facing
 * warning); returns `false` if no change was needed.
 *
 * [SEC M-8] On bump from a legacy v1 registry, callers emit a stderr
 * warning so multi-machine users (laptop + workstation) are aware that
 * older repo-aegis builds will refuse the file until upgraded.
 */
function ensureSchemaVersion(doc: Doc, required: number): boolean {
  const current = readSchemaVersion(doc);
  if (current >= required) return false;
  doc.set("schemaVersion", required);
  return true;
}

/**
 * Append one or more org names to the top-level `personalOrgs` list,
 * creating the list if absent and deduping case-insensitively. Mutates
 * the doc in place. Caller is responsible for save + lock.
 *
 * Returns `{ added, skipped }` where `skipped` is the orgs already
 * present (idempotent re-add).
 */
function appendPersonalOrgs(
  doc: Doc,
  orgs: string[],
): { added: string[]; skipped: string[] } {
  let seq = doc.get("personalOrgs") as YAMLSeq | null;
  if (seq === null || !(seq instanceof YAMLSeq)) {
    seq = new YAMLSeq();
    doc.set("personalOrgs", seq);
  }
  const existing = new Set<string>();
  for (const item of seq.items ?? []) {
    if (typeof item === "string") existing.add(item);
    else if (item instanceof Scalar && typeof item.value === "string")
      existing.add(item.value);
  }
  const added: string[] = [];
  const skipped: string[] = [];
  for (const org of orgs) {
    if (existing.has(org)) {
      skipped.push(org);
      continue;
    }
    seq.add(org);
    existing.add(org);
    added.push(org);
  }
  return { added, skipped };
}

/**
 * Load the registry YAML doc or call emitError (which exits 2). Used to
 * collapse the `let doc; try { doc = ... } catch { emitError(...) }`
 * pattern into a single expression so TypeScript flow analysis narrows
 * the result without `!` assertions.
 */
function loadDocOrExit(path: string, opts: OutputOptions): Doc {
  try {
    return loadDoc(path);
  } catch (err) {
    if (err instanceof RegistryNotFoundError) {
      emitError(
        {
          code: "REGISTRY_NOT_FOUND",
          error: "registry not found; run `repo-aegis init` first",
          details: err.path,
        },
        opts,
      );
    }
    emitError({ error: (err as Error).message }, opts);
  }
}

/**
 * Run a callback under the registry write lock; map known exception types
 * to their canonical CLI error payloads. Centralises the lock+error dance
 * shared by add / end / remove.
 */
function withRegistryLock<T>(opts: OutputOptions, fn: () => T): T {
  try {
    return withLockSync(fn);
  } catch (err) {
    if (err instanceof LockTimeoutError) {
      emitError({ code: err.code, error: err.message }, opts);
    }
    if (err instanceof PatternValidationError) {
      emitError(
        { code: "PATTERN_VALIDATION", error: err.message, details: err.invalid },
        opts,
      );
    }
    emitError({ code: "RENDER_ERROR", error: (err as Error).message }, opts);
  }
}

/**
 * stderr writer used for the [SEC M-8] schemaVersion-bump warning. Pulled
 * out so tests can spy / replace if needed.
 */
function writeWarning(line: string): void {
  process.stderr.write(`warning: ${line}\n`);
}

export function engagementsAdd(
  id: string | undefined,
  opts: EngagementsAddOptions,
): void {
  // [SEC fix] Reject the conflicting-flag combination up front.
  const githubOrgsRaw = opts.githubOrg ?? [];
  const personalOrgsRaw = opts.personalOrg ?? [];
  if (githubOrgsRaw.length > 0 && personalOrgsRaw.length > 0) {
    emitError(
      {
        code: "USAGE",
        error:
          "--github-org and --personal-org are mutually exclusive; use separate invocations",
      },
      opts,
    );
  }

  // ----------------------------------------------------------------------
  // Personal-org-only path: write to top-level `personalOrgs`, no
  // engagement created. The engagement-creation arguments (`<id>`, name,
  // started, markers) are not used here — error out if the caller mixed
  // them in to avoid silent confusion.
  // ----------------------------------------------------------------------
  if (personalOrgsRaw.length > 0) {
    if (id !== undefined && id.length > 0) {
      emitError(
        {
          code: "USAGE",
          error:
            "engagements add --personal-org <org> does not take a positional <id>; the personal-orgs list is repo-wide, not per-engagement",
        },
        opts,
      );
    }
    const validation = normalizeOrgs(personalOrgsRaw);
    if (!validation.ok) {
      emitError(
        {
          code: "INVALID_ORG_NAME",
          error: `${validation.invalid.length} invalid --personal-org value(s)`,
          details: validation.invalid
            .map(i => `  ${JSON.stringify(i.org)}: ${i.reason}`)
            .join("\n"),
        },
        opts,
      );
    }
    const path = opts.registryPath ?? defaultRegistryPath();
    const doc = loadDocOrExit(path, opts);

    const result = withRegistryLock(opts, () => {
      const bumped = ensureSchemaVersion(doc, 2);
      const { added, skipped } = appendPersonalOrgs(doc, validation.orgs);
      saveDoc(doc, path);
      const reg = loadRegistry(path);
      const render = renderMarkers(reg);
      return { added, skipped, bumped, render };
    });

    if (result.bumped) {
      writeWarning(
        "registry schemaVersion bumped from 1 to 2; older repo-aegis builds will refuse to read this file. Upgrade other machines using this registry to a build with MAX_SUPPORTED_REGISTRY_SCHEMA_VERSION >= 2.",
      );
    }

    try {
      appendAuditRecord({
        action: "engagements-add-personal-org",
        details: {
          added: result.added.length,
          skipped: result.skipped.length,
          schemaBumped: result.bumped,
        },
      });
    } catch {
      /* audit log must not break user-facing ops */
    }

    if (opts.json) {
      emitJson({
        action: "engagements-add-personal-org",
        added: result.added,
        skipped: result.skipped,
        schemaBumped: result.bumped,
        rendered: {
          written: result.render.written,
          removed: result.render.removed,
        },
      });
      return;
    }
    if (result.added.length === 0) {
      emitText(
        `personalOrgs unchanged (${result.skipped.length} already present)`,
      );
    } else {
      emitText(
        `added ${result.added.length} personal org(s); ${result.skipped.length} already present`,
      );
    }
    return;
  }

  // ----------------------------------------------------------------------
  // Engagement-creation path (existing behaviour, plus optional
  // `--github-org` flag that populates the new engagement's `githubOrgs`).
  // ----------------------------------------------------------------------
  if (!id || id.length === 0) {
    emitError(
      { code: "USAGE", error: "engagements add requires an <id> argument" },
      opts,
    );
  }
  if (id === ALWAYS_BLOCK_RESERVED_ID) {
    emitError(
      {
        code: "RESERVED_ID",
        error: `engagement id "${ALWAYS_BLOCK_RESERVED_ID}" is reserved; use the top-level always_block list`,
      },
      opts,
    );
  }
  const path = opts.registryPath ?? defaultRegistryPath();
  const markers = opts.marker ?? [];
  const validation = validatePatterns(markers);
  if (validation.invalid.length > 0) {
    emitError(
      {
        code: "PATTERN_VALIDATION",
        error: `${validation.invalid.length} marker pattern(s) failed validation`,
        details: validation.invalid.map(i => `  ${i.pattern}: ${i.reason}`).join("\n"),
      },
      opts,
    );
  }

  let normalisedGithubOrgs: string[] = [];
  if (githubOrgsRaw.length > 0) {
    const orgValidation = normalizeOrgs(githubOrgsRaw);
    if (!orgValidation.ok) {
      emitError(
        {
          code: "INVALID_ORG_NAME",
          error: `${orgValidation.invalid.length} invalid --github-org value(s)`,
          details: orgValidation.invalid
            .map(i => `  ${JSON.stringify(i.org)}: ${i.reason}`)
            .join("\n"),
        },
        opts,
      );
    }
    // Dedupe within the input.
    normalisedGithubOrgs = [...new Set(orgValidation.orgs)];
  }

  const doc = loadDocOrExit(path, opts);

  const existing = findEngagementNode(doc, id);
  if (existing) {
    emitError(
      {
        code: "ENGAGEMENT_EXISTS",
        error: `engagement "${id}" already exists; use \`engagements show ${id}\` to inspect`,
      },
      opts,
    );
  }

  const seq = doc.get("engagements") as YAMLSeq;
  const newEntry: Record<string, unknown> = {
    id,
    name: opts.name ?? id,
    started: opts.started ?? todayIso(),
    markers,
  };
  if (normalisedGithubOrgs.length > 0) {
    newEntry["githubOrgs"] = normalisedGithubOrgs;
  }

  const result = withRegistryLock(opts, () => {
    const bumped =
      normalisedGithubOrgs.length > 0 ? ensureSchemaVersion(doc, 2) : false;
    seq.add(newEntry);
    saveDoc(doc, path);
    const reg = loadRegistry(path);
    return { bumped, render: renderMarkers(reg) };
  });

  if (result.bumped) {
    writeWarning(
      "registry schemaVersion bumped from 1 to 2; older repo-aegis builds will refuse to read this file. Upgrade other machines using this registry to a build with MAX_SUPPORTED_REGISTRY_SCHEMA_VERSION >= 2.",
    );
  }

  // [SEC H-5] follow-up: warn if the new engagement has no markers.
  // Closes the window where a freshly registered org has no deny-set
  // entry to catch leaks. Surfaced both as a stderr warning (for the
  // human / agent reading text output) and as a `markerWarning` field
  // in the JSON envelope (for the MCP-driven flow).
  const markerWarning =
    markers.length === 0 ? { engagementId: id ?? "", count: 0 } : null;
  if (markerWarning) {
    writeWarning(
      `engagement "${id}" was created with 0 markers; ` +
        `run \`repo-aegis suggest-markers --engagement ${id} --from <repo>\` ` +
        `to populate, or add markers via \`engagements add ... --marker <pattern>\`.`,
    );
  }

  // Audit (best-effort). Record id + count only — never the literal
  // marker patterns themselves.
  try {
    appendAuditRecord({
      action: "engagements-add",
      engagement: id ?? "",
      details: {
        markerCount: markers.length,
        name: opts.name ?? id ?? "",
        ...(normalisedGithubOrgs.length > 0 && {
          githubOrgsCount: normalisedGithubOrgs.length,
        }),
        ...(result.bumped && { schemaBumped: true }),
        ...(markerWarning && { zeroMarkers: true }),
      },
    });
  } catch {
    /* audit log must not break user-facing ops */
  }

  if (opts.json) {
    emitJson({
      action: "engagements-add",
      id,
      name: newEntry["name"],
      started: newEntry["started"],
      markers: markers.length,
      ...(normalisedGithubOrgs.length > 0 && {
        githubOrgs: normalisedGithubOrgs,
      }),
      schemaBumped: result.bumped,
      markerWarning,
      rendered: {
        written: result.render.written,
        removed: result.render.removed,
      },
    });
    return;
  }
  emitText(
    `added engagement ${id} (${markers.length} marker pattern(s)` +
      (normalisedGithubOrgs.length > 0
        ? `, ${normalisedGithubOrgs.length} github org(s)`
        : "") +
      `)`,
  );
}

export function engagementsEnd(id: string, opts: EngagementsEndOptions): void {
  if (!id || id.length === 0) {
    emitError({ code: "USAGE", error: "engagements end requires an <id> argument" }, opts);
  }
  const path = opts.registryPath ?? defaultRegistryPath();

  const doc = loadDocOrExit(path, opts);

  const node = findEngagementNode(doc, id);
  if (!node) {
    emitError({ code: "ENGAGEMENT_NOT_FOUND", error: `engagement "${id}" not found` }, opts);
  }

  const endedDate = opts.purge ? backdated13MonthsIso() : todayIso();

  const renderResult = withRegistryLock(opts, () => {
    node.set("ended", endedDate);
    saveDoc(doc, path);
    const reg = loadRegistry(path);
    return renderMarkers(reg);
  });

  try {
    appendAuditRecord({
      action: "engagements-end",
      engagement: id,
      details: { ended: endedDate, purged: !!opts.purge },
    });
  } catch {
    /* audit log must not break user-facing ops */
  }

  if (opts.json) {
    emitJson({
      action: "engagements-end",
      id,
      ended: endedDate,
      purged: !!opts.purge,
      rendered: { written: renderResult.written, removed: renderResult.removed },
    });
    return;
  }
  if (opts.purge) {
    emitText(`ended engagement ${id} (purged: markers removed at next render)`);
  } else {
    emitText(`ended engagement ${id} (markers retained for 12 months)`);
  }
}

export function engagementsShow(id: string, opts: EngagementsShowOptions): void {
  if (!id || id.length === 0) {
    emitError({ code: "USAGE", error: "engagements show requires an <id> argument" }, opts);
  }
  const path = opts.registryPath ?? defaultRegistryPath();

  let reg: ReturnType<typeof loadRegistry>;
  try {
    reg = loadRegistry(path);
  } catch (err) {
    if (err instanceof RegistryNotFoundError) {
      emitError({ code: "REGISTRY_NOT_FOUND", error: "registry not found", details: err.path }, opts);
    }
    emitError({ error: (err as Error).message }, opts);
  }

  const e = reg.engagements.find(x => x.id === id);
  if (!e) {
    emitError({ code: "ENGAGEMENT_NOT_FOUND", error: `engagement "${id}" not found` }, opts);
  }

  const active = isActive(e);

  if (opts.json) {
    emitJson({
      action: "engagements-show",
      id: e.id,
      name: e.name,
      started: e.started ?? null,
      ended: e.ended ?? null,
      active,
      markerCount: e.markers.length,
      notes: e.notes ?? null,
    });
    return;
  }

  emitText(`id:       ${e.id}`);
  emitText(`name:     ${e.name}`);
  if (e.started) emitText(`started:  ${e.started}`);
  if (e.ended) emitText(`ended:    ${e.ended}`);
  emitText(`active:   ${active}`);
  emitText(`markers:  ${e.markers.length} pattern(s)`);
  if (e.notes) {
    emitText("notes:");
    for (const line of e.notes.split("\n")) {
      emitText(`  ${line}`);
    }
  }
}

/**
 * Hard-delete an engagement entry from the registry.
 *
 * `engagementsEnd --purge` only back-dates and lets render remove the
 * marker file; the engagement record itself stays in the YAML
 * indefinitely. This command is the data-subject-erasure path: it
 * physically removes the engagement entry from the registry,
 * triggers a re-render (which removes the marker file), and is
 * idempotent (no-op + clear message if the engagement is already
 * absent).
 *
 * Requires the explicit `--hard` flag so a typo at the CLI doesn't
 * destroy a marker registry. Refuses to remove `_always` (reserved).
 */
export function engagementsRemove(id: string, opts: EngagementsRemoveOptions): void {
  if (!id || id.length === 0) {
    emitError({ code: "USAGE", error: "engagements remove requires an <id> argument" }, opts);
  }
  if (id === ALWAYS_BLOCK_RESERVED_ID) {
    emitError(
      { code: "RESERVED_ID", error: `cannot remove reserved id "${ALWAYS_BLOCK_RESERVED_ID}"` },
      opts,
    );
  }
  if (!opts.hard) {
    emitError(
      {
        code: "REMOVE_REQUIRES_HARD",
        error: "engagements remove is destructive; pass --hard to confirm",
        details:
          "this physically deletes the engagement entry from the registry; " +
          "use `engagements end <id>` (with optional --purge) for soft / retention-window removal",
      },
      opts,
    );
  }

  const path = opts.registryPath ?? defaultRegistryPath();

  const doc = loadDocOrExit(path, opts);

  const seq = doc.get("engagements") as YAMLSeq | null;
  let removed = false;
  if (seq && Array.isArray(seq.items)) {
    const idx = seq.items.findIndex(item => {
      if (!isMap(item)) return false;
      const idNode = (item as YAMLMap).get("id");
      if (typeof idNode === "string") return idNode === id;
      if (idNode instanceof Scalar) return idNode.value === id;
      return false;
    });
    if (idx >= 0) {
      seq.items.splice(idx, 1);
      removed = true;
    }
  }

  if (!removed) {
    if (opts.json) {
      emitJson({
        action: "engagements-remove",
        id,
        removed: false,
        reason: "engagement not in registry (already removed?)",
      });
      return;
    }
    emitText(`engagement ${id} not in registry (already removed?)`);
    return;
  }

  const renderResult = withRegistryLock(opts, () => {
    saveDoc(doc, path);
    const reg = loadRegistry(path);
    return renderMarkers(reg);
  });

  try {
    appendAuditRecord({
      action: "engagements-remove",
      engagement: id,
      details: { hard: true },
    });
  } catch {
    /* audit log must not break user-facing ops */
  }

  if (opts.json) {
    emitJson({
      action: "engagements-remove",
      id,
      removed: true,
      rendered: { written: renderResult.written, removed: renderResult.removed },
    });
    return;
  }
  emitText(`removed engagement ${id} from registry`);
  emitText(`  marker file removed: ${renderResult.removed.length} file(s) at next render`);
}
