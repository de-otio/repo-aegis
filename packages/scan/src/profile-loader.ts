// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Load all engagement profiles from a profiles directory. Used by
// `run --semantic` and `rebuild-profiles`.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readProfile, type EngagementProfile } from "@de-otio/repo-aegis-llm";

export interface LoadProfilesResult {
  profiles: EngagementProfile[];
  errors: Array<{ engagementId: string; error: string }>;
}

export const DEFAULT_PROFILES_DIR_FROM_HOME = ".config/repo-aegis";

/**
 * Read every `*.json` file in `<home>/profiles/` and return the parsed
 * profiles. Files that fail to parse are recorded in `errors` and do
 * not abort the load — one bad profile should not prevent the sweep
 * from running against the remaining engagements.
 *
 * `home` is the repo-aegis config root (typically
 * `~/.config/repo-aegis`), NOT the user's `$HOME`. This mirrors
 * `profile.ts` which takes the same parameter.
 */
export function loadAllProfiles(home: string): LoadProfilesResult {
  const dir = join(home, "profiles");
  if (!existsSync(dir)) return { profiles: [], errors: [] };

  const profiles: EngagementProfile[] = [];
  const errors: Array<{ engagementId: string; error: string }> = [];

  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    if (/\.tmp\./.test(name)) continue;
    const engagementId = name.slice(0, -".json".length);
    try {
      const p = readProfile(home, engagementId);
      if (p !== null) profiles.push(p);
    } catch (err) {
      errors.push({ engagementId, error: (err as Error).message });
    }
  }

  return { profiles, errors };
}
