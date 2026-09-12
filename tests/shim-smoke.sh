#!/usr/bin/env bash
# Smoke test for the `gh` PATH shim (doc/design/egress-guard.md §3).
#
# The shim is the one piece of this design that is not TypeScript: it is a
# bash script that sits in front of `gh` for every agent and every terminal
# on the machine. Unit tests can assert what `install shim` writes; only an
# end-to-end run can assert what that script DOES. Four properties, each of
# which would be a real defect if it broke:
#
#   a) reads pass through byte-for-byte (`gh --version`, `gh api <GET>`) —
#      a shim that mangles ordinary output gets uninstalled by lunchtime;
#   b) a mode-dependent body path is refused with exit 2 — the shape of the
#      2026-09-07 incident;
#   c) a permitted `pr create` with a body file actually runs `gh` AND reads
#      the published body back, exiting 1 on a mismatch;
#   d) with nothing but the shim's own directory on PATH the shim exits 127
#      instead of exec'ing itself forever.
#
# Assumes `npm run build` has run. Runnable as `bash tests/shim-smoke.sh`
# from anywhere; `npm run test:shim` is the same thing.
#
# `set -e` is deliberately absent: this script inspects exit codes.
set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
CLI="${REPO_ROOT}/packages/cli/dist/index.js"

if [ ! -f "${CLI}" ]; then
  echo "FAIL: ${CLI} not found - run \`npm run build\` first" >&2
  exit 1
fi

failures=0
pass() { echo "ok   - $1"; }
fail() { echo "FAIL - $1" >&2; failures=$((failures + 1)); }

# ---------------------------------------------------------------------------
# Fixture
# ---------------------------------------------------------------------------
# Under $HOME, NOT under $TMPDIR: the payload rule this test exercises refuses
# a body file under `/var/folders/**` (macOS's temp root) or `/tmp/claude-*`,
# so a fixture in the temp dir would be denied on one platform and allowed on
# another and case (c) could never pass on both.
WORK="$(mktemp -d "${HOME}/.repo-aegis-shim-smoke-XXXXXX")" || {
  echo "FAIL: could not create a work directory under \$HOME" >&2
  exit 1
}
cleanup() { rm -rf "${WORK}"; }
trap cleanup EXIT

export REPO_AEGIS_HOME="${WORK}/repo-aegis"
# Never read the developer's real git config; the temp repos below set their own.
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_SYSTEM=/dev/null
export GIT_CONFIG_NOSYSTEM=1
mkdir -p "${REPO_AEGIS_HOME}"

NODE_BIN="$(command -v node)"
if [ -z "${NODE_BIN}" ]; then
  echo "FAIL: node is required" >&2
  exit 1
fi

# A `repo-aegis` the shim can find on PATH.
BIN="${WORK}/bin"
mkdir -p "${BIN}"
cat > "${BIN}/repo-aegis" <<EOF
#!/bin/sh
exec "${NODE_BIN}" "${CLI}" "\$@"
EOF
chmod 755 "${BIN}/repo-aegis"

# The fake `gh` the shim should find and run. It echoes its argv so a
# pass-through can be compared byte-for-byte, invents a PR URL for
# \`pr create\`, and serves a DIFFERENT body for \`pr view\` so the read-back
# has a genuine mismatch to report.
FAKE="${WORK}/fake-gh"
mkdir -p "${FAKE}"
SEED="${WORK}/published-body.txt"
printf 'A COMPLETELY DIFFERENT DOCUMENT' > "${SEED}"
cat > "${FAKE}/gh" <<EOF
#!/bin/sh
if [ "\$1" = "pr" ] && [ "\$2" = "view" ]; then
  cat "${SEED}"
  exit 0
fi
if [ "\$1" = "pr" ] && [ "\$2" = "create" ]; then
  echo "gh argv: \$*"
  echo "https://github.com/acme/svc/pull/4242"
  exit 0
fi
if [ "\$1" = "release" ] && [ "\$2" = "create" ]; then
  echo "HTTP 422: Validation Failed" >&2
  exit 1
fi
echo "gh argv: \$*"
exit 0
EOF
chmod 755 "${FAKE}/gh"

