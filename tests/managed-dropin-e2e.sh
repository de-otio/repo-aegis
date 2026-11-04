#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Richard Myers and contributors.
#
# End-to-end test of the managed-settings drop-in (doc/plan-pin-enforcement-binary.md
# §2.3, steps 1-11), against the REAL system directory with REAL sudo. It runs only
# on a GitHub-hosted runner, where sudo needs no password; it refuses anywhere else,
# because it writes, and removes, root-owned files below /etc or /Library.
#
# The installer requires a person's terminal: stderr a TTY AND a process chain that
# reaches a login, sshd, terminal emulator or attached multiplexer, with no pty
# wrapper (`script`, `expect`) above it. So it is driven over `ssh -tt localhost`:
# the root sshd is the positive root, and the typed `y` arrives on the pty. That is
# the shape the spec's P7 describes: with password-less sudo, a fake terminal can
# run the install end to end, which is why doctor must report SUDO_NOPASSWD here.
#
# Usage (from the repo root, after `npm ci && npm run build`):
#   bash tests/managed-dropin-e2e.sh
set -euo pipefail

if [[ "${GITHUB_ACTIONS:-}" != "true" || "${RUNNER_ENVIRONMENT:-}" != "github-hosted" ]]; then
  echo "managed-dropin-e2e: refusing to run outside a GitHub-hosted runner (it writes root-owned system files)" >&2
  exit 2
fi

REPO="$(pwd -P)"
NODE="$(node -p 'require("fs").realpathSync(process.execPath)')"
CLI="$(node -p 'require("fs").realpathSync(process.argv[1])' "$REPO/packages/cli/dist/index.js")"
ME="$(id -un)"
MYUID="$(id -u)"
OS="$(uname -s)"
STATE="$HOME/.config/repo-aegis/state"
LEDGER="$STATE/claude-md-managed.json"
HEARTBEAT="$STATE/managed-hooks-seen"
WORK="${RUNNER_TEMP:?}/managed-dropin-e2e"
OTHER=raegis-e2e-other

case "$OS" in
  Linux) SYSDIR=/etc/claude-code ;;
  Darwin) SYSDIR="/Library/Application Support/ClaudeCode" ;;
  *) echo "managed-dropin-e2e: unsupported OS $OS" >&2; exit 2 ;;
esac
DROPDIR="$SYSDIR/managed-settings.d"
DROPIN="$DROPDIR/50-repo-aegis-$MYUID.json"
TMPNAME="$DROPDIR/.50-repo-aegis-$MYUID.json.tmp"

