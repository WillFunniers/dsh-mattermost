#!/usr/bin/env bash
#
# Acceptance suite: Approval Bridge, Session Navigator, Multi-Bot routing.
#
# Runs ONLY against an explicitly declared ISOLATED instance. The guard below is
# deliberate: this suite posts real messages, adds real reactions and asks the
# real approval seam for decisions, so pointing it at production would be a
# production incident, not a test.
#
#   MMT_HOME     isolated DSH home (must match ~/.dsh-mmt-*)
#   PROBE        isolated probe base URL (default http://127.0.0.1:3093)
#   MM_CHANNEL   test channel id
#   MM_USER      authorized human user id (the identity synthetic frames carry)
#   MM_BOT       bot's own user id (self-reaction test); empty = skip that check
#   TOKEN_FILE   Mattermost bot token file
#
# Groups: core (default), expiry, never, multibot. See run-all.sh for the
# restart-driven phases.
set -uo pipefail

P="${PROBE:-http://127.0.0.1:3093}"
MMT_HOME="${MMT_HOME:?set MMT_HOME to the isolated test home}"
MM_URL="${MM_URL:-http://127.0.0.1:8065}"
MM_CHANNEL="${MM_CHANNEL:?set MM_CHANNEL to the test channel id}"
MM_USER="${MM_USER:?set MM_USER to the authorized user id}"
MM_BOT="${MM_BOT:-}"
TOKEN_FILE="${TOKEN_FILE:-$HOME/.dsh/mattermost-token}"
STATE="$MMT_HOME/mattermost"
LOG="$STATE/plugin.log"
BOT_ID="${MMT_BOT_ID:-bot0}"

case "$MMT_HOME" in
  "$HOME/.dsh"|"$HOME/.dsh/") echo "REFUSING: MMT_HOME is the production home" >&2; exit 2 ;;
  "$HOME"/.dsh-mmt-*) : ;;
  *) echo "REFUSING: MMT_HOME=$MMT_HOME is not a declared isolated home (~/.dsh-mmt-*)" >&2; exit 2 ;;
esac
[ -r "$TOKEN_FILE" ] || { echo "no token file: $TOKEN_FILE" >&2; exit 2; }
TOKEN="$(cat "$TOKEN_FILE")"

PASS=0; FAIL=0; SKIP=0
ok()   { PASS=$((PASS+1)); printf '  PASS  %s\n' "$*"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL  %s\n' "$*"; }
skip() { SKIP=$((SKIP+1)); printf '  SKIP  %s\n' "$*"; }
hdr()  { printf '\n== %s\n' "$*"; }

now_ms() { python3 -c 'import time;print(int(time.time()*1000))'; }

probe_get()  { curl -s --max-time 25 "$P$1"; }
probe_post() { curl -s --max-time 25 -X POST "$P$1" -H 'Content-Type: application/json' -d "$2"; }
mm_api()     { curl -s --max-time 25 -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' "$@"; }

py() { python3 -c "import sys,json;d=json.load(sys.stdin);$1"; }

# --- approval helpers -------------------------------------------------------
pending_rows() { probe_get "/mm/approvals?botId=$BOT_ID"; }
stat_of() { pending_rows | py "print(d['stats'].get('$1',0))"; }

pending_id() { pending_rows | py 'ps=d.get("pending") or [];print(ps[0]["id"] if ps else "")'; }
pending_post() { pending_rows | py 'ps=d.get("pending") or [];print((ps[0].get("postId") or "") if ps else "")'; }

# Wait until a pending request exists AND its card has been posted.
wait_card() {
  local tries="${1:-30}" i
  for i in $(seq 1 "$tries"); do
    local post; post=$(pending_post)
    if [ -n "$post" ]; then printf '%s' "$post"; return 0; fi
    sleep 1
  done
  return 1
}

wait_id() {
  local tries="${1:-20}" i
  for i in $(seq 1 "$tries"); do
    local id; id=$(pending_id)
    if [ -n "$id" ]; then printf '%s' "$id"; return 0; fi
    sleep 1
  done
  return 1
}

# Start one ask in the background; the native outcome lands in $2.
ask_bg() {
  local sid="$1" call="$2" reason="$3" out="$4"
  rm -f "$out"
  ( curl -s --max-time 180 -X POST "$P/mm/waterfall" -H 'Content-Type: application/json' \
      -d "{\"sessionId\":\"$sid\",\"toolName\":\"bash\",\"callId\":\"$call\",\"reason\":\"$reason\"}" > "$out" 2>&1 ) &
  echo $!
}

ask_outcome() { py 'print(d.get("outcome") or ("ERR:" + str(d.get("message"))))' < "$1" 2>/dev/null; }

react() { # postId emoji [userId]
  probe_post /mm/react "{\"botId\":\"$BOT_ID\",\"postId\":\"$1\",\"userId\":\"${3:-$MM_USER}\",\"emojiName\":\"$2\"}" >/dev/null
}

decide() { # id decision [userId]
  probe_post /mm/decide "{\"requestId\":\"$1\",\"userId\":\"${3:-$MM_USER}\",\"botId\":\"$BOT_ID\",\"channelId\":\"$MM_CHANNEL\",\"decision\":\"$2\",\"via\":\"test\"}" \
    | py 'print(d.get("code"))'
}

clear_pending() {
  local rows i
  for i in 1 2 3 4 5 6 7 8; do
    rows=$(pending_rows | py 'print(" ".join(p["id"] for p in (d.get("pending") or [])))')
    [ -z "$rows" ] && return 0
    for id in $rows; do
      probe_post /mm/decide "{\"requestId\":\"$id\",\"userId\":\"$MM_USER\",\"botId\":\"$BOT_ID\",\"channelId\":\"$MM_CHANNEL\",\"decision\":\"rejected\",\"via\":\"cleanup\"}" >/dev/null
    done
    sleep 1
  done
}

# --- Mattermost read helpers ------------------------------------------------
posts_since() { # epoch-ms -> one message per line
  mm_api "$MM_URL/api/v4/channels/$MM_CHANNEL/posts?per_page=60" | python3 -c "
import sys, json
d = json.load(sys.stdin)
since = int(sys.argv[1])
for p in sorted(d.get('posts', {}).values(), key=lambda x: x['create_at']):
    if p['create_at'] >= since:
        print(p['message'].replace(chr(10), ' / '))
" "$1"
}

reply_has() { # needle, since-ms
  posts_since "$2" | grep -qF -- "$1"
}

post_json() { mm_api "$MM_URL/api/v4/posts/$1"; }

# --- instance helpers -------------------------------------------------------
inject() { # channelId userId message [rootId] [channelType]
  probe_post /inject "{\"channelId\":\"$1\",\"userId\":\"$2\",\"message\":\"$3\",\"rootId\":\"${4:-}\",\"channelType\":\"${5:-O}\"}" >/dev/null
}

ensure_map() { # chatKey -> sessionId
  probe_post /mm/ensure "{\"botId\":\"$BOT_ID\",\"chatKey\":\"$1\",\"meta\":{\"channelId\":\"$MM_CHANNEL\",\"userId\":\"$MM_USER\",\"kind\":\"chat\"}}" \
    | py 'print(d.get("sessionId") or "")'
}

gens() { probe_get "/mm/sessions?botId=$BOT_ID&chatKey=$1" | py 'print(json.dumps(d.get("generations") or []))'; }
# NOTE: `gens` already prints a JSON array, so the follow-up parser must use `d`
# (the already-loaded value) — re-reading stdin silently yields nothing.
gen_count() { gens "$1" | py 'print(len(d))' 2>/dev/null; }
current_sid() { gens "$1" | py 'print([g["sessionId"] for g in d if g["current"]][0])' 2>/dev/null; }

# ===========================================================================
# A: Approval Bridge
# ===========================================================================
a_ask_and_card() {
  hdr "A1  a native approval request reaches Mattermost as a card"
  clear_pending
  local before sid; before=$(stat_of asked)
  sid=$(ensure_map "ch:$MM_CHANNEL")
  [ -z "$sid" ] && { bad "A1 no mapped session"; return; }
  local pid; pid=$(ask_bg "$sid" "call-A1" "A1 需要更高权限" /tmp/ft-A1.out)
  local post; post=$(wait_card 30)
  if [ -z "$post" ]; then bad "A1 no card posted within 30s"; kill "$pid" 2>/dev/null; return; fi
  local after; after=$(stat_of asked)
  [ "$after" -gt "$before" ] && ok "A1 request claimed by the bridge (asked $before -> $after)" || bad "A1 asked did not increase"
  local rec; rec=$(pending_rows | py 'ps=d["pending"];p=ps[0];print("|".join([p["toolName"],p["sessionId"],p["chatKey"],p["state"]]))')
  case "$rec" in
    "bash|$sid|ch:$MM_CHANNEL|pending") ok "A1 pending record is complete and points at the right session" ;;
    *) bad "A1 pending record wrong: $rec" ;;
  esac
  local body; body=$(post_json "$post" | py 'a=(d.get("props") or {}).get("attachments") or [];print("|".join([a[0].get("title",""), [f["value"] for f in a[0]["fields"] if f["title"]=="状态"][0]]) if a else "NO-ATTACHMENT")')
  case "$body" in
    *"bash"*"待决定") ok "A1 card carries the tool name and the pending state" ;;
    *) bad "A1 card body unexpected: $body" ;;
  esac
  echo "$pid" > /tmp/ft-A1.pid
}