# A destination repo: a private-strict class, so the decision turns on the
# payload path and not on the public-destination rule.
REPO="${WORK}/svc"
mkdir -p "${REPO}"
git -C "${REPO}" init -q -b main
git -C "${REPO}" remote add origin git@github.com:acme/svc.git
git -C "${REPO}" config repo-aegis.class private-strict

"${BIN}/repo-aegis" install shim >/dev/null 2>&1
SHIM_DIR="${REPO_AEGIS_HOME}/bin"
if [ -x "${SHIM_DIR}/gh" ]; then
  pass "install shim wrote an executable ${SHIM_DIR}/gh"
else
  fail "install shim did not write an executable ${SHIM_DIR}/gh"
  echo "${failures} failure(s)" >&2
  exit 1
fi

export PATH="${SHIM_DIR}:${FAKE}:${BIN}:${PATH}"

# A watchdog, so a shim that ever did resolve to itself fails this test in
# seconds instead of wedging the run. `timeout` is GNU; macOS has perl.
run_with_timeout() {
  secs="$1"
  shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "${secs}" "$@"
  else
    perl -e '$SIG{ALRM} = sub { exit 124 }; alarm shift; exec @ARGV or exit 127;' "${secs}" "$@"
  fi
}

# ---------------------------------------------------------------------------
# a) reads pass through byte-for-byte
# ---------------------------------------------------------------------------
direct_version="$("${FAKE}/gh" --version 2>/dev/null)"
shim_version="$(cd "${REPO}" && run_with_timeout 20 gh --version 2>/dev/null)"
if [ "${direct_version}" = "${shim_version}" ] && [ -n "${direct_version}" ]; then
  pass "a) gh --version passes through byte-for-byte"
else
  fail "a) gh --version was altered: direct=[${direct_version}] shim=[${shim_version}]"
fi

direct_api="$("${FAKE}/gh" api repos/acme/svc 2>/dev/null)"
shim_api="$(cd "${REPO}" && run_with_timeout 20 gh api repos/acme/svc 2>/dev/null)"
if [ "${direct_api}" = "${shim_api}" ] && [ -n "${direct_api}" ]; then
  pass "a) gh api <GET> passes through byte-for-byte"
else
  fail "a) gh api <GET> was altered: direct=[${direct_api}] shim=[${shim_api}]"
fi

# ---------------------------------------------------------------------------
# b) a mode-dependent body path is refused
# ---------------------------------------------------------------------------
b_rc=0
(
  cd "${REPO}" && run_with_timeout 20 gh pr create --title t --body-file /var/folders/xx/pr.md
) >"${WORK}/b.out" 2>"${WORK}/b.err" || b_rc=$?
if [ "${b_rc}" -eq 2 ]; then
  pass "b) a /var/folders body path exits 2"
else
  fail "b) expected exit 2 for a /var/folders body path, got ${b_rc}"
fi
if grep -q "PAYLOAD_MODE_DEPENDENT_PATH" "${WORK}/b.err"; then
  pass "b) the deny reason reaches stderr"
else
  fail "b) PAYLOAD_MODE_DEPENDENT_PATH not found on stderr: $(cat "${WORK}/b.err")"
fi
if grep -q "gh argv" "${WORK}/b.out"; then
  fail "b) the real gh RAN despite the deny"
else
  pass "b) the real gh never ran"
fi

# ---------------------------------------------------------------------------
# c) a permitted pr create runs gh and then reads the body back
# ---------------------------------------------------------------------------
BODY="${WORK}/pr-body.md"
printf 'THE-BODY-WE-MEANT-TO-PUBLISH\n' > "${BODY}"
c_rc=0
(
  cd "${REPO}" &&
    REPO_AEGIS_EGRESS_HUMAN=1 run_with_timeout 30 gh pr create --title t --body-file "${BODY}"
) >"${WORK}/c.out" 2>"${WORK}/c.err" || c_rc=$?

if grep -q "gh argv: pr create" "${WORK}/c.out"; then
  pass "c) the real gh ran, with argv intact"
else
  fail "c) the real gh did not run: $(cat "${WORK}/c.out")"
