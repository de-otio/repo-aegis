import {
  loadRegistry,
  renderMarkers,
  withLockSync,
  PatternValidationError,
  RegistryNotFoundError,
  LockTimeoutError,
  EXIT_USAGE,
} from "@de-otio/repo-aegis-core";
import { emitJson, emitText, emitError, type OutputOptions } from "../format.js";

interface RenderOptions extends OutputOptions {
  dryRun?: boolean;
}

export function render(opts: RenderOptions): void {
  let reg;
  try {
    reg = loadRegistry();
  } catch (err) {
    if (err instanceof RegistryNotFoundError) {
      emitError(
        {
          code: "REGISTRY_NOT_FOUND",
          error: "engagement registry not found",
          details: `expected at ${err.path}`,
        },
        opts,
      );
    }
    emitError({ error: (err as Error).message }, opts);
  }

  let result;
  try {
    if (opts.dryRun) {
      result = renderMarkers(reg, { dryRun: true });
    } else {
      result = withLockSync(() => renderMarkers(reg, { dryRun: false }));
    }
  } catch (err) {
    if (err instanceof LockTimeoutError) {
      emitError({ code: err.code, error: err.message }, opts);
    }
    if (err instanceof PatternValidationError) {
      if (opts.json) {
        emitJson({
          code: "PATTERN_VALIDATION",
          error: err.message,
          invalidPatterns: err.invalid,
        });
      } else {
        emitText(`repo-aegis: ${err.message} — render aborted, no files written`);
        for (const inv of err.invalid) {
          // Pattern is shown to the user (it's their own pattern from their
          // registry); reason is shown for diagnostic. The literal pattern
          // is not the same recency-pressure surface as a matched marker
          // value, since the user already authored it.
          emitText(`  ${inv.engagementId ?? "?"}: ${inv.reason}`);
        }
      }
      process.exit(EXIT_USAGE);
    }
    emitError({ error: (err as Error).message }, opts);
  }

  const summary = {
    dryRun: !!opts.dryRun,
    written: result.written,
    removed: result.removed,
    flat: result.flat,
  };

  if (opts.json) {
    emitJson(summary);
    return;
  }
  emitText(
    `repo-aegis render${opts.dryRun ? " (dry-run)" : ""}: wrote ${result.written.length} marker file${
      result.written.length === 1 ? "" : "s"
    }`,
  );
  for (const f of result.written) {
    emitText(`  ${f.engagementId}.txt — ${f.patternCount} pattern${f.patternCount === 1 ? "" : "s"}`);
  }
  for (const r of result.removed) {
    emitText(`  removed: ${r}`);
  }
  if (result.flat) emitText(`  (legacy flat union: ${result.flat})`);
}