rm -rf "$WORK"
mkdir -p "$WORK/empty-root"
FAILS=0
pass() { printf 'ok    %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; FAILS=$((FAILS + 1)); }
check() { local name="$1"; shift; if "$@"; then pass "$name"; else fail "$name"; fi; }
section() { printf '\n== %s\n' "$1"; }

# The CLI is moved aside for the "pin missing" case; always put it back.
restore_cli() { if [[ -f "$CLI.away" ]]; then mv "$CLI.away" "$CLI"; fi; }
trap restore_cli EXIT

if [[ -e "$SYSDIR" ]]; then
  echo "managed-dropin-e2e: $SYSDIR already exists on this runner; step 5 needs a machine where repo-aegis creates it" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# sshd on localhost, key-only, for this user
# ---------------------------------------------------------------------------
section "setup: sshd on localhost"
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
KEY="$WORK/id_e2e"
ssh-keygen -q -t ed25519 -N "" -f "$KEY"
cat "$KEY.pub" >> "$HOME/.ssh/authorized_keys"
chmod 600 "$HOME/.ssh/authorized_keys"
if [[ "$OS" == Linux ]]; then
  if ! command -v sshd >/dev/null 2>&1 && [[ ! -x /usr/sbin/sshd ]]; then
    sudo apt-get update -qq
    sudo apt-get install -y -qq openssh-server
  fi
  sudo systemctl start ssh
else
  # Remote Login, without systemsetup (which needs Full Disk Access). The wait
  # loop below is the check that it worked.
  sudo launchctl enable system/com.openssh.sshd || true
  sudo launchctl bootstrap system /System/Library/LaunchDaemons/ssh.plist 2>/dev/null || true
fi
SSH=(ssh -tt -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -i "$KEY" "$ME@localhost")
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if "${SSH[@]}" true </dev/null >/dev/null 2>&1; then break; fi
  sleep 1
done
"${SSH[@]}" true </dev/null

# Run `repo-aegis <args>` from a session whose root is sshd, answering `y` on the pty.
# $1 = extra PATH prefix ("" for none); the rest are CLI arguments. Output goes to
# $WORK/last.log; returns the remote exit status.
q() { printf "'%s'" "${1//\'/\'\\\'\'}"; }
person() {
  local prefix="$1"; shift
  local cmd
  cmd="cd $(q "$REPO") && "
  if [[ -n "$prefix" ]]; then cmd+="PATH=$(q "$prefix"):\"\$PATH\" "; fi
  cmd+="$(q "$NODE") $(q "$CLI")"
  local a
  for a in "$@"; do cmd+=" $(q "$a")"; done
  local status=0
  printf 'y\n' | "${SSH[@]}" "$cmd" >"$WORK/last.log" 2>&1 || status=$?
  tr -d '\r' <"$WORK/last.log" >"$WORK/last.txt"
  return "$status"
}
show_last() { sed 's/^/    | /' "$WORK/last.txt"; }

# A command from the drop-in, by hook name (for example managed-heartbeat).
hook_cmd() {
  node -e '
    const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const all = Object.values(s.hooks ?? {}).flat().flatMap(m => m.hooks ?? []).map(h => h.command);
    const hit = all.find(c => c.includes(" hook " + process.argv[2]));
    if (hit === undefined) process.exit(1);
    process.stdout.write(hit);
  ' "$DROPIN" "$1"
}

# Codes of doctor checks that failed, D8 ones only, one per line.
d8_failures() {
  "$NODE" "$CLI" --json doctor --scan-root "$WORK/empty-root" >"$WORK/doctor.json" 2>"$WORK/doctor.err" || true
  node -e '
    const out = [];
    const walk = v => {
      if (Array.isArray(v)) return v.forEach(walk);
      if (v === null || typeof v !== "object") return;
      if (typeof v.code === "string" && v.ok === false) out.push(v.code);
      Object.values(v).forEach(walk);
    };
    walk(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")));
    const d8 = /^(MANAGED_|SUDO_NOPASSWD$|ENFORCEMENT_IN_USER_SETTINGS$)/;
    process.stdout.write([...new Set(out.filter(c => d8.test(c)))].sort().join("\n"));
  ' "$WORK/doctor.json"
}

# Fake tools that record that they ran. None of them may ever run (P1, D8.4).
FAKE="$WORK/fakebin"
MARK="$WORK/fake-ran"
mkdir -p "$FAKE"
for t in sudo tee id install chmod chown mv rm rmdir; do
  printf '#!/bin/sh\necho "%s $*" >>%s\n[ "%s" = id ] && echo 0\nexit 0\n' "$t" "$(q "$MARK")" "$t" >"$FAKE/$t"
  chmod +x "$FAKE/$t"
done
# A shadowing `id` that prints a chosen uid, for the hook's guard (step 8).
fake_id_dir() {
  local dir="$WORK/fakeid-$1"
  mkdir -p "$dir"
  printf '#!/bin/sh\necho %s\n' "$1" >"$dir/id"
  chmod +x "$dir/id"
  printf '%s' "$dir"
}

# Run hook command $2 under shell $1 with an empty SessionStart payload; prints the exit status.
run_hook() {
  local sh="$1" cmd="$2" status=0
  printf '{"hook_event_name":"SessionStart","session_id":"e2e","cwd":"%s"}' "$REPO" |
    "$sh" -c "$cmd" >"$WORK/hook.out" 2>"$WORK/hook.err" || status=$?
  printf '%s' "$status"
}

# ---------------------------------------------------------------------------
# Round A: a clean machine (step 11's leftover temp file needs the directory to
# exist beforehand, so it is in round B)
# ---------------------------------------------------------------------------
section "1. install claude-md through a person-shaped terminal (sshd root, y on the pty)"
if person "$FAKE" install claude-md; then pass "install exits 0"; else fail "install exits 0"; show_last; fi
check "drop-in exists at $DROPIN" test -f "$DROPIN"

section "7. no fake sudo, tee, id or other tool on PATH ran during install"
check "no fake tool ran" test ! -e "$MARK"

section "2. owner, mode, digest, uid guard"
if [[ "$OS" == Linux ]]; then OWNER="$(stat -c '%u:%g %a' "$DROPIN")"; else OWNER="$(stat -f '%u:%g %Lp' "$DROPIN")"; fi
check "owner 0:0 mode 644 (got $OWNER)" test "$OWNER" = "0:0 644"
SUM="$(node -e 'process.stdout.write(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' "$DROPIN")"
LEDGER_SUM="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).digest' "$LEDGER")"
check "digest matches the ledger" test "$SUM" = "$LEDGER_SUM"
guarded() {
  node -e '
    const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const all = Object.values(s.hooks ?? {}).flat().flatMap(m => m.hooks ?? []).map(h => h.command);
    const guard = `__u=$(/usr/bin/id -u 2>/dev/null) || {`;
    const cmp = `[ "$__u" = ${process.argv[2]} ] || exit 0;`;
    process.exit(all.length > 0 && all.every(c => c.startsWith(guard) && c.includes(cmp)) ? 0 : 1);
  ' "$DROPIN" "$MYUID"
}
check "every hook command starts with the /usr/bin/id uid guard for uid $MYUID" guarded
check "no hidden temp file left" test ! -e "$TMPNAME"
HB="$(hook_cmd managed-heartbeat)"

SHELLS=(/bin/sh)
if [[ "$OS" == Linux ]] && command -v dash >/dev/null 2>&1; then SHELLS+=("$(command -v dash)"); fi

section "3. the rendered hook as this user"
for sh in "${SHELLS[@]}"; do
  rm -f "$HEARTBEAT"
  st="$(run_hook "$sh" "$HB")"
  check "[$sh] pin present: exit 0 (got $st)" test "$st" = 0
  check "[$sh] pin present: the pinned CLI ran (heartbeat written)" test -f "$HEARTBEAT"
  mv "$CLI" "$CLI.away"
  st="$(run_hook "$sh" "$HB")"
  restore_cli
  check "[$sh] pin missing: exit 2 (got $st)" test "$st" = 2
  check "[$sh] pin missing: message names sudo rm '<drop-in>'" grep -qF "sudo rm '$DROPIN'" "$WORK/hook.err"
done

section "8. a shadowing id on PATH does not change the verdict"
for fake in 0 99999; do
  dir="$(fake_id_dir "$fake")"
  mv "$CLI" "$CLI.away"
  st="$(PATH="$dir:$PATH" run_hook /bin/sh "$HB")"
  restore_cli
  check "fake id prints $fake, pin missing: still exit 2 (got $st)" test "$st" = 2
done

if [[ "$OS" == Linux ]]; then
  section "4 and 10. a second account, owner's home 0750"
  sudo useradd -m -s /bin/sh "$OTHER"
  OLDMODE="$(stat -c '%a' "$HOME")"
  sudo chmod 0750 "$HOME"
  for sh in "${SHELLS[@]}"; do
    st=0
    # shellcheck disable=SC2024 # the output files belong to this user on purpose
    printf '{}' | sudo -u "$OTHER" -H -- "$sh" -c "cd /; $HB" >"$WORK/other.out" 2>"$WORK/other.err" || st=$?
    check "[$sh] second user: exit 0 (got $st)" test "$st" = 0
    # Outside the 0750 home, so the second account can run it.
    dir=/tmp/raegis-e2e-fakeid
    mkdir -p "$dir"
    printf '#!/bin/sh\necho %s\n' "$MYUID" >"$dir/id"
    chmod 755 "$dir" "$dir/id"
    st=0
    # shellcheck disable=SC2024 # the output files belong to this user on purpose
    printf '{}' | sudo -u "$OTHER" -H -- env PATH="$dir:/usr/bin:/bin" "$sh" -c "cd /; $HB" >"$WORK/other.out" 2>"$WORK/other.err" || st=$?
    check "[$sh] second user with a fake id printing $MYUID: exit 0, not the owner's verdict (got $st)" test "$st" = 0
  done
  sudo chmod "$OLDMODE" "$HOME"
fi

section "6a. doctor with the drop-in installed"
FAILED="$(d8_failures)"
check "the only D8 finding is SUDO_NOPASSWD (got: ${FAILED//$'\n'/, })" test "$FAILED" = "SUDO_NOPASSWD"

section "5a. uninstall on a clean machine"
rm -f "$MARK"
if person "$FAKE" install claude-md --uninstall; then pass "uninstall exits 0"; else fail "uninstall exits 0"; show_last; fi
check "drop-in removed" test ! -e "$DROPIN"
check "managed-settings.d removed (repo-aegis created it)" test ! -e "$DROPDIR"
check "system directory removed (repo-aegis created it)" test ! -e "$SYSDIR"
check "ledger removed" test ! -e "$LEDGER"
check "no fake tool ran during uninstall" test ! -e "$MARK"

section "6b. doctor after uninstall"
FAILED="$(d8_failures)"
check "no D8 finding (got: ${FAILED//$'\n'/, })" test -z "$FAILED"

# ---------------------------------------------------------------------------
# Round B: someone else's managed files are already there
# ---------------------------------------------------------------------------
section "setup: a managed-settings.json, another drop-in and a leftover temp file"
sudo /usr/bin/install -d -m 0755 "$DROPDIR"
printf '{}\n' | sudo tee "$SYSDIR/managed-settings.json" >/dev/null
printf '{}\n' | sudo tee "$DROPDIR/40-someone-else.json" >/dev/null
printf 'not json, from an interrupted write' | sudo tee "$TMPNAME" >/dev/null
sudo chmod 0644 "$SYSDIR/managed-settings.json" "$DROPDIR/40-someone-else.json"
OTHER_SUMS="$(sudo cat "$SYSDIR/managed-settings.json" "$DROPDIR/40-someone-else.json" | shasum -a 256)"

section "11. the next install replaces the leftover temp file"
if person "" install claude-md; then pass "install exits 0"; else fail "install exits 0"; show_last; fi
check "drop-in exists" test -f "$DROPIN"
check "hidden temp file is gone" test ! -e "$TMPNAME"

section "5b. uninstall leaves other files alone"
if person "" install claude-md --uninstall; then pass "uninstall exits 0"; else fail "uninstall exits 0"; show_last; fi
check "drop-in removed" test ! -e "$DROPIN"
check "managed-settings.json untouched" test -f "$SYSDIR/managed-settings.json"
check "the other drop-in untouched" test -f "$DROPDIR/40-someone-else.json"
check "their content is unchanged" test "$(sudo cat "$SYSDIR/managed-settings.json" "$DROPDIR/40-someone-else.json" | shasum -a 256)" = "$OTHER_SUMS"

section "9. uninstall with the ledger deleted still removes the drop-in"
if person "" install claude-md; then pass "install exits 0"; else fail "install exits 0"; show_last; fi
rm -f "$LEDGER"
if person "" install claude-md --uninstall; then pass "uninstall exits 0"; else fail "uninstall exits 0"; show_last; fi
check "drop-in removed without a ledger" test ! -e "$DROPIN"
check "directories kept (no ledger says repo-aegis created them)" test -d "$DROPDIR"

section "cleanup"
sudo /bin/rm -f "$SYSDIR/managed-settings.json" "$DROPDIR/40-someone-else.json"
sudo /bin/rmdir "$DROPDIR" "$SYSDIR"
if [[ "$OS" == Linux ]]; then sudo userdel -r "$OTHER" 2>/dev/null || true; fi

printf '\n%s\n' "$([[ $FAILS -eq 0 ]] && echo "managed-dropin-e2e: all checks passed" || echo "managed-dropin-e2e: $FAILS check(s) failed")"
exit $((FAILS > 0))