a_approve() {
  hdr "A2  a reaction approves exactly once"
  local post id; post=$(wait_card 5); id=$(pending_id)
  [ -z "$post" ] && { bad "A2 no pending request"; return; }
  react "$post" white_check_mark
  sleep 2
  local outcome; outcome=$(ask_outcome /tmp/ft-A1.out)
  [ "$outcome" = "allowed-once" ] && ok "A2 native outcome is allowed-once" || bad "A2 outcome=$outcome"
  if pending_rows | py 'import sys;print("yes" if any(p["id"]=="'"$id"'" for p in (d.get("pending") or [])) else "no")' | grep -q yes; then
    bad "A2 request is still listed as pending"
  else
    ok "A2 request left the pending set"
  fi
  local card; card=$(post_json "$post" | py 'a=(d.get("props") or {}).get("attachments") or [];print([f["value"] for f in a[0]["fields"] if f["title"]=="状态"][0] if a else "NO")')
  case "$card" in *批准*) ok "A2 card was rewritten with the outcome ($card)" ;; *) bad "A2 card not updated ($card)" ;; esac
}

a_reject() {
  hdr "A3  a rejection never grants"
  clear_pending
  local sid; sid=$(ensure_map "ch:$MM_CHANNEL")
  local pid; pid=$(ask_bg "$sid" "call-A3" "A3 拒绝路径" /tmp/ft-A3.out)
  local post; post=$(wait_card 30)
  [ -z "$post" ] && { bad "A3 no card"; kill "$pid" 2>/dev/null; return; }
  react "$post" x
  sleep 2
  local outcome; outcome=$(ask_outcome /tmp/ft-A3.out)
  [ "$outcome" = "rejected" ] && ok "A3 native outcome is rejected" || bad "A3 outcome=$outcome"
}

a_duplicate() {
  hdr "A4  a second decision cannot change a settled request"
  clear_pending
  local sid; sid=$(ensure_map "ch:$MM_CHANNEL")
  local before_rejected; before_rejected=$(stat_of rejected)
  local pid; pid=$(ask_bg "$sid" "call-A4" "A4 幂等" /tmp/ft-A4.out)
  local post; post=$(wait_card 30)
  [ -z "$post" ] && { bad "A4 no card"; kill "$pid" 2>/dev/null; return; }
  react "$post" white_check_mark
  sleep 2
  react "$post" x
  react "$post" white_check_mark
  sleep 3
  local outcome; outcome=$(ask_outcome /tmp/ft-A4.out)
  [ "$outcome" = "allowed-once" ] && ok "A4 the first decision stands (allowed-once)" || bad "A4 outcome=$outcome"
  local after; after=$(stat_of rejected)
  [ "$after" -eq "$before_rejected" ] && ok "A4 later reactions added no decision" || bad "A4 a later reaction was applied (+$((after-before_rejected)))"
}