fi
if grep -q "PUBLISHED_BODY_MISMATCH" "${WORK}/c.err"; then
  pass "c) the read-back reported PUBLISHED_BODY_MISMATCH"
else
  fail "c) no PUBLISHED_BODY_MISMATCH on stderr: $(cat "${WORK}/c.err")"
fi
if [ "${c_rc}" -eq 1 ]; then
  pass "c) a confirmed mismatch exits 1"
else
  fail "c) expected exit 1 after a mismatch, got ${c_rc}"
fi
if grep -q "THE-BODY-WE-MEANT-TO-PUBLISH" "${WORK}/c.err" ||
  grep -q "A COMPLETELY DIFFERENT DOCUMENT" "${WORK}/c.err"; then
  fail "c) body content leaked into the mismatch report"
else
  pass "c) the mismatch report carries byte counts, not content"
fi

if grep -q "^PUBLISHED → acme/svc" "${WORK}/c.err"; then
  pass "c) the receipt names the destination"
else
  fail "c) no receipt on stderr: $(cat "${WORK}/c.err")"
fi

# ---------------------------------------------------------------------------
# e) a receipt never claims a publish that did not happen
# ---------------------------------------------------------------------------
# The fake gh fails `release create` the way the real one did on 2026-09-12
# (HTTP 422). Until v0.9.2 the shim had already printed PUBLISHED by then.
e_rc=0
(
  cd "${REPO}" &&
    REPO_AEGIS_EGRESS_HUMAN=1 run_with_timeout 30 gh release create v9.9.9 --title t
) >"${WORK}/e.out" 2>"${WORK}/e.err" || e_rc=$?

if [ "${e_rc}" -eq 1 ]; then
  pass "e) gh's own exit code is preserved"
else
  fail "e) expected gh's exit 1, got ${e_rc}"
fi
if grep -q "PUBLISHED" "${WORK}/e.err" "${WORK}/e.out"; then
  fail "e) a PUBLISHED receipt for a publish that failed: $(cat "${WORK}/e.err")"
else
  pass "e) no PUBLISHED receipt for a failed gh"
fi
if grep -q "^EGRESS FAILED → acme/svc" "${WORK}/e.err"; then
  pass "e) the failure line names the destination"
else
  fail "e) no EGRESS FAILED line on stderr: $(cat "${WORK}/e.err")"
fi
if grep -q "HTTP 422" "${WORK}/e.err"; then
  pass "e) gh's own stderr still reaches the user"
else
  fail "e) gh's stderr was swallowed: $(cat "${WORK}/e.err")"
fi

# ---------------------------------------------------------------------------
# d) the shim never resolves to itself
# ---------------------------------------------------------------------------
d_rc=0
# A PATH with NO `gh` on it that can still reach `bash` — the shim's shebang
# is `#!/usr/bin/env bash`, so a PATH holding literally nothing but the shim
# would fail in `env` before the shim ever ran, and the test would pass for
# the wrong reason. Same trick as `ghFreePath` in the CLI test utils.
NOGH="${WORK}/nogh"
mkdir -p "${NOGH}"
ln -sf "$(command -v bash)" "${NOGH}/bash"
# The watchdog goes OUTSIDE `env`: it is a shell function, and `env` can
# only run a real binary.
d_out="$(run_with_timeout 5 env PATH="${SHIM_DIR}:${NOGH}" "${SHIM_DIR}/gh" --version 2>&1)" || d_rc=$?
if [ "${d_rc}" -eq 127 ]; then
  pass "d) with only the shim on PATH, gh exits 127"
else
  fail "d) expected exit 127 with only the shim on PATH, got ${d_rc} (124/142 means it hung)"
fi
case "${d_out}" in
  *"repo-aegis shim: real gh not found on PATH"*)
    pass "d) the shim says why"
    ;;
  *)
    fail "d) missing the 'real gh not found' line: ${d_out}"
    ;;
esac

# ---------------------------------------------------------------------------
if [ "${failures}" -eq 0 ]; then
  echo "shim-smoke: all checks passed"
  exit 0
fi
echo "shim-smoke: ${failures} check(s) failed" >&2
exit 1
