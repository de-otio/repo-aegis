import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { parseDocument, YAMLSeq, YAMLMap, Scalar, isMap } from "yaml";
import {
  registryPath as defaultRegistryPath,
  loadRegistry,
  validatePatterns,
  isActive,
  renderMarkers,
  PatternValidationError,
  RegistryNotFoundError,
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

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function backdated13MonthsIso(): string {
  const d = new Date();
  d.setMonth(d.getMonth() - 13);
  return d.toISOString().slice(0, 10);
}

function loadDoc(path: string): ReturnType<typeof parseDocument> {
  if (!existsSync(path)) throw new RegistryNotFoundError(path);
  const raw = readFileSync(path, "utf8");
  return parseDocument(raw);
}

function saveDoc(doc: ReturnType<typeof parseDocument>, path: string): void {
  writeFileSync(path, doc.toString(), { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* platform-restricted */
  }
}

function findEngagementNode(doc: ReturnType<typeof parseDocument>, id: string): YAMLMap | null {
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

  let doc;
  try {
    doc = loadDoc(path);
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

  const existing = findEngagementNode(doc!, id);
  if (existing) {
    emitError(
      {
        code: "ENGAGEMENT_EXISTS",
        error: `engagement "${id}" already exists; use \`engagements show ${id}\` to inspect`,
      },
      opts,
    );
  }

  const seq = doc!.get("engagements") as YAMLSeq;
  const newEntry: Record<string, unknown> = {
    id,
    name: opts.name ?? id,
    started: opts.started ?? todayIso(),
    markers,
  };
  seq.add(newEntry);

  saveDoc(doc!, path);

  let renderResult;
  try {
    const reg = loadRegistry(path);
    renderResult = renderMarkers(reg);
  } catch (err) {
    if (err instanceof PatternValidationError) {
      emitError(
        { code: "PATTERN_VALIDATION", error: err.message, details: err.invalid },
        opts,
      );
    }
    emitError({ code: "RENDER_ERROR", error: (err as Error).message }, opts);
  }

  if (opts.json) {
    emitJson({
      action: "engagements-add",
      id,
      name: newEntry["name"],
      started: newEntry["started"],
      markers: markers.length,
      rendered: { written: renderResult!.written, removed: renderResult!.removed },
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

  let doc;
  try {
    doc = loadDoc(path);
  } catch (err) {
    if (err instanceof RegistryNotFoundError) {
      emitError({ code: "REGISTRY_NOT_FOUND", error: "registry not found", details: err.path }, opts);
    }
    emitError({ error: (err as Error).message }, opts);
  }

  const node = findEngagementNode(doc!, id);
  if (!node) {
    emitError({ code: "ENGAGEMENT_NOT_FOUND", error: `engagement "${id}" not found` }, opts);
  }

  const endedDate = opts.purge ? backdated13MonthsIso() : todayIso();
  node!.set("ended", endedDate);

  saveDoc(doc!, path);

  let renderResult;
  try {
    const reg = loadRegistry(path);
    renderResult = renderMarkers(reg);
  } catch (err) {
    if (err instanceof PatternValidationError) {
      emitError(
        { code: "PATTERN_VALIDATION", error: err.message, details: err.invalid },
        opts,
      );
    }
    emitError({ code: "RENDER_ERROR", error: (err as Error).message }, opts);
  }

  if (opts.json) {
    emitJson({
      action: "engagements-end",
      id,
      ended: endedDate,
      purged: !!opts.purge,
      rendered: { written: renderResult!.written, removed: renderResult!.removed },
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

  let reg;
  try {
    reg = loadRegistry(path);
  } catch (err) {
    if (err instanceof RegistryNotFoundError) {
      emitError({ code: "REGISTRY_NOT_FOUND", error: "registry not found", details: err.path }, opts);
    }
    emitError({ error: (err as Error).message }, opts);
  }

  const e = reg!.engagements.find(x => x.id === id);
  if (!e) {
    emitError({ code: "ENGAGEMENT_NOT_FOUND", error: `engagement "${id}" not found` }, opts);
  }

  const active = isActive(e!);

  if (opts.json) {
    emitJson({
      action: "engagements-show",
      id: e!.id,
      name: e!.name,
      started: e!.started ?? null,
      ended: e!.ended ?? null,
      active,
      markerCount: e!.markers.length,
      notes: e!.notes ?? null,
    });
    return;
  }

  emitText(`id:       ${e!.id}`);
  emitText(`name:     ${e!.name}`);
  if (e!.started) emitText(`started:  ${e!.started}`);
  if (e!.ended) emitText(`ended:    ${e!.ended}`);
  emitText(`active:   ${active}`);
  emitText(`markers:  ${e!.markers.length} pattern(s)`);
  if (e!.notes) {
    emitText("notes:");
    for (const line of e!.notes.split("\n")) {
      emitText(`  ${line}`);
    }
  }
}