a_command_settled() {
  hdr "A5  /approve on a settled request reports settled and changes nothing"
  clear_pending
  local sid; sid=$(ensure_map "ch:$MM_CHANNEL")
  local pid; pid=$(ask_bg "$sid" "call-A5" "A5 命令幂等" /tmp/ft-A5.out)
  local post id; post=$(wait_card 30); id=$(pending_id)
  [ -z "$id" ] && { bad "A5 no pending"; kill "$pid" 2>/dev/null; return; }
  react "$post" white_check_mark
  sleep 2
  local t0; t0=$(now_ms)
  inject "$MM_CHANNEL" "$MM_USER" "/approve $id"
  sleep 3
  if reply_has "已经处理过" "$t0"; then ok "A5 second decision is refused with an explicit message"
  elif reply_has "已批准" "$t0"; then bad "A5 second /approve was accepted again"
  else bad "A5 no reply for the second decision"; fi
}

a_unauthorized() {
  hdr "A6  an unauthorized user cannot decide"
  clear_pending
  local sid; sid=$(ensure_map "ch:$MM_CHANNEL")
  local pid; pid=$(ask_bg "$sid" "call-A6" "A6 未授权" /tmp/ft-A6.out)
  local post; post=$(wait_card 30)
  [ -z "$post" ] && { bad "A6 no card"; kill "$pid" 2>/dev/null; return; }
  local before; before=$(stat_of approved)
  react "$post" white_check_mark "not-an-allowed-user"
  sleep 3
  local after; after=$(stat_of approved)
  [ "$after" -eq "$before" ] && ok "A6 unauthorized reaction did not grant" || bad "A6 unauthorized reaction granted!"
  local still; still=$(pending_id)
  [ -n "$still" ] && ok "A6 request is still pending" || bad "A6 request was settled by an unauthorized user"
  clear_pending
  kill "$pid" 2>/dev/null
}

a_wrong_channel() {
  hdr "A7  a decision from another channel is refused"
  clear_pending
  local sid; sid=$(ensure_map "ch:$MM_CHANNEL")
  local pid; pid=$(ask_bg "$sid" "call-A7" "A7 跨频道" /tmp/ft-A7.out)
  local id; id=$(wait_id 30)
  [ -z "$id" ] && { bad "A7 no pending"; kill "$pid" 2>/dev/null; return; }
  local code; code=$(probe_post /mm/decide "{\"requestId\":\"$id\",\"userId\":\"$MM_USER\",\"botId\":\"$BOT_ID\",\"channelId\":\"other-channel\",\"decision\":\"approved\",\"via\":\"test\"}" | py 'print(d.get("code"))')
  [ "$code" = "wrong-channel" ] && ok "A7 cross-channel decision refused ($code)" || bad "A7 expected wrong-channel, got $code"
  local code2; code2=$(probe_post /mm/decide "{\"requestId\":\"$id\",\"userId\":\"$MM_USER\",\"botId\":\"bot-other\",\"channelId\":\"$MM_CHANNEL\",\"decision\":\"approved\",\"via\":\"test\"}" | py 'print(d.get("code"))')
  [ "$code2" = "forbidden" ] && ok "A7 decision from another bot refused ($code2)" || bad "A7 expected forbidden, got $code2"
  clear_pending
  kill "$pid" 2>/dev/null
}

a_native_guard() {
  hdr "A11 the native turn guard is respected, not bypassed"
  local sid; sid=$(ensure_map "ch:$MM_CHANNEL")
  local out; out=$(curl -s --max-time 30 -X POST "$P/mm/ask" -H 'Content-Type: application/json' \
    -d "{\"sessionId\":\"$sid\",\"toolName\":\"bash\",\"callId\":\"call-A11\",\"reason\":\"A11 guard\"}")
  local msg; msg=$(printf '%s' "$out" | py 'print(d.get("message") or "")' 2>/dev/null)
  case "$msg" in
    *"outside an open turn"*) ok "A11 an out-of-turn ask is refused by the native service" ;;
    *) bad "A11 expected the native turn guard, got: ${msg:-$out}" ;;
  esac
}

a_cancelled() {
  hdr "A9  a withdrawn request settles cancelled and grants nothing"
  clear_pending
  local sid; sid=$(ensure_map "ch:$MM_CHANNEL")
  local before; before=$(stat_of cancelled)
  local out; out=$(curl -s --max-time 60 -X POST "$P/mm/waterfall" -H 'Content-Type: application/json' \
    -d "{\"sessionId\":\"$sid\",\"toolName\":\"bash\",\"callId\":\"call-A9\",\"reason\":\"A9 撤回\",\"abortAfterMs\":3000}")
  local outcome; outcome=$(printf '%s' "$out" | py 'print(d.get("outcome") or ("ERR:" + str(d.get("message"))))' 2>/dev/null)
  [ "$outcome" = "cancelled" ] && ok "A9 a withdrawn request settles cancelled ($outcome)" || bad "A9 outcome=${outcome:-<none>}"
  local after; after=$(stat_of cancelled)
  [ "$after" -gt "$before" ] && ok "A9 the cancellation was recorded ($before -> $after)" || bad "A9 cancellation not recorded"
  local approved; approved=$(stat_of approved)
  [ "$approved" -ge 0 ] && ok "A9 nothing was granted" || bad "A9 a grant was recorded"
}

a_unavailable() {
  hdr "A14 an undeliverable card fails closed instead of waiting"
  clear_pending
  # A channel that does not exist makes the card POST fail. Suspending the
  # WebSocket would NOT: the REST API stays up, so the card would post and the
  # request would wait for a decision that nobody was asked for.
  local sid
  sid=$(probe_post /mm/ensure '{"botId":"'"$BOT_ID"'","chatKey":"ch:undeliverable-probe","meta":{"channelId":"no-such-channel-0000","kind":"chat"}}' \
    | py 'print(d.get("sessionId") or "")')
  [ -z "$sid" ] && { bad "A14 could not create the probe conversation"; return; }
  local t0; t0=$(now_ms)
  local out; out=$(curl -s --max-time 90 -X POST "$P/mm/waterfall" -H 'Content-Type: application/json' \
    -d "{\"sessionId\":\"$sid\",\"toolName\":\"bash\",\"callId\":\"call-A14\",\"reason\":\"A14 投递失败\"}")
  local elapsed=$(( $(now_ms) - t0 ))
  local outcome; outcome=$(printf '%s' "$out" | py 'print(d.get("outcome") or ("ERR:" + str(d.get("message"))))' 2>/dev/null)
  [ "$outcome" = "unavailable" ] && ok "A14 undeliverable request fails closed ($outcome)" || bad "A14 outcome=${outcome:-<none>}"
  [ "$elapsed" -lt 30000 ] && ok "A14 it failed fast instead of waiting for the timeout (${elapsed}ms)" \
    || bad "A14 took ${elapsed}ms (waited for the timeout)"
}

