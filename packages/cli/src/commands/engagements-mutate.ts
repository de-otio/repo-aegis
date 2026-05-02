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
} from "@de-otio/repo-aegis-core";
import { emitJson, emitText, emitError, type OutputOptions } from "../format.js";

interface EngagementsAddOptions extends OutputOptions {
  name?: string;
  started?: string;
  marker?: string[];
  registryPath?: string;
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

export function engagementsAdd(id: string, opts: EngagementsAddOptions): void {
  if (!id || id.length === 0) {
    emitError({ code: "USAGE", error: "engagements add requires an <id> argument" }, opts);
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

  const renderResult = withRegistryLock(opts, () => {
    seq.add(newEntry);
    saveDoc(doc, path);
    const reg = loadRegistry(path);
    return renderMarkers(reg);
  });

  if (opts.json) {
    emitJson({
      action: "engagements-add",
      id,
      name: newEntry["name"],
      started: newEntry["started"],
      markers: markers.length,
      rendered: { written: renderResult.written, removed: renderResult.removed },
    });
    return;
  }
  emitText(`added engagement ${id} (${markers.length} marker pattern(s))`);
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
