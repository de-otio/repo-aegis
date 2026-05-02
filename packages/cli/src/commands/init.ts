import { mkdirSync, existsSync, writeFileSync, chmodSync } from "node:fs";
import {
  repoAegisHome,
  registryPath,
  markersDir,
  statePath,
  renderMarkers,
  loadRegistry,
  withLockSync,
  RegistryNotFoundError,
  PatternValidationError,
  LockTimeoutError,
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
  /** When --with-hooks runs installHooks, this is the cwd it targets. */
  cwd?: string;
  /** Override ~/.claude path used by --with-claude. */
  claudeHome?: string;
}

export async function init(opts: InitOptions): Promise<void> {
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
    rendered = withLockSync(() => renderMarkers(reg));
  } catch (err) {
    if (err instanceof LockTimeoutError) {
      emitError({ code: err.code, error: err.message }, opts);
    }
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

  // Step 4: install hooks (per-repo) when --with-hooks. Default on.
  // Side-loaded via dynamic import to avoid a cycle (install-hooks.ts
  // doesn't import init, but init keeps the import out of the module
  // top-level so test suites that don't exercise this path stay fast).
  type HooksResult =
    | { ran: true; hooksDir: string }
    | { ran: false; reason: string };
  let hooksResult: HooksResult = { ran: false, reason: "--no-with-hooks" };
  if (opts.withHooks !== false) {
    try {
      const { installHooks } = await import("./install-hooks.js");
      installHooks({
        ...(opts.cwd !== undefined && { cwd: opts.cwd }),
        force: opts.force,
        silent: true,
      });
      hooksResult = { ran: true, hooksDir: `${home}/hooks` };
    } catch (err) {
      // installHooks calls process.exit via emitError on hard failures
      // (NOT_GIT_REPO, FS_ERROR, HOOKS_PATH_CONFLICT). Catching here is
      // best-effort: in practice the throw aborts the process, so we
      // only see this branch on truly unexpected exceptions.
      hooksResult = { ran: false, reason: `install-hooks failed: ${(err as Error).message}` };
    }
  }

  type ClaudeResult =
    | { ran: true; claudeHome: string }
    | { ran: false; reason: string };
  let claudeResult: ClaudeResult = { ran: false, reason: "--no-with-claude" };
  if (opts.withClaude !== false) {
    try {
      const { installClaudeMd } = await import("./install-claude-md.js");
      installClaudeMd({
        ...(opts.claudeHome !== undefined && { claudeHome: opts.claudeHome }),
        silent: true,
      });
      claudeResult = { ran: true, claudeHome: opts.claudeHome ?? "~/.claude" };
    } catch (err) {
      claudeResult = { ran: false, reason: `install-claude-md failed: ${(err as Error).message}` };
    }
  }

  if (!opts.json) {
    if (hooksResult.ran) emitText(`hooks: installed at ${hooksResult.hooksDir}`);
    else emitText(`hooks: skipped (${hooksResult.reason})`);
    if (claudeResult.ran) emitText(`claude-md: installed at ${claudeResult.claudeHome}`);
    else emitText(`claude-md: skipped (${claudeResult.reason})`);
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
      hooks: hooksResult,
      claude: claudeResult,
    });
    return;
  }
}
