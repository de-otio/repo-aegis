// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
// Test-only helper (underscore-prefixed: not a runtime module): make the
// process's git environment hermetic, so that no outer `GIT_SSH_COMMAND`,
// `GIT_CONFIG_*` (a sandbox or CI wrapper often sets them) or user git config
// leaks into a test. The ssh override check reads exactly these.

const SCRUBBED = /^(GIT_SSH.*|GIT_CONFIG_(COUNT|PARAMETERS|KEY_\d+|VALUE_\d+))$/;

/** Remove the ssh/config variables from `process.env`, pin global/system config off; returns the undo. */
export function scrubGitEnv(): () => void {
  const saved: Record<string, string | undefined> = {};
  const touch = (name: string, value: string | undefined): void => {
    if (!(name in saved)) saved[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  for (const name of Object.keys(process.env)) if (SCRUBBED.test(name)) touch(name, undefined);
  touch("GIT_CONFIG_GLOBAL", "/dev/null");
  touch("GIT_CONFIG_NOSYSTEM", "1");
  return () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

/** An environment for a child `git`: the current one, scrubbed, plus `extra`. */
export function hermeticGitEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!SCRUBBED.test(k)) env[k] = v;
  env["GIT_CONFIG_GLOBAL"] = "/dev/null";
  env["GIT_CONFIG_NOSYSTEM"] = "1";
  return { ...env, ...extra };
}
