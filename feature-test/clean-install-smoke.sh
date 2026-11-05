#!/usr/bin/env bash
#
# Clean-install smoke test for dsh-mattermost.
#
# Creates a temporary DSH_HOME, installs the checkout exactly as README
# describes, boots DSH without any Mattermost configuration, and asserts that
# the plugin row activates instead of failing to import.
#
# It never reads the production DSH home, profile, credentials, or Mattermost
# configuration. It only needs: dsh, pnpm, node, and registry access for the
# one plugin-owned dependency.
#
#   bash feature-test/clean-install-smoke.sh
#   KEEP=1 bash feature-test/clean-install-smoke.sh   # keep the temp home
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH_BIN="${DSH_BIN:-dsh}"
PNPM_BIN="${PNPM_BIN:-pnpm}"
NODE_BIN="${NODE_BIN:-node}"
EXPECT_DSH="${EXPECT_DSH:-0.2.1-rc.2}"
KEEP="${KEEP:-0}"
WORK="${WORK:-$(mktemp -d "${TMPDIR:-/tmp}/dsh-mattermost-clean-XXXXXX")}"
DSH_PKG="${DSH_PKG:-$(npm root -g 2>/dev/null)/@deepseek-ai/dsh}"

PID=''
LOG=''

redact() {
  sed -E \
    -e 's#(https?://127\.0\.0\.1:[0-9]+/\?token=)[^ ]+#\1[REDACTED]#g' \
    -e 's/(token=)[A-Za-z0-9._~-]{16,}/\1[REDACTED]/g' \
    -e 's/(Bearer )[A-Za-z0-9._~-]{16,}/\1[REDACTED]/g'
}

fail() {
  printf 'FAIL  %s\n' "$*" >&2
  if [ -n "$LOG" ] && [ -f "$LOG" ]; then
    printf '%s\n' '--- last boot log ---' >&2
    redact < "$LOG" | tail -25 >&2
  fi
  exit 1
}

pass() { printf 'PASS  %s\n' "$*"; }

cleanup() {
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    sleep 1
    kill -9 "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
  fi
  case "$WORK" in
    "${TMPDIR:-/tmp}"/dsh-mattermost-clean-*)
      if [ "$KEEP" = 1 ]; then
        printf 'kept %s\n' "$WORK"
      else
        rm -rf "$WORK"
      fi
      ;;
    *)
      printf 'refusing to remove unexpected WORK=%s\n' "$WORK" >&2
      ;;
  esac
}
trap cleanup EXIT

command -v "$DSH_BIN" >/dev/null 2>&1 || fail "dsh not found: $DSH_BIN"
command -v "$PNPM_BIN" >/dev/null 2>&1 || fail "pnpm not found: $PNPM_BIN"
command -v "$NODE_BIN" >/dev/null 2>&1 || fail "node not found: $NODE_BIN"
[ -f "$DSH_PKG/package.json" ] || fail "DSH package not found at $DSH_PKG (set DSH_PKG)"

DSH_VERSION="$("$DSH_BIN" --version 2>/dev/null | head -1)"
[ "$DSH_VERSION" = "$EXPECT_DSH" ] || fail "expected DSH $EXPECT_DSH, got '$DSH_VERSION'"
printf 'INFO  dsh=%s node=%s pnpm=%s\n' \
  "$DSH_VERSION" "$("$NODE_BIN" -v)" "$("$PNPM_BIN" --version 2>/dev/null | head -1)"

SRC="$WORK/src/dsh-mattermost"
mkdir -p "$SRC"

if git -C "$REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git -C "$REPO" archive HEAD | tar -x -C "$SRC"
else
  tar -C "$REPO" --exclude=.git --exclude=node_modules --exclude='*/node_modules' \
    -cf - . | tar -x -C "$SRC"
fi
[ -f "$SRC/package.json" ] || fail "source copy has no package.json"
[ ! -e "$SRC/node_modules" ] || fail "source copy unexpectedly contains node_modules"

# The plugin-owned dependency must install; the six host peers must not.
(
  cd "$SRC"
  "$PNPM_BIN" install --prod --ignore-scripts > "$WORK/pnpm-install.log" 2>&1
) || fail "pnpm install failed"
[ -f "$SRC/node_modules/@deepseek-ai/schemastery/package.json" ] \
  || fail "schemastery was not installed"
if find "$SRC/node_modules/@deepseek-ai" -maxdepth 1 -name 'dsh-*' 2>/dev/null | grep -q .; then
  fail "host peer packages were installed into the plugin checkout"
