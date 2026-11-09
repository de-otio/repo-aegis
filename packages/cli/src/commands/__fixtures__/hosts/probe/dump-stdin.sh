#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Richard Myers and contributors.
#
# Probe hook for plan task H1 (doc/plan-landscape-recommendations.md §5):
# copies the host's hook stdin to a file so a real payload can replace a
# doc-derived fixture. It decides nothing.
#
#   dump-stdin.sh <host> <out-dir>
#
# Register it ONLY in a project-level config inside a throwaway directory
# (Cursor: <tmp>/.cursor/hooks.json; Copilot: <tmp>/.github/hooks/probe.json;
# Antigravity: <tmp>/.agents/hooks.json), never in a global one. Each payload
# lands in <out-dir>/<host>.<epoch-ns>.json.
#
# What it prints is the host's "no opinion" answer, because some hosts treat
# empty stdout as an error: Cursor documents that a permission hook's invalid
# or schema-mismatched output BLOCKS the action.
host="${1:?usage: dump-stdin.sh <host> <out-dir>}"
out="${2:?usage: dump-stdin.sh <host> <out-dir>}"
mkdir -p "$out"
cat > "$out/$host.$(date +%s)$$.json"
case "$host" in
  cursor) printf '{"permission":"allow"}\n' ;;
  antigravity) printf '{"decision":"allow"}\n' ;;
  *) : ;; # Claude Code, Codex, Gemini, Copilot: empty stdout + exit 0 = no decision
esac
exit 0
