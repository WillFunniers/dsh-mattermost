#!/usr/bin/env bash
#
# A3 end-to-end: Web-origin approval arbitration on the ISOLATED harness.
#
# Fake Mattermost + dummy token + an isolated DSH home. Nothing here touches the
# real server, the production token or the production state directory.
#
# Cases:
#   1. verified 1:1 DM → decidable card → Mattermost decides → allowed-once
#   2. DM peer is not the approver → nothing posted, nothing pending
#   3. group channel → non-decidable notice only
#   4. nobody decides → the plugin timer closes it as expired / unavailable
#
# Every case also asserts the audit line's business fields
# (outcome / settledBy / card), which is what A3 separates.
#
#   bash feature-test/web-approval-e2e.sh
#
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DEV="$(cd "$HERE/.." && pwd)"
HOME_DIR="${DSH_HOME_TEST:?set DSH_HOME_TEST to an isolated DSH home (…/.dsh-mmt-*)}"
STATE="$HOME_DIR/mattermost"
APP_PORT="${APP_PORT:-3092}"
PROBE_PORT="${PROBE_PORT:-3093}"
FAKE_PORT="${FAKE_PORT:-3099}"
PROBE="http://127.0.0.1:$PROBE_PORT"
FAKE="http://127.0.0.1:$FAKE_PORT"
APP_PID=""; FAKE_PID=""
PASS=0; FAILN=0

ok()  { PASS=$((PASS+1));  printf '  \033[32mPASS\033[0m %s\n' "$*"; }
bad() { FAILN=$((FAILN+1)); printf '  \033[31mFAIL\033[0m %s\n' "$*"; }
hdr() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
pj()  { python3 -c "import sys,json;d=json.load(sys.stdin);$1"; }
wait_outcome() { for _ in $(seq 1 200); do sleep 0.25; grep -q '"outcome"' "$1" 2>/dev/null && return 0; done; return 1; }

port_pid() { ss -ltnp 2>/dev/null | grep ":$1 " | grep -o 'pid=[0-9]*' | cut -d= -f2 | head -1; }
cleanup() {
  [ -n "$APP_PID" ] && kill "$APP_PID" 2>/dev/null
  [ -n "$FAKE_PID" ] && kill "$FAKE_PID" 2>/dev/null
  sleep 2
  for p in "$APP_PORT" "$PROBE_PORT" "$FAKE_PORT"; do
    pid=$(port_pid "$p"); [ -n "$pid" ] && kill "$pid" 2>/dev/null
  done
}
trap cleanup EXIT

for p in "$APP_PORT" "$PROBE_PORT" "$FAKE_PORT"; do
  [ -n "$(port_pid "$p")" ] && { echo "FATAL: port $p busy" >&2; exit 2; }
done
case "$HOME_DIR" in
  "$HOME/.dsh"|"$HOME/.dsh/") echo "REFUSING: DSH_HOME_TEST is the production home" >&2; exit 2 ;;
  */.dsh-mmt-*) : ;;
  *) echo "REFUSING: not an isolated home: $HOME_DIR" >&2; exit 2 ;;
esac

start_fake() { # human user id
  setsid nohup node "$HERE/d1-fake-mattermost.mjs" "$FAKE_PORT" d1chan devbot0000000000000000000 dsh "$1" \
    > /tmp/a3-e2e-fake.log 2>&1 < /dev/null &
  FAKE_PID=$!
  sleep 1.2
  curl -s --max-time 3 "$FAKE/api/v4/users/me" | grep -q devbot || { echo "fake server failed" >&2; exit 2; }
}
stop_fake() { [ -n "$FAKE_PID" ] && kill "$FAKE_PID" 2>/dev/null; FAKE_PID=""; sleep 0.5; }