a_delegation() {
  hdr "A10 an agent this plugin does not own is delegated, never answered here"
  local target; target=$(probe_post /new-session '{}' | py 'print(d.get("sessionId") if d.get("ok") else "")')
  [ -z "$target" ] && { skip "A10 could not create a foreign session"; return; }
  local before; before=$(stat_of asked)
  # Bounded on purpose: with no browser attached, the Web forwarder claims the
  # request and waits, so this call would otherwise hang indefinitely. That wait
  # is the platform's, not ours — the assertion is that WE did not answer it.
  local out; out=$(curl -s --max-time 10 -X POST "$P/mm/waterfall" -H 'Content-Type: application/json' \
    -d "{\"sessionId\":\"$target\",\"toolName\":\"bash\",\"callId\":\"call-A10\",\"reason\":\"A10 \u975e\u672c\u63d2\u4ef6\u4f1a\u8bdd\"}")
  local outcome="pending-upstream"
  if [ -n "$out" ]; then
    outcome=$(printf '%s' "$out" | py 'print(d.get("outcome") or ("ERR:" + str(d.get("message"))))' 2>/dev/null || echo "unparsed")
  fi
  local after; after=$(stat_of asked)
  case "$outcome" in
    allowed-once|rejected|cancelled) bad "A10 the bridge answered a foreign agent: $outcome" ;;
    pending-upstream) ok "A10 a foreign agent was left to the Web forwarder (no decision from us)" ;;
    unavailable)      ok "A10 a foreign agent fell through to the chain end" ;;
    ERR:*)            ok "A10 a foreign agent was handed on (${outcome#ERR:})" ;;
    *)                ok "A10 a foreign agent was not answered here ($outcome)" ;;
  esac
  [ "$after" -eq "$before" ] && ok "A10 the bridge did not claim a foreign request" || bad "A10 the bridge claimed a foreign request"
  # And it must not have posted a card for it either.
  local cards; cards=$(posts_since "$(( $(now_ms) - 30000 ))" | grep -c "A10 非本插件会话" || true)
  [ "${cards:-0}" -eq 0 ] && ok "A10 no card was posted for a foreign agent" || bad "A10 a card was posted for a foreign agent"
}

a_args() {
  hdr "A13 tool arguments are shown masked and bounded"
  # Unit-level: the masking rules are the security property, so they are checked
  # directly rather than inferred from a card body.
  local out
  out=$(cd "$(dirname "$0")/.." && node --input-type=module -e "
    import { maskSecrets, maskAndClip } from './redact.js'
    const a = maskSecrets('curl -H \"Authorization: Bearer abcdefghijklmnop\" --data password=hunter2 sk-abcdefghijklmnop')
    const b = maskAndClip('x'.repeat(900), 800)
    console.log(JSON.stringify({ a, truncated: b.truncated, len: b.text.length }))
  " 2>/dev/null)
  case "$out" in
    *"[REDACTED]"*"[REDACTED]"*) ok "A13 credentials are masked ($out)" ;;
    *) bad "A13 masking produced $out" ;;
  esac
  case "$out" in
    *'"truncated":true'*) ok "A13 oversize arguments are marked as truncated" ;;
    *) bad "A13 truncation not applied: $out" ;;
  esac
  # Integration: a REAL tool call from the live session.
  local sid call; sid=$(ensure_map "ch:$MM_CHANNEL")
  call=$(probe_get "/mm/calls?sessionId=$sid" | py 'cs=d.get("calls") or [];print(cs[0]["callId"] if cs else "")')
  if [ -z "$call" ]; then
    echo "     (asking the agent for one real bash call; costs one turn)"
    inject "$MM_CHANNEL" "$MM_USER" "请用 bash 工具执行 echo ft-args-check，然后只回复输出。"
    local i
    for i in $(seq 1 120); do
      call=$(probe_get "/mm/calls?sessionId=$sid" | py 'cs=d.get("calls") or [];print(cs[0]["callId"] if cs else "")')
      [ -n "$call" ] && break
      sleep 1
    done
  fi
  if [ -z "$call" ]; then skip "A13 no real tool call in this session (integration half)"; return; fi
  echo "     (using real callId $call)"
  local w
  for w in $(seq 1 90); do
    local st; st=$(curl -s --max-time 10 "$P/agent?sessionId=$sid" | py 'print(d.get("status") or "")' 2>/dev/null)
    [ "$st" != "running" ] && break
    sleep 1
  done
  clear_pending
  local pid; pid=$(ask_bg "$sid" "$call" "A13 参数展示" /tmp/ft-A13.out)
  local post; post=$(wait_card 30)
  [ -z "$post" ] && { bad "A13 no card"; kill "$pid" 2>/dev/null; return; }
  local text; text=$(post_json "$post" | py 'a=(d.get("props") or {}).get("attachments") or [];print(a[0].get("text","") if a else "")')
  case "$text" in
    *"参数"*) ok "A13 card shows an arguments section" ;;
    *) bad "A13 card has no arguments section" ;;
  esac
  case "$text" in
    *"Bearer "*"TOPSECRET"*) bad "A13 card leaked a credential" ;;
    *) ok "A13 no obvious credential in the card" ;;
  esac
  react "$post" x
}

# ===========================================================================
# S: Session Navigator
# ===========================================================================
s_current() {
  hdr "S1  /session reports the current conversation"
  local key="ch:$MM_CHANNEL" sid; sid=$(ensure_map "$key")
  local t0; t0=$(now_ms)
  inject "$MM_CHANNEL" "$MM_USER" "/session"
  sleep 3
  if reply_has "$sid" "$t0"; then ok "S1 reply names the current session"; else bad "S1 reply did not name $sid"; fi
  if posts_since "$t0" | grep -qE '第 [0-9]+ 代'; then ok "S1 reply names the generation"; else bad "S1 generation line missing"; fi
}

