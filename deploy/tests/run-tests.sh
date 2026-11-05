#!/usr/bin/env bash
#
# Isolated tests for deploy/preflight.sh and deploy/verify.sh.
# Uses a local mock Mattermost, a scratch git repo and stubbed systemctl/journalctl.
# Never touches the production repository, service or Mattermost.
#
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DEPLOY="$(cd "$HERE/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"; [ -n "${MOCK_PID:-}" ] && kill "$MOCK_PID" 2>/dev/null' EXIT

PASSED=0; FAILED=0
ok()   { PASSED=$((PASSED + 1)); printf '  PASS %s\n' "$1"; }
bad()  { FAILED=$((FAILED + 1)); printf '  FAIL %s\n' "$1"; }

# ---- scratch git repo with three commits (baseline -> A3 -> target) ----
REPO="$TMP/repo"
mkdir -p "$REPO"; git -C "$REPO" init -q
git -C "$REPO" config user.email t@test; git -C "$REPO" config user.name t
echo a > "$REPO/a.txt"; git -C "$REPO" add .; git -C "$REPO" commit -qm one
BASE=$(git -C "$REPO" rev-parse HEAD)
echo b > "$REPO/b.txt"; git -C "$REPO" add .; git -C "$REPO" commit -qm two
A3=$(git -C "$REPO" rev-parse HEAD)
echo c > "$REPO/c.txt"; git -C "$REPO" add .; git -C "$REPO" commit -qm three
TARGET=$(git -C "$REPO" rev-parse HEAD)
touch "$REPO/web-route.js"; git -C "$REPO" add .; git -C "$REPO" commit -qm four
TARGET2=$(git -C "$REPO" rev-parse HEAD)
git -C "$REPO" bundle create "$TMP/good.bundle" refs/heads/master >/dev/null 2>&1 \
  || git -C "$REPO" bundle create "$TMP/good.bundle" refs/heads/main >/dev/null
# verify runs against a clone at the deployed commit; preflight runs at baseline
REPO2="$TMP/repo-verify"
git clone -q "$REPO" "$REPO2"
git -C "$REPO" checkout -q "$BASE"
printf 'corrupt' > "$TMP/bad.bundle"
cfghash() { sha256sum "$1" | cut -d' ' -f1; }

# ---- stubs ----
cat > "$TMP/systemctl" <<'EOF'
#!/usr/bin/env bash
case "${STUB_STATE:-active}" in
  active) printf 'active\nrunning\n%s\n%s\n' "${STUB_PID:-200}" "${STUB_NR:-0}" ;;
  failed) printf 'failed\nfailed\n0\n0\n' ;;
  *) printf 'unknown\nunknown\n0\n0\n' ;;
esac
EOF
chmod +x "$TMP/systemctl"
cat > "$TMP/journalctl" <<'EOF'
#!/usr/bin/env bash
echo "2026-01-01T00:00:00Z INFO ok"
exit 0
EOF
chmod +x "$TMP/journalctl"

start_mock() { # mode
  MOCK_MODE="$1" python3 "$HERE/mock_mm.py" > "$TMP/port" 2>/dev/null &
  MOCK_PID=$!
  for _ in $(seq 1 40); do [ -s "$TMP/port" ] && break; sleep 0.1; done
  MOCK_PORT=$(cat "$TMP/port")
}
stop_mock() { [ -n "${MOCK_PID:-}" ] && kill "$MOCK_PID" 2>/dev/null; MOCK_PID=""; : > "$TMP/port"; }

write_cfg() {
  cat > "$TMP/cfg.yml" <<EOF
- id: mattermost
  name: dsh-mattermost
  config:
    baseUrl: http://127.0.0.1:${MOCK_PORT}
    tokenRef: MATTERMOST_TOKEN
    channels: [chanA, chanB]
EOF
  printf 'version: 1\nrefs:\n  MATTERMOST_TOKEN: testtoken\n' > "$TMP/cred.yml"
  printf '2026-01-01T00:00:00Z INFO [mm] bot identity: dsh (jock…)\n' > "$TMP/plugin.log"
}

run_preflight() { # extra env in "$@"
  env AB_CFG="$TMP/cfg.yml" AB_CRED="$TMP/cred.yml" AB_LOG="$TMP/plugin.log" \
      AB_REPO="$REPO" AB_EXPECT_HEAD="$BASE" AB_EXPECT_A3="$A3" AB_EXPECT_TARGET="$TARGET" \
      AB_BUNDLE="$TMP/good.bundle" AB_EXPECTED_CFG_SHA="$(cfghash "$TMP/cfg.yml")" \
      AB_SYSTEMCTL="$TMP/systemctl" "$@" \
      bash "$DEPLOY/preflight.sh"
}

