#!/usr/bin/env bash
# Smoke test for action.yml at the repo root.
#
# Validates:
#   - action.yml is syntactically valid YAML.
#   - top-level required keys are present (name, description, runs).
#   - runs.using is "composite".
#   - every entry under inputs.* has a description.
#
# Runnable as `bash tests/action-smoke.sh` from the repo root.

set -euo pipefail

# Resolve repo root from this script's location so the test can be run
# from any cwd.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
ACTION_YML="${REPO_ROOT}/action.yml"

if [ ! -f "${ACTION_YML}" ]; then
  echo "FAIL: ${ACTION_YML} does not exist" >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "FAIL: python3 is required to run this smoke test" >&2
  exit 1
fi

python3 - "${ACTION_YML}" <<'PY'
import sys

try:
    import yaml
except ImportError:
    sys.stderr.write(
        "FAIL: PyYAML is required (pip install pyyaml)\n"
    )
    sys.exit(1)

action_path = sys.argv[1]

# 1) Syntactically valid YAML.
try:
    with open(action_path, "r", encoding="utf-8") as f:
        doc = yaml.safe_load(f)
except yaml.YAMLError as exc:
    sys.stderr.write(f"FAIL: action.yml is not valid YAML: {exc}\n")
    sys.exit(1)

if not isinstance(doc, dict):
    sys.stderr.write("FAIL: action.yml must parse to a mapping\n")
    sys.exit(1)

errors = []

# 2) Required top-level keys.
for key in ("name", "description", "runs"):
    if key not in doc:
        errors.append(f"missing top-level key: {key}")
    elif not doc[key]:
        errors.append(f"top-level key has empty value: {key}")

# 3) runs.using == composite.
runs = doc.get("runs")
if isinstance(runs, dict):
    using = runs.get("using")
    if using != "composite":
        errors.append(
            f"runs.using must be 'composite' (got {using!r})"
        )
    steps = runs.get("steps")
    if not isinstance(steps, list) or not steps:
        errors.append("runs.steps must be a non-empty list")
else:
    errors.append("runs must be a mapping")

# 4) Every input must have a description.
inputs = doc.get("inputs")
if inputs is not None:
    if not isinstance(inputs, dict):
        errors.append("inputs must be a mapping")
    else:
        for name, spec in inputs.items():
            if not isinstance(spec, dict):
                errors.append(f"inputs.{name} must be a mapping")
                continue
            desc = spec.get("description")
            if not isinstance(desc, str) or not desc.strip():
                errors.append(
                    f"inputs.{name} is missing a non-empty description"
                )

# 5) Outputs (if present) must have descriptions too — stricter than
#    GitHub requires, but it catches the same class of bug.
outputs = doc.get("outputs")
if isinstance(outputs, dict):
    for name, spec in outputs.items():
        if not isinstance(spec, dict):
            errors.append(f"outputs.{name} must be a mapping")
            continue
        desc = spec.get("description")
        if not isinstance(desc, str) or not desc.strip():
            errors.append(
                f"outputs.{name} is missing a non-empty description"
            )

if errors:
    sys.stderr.write("FAIL: action.yml validation errors:\n")
    for err in errors:
        sys.stderr.write(f"  - {err}\n")
    sys.exit(1)

print("OK: action.yml is valid")
print(f"  name:        {doc['name']}")
print(f"  description: {doc['description']}")
print(f"  inputs:      {len(inputs or {})}")
print(f"  outputs:     {len(outputs or {})}")
PY