fi
pass "plugin dependency installed (schemastery only; host peers not duplicated)"

# Verify the host really supplies every declared peer at the declared version.
PEERS="$("$NODE_BIN" - "$SRC/package.json" <<'JS'
const p = require(process.argv[2])
for (const name of Object.keys(p.peerDependencies || {})) console.log(`${name}\t${p.peerDependencies[name]}`)
JS
)"
while IFS=$'\t' read -r name range; do
  [ -n "$name" ] || continue
  installed="$("$NODE_BIN" - "$DSH_PKG" "$name" <<'JS' 2>/dev/null || true
const path = require('path'), fs = require('fs')
const root = process.argv[2], name = process.argv[3]
const file = path.join(root, 'node_modules', name, 'package.json')
try { console.log(JSON.parse(fs.readFileSync(file, 'utf8')).version) } catch {}
JS
)"
  [ -n "$installed" ] || fail "DSH host does not supply peer $name"
  [ "$installed" = "$range" ] || fail "DSH host supplies $name@$installed, plugin requires $range"
  pass "host peer $name@$installed"
done <<< "$PEERS"

ensure_web_profile() {
  local profile="$1"
  "$NODE_BIN" - "$profile/package.json" <<'JS'
const fs = require('fs')
const file = process.argv[2]
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
manifest.dsh ??= {}
manifest.dsh.profile ??= {}
manifest.dsh.profile.bundles ??= []
for (const name of ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-mattermost']) {
  if (!manifest.dsh.profile.bundles.includes(name)) manifest.dsh.profile.bundles.push(name)
}
fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n')
JS
}

boot_and_check() {
  local home="$1" label="$2"
  LOG="$WORK/$label.boot.log"
  local plugin_log="$home/mattermost/plugin.log"
  rm -f "$plugin_log"
  : > "$LOG"

  env -u MATTERMOST_TOKEN -u MATTERMOST_URL -u MATTERMOST_STATE_DIR \
    -u MATTERMOST_CHANNELS -u MATTERMOST_ALLOWED_USERS \
    DSH_HOME="$home" "$DSH_BIN" --profile web --no-open --port 0 \
    > "$LOG" 2>&1 &
  PID=$!

  local i
  for i in $(seq 1 60); do
    grep -q 'dsh web:' "$LOG" && break
    kill -0 "$PID" 2>/dev/null || break
    sleep 1
  done
  sleep 4
  kill -0 "$PID" 2>/dev/null || fail "$label: dsh exited before the plugin activated"
  grep -q 'failed to import' "$LOG" && fail "$label: module import failed"
  [ -f "$plugin_log" ] || fail "$label: plugin.log was not written"
  grep -q 'apply() entered' "$plugin_log" || fail "$label: plugin did not enter apply()"
  grep -q 'web approval routing enabled=no' "$plugin_log" \
    || fail "$label: Web Approval is not disabled by default"
  grep -q 'approvers=0' "$plugin_log" || fail "$label: Web Approval approvers are not empty"
  grep -q 'allowAll: Schema.boolean().default(false)' "$SRC/index.js" \
    || fail "allowAll default is not false"
  pass "$label: plugin activated; Web Approval off; allowAll default false"

  kill "$PID" 2>/dev/null || true
  sleep 1
  kill -9 "$PID" 2>/dev/null || true
  wait "$PID" 2>/dev/null || true
  PID=''
}

# Method 1: the README's recommended path, `dsh plugin add`.
HOME_ADD="$WORK/home-add"
DSH_HOME="$HOME_ADD" "$DSH_BIN" plugin --profile web add "$SRC" \
  > "$WORK/plugin-add.log" 2>&1 || fail "dsh plugin add failed"
ensure_web_profile "$HOME_ADD/profiles/web"
[ -e "$HOME_ADD/profiles/web/node_modules/dsh-mattermost" ] \
  || fail "dsh plugin add did not register the bundle"
boot_and_check "$HOME_ADD" "plugin-add"

# Method 2: the manual symlink + bundles path documented as the development alternative.
HOME_LINK="$WORK/home-link"
DSH_HOME="$HOME_LINK" "$DSH_BIN" plugin --profile web list \
  > "$WORK/profile-init.log" 2>&1 || fail "profile initialization failed"
mkdir -p "$HOME_LINK/profiles/web/node_modules"
ln -s "$SRC" "$HOME_LINK/profiles/web/node_modules/dsh-mattermost"
ensure_web_profile "$HOME_LINK/profiles/web"
boot_and_check "$HOME_LINK" "symlink"

printf 'PASS  clean-install smoke test complete\n'
