#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
// Bin entry point. The Commander tree itself is built in `program.ts`
// so it can be introspected from tests without triggering parseAsync.
// Keep this file tiny — every line here is module-load side-effecting
// behaviour that the test runner does NOT want to inherit.
import { homeWarning } from "./format.js";
import { buildProgram } from "./program.js";

homeWarning();
const program = await buildProgram();
await program.parseAsync(process.argv);
