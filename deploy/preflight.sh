#!/usr/bin/env bash
#
# Read-only pre-deployment checks for dsh-mattermost.
#
# Never merges, fetches, resets, restarts, sends Mattermost messages or writes
# production data. It only reads config, credentials (in memory), logs, git
# metadata and (optionally) a bundle, plus read-only Mattermost GETs.
#
# Output: one "PASS|FAIL|UNKNOWN <detail>" line per check.
# Exit: 0 = all PASS, 1 = at least one FAIL, 2 = no FAIL but at least one UNKNOWN.
#
# Environment overrides (tests / alternate profiles):
#   AB_CFG              profile patch file
#   AB_CRED             DSH credential store
#   AB_LOG              plugin log
#   AB_REPO             production repository
#   AB_SERVICE_UNIT     systemd unit (default dsh-web)
#   AB_SYSTEMCTL        systemctl command (default systemctl)
#   AB_EXPECT_HEAD      expected current HEAD (default d61d34d…)
#   AB_EXPECT_A3        expected A3 commit (default a3ff375…)
#   AB_EXPECT_TARGET    expected deploy target (default bcf19fd…)
#   AB_BUNDLE           bundle path (optional; missing => UNKNOWN)
#   AB_BUNDLE_SHA       sha256 file for the bundle (optional)
#   AB_EXPECTED_CFG_SHA expected config sha256 (optional; missing => UNKNOWN)
#   AB_MAX_PAGES        pagination cap (default 500)
#
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
CHECKS="$HERE/checks.py"

PROFILE="${AB_CFG:-$HOME/.dsh/profiles/web/cordis.patch.yml}"
REPO="${AB_REPO:-$HOME/dsh-mattermost}"
UNIT="${AB_SERVICE_UNIT:-dsh-web}"
SYSTEMCTL="${AB_SYSTEMCTL:-systemctl}"
EXPECT_HEAD="${AB_EXPECT_HEAD:-d61d34d01190b1cc6025e7e5482acf12a6a318f5}"
EXPECT_A3="${AB_EXPECT_A3:-a3ff3751c0ec33a8cd57ab7213b0c20a7dc104df}"
EXPECT_TARGET="${AB_EXPECT_TARGET:-bcf19fd4a698e63706142181f55f05278c9e95dc}"
BUNDLE="${AB_BUNDLE:-}"
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

# 1. configuration structure
line=$(AB_CFG="$PROFILE" python3 "$CHECKS" config 2>/dev/null) || true
[ -n "$line" ] || line="UNKNOWN config check failed"
record CONFIG "$line"

# 2. credential source
line=$(AB_CFG="$PROFILE" python3 "$CHECKS" credential 2>/dev/null) || true
[ -n "$line" ] || line="UNKNOWN credential check failed"
record CREDENTIAL "$line"

# 3. token identity (read-only GET; fail-closed)
line=$(AB_CFG="$PROFILE" python3 "$CHECKS" identity 2>/dev/null) || true
[ -n "$line" ] || line="UNKNOWN identity check failed"
record IDENTITY "$line"

# 4. pending approvals (full pagination, fail-closed)
line=$(AB_CFG="$PROFILE" python3 "$CHECKS" pending 2>/dev/null) || true
[ -n "$line" ] || line="UNKNOWN pending check failed"
record PENDING "$line"

# 5. git baseline, worktree and commit chain
git_check() {
  [ -d "$REPO/.git" ] || { echo "UNKNOWN repository not found"; return; }
  local head dirty
  head=$(git -C "$REPO" rev-parse HEAD 2>/dev/null) || { echo "UNKNOWN git rev-parse failed"; return; }
  dirty=$(git -C "$REPO" status --porcelain 2>/dev/null) || { echo "UNKNOWN git status failed"; return; }
  [ -z "$dirty" ] || { echo "FAIL worktree dirty"; return; }
  [ "$head" = "$EXPECT_HEAD" ] || { echo "FAIL unexpected HEAD"; return; }
  git -C "$REPO" cat-file -e "${EXPECT_A3}^{commit}" 2>/dev/null || { echo "UNKNOWN A3 commit not present"; return; }
  git -C "$REPO" cat-file -e "${EXPECT_TARGET}^{commit}" 2>/dev/null || { echo "UNKNOWN target commit not present"; return; }
  [ "$(git -C "$REPO" rev-parse "${EXPECT_TARGET}^" 2>/dev/null)" = "$EXPECT_A3" ] || { echo "FAIL target parent mismatch"; return; }
  [ "$(git -C "$REPO" rev-parse "${EXPECT_A3}^" 2>/dev/null)" = "$EXPECT_HEAD" ] || { echo "FAIL A3 parent mismatch"; return; }
  echo "PASS baseline clean chain ok"
}
record GIT "$(git_check)"

# 6. bundle integrity (optional)
bundle_check() {
  if [ -z "$BUNDLE" ]; then echo "UNKNOWN bundle not provided"; return; fi
  [ -f "$BUNDLE" ] || { echo "FAIL bundle missing"; return; }
  if [ -n "${AB_BUNDLE_SHA:-}" ]; then
    [ -f "$AB_BUNDLE_SHA" ] || { echo "FAIL checksum file missing"; return; }
    ( cd "$(dirname "$BUNDLE")" && sha256sum -c "$AB_BUNDLE_SHA" >/dev/null 2>&1 ) \
      || { echo "FAIL bundle checksum mismatch"; return; }
  fi
  git -C "$REPO" bundle verify "$BUNDLE" >/dev/null 2>&1 || { echo "FAIL bundle verify failed"; return; }
  git -C "$REPO" bundle list-heads "$BUNDLE" 2>/dev/null | grep -q . || { echo "FAIL bundle has no refs"; return; }
  echo "PASS bundle verify ok"
}
record BUNDLE "$(bundle_check)"

# 7. configuration hash
cfg_hash_check() {
  [ -f "$PROFILE" ] || { echo "UNKNOWN config missing"; return; }
  local actual
  actual=$(sha256sum "$PROFILE" 2>/dev/null | cut -d' ' -f1) || { echo "UNKNOWN hash failed"; return; }
  if [ -z "$EXPECTED_CFG_SHA" ]; then
    echo "UNKNOWN expected hash not provided (actual ${actual:0:8}…)"
    return
  fi
  [ "$actual" = "$EXPECTED_CFG_SHA" ] && echo "PASS config hash match" || echo "FAIL config hash mismatch"
}
record CFG_HASH "$(cfg_hash_check)"

# 8. service state (read-only)
service_check() {
  local out
  out=$($SYSTEMCTL show "$UNIT" -p ActiveState -p SubState -p MainPID -p NRestarts --value 2>/dev/null) \
    || { echo "UNKNOWN systemctl failed"; return; }
  local active sub pid nr
  active=$(printf '%s\n' "$out" | sed -n '1p')
  sub=$(printf '%s\n' "$out" | sed -n '2p')
  pid=$(printf '%s\n' "$out" | sed -n '3p')
  nr=$(printf '%s\n' "$out" | sed -n '4p')
  [ "$active" = "active" ] && [ "$sub" = "running" ] \
    && echo "PASS service running pid=$pid restarts=$nr" \
    || echo "FAIL service state=$active/$sub"
}
record SERVICE "$(service_check)"

printf '\nSUMMARY pass=%d fail=%d unknown=%d\n' "$PASS" "$FAIL" "$UNKNOWN"
if [ "$FAIL" -gt 0 ]; then exit 1; fi
if [ "$UNKNOWN" -gt 0 ]; then exit 2; fi
exit 0