run_verify() {
  env AB_CFG="$TMP/cfg.yml" AB_CRED="$TMP/cred.yml" AB_LOG="$TMP/plugin.log" \
      AB_REPO="$REPO2" AB_EXPECT_HEAD="$TARGET2" AB_BUNDLE="$TMP/good.bundle" \
      AB_EXPECTED_CFG_SHA="$(cfghash "$TMP/cfg.yml")" AB_OLD_PID=100 AB_PRE_NR=0 \
      AB_SYSTEMCTL="$TMP/systemctl" AB_JOURNALCTL="$TMP/journalctl" "$@" \
      bash "$DEPLOY/verify.sh"
}

echo "== normal path =="
start_mock normal; write_cfg
if run_preflight > "$TMP/out" 2>&1 && grep -q 'SUMMARY pass=8 fail=0 unknown=0' "$TMP/out"; then ok "preflight normal"; else bad "preflight normal"; cat "$TMP/out"; fi
if run_verify > "$TMP/out" 2>&1 && grep -q 'SUMMARY pass=6 fail=0 unknown=0' "$TMP/out"; then ok "verify normal"; else bad "verify normal"; cat "$TMP/out"; fi

echo "== credential unreadable =="
if run_preflight AB_CRED="$TMP/missing.yml" > "$TMP/out" 2>&1; then bad "credential should fail"; else
  grep -q '^CREDENTIAL *UNKNOWN' "$TMP/out" && ok "credential UNKNOWN" || { bad "credential UNKNOWN"; cat "$TMP/out"; }; fi

echo "== identity mismatch =="
stop_mock; start_mock identity_mismatch; write_cfg
if run_preflight > "$TMP/out" 2>&1; then bad "identity should fail"; else
  grep -q '^IDENTITY *UNKNOWN' "$TMP/out" && ok "identity UNKNOWN" || { bad "identity UNKNOWN"; cat "$TMP/out"; }; fi

echo "== pending exists =="
stop_mock; start_mock pending; write_cfg
if run_preflight > "$TMP/out" 2>&1; then bad "pending should fail"; else
  grep -q '^PENDING *FAIL' "$TMP/out" && ok "pending FAIL" || { bad "pending FAIL"; cat "$TMP/out"; }; fi

echo "== pagination anomaly =="
stop_mock; start_mock anomaly; write_cfg
if run_preflight > "$TMP/out" 2>&1; then bad "pagination should fail"; else
  grep -q '^PENDING *UNKNOWN' "$TMP/out" && ok "pagination UNKNOWN" || { bad "pagination UNKNOWN"; cat "$TMP/out"; }; fi

echo "== log unreadable =="
stop_mock; start_mock normal; write_cfg
if run_preflight AB_LOG="$TMP/none.log" > "$TMP/out" 2>&1; then bad "log should fail"; else
  grep -q '^IDENTITY *UNKNOWN' "$TMP/out" && ok "log UNKNOWN" || { bad "log UNKNOWN"; cat "$TMP/out"; }; fi

echo "== bundle corrupt =="
if run_preflight AB_BUNDLE="$TMP/bad.bundle" > "$TMP/out" 2>&1; then bad "bundle should fail"; else
  grep -q '^BUNDLE *FAIL' "$TMP/out" && ok "bundle FAIL" || { bad "bundle FAIL"; cat "$TMP/out"; }; fi

echo "== worktree dirty =="
echo dirty >> "$REPO/a.txt"
if run_preflight > "$TMP/out" 2>&1; then bad "dirty should fail"; else
  grep -q '^GIT *FAIL' "$TMP/out" && ok "git FAIL" || { bad "git FAIL"; cat "$TMP/out"; }; fi
git -C "$REPO" checkout -q -- a.txt

echo "== service restart failure =="
if run_verify STUB_STATE=failed > "$TMP/out" 2>&1; then bad "service should fail"; else
  grep -q '^SERVICE *FAIL' "$TMP/out" && ok "service FAIL" || { bad "service FAIL"; cat "$TMP/out"; }; fi

stop_mock
printf '\n-- summary: pass=%d fail=%d\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ]
