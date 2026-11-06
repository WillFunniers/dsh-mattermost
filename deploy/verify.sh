#!/usr/bin/env bash
#
# Read-only post-deployment verification for dsh-mattermost.
#
# Never merges, fetches, resets, restarts or sends Mattermost messages.
# The restart itself is a separate, explicitly authorized action.
#
# Usage: deploy/verify.sh [--wait 60]     (sleep before checking stability)
#
# Output: one "PASS|FAIL|UNKNOWN <detail>" line per check.
# Exit: 0 = all PASS, 1 = FAIL, 2 = UNKNOWN only.
#
# Environment overrides:
#   AB_REPO, AB_CFG, AB_CRED, AB_LOG, AB_SERVICE_UNIT
#   AB_SYSTEMCTL, AB_JOURNALCTL
#   AB_EXPECT_HEAD      expected deployed HEAD (default bcf19fd…)
#   AB_OLD_PID          MainPID before restart (required; else UNKNOWN)
#   AB_PRE_NR           NRestarts before restart (required; else UNKNOWN)
#   AB_EXPECTED_CFG_SHA expected config sha256 (required; else UNKNOWN)
#
set -uo pipefail

WAIT=0
if [ "${1:-}" = "--wait" ] && [ -n "${2:-}" ]; then WAIT="$2"; fi

HERE="$(cd "$(dirname "$0")" && pwd)"
CHECKS="$HERE/checks.py"

PROFILE="${AB_CFG:-$HOME/.dsh/profiles/web/cordis.patch.yml}"
REPO="${AB_REPO:-$HOME/dsh-mattermost}"
UNIT="${AB_SERVICE_UNIT:-dsh-web}"
SYSTEMCTL="${AB_SYSTEMCTL:-systemctl}"
JOURNALCTL="${AB_JOURNALCTL:-journalctl}"
EXPECT_HEAD="${AB_EXPECT_HEAD:-bcf19fd4a698e63706142181f55f05278c9e95dc}"
OLD_PID="${AB_OLD_PID:-}"
PRE_NR="${AB_PRE_NR:-}"
EXPECTED_CFG_SHA="${AB_EXPECTED_CFG_SHA:-}"

PASS=0; FAIL=0; UNKNOWN=0
record() {
  local name="$1" line="$2" status detail
  status="${line%% *}"
  detail="${line#* }"
  case "$status" in
    PASS) PASS=$((PASS + 1)) ;;
    FAIL) FAIL=$((FAIL + 1)) ;;
    *)    UNKNOWN=$((UNKNOWN + 1)); status="UNKNOWN" ;;
  esac
  printf '%-14s %-7s %s\n' "$name" "$status" "$detail"
}

if [ "$WAIT" -gt 0 ]; then
  echo "waiting ${WAIT}s before verification"
  sleep "$WAIT"
fi

# deployed commit + worktree + new file
head_check() {
  [ -d "$REPO/.git" ] || { echo "UNKNOWN repository not found"; return; }
  local head dirty
  head=$(git -C "$REPO" rev-parse HEAD 2>/dev/null) || { echo "UNKNOWN git rev-parse failed"; return; }
  dirty=$(git -C "$REPO" status --porcelain 2>/dev/null) || { echo "UNKNOWN git status failed"; return; }
  [ -z "$dirty" ] || { echo "FAIL worktree dirty"; return; }
  [ "$head" = "$EXPECT_HEAD" ] || { echo "FAIL unexpected HEAD"; return; }
  [ -f "$REPO/web-route.js" ] || { echo "FAIL web-route.js missing"; return; }
  echo "PASS deployed HEAD clean"
}
record CODE "$(head_check)"

# config hash must be unchanged by the deploy
cfg_hash_check() {
  [ -f "$PROFILE" ] || { echo "UNKNOWN config missing"; return; }
  local actual
  actual=$(sha256sum "$PROFILE" 2>/dev/null | cut -d' ' -f1) || { echo "UNKNOWN hash failed"; return; }
  if [ -z "$EXPECTED_CFG_SHA" ]; then
    echo "UNKNOWN expected hash not provided (actual ${actual:0:8}…)"
    return
  fi
  [ "$actual" = "$EXPECTED_CFG_SHA" ] && echo "PASS config hash unchanged" || echo "FAIL config hash changed"
}
record CFG_HASH "$(cfg_hash_check)"

# service state + process + restart counter
service_check() {
  local out
  out=$($SYSTEMCTL show "$UNIT" -p ActiveState -p SubState -p MainPID -p NRestarts --value 2>/dev/null) \
    || { echo "UNKNOWN systemctl failed"; return; }
  local active sub pid nr
  active=$(printf '%s\n' "$out" | sed -n '1p')
  sub=$(printf '%s\n' "$out" | sed -n '2p')
  pid=$(printf '%s\n' "$out" | sed -n '3p')
  nr=$(printf '%s\n' "$out" | sed -n '4p')
  [ "$active" = "active" ] && [ "$sub" = "running" ] || { echo "FAIL service state=$active/$sub"; return; }
  if [ -z "$OLD_PID" ] || [ -z "$PRE_NR" ]; then
    echo "UNKNOWN pid/restart baseline not provided"
    return
  fi
  [ "$pid" != "$OLD_PID" ] || { echo "FAIL PID unchanged"; return; }
  [ "$nr" = "$PRE_NR" ] || { echo "FAIL unexpected restart ($PRE_NR -> $nr)"; return; }
  echo "PASS service stable pid changed restarts=$nr"
}
record SERVICE "$(service_check)"

# journalctl three-state: failure is UNKNOWN, never PASS
log_check() {
  local tmp rc
  tmp=$(mktemp)
  $JOURNALCTL -q -u "$UNIT" --since "-5min" --no-pager > "$tmp" 2>/dev/null
  rc=$?
  if [ "$rc" -ne 0 ]; then rm -f "$tmp"; echo "UNKNOWN journalctl failed rc=$rc"; return; fi
  if grep -qiE "uncaught|fatal" "$tmp"; then rm -f "$tmp"; echo "FAIL fatal/uncaught in log"; return; fi
  rm -f "$tmp"; echo "PASS no fatal log lines"
}
record LOGS "$(log_check)"

# token identity and pending approvals (read-only)
line=$(AB_CFG="$PROFILE" python3 "$CHECKS" identity 2>/dev/null) || true
[ -n "$line" ] || line="UNKNOWN identity check failed"
record IDENTITY "$line"

line=$(AB_CFG="$PROFILE" python3 "$CHECKS" pending 2>/dev/null) || true
[ -n "$line" ] || line="UNKNOWN pending check failed"
record PENDING "$line"

printf '\nSUMMARY pass=%d fail=%d unknown=%d\n' "$PASS" "$FAIL" "$UNKNOWN"
if [ "$FAIL" -gt 0 ]; then exit 1; fi
if [ "$UNKNOWN" -gt 0 ]; then exit 2; fi
exit 0
