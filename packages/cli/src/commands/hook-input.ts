// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Richard Myers and contributors.
//
// Reading a Claude Code hook payload (issue #156). Each hook caps what it reads from stdin. Until 0.11.3 the
// write hooks and the Bash-output hook cut the payload at the cap and then ran `JSON.parse` on the prefix,
// which always fails, so a payload past the cap was neither checked nor scanned (and the hooks exited 0).
// This module keeps the cap but says when it cut, and reads the fields the hooks need from a prefix: the
// path is near the start of a Write/Edit payload, and the file itself is scanned from disk anyway.

/** Bytes a hook reads from stdin before it stops. */
export const WRITE_HOOK_INPUT_MAX_BYTES = 1024 * 1024;

/** Read stdin up to `max` bytes; `truncated` says there was more. The rest is drained, not buffered. */
export async function readHookStdin(max: number): Promise<{ text: string; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  for await (const chunk of process.stdin) {
    if (truncated) continue; // drain, so the writer is not left blocked on a full pipe
    const b = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    if (total + b.length > max) {
      chunks.push(b.subarray(0, max - total));
      total = max;
      truncated = true;
      continue;
    }
    chunks.push(b);
    total += b.length;
  }
  return { text: Buffer.concat(chunks).toString("utf8"), truncated };
}

export interface HookWriteFields {
  /** `tool_input.file_path`, or the older `tool_input.path`. */
  filePath?: string;
  /** The session's working directory, a top-level field. */
  cwd?: string;
}

/**
 * The fields of a Write/Edit hook payload: from `JSON.parse` when the text is whole, otherwise from
 * {@link scanJsonPrefix} on what was read. Pure; never throws.
 */
export function parseHookWriteFields(text: string): HookWriteFields {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fieldsFromStrings(scanJsonPrefix(text));
  }
  if (!parsed || typeof parsed !== "object") return {};
  const root = parsed as Record<string, unknown>;
  const out: HookWriteFields = {};
  const ti = root["tool_input"];
  if (ti && typeof ti === "object") {
    const tiObj = ti as Record<string, unknown>;
    for (const k of ["file_path", "path"]) {
      const v = tiObj[k];
      if (typeof v === "string" && v.length > 0) {
        out.filePath = v;
        break;
      }
    }
  }
  const cwd = root["cwd"];
  if (typeof cwd === "string" && cwd.length > 0) out.cwd = cwd;
  return out;
}

function fieldsFromStrings(strings: ReadonlyMap<string, string>): HookWriteFields {
  const out: HookWriteFields = {};
  const fp = strings.get("tool_input.file_path") || strings.get("tool_input.path");
  if (fp) out.filePath = fp;
  const cwd = strings.get("cwd");
  if (cwd) out.cwd = cwd;
  return out;
}

/**
 * The complete string values found in a JSON text that may be cut off anywhere, keyed by their dotted
 * object path (`cwd`, `tool_input.file_path`); values inside arrays are skipped. A real lexer, so a key
 * that only appears inside another string's content (`"content": "{\"file_path\": …}"`) is never taken
 * for one. A value cut off by the end of the text is not reported. The first occurrence of a path wins.
 * Linear in the text. Pure; never throws.
 */
export function scanJsonPrefix(text: string): Map<string, string> {
  const out = new Map<string, string>();
  // One frame per open container: an object tracks the key whose value comes next.
  const stack: Array<{ kind: "object"; path: string; key: string | null; expectKey: boolean } | { kind: "array" }> = [];
  let i = 0;
  const n = text.length;

  /** A string token starting at text[i] === '"': its decoded value and the index after it, or null if cut off. */
  const readString = (): { value: string; end: number } | null => {
    let j = i + 1;
    let raw = "";
    while (j < n) {
      const c = text[j]!;
      if (c === "\\") {
        if (j + 1 >= n) return null;
        raw += c + text[j + 1]!;
        j += 2;
        continue;
      }
      if (c === '"') {
        try {
          return { value: JSON.parse(`"${raw}"`) as string, end: j + 1 };
        } catch {
          return null; // an invalid escape: not JSON, stop trusting the text
        }
      }
      raw += c;
      j++;
    }
    return null;
  };

  while (i < n) {
    const c = text[i]!;
    const top = stack[stack.length - 1];
    if (c === "{") {
      if (top?.kind === "array") {
        stack.push({ kind: "array" }); // an object inside an array: its strings are skipped like the array's
      } else {
        const path = top !== undefined && top.key !== null ? (top.path ? `${top.path}.${top.key}` : top.key) : "";
        stack.push({ kind: "object", path, key: null, expectKey: true });
      }
      i++;
      continue;
    }
    if (c === "[") {
      stack.push({ kind: "array" });
      i++;
      continue;
    }
    if (c === "}" || c === "]") {
      stack.pop();
      const parent = stack[stack.length - 1];
      if (parent?.kind === "object") parent.key = null;
      i++;
      continue;
    }
    if (c === ",") {
      if (top?.kind === "object") {
        top.expectKey = true;
        top.key = null;
      }
      i++;
      continue;
    }
    if (c === '"') {
      const s = readString();
      if (s === null) return out;
      if (top?.kind === "object") {
        if (top.expectKey) {
          top.key = s.value;
          top.expectKey = false;
        } else if (top.key !== null) {
          const path = top.path ? `${top.path}.${top.key}` : top.key;
          if (!out.has(path)) out.set(path, s.value);
        }
      }
      i = s.end;
      continue;
    }
    i++; // `:`, whitespace, numbers, literals
  }
  return out;
}

/** The refusal text for a write hook that could not find the path in a payload it had to cut. */
export const WRITE_HOOK_INPUT_TOO_LARGE_REASON =
  "repo-aegis: refused. This write's hook payload is larger than 1 MiB and the file path could not be read from " +
  "its start, so the write could not be checked. No approval covers this. Fix: write the file in smaller parts " +
  "(a first Write, then Edits), or have your human check the payload. See doc/agent-guide.md#hook_input_too_large.";
