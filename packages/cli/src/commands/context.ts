import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { leakContextFlagPath } from "@de-otio/repo-aegis-core";
import { emitJson, emitText, type OutputOptions } from "../format.js";

// ---------------------------------------------------------------------------
// Local helpers (core API surface is locked; these live here instead)
// ---------------------------------------------------------------------------

function isLeakContextOn(): boolean {
  return existsSync(leakContextFlagPath());
}

function setLeakContext(on: boolean): void {
  const path = leakContextFlagPath();
  if (on) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, "");
  } else if (existsSync(path)) {
    unlinkSync(path);
  }
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

export function contextOn(opts: OutputOptions): void {
  const flagPath = leakContextFlagPath();
  const wasOn = isLeakContextOn();
  setLeakContext(true);

  if (opts.json) {
    emitJson({ action: "context-on", flagPath, wasOn, isOn: true });
    return;
  }
  if (wasOn) {
    emitText("repo-aegis: leak-context strict mode is already on");
  } else {
    emitText("repo-aegis: leak-context strict mode enabled");
  }
}

export function contextOff(opts: OutputOptions): void {
  const flagPath = leakContextFlagPath();
  const wasOn = isLeakContextOn();
  setLeakContext(false);

  if (opts.json) {
    emitJson({ action: "context-off", flagPath, wasOn, isOn: false });
    return;
  }
  if (wasOn) {
    emitText("repo-aegis: leak-context strict mode disabled");
  } else {
    emitText("repo-aegis: leak-context strict mode is already off");
  }
}

export function contextStatus(opts: OutputOptions): void {
  const flagPath = leakContextFlagPath();
  const isOn = isLeakContextOn();

  if (opts.json) {
    emitJson({ action: "context-status", flagPath, isOn });
    return;
  }
  emitText(`repo-aegis: leak-context strict mode is ${isOn ? "on" : "off"}`);
}