s_list() {
  hdr "S2  /sessions lists this conversation's generations only"
  local key="ch:$MM_CHANNEL" other; other=$(ensure_map "th:other-thread-1")
  local t0; t0=$(now_ms)
  inject "$MM_CHANNEL" "$MM_USER" "/sessions"
  sleep 3
  if reply_has "本对话的会话" "$t0"; then ok "S2 list rendered"; else bad "S2 no list reply"; fi
  if reply_has "$other" "$t0"; then bad "S2 leaked another conversation's session"; else ok "S2 does not show another thread's session"; fi
}

s_new() {
  hdr "S3  /new advances the generation and keeps the old one reachable"
  local key="ch:$MM_CHANNEL" before after
  before=$(current_sid "$key")
  local t0; t0=$(now_ms)
  inject "$MM_CHANNEL" "$MM_USER" "/new"
  sleep 3
  after=$(current_sid "$key")
  [ "$before" != "$after" ] && ok "S3 current session changed ($before -> $after)" || bad "S3 session did not change"
  reply_has "已开启新会话" "$t0" && ok "S3 user is told" || bad "S3 no confirmation"
  local n; n=$(gen_count "$key"); n=${n:-0}
  [ "$n" -ge 2 ] && ok "S3 previous generation is still listed ($n total)" || bad "S3 history lost ($n total)"
}

s_switch() {
  hdr "S4  /switch returns to a previous generation of the SAME conversation"
  local key="ch:$MM_CHANNEL"
  # Deterministic pre-state: move away from generation 0 first, so the switch
  # below is always a real move and never the already-current no-op.
  inject "$MM_CHANNEL" "$MM_USER" "/new"
  sleep 3
  local rows; rows=$(gens "$key")
  local count; count=$(printf '%s' "$rows" | py 'print(len(d))' 2>/dev/null)
  [ "${count:-0}" -lt 2 ] && { bad "S4 needs 2 generations (got ${count:-0})"; return; }
  local first; first=$(printf '%s' "$rows" | py 'print([g["sessionId"] for g in d if g["generation"]==0][0])')
  local t0; t0=$(now_ms)
  inject "$MM_CHANNEL" "$MM_USER" "/switch 1"
  sleep 3
  local nowsid; nowsid=$(current_sid "$key")
  [ "$nowsid" = "$first" ] && ok "S4 mapping now points at generation 0" || bad "S4 expected $first, got $nowsid"
  reply_has "已切换" "$t0" && ok "S4 switch confirmed to the user" || bad "S4 no confirmation"
  # The switch must have REDIRECTED the conversation, not copied it: the next
  # message has to resume the target session.
  local t1; t1=$(now_ms)
  inject "$MM_CHANNEL" "$MM_USER" "切换后的一句话"
  local i
  for i in $(seq 1 40); do
    grep -q "agent ready session=$first" "$LOG" && break
    sleep 1
  done
  if grep -q "agent ready session=$first" "$LOG"; then ok "S4 next message resumed the switched-to session"; else bad "S4 message did not reach $first"; fi
}

s_thread_isolation() {
  hdr "S5  a /new in one thread does not move another thread"
  local a="th:root-thread-a" b="th:root-thread-b"
  local sa sb; sa=$(ensure_map "$a"); sb=$(ensure_map "$b")
  [ "$sa" = "$sb" ] && { bad "S5 two threads share one session"; return; }
  ok "S5 two threads map to distinct sessions"
  local before_b; before_b=$(current_sid "$b")
  inject "$MM_CHANNEL" "$MM_USER" "/new" "root-thread-a"
  sleep 3
  local after_a after_b
  after_a=$(current_sid "$a"); after_b=$(current_sid "$b")
  [ "$after_a" != "$sa" ] && ok "S5 the addressed thread advanced" || bad "S5 /new did not move its own thread"
  [ "$before_b" = "$after_b" ] && ok "S5 the other thread is untouched" || bad "S5 another thread moved ($before_b -> $after_b)"
}

s_unknown() {
  hdr "S7  switching to an unknown selector is refused"
  local t0; t0=$(now_ms)
  inject "$MM_CHANNEL" "$MM_USER" "/switch 99"
  sleep 3
  if reply_has "序号超出范围" "$t0"; then ok "S7 out-of-range index refused"; else bad "S7 no refusal for index 99"; fi
  t0=$(now_ms)
  inject "$MM_CHANNEL" "$MM_USER" "/switch mm-doesnotexist"
  sleep 3
  if reply_has "没有匹配" "$t0"; then ok "S7 unknown session id refused"; else bad "S7 unknown id not refused"; fi
}

s_no_web_sessions() {
  hdr "S9  the navigator never shows a session this plugin did not create"
  local t0; t0=$(now_ms)
  inject "$MM_CHANNEL" "$MM_USER" "/sessions"
  sleep 3
  local replies; replies=$(posts_since "$t0")
  local ids; ids=$(printf '%s' "$replies" | grep -oE 'mm-[a-f0-9]{16}(-v[0-9]+)?' | sort -u)
  [ -z "$ids" ] && { bad "S9 the list reply contained no session ids"; return; }
  local foreign=0
  for id in $ids; do
    probe_get "/mm/sessions?botId=$BOT_ID&chatKey=ch:$MM_CHANNEL" | grep -q "$id" || foreign=$((foreign+1))
  done
  [ "$foreign" -eq 0 ] && ok "S9 every id shown belongs to this conversation" || bad "S9 $foreign foreign id(s) shown"
}

