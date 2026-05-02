// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
// Thin re-export of the age helpers, factored into core so the cli's
// `registry encrypt` / `registry decrypt` commands can share the same
// machinery without scan being a dependency of cli. Tests for the
// behaviour live alongside this module (age.test.ts) and exercise the
// re-exported surface — they remain valid.

export {
  encryptFile,
  decryptFile,
  writeBufferTo,
  AgeNotFoundError,
  AgeError,
} from "@de-otio/repo-aegis-core";
export type { EncryptOptions, DecryptOptions } from "@de-otio/repo-aegis-core";