boot() { # web approval channel
  : > "$STATE/plugin.log"
  (
    cd /tmp || exit 1
    DSH_HOME="$HOME_DIR" MATTERMOST_URL="$FAKE" MATTERMOST_TOKEN=dev-dummy-token \
    MATTERMOST_CHANNELS="d1chan,chanB,dmchanB,failchan,dmchanW" MATTERMOST_FREE='' \
    MATTERMOST_ALLOWED_USERS=d1user MATTERMOST_STATE_DIR="$STATE" MATTERMOST_BOTS='[]' \
    MATTERMOST_APPROVAL_TIMEOUT_MS=30000 \
    MATTERMOST_WEB_APPROVAL_APPROVERS=d1user \
    MATTERMOST_WEB_APPROVAL_CHANNEL="$1" \
    DSH_PERMISSION_MODE=workspace-write \
    setsid nohup dsh --profile mmt-dev --no-open --port "$APP_PORT" \
      --trusted-host "127.0.0.1:$APP_PORT" > /tmp/a3-e2e-instance.log 2>&1 < /dev/null &
    echo $! > /tmp/a3-e2e-app.pid
  )
  APP_PID=$(cat /tmp/a3-e2e-app.pid)
  for _ in $(seq 1 60); do
    sleep 1
    curl -s --max-time 3 "$PROBE/status" | grep -q '"started":true' && return 0
  done
  echo "instance did not start" >&2; tail -5 /tmp/a3-e2e-instance.log >&2; return 1
}
stop_app() {
  [ -n "$APP_PID" ] && kill "$APP_PID" 2>/dev/null
  for _ in $(seq 1 20); do sleep 0.5; [ -z "$(port_pid "$APP_PORT")" ] && break; done
  pid=$(port_pid "$APP_PORT"); [ -n "$pid" ] && kill "$pid" 2>/dev/null
  APP_PID=""; sleep 0.5
}

pending()   { curl -s --max-time 5 "$PROBE/mm/approvals?botId=bot0"; }
fake_posts(){ curl -s --max-time 5 "$FAKE/__posts"; }
audit_tail(){ tail -1 "$STATE/approvals.log" 2>/dev/null; }

hdr "1. verified 1:1 DM → decidable card → Mattermost decides"
start_fake d1user
boot 'dm:dmchanW' || exit 2
curl -s "$PROBE/mm/waterfall" -X POST -H 'Content-Type: application/json' \
  -d '{"sessionId":"a3-web-1","toolName":"bash","callId":"c1","reason":"e2e"}' > /tmp/a3-out1.json &
sleep 3
rec=$(pending | pj "p=(d.get('pending') or []);print(((p[0]['source'])+'|'+(p[0]['postId'] or '')+'|'+(p[0]['card'] if p else '')) if p else '||')")
src=${rec%%|*}; rest=${rec#*|}; pid=${rest%%|*}; card=${rest#*|}
[ "$src" = "web" ] && ok "pending record source=web" || bad "pending source '$src'"
[ "$card" = "posted" ] && ok "card lifecycle = posted" || bad "card lifecycle '$card'"
[ -n "$pid" ] && ok "card delivered to the DM" || bad "no post id"
row=$(fake_posts | python3 -c "
import sys,json
pid=sys.argv[1]
for p in json.load(sys.stdin):
    if p['id']==pid: print(p['channel_id']); break
" "$pid")
[ "$row" = "dmchanW" ] && ok "card is in the one-to-one DM" || bad "card channel '$row'"
curl -s "$PROBE/mm/react" -X POST -H 'Content-Type: application/json' \
  -d "{\"postId\":\"$pid\",\"userId\":\"d1user\",\"botId\":\"bot0\",\"emojiName\":\"white_check_mark\"}" >/dev/null
wait_outcome /tmp/a3-out1.json
out=$(pj 'print(d.get("outcome") or d.get("message") or "")' < /tmp/a3-out1.json)
[ "$out" = "allowed-once" ] && ok "Mattermost decision wins → allowed-once" || bad "outcome '$out'"
sleep 1
audit=$(audit_tail)
printf '%s' "$audit" | grep -q '"outcome":"approved"' && ok "audit outcome=approved" || bad "audit outcome: $audit"
printf '%s' "$audit" | grep -q '"settledBy":"mattermost"' && ok "audit settledBy=mattermost" || bad "audit settledBy: $audit"
printf '%s' "$audit" | grep -q '"card":"posted"' && ok "audit card=posted" || bad "audit card: $audit"
n=$(pending | pj "print(len(d.get('pending') or []))")
[ "$n" -eq 0 ] && ok "no pending record left" || bad "$n pending record(s) left"
stop_app; stop_fake

hdr "2. DM peer is not the approver → nothing at all"
start_fake someoneelse00000000000000
boot 'dm:dmchanW' || exit 2
curl -s "$PROBE/mm/waterfall" -X POST -H 'Content-Type: application/json' \
  -d '{"sessionId":"a3-web-2","toolName":"bash","callId":"c2","reason":"x","abortAfterMs":1200}' > /tmp/a3-out2.json &
sleep 3
n=$(pending | pj "print(len(d.get('pending') or []))")
[ "$n" -eq 0 ] && ok "no pending record" || bad "$n pending record(s)"
p=$(fake_posts | pj "print(len(d))")
[ "$p" -eq 0 ] && ok "nothing posted" || bad "$p post(s) posted"
wait_outcome /tmp/a3-out2.json
out=$(pj 'print(d.get("outcome") or d.get("message") or "")' < /tmp/a3-out2.json)
case "$out" in cancelled|unavailable) ok "Web request resolves normally ($out)" ;; *) bad "outcome '$out'" ;; esac
stop_app; stop_fake