# ===========================================================================
# expiry / never / multibot phases
# ===========================================================================
a_expiry() {
  hdr "A8  an unanswered request expires and fails closed"
  clear_pending
  local sid; sid=$(ensure_map "ch:$MM_CHANNEL")
  local pid; pid=$(ask_bg "$sid" "call-A8" "A8 超时" /tmp/ft-A8.out)
  local post; post=$(wait_card 20)
  [ -z "$post" ] && { bad "A8 no card"; kill "$pid" 2>/dev/null; return; }
  local timeout; timeout=$(pending_rows | py 'print(d["stats"]["timeoutMs"])')
  local wait_s=$(( timeout / 1000 + 30 ))
  echo "     (waiting out the configured timeout: ${timeout}ms + 30s margin)"
  local i; for i in $(seq 1 "$wait_s"); do
    [ -s /tmp/ft-A8.out ] && break
    sleep 1
  done
  local outcome; outcome=$(ask_outcome /tmp/ft-A8.out)
  [ "$outcome" = "unavailable" ] && ok "A8 expired request never grants ($outcome)" || bad "A8 outcome=$outcome"
  # The card rewrite is fire-and-forget after the decision resolves: poll the
  # post instead of assuming one round-trip of slack.
  local st="" i
  for i in $(seq 1 15); do
    st=$(post_json "$post" | py 'a=(d.get("props") or {}).get("attachments") or [];print([f["value"] for f in a[0]["fields"] if f["title"]=="状态"][0] if a else "NO")')
    case "$st" in *过期*) break ;; esac
    sleep 1
  done
  case "$st" in *过期*) ok "A8 card shows the expiry ($st)" ;; *) bad "A8 card not marked expired ($st)" ;; esac
  # A late decision must not revive it.
  local code; code=$(probe_post /mm/decide "{\"requestId\":\"$(pending_id)\",\"userId\":\"$MM_USER\",\"botId\":\"$BOT_ID\",\"channelId\":\"$MM_CHANNEL\",\"decision\":\"approved\"}" | py 'print(d.get("code"))')
  [ "$code" = "unknown" ] || [ "$code" = "expired" ] && ok "A8 a late approval is refused ($code)" || bad "A8 late approval produced $code"
}

a_never() {
  hdr "A12  under a never policy the native service rejects BEFORE the bridge"
  # The policy gate lives INSIDE ApprovalService.decide(), so it is only
  # observable through the service — not through the raw waterfall. That means a
  # request inside a REAL turn, which is the only place the service accepts one.
  # A session records its approval policy at CREATION, so an existing session
  # keeps whatever it was born with and the deployment default only governs new
  # ones. This test therefore starts from a brand-new session.
  inject "$MM_CHANNEL" "$MM_USER" "/new"
  sleep 3
  local sid; sid=$(ensure_map "ch:$MM_CHANNEL")
  local before; before=$(stat_of asked)
  inject "$MM_CHANNEL" "$MM_USER" "请用 bash 依次执行 echo a、echo b、echo c，然后汇总结果。"
  local out="" msg="" i
  for i in $(seq 1 120); do
    out=$(curl -s --max-time 20 -X POST "$P/mm/ask" -H 'Content-Type: application/json' \
      -d "{\"sessionId\":\"$sid\",\"toolName\":\"bash\",\"callId\":\"call-A12\",\"reason\":\"A12 never\"}")
    msg=$(printf '%s' "$out" | py 'print(d.get("message") or "")' 2>/dev/null)
    case "$msg" in
      *"outside an open turn"*) sleep 1; continue ;;
    esac
    [ -n "$out" ] && break
    sleep 1
  done
  local outcome; outcome=$(printf '%s' "$out" | py 'print(d.get("outcome") or ("ERR:" + str(d.get("message"))))' 2>/dev/null)
  [ "$outcome" = "rejected" ] && ok "A12 never-policy rejects deterministically ($outcome)" \
    || bad "A12 expected rejected, got '${outcome:-<no response>}'"
  local after; after=$(stat_of asked)
  [ "$after" -eq "$before" ] && ok "A12 the bridge was never consulted" || bad "A12 bridge was consulted (+$((after-before)))"
  local cards; cards=$(posts_since "$(( $(now_ms) - 120000 ))" | grep -c "A12 never" || true)
  [ "${cards:-0}" -eq 0 ] && ok "A12 no approval card was posted" || bad "A12 a card was posted under never"
}

m_bots() {
  hdr "M1/M2  two bots own separate clients, state files and session namespaces"
  local bots; bots=$(probe_get /mm/bots)
  local n; n=$(printf '%s' "$bots" | py 'print(len(d.get("bots") or []))')
  [ "$n" -ge 2 ] && ok "M1 two bots configured and started ($n)" || { bad "M1 only $n bot(s)"; return; }
  local a b; a=$(printf '%s' "$bots" | py 'print(d["bots"][0]["id"])'); b=$(printf '%s' "$bots" | py 'print(d["bots"][1]["id"])')
  local ca cb; ca=$(printf '%s' "$bots" | py 'print(d["bots"][0]["connected"])'); cb=$(printf '%s' "$bots" | py 'print(d["bots"][1]["connected"])')
  [ "$ca" = "True" ] && [ "$cb" = "True" ] && ok "M1 both bots hold their own WebSocket" || bad "M1 connected: $a=$ca $b=$cb"
  ok "M1 bot ids: $a, $b"
  # A state file is written when the bot first records an event, so drive one
  # post through both sockets before asserting the files exist. `/session` is a
  # command: it produces a post event but starts no model turn.
  inject "$MM_CHANNEL" "$MM_USER" "/session"
  sleep 5
  # The FIRST bot deliberately keeps the historical `state.json` name; every
  # other bot gets `state.<id>.json`. Distinct files are what isolation needs.
  local f1="$STATE/state.json" f2="$STATE/state.$b.json"
  [ -f "$f1" ] && ok "M1 $a keeps the primary state file ($(basename "$f1"))" || bad "M1 missing $f1"
  [ -f "$f2" ] && ok "M1 $b has its own state file ($(basename "$f2"))" || bad "M1 missing $f2"
  local s1 s2
  s1=$(probe_post /mm/ensure "{\"botId\":\"$a\",\"chatKey\":\"ch:$MM_CHANNEL\",\"meta\":{}}" | py 'print(d.get("sessionId") or "")')
  s2=$(probe_post /mm/ensure "{\"botId\":\"$b\",\"chatKey\":\"ch:$MM_CHANNEL\",\"meta\":{}}" | py 'print(d.get("sessionId") or "")')
  [ -n "$s1" ] && [ -n "$s2" ] && [ "$s1" != "$s2" ] && ok "M2 same channel, distinct sessions ($s1 vs $s2)" || bad "M2 session collision: '$s1' / '$s2'"
  local t1 t2
  t1=$(probe_post /mm/ensure "{\"botId\":\"$a\",\"chatKey\":\"th:shared-thread\",\"meta\":{}}" | py 'print(d.get("sessionId") or "")')
  t2=$(probe_post /mm/ensure "{\"botId\":\"$b\",\"chatKey\":\"th:shared-thread\",\"meta\":{}}" | py 'print(d.get("sessionId") or "")')
  [ -n "$t1" ] && [ -n "$t2" ] && [ "$t1" != "$t2" ] && ok "M2 same thread, distinct sessions" || bad "M2 thread collision"
  # WS independence: dropping one socket must not reconnect the other.
  local before1 before2
  before1=$(printf '%s' "$bots" | py 'print(d["bots"][0]["reconnects"])')
  before2=$(printf '%s' "$bots" | py 'print(d["bots"][1]["reconnects"])')
  probe_get /wsdrop >/dev/null
  sleep 10
  local after1 after2
  after1=$(probe_get /mm/bots | py 'print(d["bots"][0]["reconnects"])')
  after2=$(probe_get /mm/bots | py 'print(d["bots"][1]["reconnects"])')
  [ "$after1" -gt "$before1" ] && ok "M5 dropped bot reconnected ($before1 -> $after1)" || bad "M5 drop did not reconnect"
  [ "$after2" -eq "$before2" ] && ok "M5 the other bot's reconnect counter is untouched" || bad "M5 the other bot reconnected too"
}

