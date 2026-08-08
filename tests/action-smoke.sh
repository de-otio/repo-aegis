#!/usr/bin/env bash
# Smoke test for every composite action this repo ships.
#
# Validates, per action.yml:
#   - syntactically valid YAML
#   - top-level required keys are present (name, description, runs)
#   - runs.using is "composite"
#   - every entry under inputs.* / outputs.* has a description
#
# Plus the security properties the 0.8.0 hardening depends on, which are easy
# to lose in a later edit and invisible until the day they matter:
#   - the CLI install runs from outside the consumer's checkout, with
#     --ignore-scripts and an explicit registry (a PR-supplied .npmrc must not
#     be able to repoint the install)
#   - the install is version-pinned, not `latest`
#   - fail-closed and attribution-redaction wiring is present in the main action
#
# Runnable as `bash tests/action-smoke.sh` from the repo root.

set -euo pipefail

# Resolve repo root from this script's location so the test can be run
# from any cwd.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

# `actions/scan/action.yml` is the Layer-2 sweep wrapper added in 0.8.0 — a new
# install path, so it gets the same validation as the original.
ACTION_YMLS=("${REPO_ROOT}/action.yml")
for nested in "${REPO_ROOT}"/actions/*/action.yml; do
  [ -f "$nested" ] && ACTION_YMLS+=("$nested")
done

for f in "${ACTION_YMLS[@]}"; do
  if [ ! -f "${f}" ]; then
    echo "FAIL: ${f} does not exist" >&2
    exit 1
  fi
done

if ! command -v python3 >/dev/null 2>&1; then
  echo "FAIL: python3 is required to run this smoke test" >&2
  exit 1
fi

python3 - "${ACTION_YMLS[@]}" <<'PY'
import sys

try:
    import yaml
except ImportError:
    sys.stderr.write("FAIL: PyYAML is required (pip install pyyaml)\n")
    sys.exit(1)

errors = []


def check(path):
    """Validate one action.yml. Appends to the shared `errors` list."""
    label = path.split("repo-aegis/")[-1]

    try:
        with open(path, "r", encoding="utf-8") as f:
            doc = yaml.safe_load(f)
    except yaml.YAMLError as exc:
        errors.append(f"{label}: not valid YAML: {exc}")
        return None

    if not isinstance(doc, dict):
        errors.append(f"{label}: must parse to a mapping")
        return None

    # 1) Required top-level keys.
    for key in ("name", "description", "runs"):
        if key not in doc:
            errors.append(f"{label}: missing top-level key: {key}")
        elif not doc[key]:
            errors.append(f"{label}: top-level key has empty value: {key}")

    # 2) runs.using == composite.
    runs = doc.get("runs")
    if isinstance(runs, dict):
        using = runs.get("using")
        if using != "composite":
            errors.append(f"{label}: runs.using must be 'composite' (got {using!r})")
        steps = runs.get("steps")
        if not isinstance(steps, list) or not steps:
            errors.append(f"{label}: runs.steps must be a non-empty list")
    else:
        errors.append(f"{label}: runs must be a mapping")

    # 3) Every input must have a description.
    inputs = doc.get("inputs")
    if inputs is not None:
        if not isinstance(inputs, dict):
            errors.append(f"{label}: inputs must be a mapping")
        else:
            for name, spec in inputs.items():
                if not isinstance(spec, dict):
                    errors.append(f"{label}: inputs.{name} must be a mapping")
                    continue
                desc = spec.get("description")
                if not isinstance(desc, str) or not desc.strip():
                    errors.append(f"{label}: inputs.{name} is missing a non-empty description")

    # 4) Outputs (if present) must have descriptions too — stricter than
    #    GitHub requires, but it catches the same class of bug.
    outputs = doc.get("outputs")
    if isinstance(outputs, dict):
        for name, spec in outputs.items():
            if not isinstance(spec, dict):
                errors.append(f"{label}: outputs.{name} must be a mapping")
                continue
            desc = spec.get("description")
            if not isinstance(desc, str) or not desc.strip():
                errors.append(f"{label}: outputs.{name} is missing a non-empty description")

    # 5) Install-step hardening. npm reads ./.npmrc from the working directory,
    #    so an install run from the consumer's checkout can be redirected by a
    #    file the PR author controls — and the substituted package's install
    #    scripts would then execute in a job that may hold a registry secret.
    steps = runs.get("steps") if isinstance(runs, dict) else []
    install_steps = [
        s for s in (steps or [])
        if isinstance(s, dict) and isinstance(s.get("run"), str) and "npm install -g" in s["run"]
    ]
    if not install_steps:
        errors.append(f"{label}: expected an `npm install -g` step")
    for s in install_steps:
        run = s["run"]
        if "--ignore-scripts" not in run:
            errors.append(f"{label}: install step must pass --ignore-scripts")
        if "--registry=https://registry.npmjs.org" not in run:
            errors.append(f"{label}: install step must pass an explicit --registry")
        if s.get("working-directory") != "${{ runner.temp }}":
            errors.append(
                f"{label}: install step must run from ${{{{ runner.temp }}}}, "
                "not the consumer's checkout (a PR-supplied .npmrc would otherwise apply)"
            )
        if "@${REPO_AEGIS_VERSION}" not in run and "@${REPO_AEGIS_SCAN_VERSION}" not in run:
            errors.append(f"{label}: install step must be version-pinned via an env var")

    # 6) The version input must not default to `latest`: a compromised publish
    #    would otherwise reach every consumer's gate on their next run.
    version_default = ((inputs or {}).get("version") or {}).get("default")
    if version_default in (None, "", "latest"):
        errors.append(
            f"{label}: inputs.version must default to a pinned version, not {version_default!r}"
        )

    return doc


docs = {}
for path in sys.argv[1:]:
    docs[path] = check(path)

# 7) Main-action-only: the fail-closed and redaction wiring. These are what
#    stop a missing registry reading as a clean scan, and stop engagement ids
#    reaching a job log.
main = next((d for p, d in docs.items() if p.endswith("/action.yml") and "/actions/" not in p), None)
if main:
    body = yaml.dump(main)
    for needle, why in [
        ("require-deny-set", "fail-closed input"),
        ("redact-attribution", "attribution-redaction input"),
        ("REPO_AEGIS_MIN_PATTERNS", "fail-closed env wiring"),
        ("REPO_AEGIS_REDACT_ATTRIBUTION", "redaction env wiring"),
        ("results-file", "file-based output (never interpolate scan output into run:)"),
    ]:
        if needle not in body:
            errors.append(f"action.yml: missing {why} ({needle})")

if errors:
    sys.stderr.write("FAIL: composite action validation errors:\n")
    for err in errors:
        sys.stderr.write(f"  - {err}\n")
    sys.exit(1)

for path, doc in docs.items():
    if doc is None:
        continue
    label = path.split("repo-aegis/")[-1]
    print(f"OK: {label} is valid")
    print(f"  name:        {doc['name']}")
    print(f"  inputs:      {len(doc.get('inputs') or {})}")
    print(f"  outputs:     {len(doc.get('outputs') or {})}")
PY