hdr "3. group channel → non-decidable notice only"
start_fake d1user
boot 'ch:chanB' || exit 2
curl -s "$PROBE/mm/waterfall" -X POST -H 'Content-Type: application/json' \
  -d '{"sessionId":"a3-web-3","toolName":"bash","callId":"c3","reason":"x","abortAfterMs":2000}' > /tmp/a3-out3.json &
sleep 2
n=$(pending | pj "print(len(d.get('pending') or []))")
[ "$n" -eq 0 ] && ok "no pending record in a group channel" || bad "$n pending record(s)"
msg=$(fake_posts | pj "print('||'.join(p['message'] for p in d))")
case "$msg" in *"Web 界面"*) ok "notice points at the Web UI" ;; *) bad "notice text: $msg" ;; esac
case "$msg" in *bash*) bad "notice names the tool" ;; *) ok "notice does not name the tool" ;; esac
if printf '%s' "$msg" | grep -Eq '[0-9a-f]{8}'; then bad "notice contains an id-like token"; else ok "notice has no request id"; fi
wait_outcome /tmp/a3-out3.json
out=$(pj 'print(d.get("outcome") or d.get("message") or "")' < /tmp/a3-out3.json)
case "$out" in cancelled|unavailable) ok "Web request unaffected ($out)" ;; *) bad "outcome '$out'" ;; esac
stop_app; stop_fake

hdr "4. nobody decides → timer closes it as expired"
start_fake d1user
boot 'dm:dmchanW' || exit 2
: > "$STATE/approvals.log"
curl -s "$PROBE/mm/waterfall" -X POST -H 'Content-Type: application/json' \
  -d '{"sessionId":"a3-web-4","toolName":"bash","callId":"c4","reason":"timeout"}' > /tmp/a3-out4.json &
wait_outcome /tmp/a3-out4.json
out=$(pj 'print(d.get("outcome") or d.get("message") or "")' < /tmp/a3-out4.json)
[ "$out" = "unavailable" ] && ok "timeout resolves unavailable" || bad "outcome '$out'"
audit=$(audit_tail)
printf '%s' "$audit" | grep -q '"outcome":"expired"' && ok "audit outcome=expired" || bad "audit: $audit"
printf '%s' "$audit" | grep -q '"settledBy":"timeout"' && ok "audit settledBy=timeout" || bad "audit settledBy: $audit"
n=$(pending | pj "print(len(d.get('pending') or []))")
[ "$n" -eq 0 ] && ok "pending cleaned up" || bad "$n pending record(s) left"
stop_app; stop_fake

printf '\n-- summary: pass=%d fail=%d\n' "$PASS" "$FAILN"
[ "$FAILN" -eq 0 ] && exit 0 || exit 1