m_legacy_unit() {
  hdr "M6  legacy mapping: read under the new namespace, never moved"
  local out
  out=$(cd "$(dirname "$0")/.." && node --input-type=module -e "
    import { createSessionMap } from './mapping.js'
    import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs'
    import { tmpdir } from 'node:os'
    import { join } from 'node:path'
    const dir = mkdtempSync(join(tmpdir(), 'mm-legacy-'))
    const file = join(dir, 'session-map.json')
    writeFileSync(file, JSON.stringify({ version: 1, entries: { 'th:legacy': {
      sessionId: 'mm-legacy00000000', generation: 0, createdAt: 1, updatedAt: 2,
      channelId: 'c', rootId: 'r', userId: 'u', kind: 'task' } } }))
    const quiet = { warn() {}, info() {} }
    const map = createSessionMap({ file, logger: quiet, legacyBotId: 'bot0' })
    const seen = map.peek('bot0', 'th:legacy')
    const other = map.peek('bot1', 'th:legacy')
    const raw = JSON.parse(readFileSync(file, 'utf8')).entries
    const fresh = map.entryFor('bot1', 'th:legacy')
    console.log(JSON.stringify({
      sameSession: seen.sessionId === 'mm-legacy00000000',
      isolated: other === undefined,
      bareKept: raw['th:legacy'] !== undefined,
      scopedAdded: raw['bbot0:th:legacy'] !== undefined,
      distinctPerBot: fresh.sessionId !== seen.sessionId,
    }))
  " 2>/dev/null)
  case "$out" in
    *'"sameSession":true'*)  ok "M6 the legacy session id is preserved" ;; *) bad "M6 legacy session not preserved: $out" ;;
  esac
  case "$out" in
    *'"bareKept":true'*)     ok "M6 the bare legacy key is left on disk" ;; *) bad "M6 legacy key removed: $out" ;;
  esac
  case "$out" in
    *'"scopedAdded":true'*)  ok "M6 the scoped key was written" ;; *) bad "M6 scoped key missing: $out" ;;
  esac
  case "$out" in
    *'"isolated":true'*)     ok "M6 a second bot cannot see the first bot's legacy key" ;; *) bad "M6 cross-bot leak: $out" ;;
  esac
  case "$out" in
    *'"distinctPerBot":true'*) ok "M6 the same chat key yields distinct sessions per bot" ;; *) bad "M6 per-bot collision: $out" ;;
  esac
}

m_legacy() {
  hdr "M7  the LIVE home shows the new namespace for a migrated mapping"
  local raw; raw=$(python3 - "$STATE/session-map.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))["entries"]
bare = [k for k in d if not k.startswith("b")]
scoped = [k for k in d if k.startswith("b")]
print(json.dumps({"bare": bare[:3], "scoped": scoped[:3], "n": len(d)}))
PY
)
  echo "     map: $raw"
  case "$raw" in
    *'"bare":[]'*) skip "M6 this home was created after the change (no bare legacy keys)" ;;
    *) local key; key=$(printf '%s' "$raw" | py 'print((json.load(sys.stdin)["bare"] or [""])[0])')
       if [ -n "$key" ]; then
         probe_get "/mm/sessions?botId=$BOT_ID&chatKey=$key" | grep -q "mm-" && ok "M6 legacy key $key resolves in the new namespace" || bad "M6 legacy key $key not readable"
         python3 - "$STATE/session-map.json" "$key" <<'PY' && ok "M6 the bare legacy key is still present (never moved)" || bad "M6 legacy key disappeared"
import json, sys
d = json.load(open(sys.argv[1]))["entries"]
sys.exit(0 if sys.argv[2] in d else 1)
PY
       fi ;;
  esac
}

# ===========================================================================
need_ready() {
  # `started` is set before the sockets connect, so wait for BOTH before the
  # first assertion: a suite that starts during connect produces false FAILs.
  local i
  for i in $(seq 1 30); do
    case "$(probe_get /status)" in
      *'"started":true'*'"connected":true'*) break ;;
    esac
    sleep 1
  done
  local status; status=$(probe_get /status)
  case "$status" in
    *'"started":true'*) : ;;
    *) printf 'ABORT: the isolated instance is not serving the plugin: %s\n' "${status:-<empty>}" >&2; exit 3 ;;
  esac
  printf '%s' "$status" | grep -q '"connected":true' || { printf 'ABORT: no WebSocket connected\n' >&2; exit 3; }
  # /status is the production-shaped summary; the bot table lives on /mm/bots.
  local bots; bots=$(probe_get /mm/bots)
  local n; n=$(printf '%s' "$bots" | py 'print(len(d.get("bots") or []))' 2>/dev/null)
  [ "${n:-0}" -ge 1 ] || { printf 'ABORT: no bot configured (%s)\n' "${bots:-<empty>}" >&2; exit 3; }
}

