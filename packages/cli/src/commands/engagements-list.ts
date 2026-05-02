// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
import { loadRegistry, isActive, RegistryNotFoundError } from "@de-otio/repo-aegis-core";
import { emitJson, emitText, emitError } from "../format.js";

interface ListOptions {
  json?: boolean;
  all?: boolean;
}

export function engagementsList(opts: ListOptions): void {
  let reg;
  try {
    reg = loadRegistry();
  } catch (err) {
    if (err instanceof RegistryNotFoundError) {
      emitError(
        { error: "engagement registry not found", details: `expected at ${err.path}` },
        opts,
      );
    }
    emitError({ error: (err as Error).message }, opts);
  }
  const filtered = opts.all ? reg.engagements : reg.engagements.filter(isActive);

  if (opts.json) {
    emitJson({
      engagements: filtered.map(e => ({
        id: e.id,
        name: e.name,
        started: e.started ?? null,
        ended: e.ended ?? null,
        active: isActive(e),
        markerCount: e.markers.length,
      })),
      alwaysBlock: { patternCount: reg.alwaysBlock.length },
    });
    return;
  }

  emitText(`repo-aegis engagements (${filtered.length} active${opts.all ? " + retained ended" : ""}):`);
  if (filtered.length === 0) {
    emitText("  (none)");
  } else {
    for (const e of filtered) {
      const status = e.ended
        ? `ended ${e.ended}`
        : `active${e.started ? ` since ${e.started}` : ""}`;
      emitText(`  ${e.id.padEnd(30)} ${e.name.padEnd(20)} ${status}  ${e.markers.length} patterns`);
    }
  }
  emitText(`always-block: ${reg.alwaysBlock.length} pattern${reg.alwaysBlock.length === 1 ? "" : "s"}`);
}
