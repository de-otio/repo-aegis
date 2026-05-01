import { mkdirSync, existsSync, writeFileSync, chmodSync } from "node:fs";
import {
  repoAegisHome,
  registryPath,
  markersDir,
  statePath,
  renderMarkers,
  loadRegistry,
  RegistryNotFoundError,
  PatternValidationError,
} from "@de-otio/repo-aegis-core";
import { emitJson, emitText, emitError, type OutputOptions } from "../format.js";

const REGISTRY_STUB = `\
# repo-aegis engagement registry
# See: https://github.com/de-otio/repo-aegis
#
# \`always_block\`: list of regex patterns to block in EVERY repo regardless of class.
# \`engagements\`:  list of customer/employer engagements; each gets its own marker file.

# always_block example: uncomment and replace with your own patterns
# always_block:
#   - PROJECT-CODENAME-EXAMPLE
always_block: []

engagements:
  - id: example-customer
    name: Example Customer
    started: 2026-01-01
    markers: []
    notes: |
      Replace this with a real engagement entry. See the design doc for marker
      pattern conventions.
`;

interface InitOptions extends OutputOptions {
  force?: boolean;
  withHooks?: boolean;
  withClaude?: boolean;
}

export function init(opts: InitOptions): void {
  const home = repoAegisHome();
  const markers = markersDir(home);
  const state = statePath(home);
  const registry = registryPath(home);

  // Step 1: create directories with required permissions
  try {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    try {
      chmodSync(home, 0o700);
    } catch {
      /* platform-restricted */
    }

    mkdirSync(markers, { recursive: true, mode: 0o700 });
    try {
      chmodSync(markers, 0o700);
    } catch {
      /* platform-restricted */
    }

    mkdirSync(state, { recursive: true, mode: 0o700 });
    try {
      chmodSync(state, 0o700);
    } catch {
      /* platform-restricted */
    }
  } catch (err) {
    emitError({ code: "FS_ERROR", error: `failed to create home directories: ${(err as Error).message}` }, opts);
  }

  // Step 2: scaffold registry if missing or --force
  let registryScaffolded = false;
  let registryAlreadyExisted = false;

  if (!existsSync(registry) || opts.force) {
    registryAlreadyExisted = existsSync(registry) && !!opts.force;
    try {
      writeFileSync(registry, REGISTRY_STUB, { mode: 0o600 });
      try {
        chmodSync(registry, 0o600);
      } catch {
        /* platform-restricted */
      }
    } catch (err) {
      emitError({ code: "FS_ERROR", error: `failed to write registry: ${(err as Error).message}` }, opts);
    }
    registryScaffolded = true;
    if (!opts.json) {
      emitText("scaffolded engagements.yaml");
    }
  } else {
    registryAlreadyExisted = true;
    if (!opts.json) {
      emitText(`registry already exists at ${registry}`);
    }
  }

  // Step 3: render markers
  let reg;
  try {
    reg = loadRegistry(registry);
  } catch (err) {
    if (err instanceof RegistryNotFoundError) {
      emitError(
        {
          code: "REGISTRY_NOT_FOUND",
          error: "engagement registry not found after init",
          details: `expected at ${err.path}`,
        },
        opts,
      );
    }
    emitError({ code: "REGISTRY_ERROR", error: (err as Error).message }, opts);
  }

  let rendered;
  try {
    rendered = renderMarkers(reg);
  } catch (err) {
    if (err instanceof PatternValidationError) {
      if (opts.json) {
        process.stderr.write(
          JSON.stringify({ code: "PATTERN_VALIDATION", error: err.message, invalidPatterns: err.invalid }) + "\n",
        );
      } else {
        emitText(`repo-aegis: ${err.message} — render aborted`);
        for (const inv of err.invalid) {
          emitText(`  ${inv.engagementId ?? "?"}: ${inv.reason}`);
        }
      }
      process.exit(2);
    }
    emitError({ code: "RENDER_ERROR", error: (err as Error).message }, opts);
  }

  // Step 4: hooks/claude are deferred to v0.2.1
  const hooksDeferred = { deferred: true as const, reason: "v0.2.1 task" };
  const claudeDeferred = { deferred: true as const, reason: "v0.2.1 task" };

  if (!opts.json) {
    emitText("install hooks: deferred to v0.2.1 (separate task)");
  }

  if (opts.json) {
    emitJson({
      action: "init",
      home,
      registry: {
        path: registry,
        scaffolded: registryScaffolded,
        alreadyExisted: registryAlreadyExisted,
      },
      rendered: {
        written: rendered.written,
        removed: rendered.removed,
      },
      hooks: hooksDeferred,
      claude: claudeDeferred,
    });
    return;
  }
}