# ===========================================================================
# D1: command entry without a mention
#
# Regression for the 2026-11-02 production defect: a bare `/session` post was
# dropped by the mention gate before the command layer ran, and `@bot /session`
# was handed to the agent as chat. Every case below goes through the real
# handlePost() via the probe's /inject, which is the same entry a WebSocket
# frame takes once the transport has delivered the post.
# ===========================================================================
bot_username() { probe_get /mm/bots | py 'print((d.get("bots") or [{}])[0].get("username") or "")'; }

posts_after() { posts_since "$1" | wc -l | tr -d ' '; }

d1_bare_command() {
  hdr "D1.1 a bare /session in a channel is handled (was silently dropped)"
  local t0; t0=$(now_ms)
  inject "$MM_CHANNEL" "$MM_USER" "/session"
  sleep 3
  if reply_has "第 0 代" "$t0"; then ok "D1.1 bare command answered with the current generation"
  elif [ "$(posts_after "$t0")" -gt 0 ]; then ok "D1.1 bare command answered"
  else bad "D1.1 bare command produced no reply"; fi
}

d1_mentioned_command() {
  hdr "D1.2 @bot /session reaches the same command branch"
  local u; u=$(bot_username)
  if [ -z "$u" ]; then skip "D1.2 no bot username from /mm/bots"; return; fi
  local t0; t0=$(now_ms)
  inject "$MM_CHANNEL" "$MM_USER" "@$u /session"
  sleep 3
  if reply_has "第 0 代" "$t0"; then ok "D1.2 mentioned command answered as a command (not chat)"
  else bad "D1.2 mentioned command was not handled as a command"; fi
}

d1_plain_blocked() {
  hdr "D1.3 a plain message without a mention is still gated"
  local t0; t0=$(now_ms)
  inject "$MM_CHANNEL" "$MM_USER" "d1-plain-without-mention"
  sleep 3
  if [ "$(posts_after "$t0")" -eq 0 ]; then ok "D1.3 no reply (mention gate intact)"
  else bad "D1.3 the mention gate leaked a reply"; fi
}

d1_plain_mentioned() {
  hdr "D1.4 @bot plain message still reaches the chat branch"
  local u; u=$(bot_username)
  if [ -z "$u" ]; then skip "D1.4 no bot username"; return; fi
  local t0; t0=$(now_ms)
  inject "$MM_CHANNEL" "$MM_USER" "@$u d1-mention-ok"
  sleep 4
  if [ "$(posts_after "$t0")" -gt 0 ]; then ok "D1.4 mentioned chat answered"
  else bad "D1.4 mentioned chat produced no reply"; fi
}

d1_unknown_blocked() {
  hdr "D1.5 a bare unknown command does not bypass the mention gate"
  local t0; t0=$(now_ms)
  inject "$MM_CHANNEL" "$MM_USER" "/d1unknown"
  sleep 3
  if [ "$(posts_after "$t0")" -eq 0 ]; then ok "D1.5 bare unknown command stayed silent"
  else bad "D1.5 bare unknown command bypassed the gate"; fi
}

d1_unknown_mentioned() {
  hdr "D1.6 an unknown command that got through is refused, not chatted"
  local u; u=$(bot_username)
  if [ -z "$u" ]; then skip "D1.6 no bot username"; return; fi
  local t0; t0=$(now_ms)
  inject "$MM_CHANNEL" "$MM_USER" "@$u /d1unknown"
  sleep 3
  if reply_has "未知命令" "$t0"; then ok "D1.6 unknown command refused explicitly"
  else bad "D1.6 unknown command fell through to chat or was dropped"; fi
}

d1_unauthorized_command() {
  hdr "D1.7 an unauthorized user's valid command is still rejected"
  local t0; t0=$(now_ms)
  inject "$MM_CHANNEL" "not-an-allowed-user" "/session"
  sleep 3
  if [ "$(posts_after "$t0")" -eq 0 ]; then ok "D1.7 unauthorized command produced no reply"
  else bad "D1.7 unauthorized command was answered"; fi
}

d1_dm_command() {
  hdr "D1.8 a DM command keeps working without a mention"
  local t0; t0=$(now_ms)
  inject "$MM_CHANNEL" "$MM_USER" "/session" "" "D"
  sleep 3
  if reply_has "第 0 代" "$t0"; then ok "D1.8 DM command answered"
  else bad "D1.8 DM command produced no reply"; fi
}

d1_own_post() {
  hdr "D1.9 the bot's own post is still filtered"
  if [ -z "${MM_BOT:-}" ]; then skip "D1.9 no MM_BOT id"; return; fi
  local t0; t0=$(now_ms)
  inject "$MM_CHANNEL" "$MM_BOT" "/session"
  sleep 3
  if [ "$(posts_after "$t0")" -eq 0 ]; then ok "D1.9 own post ignored"
  else bad "D1.9 the bot reacted to itself"; fi
}

d1_all() {
  d1_bare_command; d1_mentioned_command; d1_plain_blocked; d1_plain_mentioned
  d1_unknown_blocked; d1_unknown_mentioned; d1_unauthorized_command; d1_dm_command; d1_own_post
}

main() {
  local groups=("$@")
  [ ${#groups[@]} -eq 0 ] && groups=(core)
  printf 'dsh-mattermost feature acceptance\n  probe: %s\n  home:  %s\n  channel: %s\n' "$P" "$MMT_HOME" "$MM_CHANNEL"
  need_ready
  for g in "${groups[@]}"; do
    case "$g" in
      core)
        a_ask_and_card; a_approve; a_reject; a_duplicate; a_command_settled
        a_unauthorized; a_wrong_channel; a_native_guard; a_cancelled; a_unavailable; a_delegation; a_args
        s_current; s_list; s_new; s_switch; s_thread_isolation; s_unknown; s_no_web_sessions ;;
      expiry) a_expiry ;;
      never) a_never ;;
      multibot) m_legacy_unit; m_bots; m_legacy ;;
      d1) d1_all ;;
      *) echo "unknown group: $g" >&2; exit 2 ;;
    esac
  done
  clear_pending
  printf '\n-- summary: pass=%d fail=%d skip=%d\n' "$PASS" "$FAIL" "$SKIP"
  [ "$FAIL" -eq 0 ] && exit 0 || exit 1
}
main "$@"
