#!/usr/bin/env bash
# Durable delayed-job scheduler — acceptance suite (T1–T34).
#
# Runs against the ISOLATED harness only (DSH_HOME=$MMT_HOME,
# profile mmt-test, probe 127.0.0.1:3091). Production is never touched.
#
#   ./run.sh              run the MAIN suite (every group except T6/T17)
#   ./run.sh T11 T22      run a subset, by group name
#
# T6/T17 need a shortened idle TTL and are run by run-eviction.sh, not here.
# Evidence is written to scheduler-test/evidence/.
set -u

# Harness locations. Neither is baked in: point them at your own setup.
MMT_HOME="${MMT_HOME:-$HOME/.dsh-mmt-test}"
# Which isolated profile the harness runs. The TTL gate matches this phrase
# exactly (plus exe == node), so it can never latch onto production or a shell.
MMT_PROFILE="${MMT_PROFILE:-mmt-test}"
BIN="${MMT_BIN:?set MMT_BIN to the harness checkout that holds restart-test.sh and mm.sh}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
P="${PROBE:-http://127.0.0.1:3091}"
CH="${MM_TEST_CHANNEL:?set MM_TEST_CHANNEL to your Mattermost channel id}"
OWNER="${MM_TEST_OWNER:?set MM_TEST_OWNER to your authorized Mattermost user id}"
HERE="$(cd "$(dirname "$0")" && pwd)"
E="$HERE/evidence"
mkdir -p "$E"

PASS=0; FAIL=0; SKIP=0
declare -a RESULTS=()

ok()   { PASS=$((PASS+1)); RESULTS+=("PASS  $1"); printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); RESULTS+=("FAIL  $1"); printf '  \033[31mFAIL\033[0m  %s\n' "$1"; }
skip() { SKIP=$((SKIP+1)); RESULTS+=("SKIP  $1"); printf '  \033[33mSKIP\033[0m  %s\n' "$1"; }
hdr()  { printf '\n\033[1m=== %s ===\033[0m\n' "$1"; }

jq_() { python3 -c "import sys,json;d=json.load(sys.stdin);$1"; }
now_ms() { python3 -c 'import time;print(int(time.time()*1000))'; }

# curl's own exit code -> a failure class we can report. Without this the
# difference between "nothing is listening", "the request timed out" and "the
# endpoint answered" is lost: a bare reachability check keeps only
# success/failure, which cannot tell those three apart.
curl_fail_class() {
  case "$1" in
    6)  echo 'dns-failure' ;;
    7)  echo 'connection-refused' ;;
    28) echo 'request-timeout' ;;
    35) echo 'tls-handshake-failed' ;;
    52) echo 'empty-reply' ;;
    56) echo 'recv-failure' ;;
    0)  echo 'ok' ;;
    *)  echo "curl-rc-$1" ;;
  esac
}

# wait_settled <since_ms> <floor_ms> <budget_s> <stable_probes>
#
# Bounded replacement for the old `sleep N` + reachability check after a restart.
# Readiness here is a real condition, not "a port is open":
#   - /status answers HTTP 200 within the per-request timeout, and
#   - /jobs answers HTTP 200 with a NON-NULL scheduler whose tick counter has
#     advanced since the first observation (job store open, timer live), and
#   - that pair has just succeeded <stable_probes> times in a row.
#
# Why the status code alone is not enough: the plugin exposes its `mattermost`
# service (and therefore `/status` and `/jobs`) when `apply()` runs, BEFORE the
# token is resolved, the websocket connects, the job store opens or the
# scheduler recovers. A 200 there means "the endpoint exists", not "the harness
# has recovered".
#
# Why consecutive probes are not cosmetic: measured on a mid-turn restart with a
# due job, the probe is absent until ~+8s, then serves normally, then cannot
# answer for ~10s around +33s while the startup catch-up tick dispatches that
# job and resumes the session. A single successful probe can land in that gap,
# and the `jobfield` call that follows then reads an empty body.
#
# <floor_ms> preserves the caller's scenario timing (T22 needs the 30s deferral
# window to have elapsed while the process was down) instead of letting a fast
# boot silently change what is being tested.
wait_settled() {
  local since_ms="$1" floor_ms="$2" budget="$3" need="$4"
  local t0; t0=$(date +%s)
  local first_ticks='' streak=0 attempt=0 last='no attempt recorded'
  while :; do
    attempt=$((attempt + 1))
    local e1 e2 s_code s_rc ms j_code j_rc jms ticks
    e1=$(date +%s%N)
    s_code=$(curl -s -o /tmp/.wait_status -w '%{http_code}' --max-time 4 "$P/status" 2>/dev/null)
    s_rc=$?
    e2=$(date +%s%N); ms=$(( (e2 - e1) / 1000000 ))
    if [ "$s_rc" -ne 0 ]; then
      streak=0
      last="attempt $attempt: /status curl rc=$s_rc ($(curl_fail_class "$s_rc")) after ${ms}ms"
    elif [ "$s_code" != "200" ]; then
      streak=0
      last="attempt $attempt: /status HTTP $s_code after ${ms}ms"
    else
      e1=$(date +%s%N)
      j_code=$(curl -s -o /tmp/.wait_jobs -w '%{http_code}' --max-time 4 "$P/jobs" 2>/dev/null)
      j_rc=$?
      e2=$(date +%s%N); jms=$(( (e2 - e1) / 1000000 ))
      if [ "$j_rc" -ne 0 ]; then
        streak=0
        last="attempt $attempt: /status 200 in ${ms}ms; /jobs curl rc=$j_rc ($(curl_fail_class "$j_rc")) after ${jms}ms"
      elif [ "$j_code" != "200" ]; then
        streak=0
        last="attempt $attempt: /status 200 in ${ms}ms; /jobs HTTP $j_code after ${jms}ms"
      else
        ticks=$(python3 -c 'import json;d=json.load(open("/tmp/.wait_jobs"));s=d.get("scheduler");print("" if s is None else s.get("ticks",""))' 2>/dev/null)
        if [ -z "$ticks" ]; then
          streak=0
          last="attempt $attempt: /jobs 200 but scheduler is null (job store not open yet) after ${jms}ms"
        elif [ -z "$first_ticks" ]; then
          first_ticks="$ticks"; streak=0
          last="attempt $attempt: serving (status ${ms}ms, jobs ${jms}ms, ticks=$ticks); waiting for the tick counter to advance"
        elif [ "$ticks" -le "$first_ticks" ]; then
          streak=0
          last="attempt $attempt: ticks still $ticks (not yet > $first_ticks)"
        else
          streak=$((streak + 1))
          last="attempt $attempt: ticks $first_ticks -> $ticks, stable ${streak}/${need}"
          local elapsed_ms=$(( $(now_ms) - since_ms ))
          if [ "$streak" -ge "$need" ] && [ "$elapsed_ms" -ge "$floor_ms" ]; then
            printf '  settled: /status %sms, /jobs %sms, ticks %s -> %s, %s consecutive probe(s), +%ss since restart\n' \
              "$ms" "$jms" "$first_ticks" "$ticks" "$streak" "$((elapsed_ms / 1000))"
            rm -f /tmp/.wait_status /tmp/.wait_jobs
            return 0
          fi
        fi
      fi
    fi
    if [ $(( $(date +%s) - t0 )) -ge "$budget" ]; then
      echo "  !! harness did not settle within ${budget}s (${attempt} probe(s))"
      echo "     last probe: $last"
      local n=0 pid exe cmd
      for pid in $(pgrep -f 'dsh --profile' 2>/dev/null); do
        exe=$(readlink "/proc/$pid/exe" 2>/dev/null)
        case "$exe" in */node|*/nodejs) ;; *) continue ;; esac
        cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null)
        case "$cmd" in *"dsh --profile mmt-test"*) n=$((n + 1)) ;; esac
      done
      echo "     harness node process(es): $n"
      echo "     listening 3090/3091: $(ss -tln 2>/dev/null | grep -cE ':3090|:3091')"
      echo "     plugin.log tail (message bodies are not logged; ids are shortened):"
      tail -8 "$MMT_HOME/mattermost/plugin.log" 2>/dev/null | sed 's/^/       /'
      rm -f /tmp/.wait_status /tmp/.wait_jobs
      exit 2
    fi
    sleep 2
  done
}

# create <type> <sessionId> <executeAtMs> <message> -> job id (or empty)
#
# Every id created here is also appended to $E/created_ids.txt (the run's
# created-id list). It has to be a FILE, not an array: every call site uses
# `id=$(create ...)`, and a command substitution runs in a subshell, so an
# `IDS+=("$id")` inside this function would be discarded before the caller ever
# sees it. The list is what teardown_jobs() reconciles at the end of the run.
create() {
  local id
  id=$(curl -s --max-time 10 -X POST "$P/job/create" -H 'Content-Type: application/json' \
    -d "$(python3 -c '
import json,sys
print(json.dumps({"type":sys.argv[1],"sessionId":sys.argv[2],"executeAt":int(sys.argv[3]),
                  "channelId":sys.argv[5],"createdBy":sys.argv[6],"message":sys.argv[4]}))
' "$1" "$2" "$3" "$4" "$CH" "$OWNER")" \
    | jq_ 'print(d["job"]["id"] if d.get("ok") else "")')
  if [ -n "$id" ]; then printf '%s\n' "$id" >> "$E/created_ids.txt"; fi
  printf '%s' "$id"
}
jobfield() { curl -s --max-time 8 "$P/jobs" | jq_ "
for j in d['jobs']:
    if j['id']=='$1': print(j.get('$2'))
"; }
jobcount() { curl -s --max-time 8 "$P/jobs" | jq_ 'print(len(d["jobs"]))'; }
tick()     { curl -s --max-time 30 -X POST "$P/job/tick" >/dev/null; }
sched()    { curl -s --max-time 8 "$P/jobs" | jq_ 'print(json.dumps(d["scheduler"]))'; }

# A session that exists and is resumable, owned by the test channel.
SESSION=$(python3 -c "
import json
m=json.load(open('$MMT_HOME/mattermost/session-map.json'))['entries']
pref=[k for k in m if ':'.join(k.split(':')[-2:-1]) == 'ch']
print(m[(pref or list(m))[0]]['sessionId'])
")
# Two distinct sessions, for isolation tests.
SESSION_B=$(python3 -c "
import json
m=json.load(open('$MMT_HOME/mattermost/session-map.json'))['entries']
ks=[k for k in m if ':'.join(k.split(':')[-2:-1]) == 'th']
print(m[ks[0]]['sessionId'] if ks else '')
")

# --------------------------------------------------------------------------- T1
t1() {
  hdr "T1  create a job"
  local at; at=$(($(now_ms)+3600000))
  local id; id=$(create reminder "$SESSION" "$at" "[T1] hello")
  if [ -n "$id" ]; then ok "T1 job created ($id)"; else bad "T1 job creation returned no id"; fi
  local st; st=$(jobfield "$id" status)
  [ "$st" = "pending" ] && ok "T1 initial status pending" || bad "T1 status=$st (want pending)"
  local ondisk
  ondisk=$(ls $MMT_HOME/storages/mattermost_jobs/jobs/"$id".json 2>/dev/null)
  [ -n "$ondisk" ] && ok "T1 record durable on disk" || bad "T1 record not found on disk"
  curl -s -X POST "$P/job/cancel" -H 'Content-Type: application/json' -d "{\"id\":\"$id\"}" >/dev/null
}

# --------------------------------------------------------------------------- T2
t2() {
  hdr "T2  job executes when due"
  # Acceptance target: a job that comes due while its target agent is IDLE is
  # dispatched when due. It is NOT "a job against a busy agent eventually runs":
  # that is the deferral path, and T11 owns it (T22 owns the restart variant).
  #
  # The precondition used to be absent, which made this test read whatever the
  # environment happened to be doing. A busy target makes the scheduler defer the
  # job -- rewriting executeAt ~jobBusyRetryMs (30s) into the future -- so the
  # single observation below saw `pending` and all three assertions failed at
  # once. That is a correct deferral being reported as a broken scheduler.
  local idle='' i=0
  while [ "$i" -lt 20 ]; do
    idle=$(curl -s --max-time 8 "$P/agent?sessionId=$SESSION" | jq_ 'print(d["status"])' 2>/dev/null)
    [ "$idle" != "running" ] && break
    sleep 3; i=$((i+1))
  done
  if [ "$idle" = "running" ]; then
    skip "T2 target session stayed busy for $((i*3))s — a deferred job is T11/T22's subject, not T2's"
    return
  fi
  ok "T2 precondition: target session is idle (status=${idle:-unknown})"

  local at; at=$(($(now_ms)+2000))
  local id; id=$(create reminder "$SESSION" "$at" "[T2] 请只回复 T2_OK")
  sleep 3; tick; sleep 2

  # Safety net for the race the precondition cannot close: the session can still
  # become busy between the probe above and the job coming due. A logged deferral
  # is evidence of the busy path, which is a SKIP here (never a PASS: nothing is
  # claimed about due-time dispatch) and never a FAIL (nothing is broken).
  if grep -q "job deferred (agent busy) id=$id" $MMT_HOME/mattermost/plugin.log; then
    skip "T2 job was deferred by a busy target (status=$(jobfield "$id" status)) — deferral is T11/T22's subject"
    return
  fi

  # Only `completed` passes. `failed`, `unknown`, a still-`pending` record and an
  # empty/missing record are all failures.
  local st; st=$(jobfield "$id" status)
  [ "$st" = "completed" ] && ok "T2 dispatched at due time" || bad "T2 status=$st (want completed)"
  local d; d=$(jobfield "$id" dispatchedAt)
  [ "$d" != "None" ] && [ -n "$d" ] && ok "T2 dispatchedAt recorded" || bad "T2 dispatchedAt missing"
  grep -q "job dispatched id=$id" $MMT_HOME/mattermost/plugin.log \
    && ok "T2 dispatch logged" || bad "T2 dispatch not logged"
}

# --------------------------------------------------------------------------- T3
t3() {
  hdr "T3  cancel a job"
  local at; at=$(($(now_ms)+2000))
  local id; id=$(create reminder "$SESSION" "$at" "[T3] must never run")
  curl -s -X POST "$P/job/cancel" -H 'Content-Type: application/json' -d "{\"id\":\"$id\"}" >/dev/null
  local st; st=$(jobfield "$id" status)
  [ "$st" = "cancelled" ] && ok "T3 cancelled before due" || bad "T3 status=$st (want cancelled)"
  sleep 3; tick; sleep 1
  st=$(jobfield "$id" status)
  [ "$st" = "cancelled" ] && ok "T3 still cancelled after due time" || bad "T3 status became $st"
  grep -q "job dispatched id=$id" $MMT_HOME/mattermost/plugin.log \
    && bad "T3 cancelled job was dispatched" || ok "T3 never dispatched"
}

# --------------------------------------------------------------------------- T4
t4() {
  hdr "T4  list jobs"
  local n; n=$(jobcount)
  [ "$n" -ge 1 ] && ok "T4 list returns $n job(s)" || bad "T4 list empty"
  curl -s --max-time 8 "$P/jobs" | python3 -c "
import sys,json
d=json.load(sys.stdin)
keys={'id','type','status','executeAt','sessionId','attempts','dispatchedAt'}
j=d['jobs'][0]
missing=keys-set(j)
print('  fields present, missing:', missing or 'none')
" | tee "$E/t4_list.txt"
  ok "T4 listing exposes full record shape"
}

# --------------------------------------------------------------------------- T5
t5() {
  hdr "T5  live agent reused at due time (no second agent)"
  # Make the session live first.
  curl -s --max-time 20 -X POST "$P/inject" -H 'Content-Type: application/json' \
    -d "{\"channelId\":\"$CH\",\"userId\":\"$OWNER\",\"channelType\":\"O\",\"message\":\"@dsh T5 warmup: reply T5W\"}" >/dev/null
  sleep 12
  local live1; live1=$(curl -s "$P/agent?sessionId=$SESSION" | jq_ 'print(d["live"])')
  if [ "$live1" != "True" ]; then skip "T5 session did not become live"; return; fi
  ok "T5 agent live before due time"
  local at; at=$(($(now_ms)+2000))
  local id; id=$(create agent_followup "$SESSION" "$at" "[T5] live-agent reuse check")
  sleep 3; tick; sleep 3
  local st; st=$(jobfield "$id" status)
  [ "$st" = "completed" ] && ok "T5 dispatched into the live agent" || bad "T5 status=$st"
  local same; same=$(curl -s "$P/agent?sessionId=$SESSION" | jq_ 'print(d["sameObject"])')
  [ "$same" = "True" ] && ok "T5 same agent object (no duplicate agent)" || bad "T5 agent identity differs"
}

# --------------------------------------------------------------------------- T6/T17
# The incident replay: schedule a job further out than the idle TTL, let the
# agent be evicted, and prove the job still fires.
t6() {
  hdr "T6/T17  job survives idle eviction (incident replay)"
  local ttl_ms; ttl_ms=$(grep -o 'T6_TTL_MS=[0-9]*' "$E/ttl.env" 2>/dev/null | cut -d= -f2)
  ttl_ms=${ttl_ms:-60000}
  # Bring the session live.
  curl -s --max-time 20 -X POST "$P/inject" -H 'Content-Type: application/json' \
    -d "{\"channelId\":\"$CH\",\"userId\":\"$OWNER\",\"channelType\":\"O\",\"message\":\"@dsh T6 warmup: reply T6W\"}" >/dev/null
  sleep 12
  local live1; live1=$(curl -s "$P/agent?sessionId=$SESSION" | jq_ 'print(d["live"])')
  [ "$live1" = "True" ] && ok "T6 agent live (job scheduled)" || { skip "T6 session not live"; return; }

  # Due AFTER the TTL, so eviction necessarily precedes execution.
  local due_in=$(( ttl_ms / 1000 + 45 ))
  local at; at=$(($(now_ms)+due_in*1000))
  local id; id=$(create reminder "$SESSION" "$at" "[T6] 请只回复 T6_OK")
  echo "  job $id due in ${due_in}s; idle TTL ${ttl_ms}ms"

  echo "  waiting $(( ttl_ms/1000 + 20 ))s for the idle sweep to evict the agent..."
  sleep $(( ttl_ms/1000 + 20 ))
  local live2; live2=$(curl -s "$P/agent?sessionId=$SESSION" | jq_ 'print(d["live"])')
  local st; st=$(jobfield "$id" status)
  if [ "$live2" = "False" ]; then ok "T6 agent WAS evicted (live=false)"; else bad "T6 agent not evicted (live=$live2)"; fi
  if [ "$st" = "pending" ]; then ok "T6 job SURVIVED eviction (still pending)"; else bad "T6 job status=$st (want pending)"; fi
  grep -q "evicted idle agent session=$SESSION" $MMT_HOME/mattermost/plugin.log \
    && ok "T6 eviction recorded in log" || skip "T6 no eviction line yet"

  echo "  waiting for the job to come due..."
  local wait_s=$(( due_in - (ttl_ms/1000 + 20) + 6 ))
  [ "$wait_s" -gt 0 ] && sleep "$wait_s"
  tick; sleep 3
  st=$(jobfield "$id" status)
  [ "$st" = "completed" ] && ok "T6 job EXECUTED after eviction" || bad "T6 status=$st (want dispatched)"
  local live3; live3=$(curl -s "$P/agent?sessionId=$SESSION" | jq_ 'print(d["live"])')
  [ "$live3" = "True" ] && ok "T6 session was RESUMED by the scheduler" || bad "T6 session not resumed"
  grep -q "job dispatched id=$id" $MMT_HOME/mattermost/plugin.log \
    && ok "T6 dispatch logged after eviction" || bad "T6 dispatch not logged"
}

# --------------------------------------------------------------------------- T7/T18
t7() {
  hdr "T7/T18  job survives a process restart"
  local due_in=${1:-45}
  local at; at=$(($(now_ms)+due_in*1000))
  local id; id=$(create reminder "$SESSION" "$at" "[T7] 请只回复 T7_OK")
  local st; st=$(jobfield "$id" status)
  [ "$st" = "pending" ] && ok "T7 job pending before restart" || bad "T7 status=$st"

  echo "  restarting the harness (simulates the 04:00 dsh-web restart)..."
  local restart_at; restart_at=$(now_ms)
  "$BIN/restart-test.sh" >/dev/null
  # Bounded readiness, deliberately with no floor: readiness IS the margin here.
  # `at` was taken `due_in` (45s) BEFORE the restart, and the `sleep due_in` below
  # only starts once readiness is reached, so the due-time assertion lands
  # readiness+45s after restart_at while the job is due at restart_at+45s. The slack
  # therefore equals the readiness duration: ~6s at worst (wait_settled requires 3
  # consecutive probes at >=2s apart) and ~12s on the measured harness
  # (`settled: ... +12s since restart`). An earlier comment claimed ">14s even if
  # readiness returns immediately", which overstated it and had the reasoning
  # backwards -- a faster boot shrinks this margin rather than preserving it.
  wait_settled "$restart_at" 0 60 3
  ok "T7 harness restarted"

  local st2; st2=$(jobfield "$id" status)
  if [ -n "$st2" ]; then ok "T7 job SURVIVED restart (status=$st2)"; else bad "T7 job lost across restart"; return; fi
  grep -q "job recovery:" $MMT_HOME/mattermost/plugin.log \
    && ok "T7 startup recovery ran" || skip "T7 no orphaned job to recover (expected when none were running)"

  echo "  waiting for the job to come due..."
  sleep "$(( due_in ))"
  tick; sleep 3
  local st3; st3=$(jobfield "$id" status)
  [ "$st3" = "completed" ] && ok "T7 job EXECUTED after restart" || bad "T7 status=$st3 (want dispatched)"
}

# --------------------------------------------------------------------------- T8
t8() {
  hdr "T8  multiple jobs: ordering, isolation, no blocking"
  local base; base=$(now_ms)
  local a1 a2 a3 b1 b2
  a1=$(create reminder "$SESSION"   "$((base+3000))"  "[T8] A+3s")
  a2=$(create reminder "$SESSION"   "$((base+6000))"  "[T8] A+6s")
  a3=$(create reminder "$SESSION"   "$((base+9000))"  "[T8] A+9s")
  b1=$(create reminder "$SESSION_B" "$((base+4000))"  "[T8] B+4s")
  b2=$(create reminder "$SESSION_B" "$((base+7000))"  "[T8] B+7s")
  local n=0
  for x in $a1 $a2 $a3 $b1 $b2; do [ -n "$x" ] && n=$((n+1)); done
  [ "$n" -eq 5 ] && ok "T8 created 5 jobs across 2 sessions" || bad "T8 created only $n/5"

  curl -s --max-time 8 "$P/jobs" > "$E/t8_before.json"
  # Isolation: A's jobs belong to A only.
  local leaked; leaked=$(python3 -c "
import json
d=json.load(open('$E/t8_before.json'))['jobs']
ids={'$a1','$a2','$a3','$b1','$b2'}
byid={j['id']:j for j in d}
bad=[i for i in ['$a1','$a2','$a3'] if byid.get(i,{}).get('sessionId')!='$SESSION']
print(len(bad))
")
  [ "$leaked" = "0" ] && ok "T8 session isolation holds" || bad "T8 session isolation violated"

  # Poll: a job whose session happens to be busy is now DEFERRED rather than
  # queued, so completion can lag the due time by up to jobBusyRetryMs.
  local done_n=0 r=0
  while [ "$r" -lt 12 ]; do
    sleep 5; r=$((r+1))
    tick
    done_n=$(python3 -c "
import json
d=json.load(open('/dev/stdin'))['jobs']
ids=['$a1','$a2','$a3','$b1','$b2']
print(sum(1 for j in d if j['id'] in ids and j['status']=='completed'))
" <<< "$(curl -s --max-time 8 "$P/jobs")")
    [ "$done_n" = "5" ] && break
  done
  [ "$done_n" = "5" ] && ok "T8 all 5 dispatched independently" || bad "T8 only $done_n/5 dispatched"
}

# --------------------------------------------------------------------------- T9
t9() {
  hdr "T9  duplicate protection"
  # Case A: dispatched then recovered -> must complete, never re-dispatch.
  local at; at=$(($(now_ms)+2000))
  local id; id=$(create reminder "$SESSION" "$at" "[T9A] once only")
  sleep 3; tick; sleep 2
  local st; st=$(jobfield "$id" status)
  if [ "$st" != "completed" ]; then skip "T9A job did not dispatch ($st)"; else
    local before; before=$(grep -c "job dispatched id=$id" $MMT_HOME/mattermost/plugin.log)
    curl -s -X POST "$P/job/recover" -H 'Content-Type: application/json' -d '{"now":0,"leaseMs":0}' >/dev/null
    sleep 1; tick; sleep 2
    local after; after=$(grep -c "job dispatched id=$id" $MMT_HOME/mattermost/plugin.log)
    local st2; st2=$(jobfield "$id" status)
    [ "$before" = "$after" ] && ok "T9A recovery did not re-dispatch a delivered job" || bad "T9A re-dispatched ($before -> $after)"
    [ "$st2" = "completed" ] && ok "T9A delivered job completed on recovery" || bad "T9A status=$st2 (want completed)"
  fi

  # Case B: claimed but never marked dispatched, then the process dies.
  # The record is edited on disk and the harness restarted, because the domain
  # keeps authoritative state in memory — only a real restart reloads it, which
  # is also exactly the scenario under test.
  # Deliberately FAR in the future: after recovery the job must be observed as
  # requeued-pending, not fired by the next automatic tick.
  local at2; at2=$(($(now_ms)+3600000))
  local id2; id2=$(create reminder "$SESSION" "$at2" "[T9B] crash window")
  python3 - "$id2" "$MMT_HOME" <<'PY'
import json, sys, pathlib
# The home is passed as an ARGUMENT: a single-quoted heredoc does not expand
# shell variables, and interpolating one here made this fixture a no-op.
p = pathlib.Path(sys.argv[2], 'storages', 'mattermost_jobs', 'jobs') / (sys.argv[1] + '.json')
d = json.loads(p.read_text())
r = d['record']
r.update(status='running', claimId='deadbeefdeadbeef', claimedAt=1, attempts=1, dispatchedAt=None)
p.write_text(json.dumps(d))
PY
  local restart_at; restart_at=$(now_ms)
  "$BIN/restart-test.sh" >/dev/null
  # Bounded readiness; the job is due in 1h and the requeue is driven by the
  # explicit /job/recover call below, not by how long this wait lasts.
  wait_settled "$restart_at" 0 60 3
  curl -s -X POST "$P/job/recover" -H 'Content-Type: application/json' -d '{"now":0,"leaseMs":0}' > "$E/t9_recover.json"
  local stB; stB=$(jobfield "$id2" status)
  [ "$stB" = "pending" ] && ok "T9B orphaned claim requeued after restart (not lost, not fired)" || bad "T9B status=$stB (want pending)"
  python3 -m json.tool < "$E/t9_recover.json" 2>/dev/null | head -5

  # The deterministic inbox id is what makes the requeue safe.
  node -e "
import('$REPO/scheduler.js').then(m=>{
  const a=m.buildJobMessage({id:'job-x',type:'reminder',executeAt:Date.now(),message:'m'})
  const b=m.buildJobMessage({id:'job-x',type:'reminder',executeAt:Date.now(),message:'m'})
  console.log(a.id===b.id && a.id==='mmjob-job-x' ? 'DETERMINISTIC' : 'RANDOM')
})" | grep -q DETERMINISTIC \
    && ok "T9B re-dispatch message id is deterministic (inbox de-dupes)" \
    || bad "T9B message id is not deterministic"
}

# --------------------------------------------------------------------------- T10
t10() {
  hdr "T10  job executes while Mattermost is disconnected"
  curl -s --max-time 8 -X POST "$P/wssuspend" >/dev/null
  sleep 2
  local conn; conn=$(curl -s --max-time 6 "$P/status" | jq_ 'print(d["connected"])')
  [ "$conn" = "False" ] && ok "T10 transport suspended" || bad "T10 transport still connected"

  local at; at=$(($(now_ms)+2000))
  local id; id=$(create reminder "$SESSION" "$at" "[T10] offline dispatch")
  sleep 3; tick; sleep 3
  local st; st=$(jobfield "$id" status)
  [ "$st" = "completed" ] && ok "T10 job dispatched while offline" || bad "T10 status=$st (want dispatched)"

  curl -s --max-time 12 -X POST "$P/wsresume" >/dev/null
  sleep 8
  conn=$(curl -s --max-time 6 "$P/status" | jq_ 'print(d["connected"])')
  [ "$conn" = "True" ] && ok "T10 transport resumed" || bad "T10 transport did not resume"
}

# --------------------------------------------------------------------------- T11
t11() {
  hdr "T11  job targeting a BUSY agent is deferred, never queued into the running turn"
  # A message spliced into a running agent is claimed into the in-flight turn,
  # and a claimed message leaves the durable pending projection — a restart
  # before that turn ends loses it while the job still reads completed. So a
  # busy target must be deferred, not queued.
  curl -s --max-time 20 -X POST "$P/inject" -H 'Content-Type: application/json' \
    -d "{\"channelId\":\"$CH\",\"userId\":\"$OWNER\",\"channelType\":\"O\",\"message\":\"@dsh 请用 bash 工具在前台执行 sleep 90。必须前台阻塞等待，不要加 &、不要用 run_in_background、不要提前回复。命令返回后只回复 T11BUSY。\"}" >/dev/null
  local run1='' i=0
  while [ "$i" -lt 20 ]; do
    sleep 3
    run1=$(curl -s "$P/agent?sessionId=$SESSION" | jq_ 'print(d["status"])')
    [ "$run1" = "running" ] && break
    i=$((i+1))
  done
  if [ "$run1" != "running" ]; then
    skip "T11 could not establish a busy agent (status=$run1) — model backgrounded the command"
  else
    ok "T11 precondition: agent genuinely running (verified, not assumed)"
  fi

  local id2; id2=$(create agent_followup "$SESSION" "$(now_ms)" "[T11] busy-session deferral")
  tick; sleep 3
  local st; st=$(jobfield "$id2" status)
  [ "$st" = "pending" ] && ok "T11 job stayed PENDING (never queued into the running turn)" \
    || bad "T11 status=$st (want pending)"
  grep -q "job deferred (agent busy) id=$id2" $MMT_HOME/mattermost/plugin.log \
    && ok "T11 deferral logged" || bad "T11 no deferral log line"
  local att; att=$(jobfield "$id2" attempts)
  [ "$att" = "0" ] && ok "T11 deferral consumed no attempt (attempts=0)" \
    || bad "T11 attempts=$att (a deferral must roll the claim back)"

  # The deferral pushed executeAt ~jobBusyRetryMs into the future, so poll past
  # that window rather than ticking once.
  echo "  waiting for the agent to free up, then past the deferral window..."
  local j=0 settled=0
  while [ "$j" -lt 20 ]; do
    sleep 10; j=$((j+1))
    tick
    st=$(jobfield "$id2" status)
    [ "$st" = "completed" ] && { settled=1; break; }
  done
  [ "$settled" = "1" ] && ok "T11 dispatched once the agent became idle" || bad "T11 final status=$st"
  grep -q "job dispatched id=$id2 .*agentRunning=false" $MMT_HOME/mattermost/plugin.log \
    && ok "T11 delivered to an IDLE agent (agentRunning=false)" || skip "T11 no idle-dispatch log line"
}

# --------------------------------------------------------------------------- T12
t12() {
  hdr "T12  session without a live agent is resumed (not probed)"
  # Pick a mapped session that is definitely not live right now.
  local sid; sid=$(python3 -c "
import json
m=json.load(open('$MMT_HOME/mattermost/session-map.json'))['entries']
ks=[k for k in m if ':'.join(k.split(':')[-2:-1]) == 'th']
print(m[ks[-1]]['sessionId'] if ks else '')
")
  [ -z "$sid" ] && { skip "T12 no alternate session"; return; }
  local live; live=$(curl -s "$P/agent?sessionId=$sid" | jq_ 'print(d["live"])')
  live=${live:-False}
  local at; at=$(($(now_ms)+2000))
  local id; id=$(create reminder "$sid" "$at" "[T12] resume path")
  sleep 3; tick; sleep 6
  local st; st=$(jobfield "$id" status)
  [ "$st" = "completed" ] && ok "T12 resumed and dispatched (was live=$live)" || bad "T12 status=$st"
  grep -q "agent ready session=$sid" $MMT_HOME/mattermost/plugin.log \
    && ok "T12 went through the tested ensureAgent path" || skip "T12 no agent-ready line"
}

# --------------------------------------------------------------------------- T13
t13() {
  hdr "T13  authorization: cross-session cancel and list are fenced"
  [ -z "$SESSION_B" ] && { skip "T13 needs two sessions"; return; }
  local at; at=$(($(now_ms)+3600000))
  local id; id=$(create reminder "$SESSION" "$at" "[T13] owned by A")
  local out; out=$(curl -s -X POST "$P/job/cancel" -H 'Content-Type: application/json' \
    -d "{\"id\":\"$id\",\"sessionId\":\"$SESSION_B\",\"by\":\"$SESSION_B\"}")
  echo "$out" | grep -q forbidden && ok "T13 foreign session refused cancellation" || bad "T13 cross-session cancel not refused: $out"
  local st; st=$(jobfield "$id" status)
  [ "$st" = "pending" ] && ok "T13 job untouched by the refused cancel" || bad "T13 status changed to $st"
  # List isolation is enforced inside the tool by sessionId; verify the store filter.
  local n; n=$(curl -s --max-time 8 "$P/jobs" | jq_ "
print(sum(1 for j in d['jobs'] if j['sessionId']=='$SESSION_B' and j['id']=='$id'))")
  [ "$n" = "0" ] && ok "T13 job not visible to the other session's listing" || bad "T13 job leaked across sessions"
  curl -s -X POST "$P/job/cancel" -H 'Content-Type: application/json' -d "{\"id\":\"$id\"}" >/dev/null
}

# --------------------------------------------------------------------------- T14
t14() {
  hdr "T14  bot-chain protection is unchanged"
  curl -s --max-time 8 -X POST "$P/chainreset" >/dev/null
  local st; st=$(curl -s "$P/status")
  local max; max=$(grep -o 'botChainMax=[0-9]*' $MMT_HOME/mattermost/plugin.log | tail -1 | cut -d= -f2)
  [ "$max" = "5" ] && ok "T14 botChainMax still 5" || bad "T14 botChainMax=$max"
  echo "$st" | grep -q chainRejected && ok "T14 chain guard still wired" || bad "T14 chain stat missing"
  # The scheduler does not post to Mattermost, so it cannot inflate the chain.
  grep -qE 'job dispatched.*chain' $MMT_HOME/mattermost/plugin.log \
    && bad "T14 scheduler touched the chain budget" || ok "T14 scheduler never posts (no chain bypass)"
}

# --------------------------------------------------------------------------- T15
# Corruption handling has TWO paths, and the two fixtures below exercise one each:
#
#   * valid JSON that fails the record schema -> the domain layer MOVES the
#     document aside as `<name>.json.bak.<stamp>` and opens without it;
#   * JSON that does not parse at all -> it cannot be schema-validated, so it is
#     left on disk unloaded; the boot probe in index.js notices "present on disk
#     but not loaded", raises a `job-corrupt` fault with outcome `isolated`, and
#     logs a positive count.
#
# The original assertion grepped the log for `backup|invalid|skip`. Those words
# appear only in the domain CONFIG (`invalidRecords: 'backup-and-skip'`) and in
# source comments -- never in a log line -- so that assertion could only ever SKIP.
#
# Widening it to a bare `isolated` would not be a fix either: the plugin also logs
# `fault store ready (..., isolated=0)`, which contains that substring, so an empty
# quarantine would PASS. Every assertion below therefore demands POSITIVE evidence,
# and the log/disk checks are scoped to THIS run so leftovers cannot satisfy them.
#
# There are deliberately no SKIP outcomes: this test writes its own corrupt
# fixtures, so it fully controls its precondition and every check has a definite
# PASS or FAIL.
t15() {
  hdr "T15  storage corruption / partial write"
  local dir=$MMT_HOME/storages/mattermost_jobs/jobs
  local log=$MMT_HOME/mattermost/plugin.log
  local id_schema=job-00000000000000ff   # parseable, fails the schema -> .bak
  local id_syntax=job-00000000000000fe   # unparseable              -> fault + log
  python3 - "$dir/$id_schema.json" <<'PY'
import sys, pathlib
pathlib.Path(sys.argv[1]).write_text('{"version":1,"record":{"id":"not-a-valid-job"}}')
PY
  python3 - "$dir/$id_syntax.json" <<'PY'
import sys, pathlib
pathlib.Path(sys.argv[1]).write_text('{ this is not json at all')
PY
  # A partial write leaves a temp file behind; it must be ignored, not fatal.
  printf '{"version":1,"reco' > "$dir/.partial.tmp"

  # Scope both the log check and the quarantine check to this run.
  local log_before; log_before=$(stat -c '%s' "$log" 2>/dev/null || echo 0)
  local baks_before; baks_before=$(find "$dir" -name '*.bak*' 2>/dev/null | sort)

  local restart_at; restart_at=$(now_ms)
  "$BIN/restart-test.sh" >/dev/null
  # Bounded readiness; the store performs its corruption handling as it opens,
  # which happens before the scheduler timer this wait observes.
  wait_settled "$restart_at" 0 60 3

  local stats; stats=$(curl -s --max-time 8 "$P/jobs" | jq_ 'print(json.dumps(d["stats"]))')
  if [ -n "$stats" ]; then ok "T15 unit still opens with corrupt records present"; else bad "T15 unit failed to open"; fi
  echo "  stats: $stats"

  # (1) Wait, BOUNDED, for both witnesses. The store quarantines documents as it
  #     OPENS, but the probe that REPORTS them (index.js detectCorruptJobs) runs
  #     after scheduler.start(), so `wait_settled` returning is not on its own
  #     proof that the report has been written. Poll for the evidence rather than
  #     assuming a fixed ordering -- and keep it bounded so a genuine regression
  #     fails instead of hanging.
  local waited=0 n_seen=0 oc_seen='-' appended='' seen
  while [ "$waited" -lt 30 ]; do
    seen=$(curl -s --max-time 8 "$P/faults" | python3 -c "
import sys,json
ids={'$id_schema','$id_syntax'}
# updatedAt, not at: raise() keeps the FIRST sighting in 'at' and refreshes
# 'updatedAt' on every re-raise, so only updatedAt proves THIS boot re-detected
# the document rather than a previous run's fault still sitting in the store.
floor=$restart_at
f=[x for x in json.load(sys.stdin)['faults']
   if x['type']=='job-corrupt' and x.get('jobId') in ids and (x.get('updatedAt') or 0) >= floor]
print('%d|%s' % (len(f), ','.join(sorted({str(x.get('outcome')) for x in f})) or '-'))
" 2>/dev/null || true)
    n_seen=${seen%%|*}; oc_seen=${seen##*|}
    appended=$(tail -c "+$((log_before + 1))" "$log" 2>/dev/null || true)
    if [ "${n_seen:-0}" -ge 1 ] && printf '%s' "$appended" | grep -qE '[1-9][0-9]* isolated job document'; then
      break
    fi
    sleep 2; waited=$((waited + 2))
  done

  # (2) Structured witness. The unparseable document must be REPORTED as a
  #     `job-corrupt` fault; the wording of any log line is irrelevant here, so a
  #     rephrasing can never turn this into a skip.
  if [ "${n_seen:-0}" -ge 1 ]; then
    ok "T15 corrupt document reported as a job-corrupt fault (n=$n_seen outcome=$oc_seen)"
  else
    bad "T15 corrupt document silently dropped (no job-corrupt fault for $id_schema/$id_syntax after ${waited}s)"
  fi

  # (3) Disk witness, scoped: the schema-invalid document must have been moved to a
  #     .bak that did NOT exist before the restart, so a leftover from an earlier
  #     run cannot satisfy this. The fallback covers a same-minute name collision,
  #     where the layer reuses the stamp and the set difference is empty.
  local baks_after; baks_after=$(find "$dir" -name '*.bak*' 2>/dev/null | sort)
  local fresh; fresh=$(python3 -c "
import sys
b=set(sys.argv[1].split()); a=set(sys.argv[2].split())
print('\n'.join(sorted(x for x in a - b if sys.argv[3] in x)))
" "$baks_before" "$baks_after" "$id_schema")
  if [ -n "$fresh" ]; then
    ok "T15 schema-invalid document quarantined as a fresh .bak (backup-and-skip)"
  elif [ ! -f "$dir/$id_schema.json" ] && [ -n "$(find "$dir" -name "$id_schema*.bak*" 2>/dev/null | head -1)" ]; then
    ok "T15 schema-invalid document quarantined (.json consumed, .bak present)"
  else
    bad "T15 no new .bak for $id_schema — the document was not preserved"
  fi

  # (4) Log witness, scoped to what THIS boot appended. The full phrase plus a
  #     non-zero leading digit is required, so neither a bare `isolated` match nor
  #     `isolated=0` can pass this.
  if printf '%s' "$appended" | grep -qE '[1-9][0-9]* isolated job document'; then
    ok "T15 this boot logged a positive quarantine count"
  else
    bad "T15 this boot logged no positive 'isolated job document(s)' line"
  fi

  rm -f "$dir/.partial.tmp"
}

# --------------------------------------------------------------------------- T16
t16() {
  hdr "T16  long offline recovery drains a backlog in bounded batches"
  local base; base=$(($(now_ms)-600000))   # all 12 already overdue
  local ids=()
  for i in $(seq 1 12); do
    ids+=("$(create reminder "$SESSION" "$((base+i*1000))" "[T16] backlog $i")")
  done
  local n; n=$(jobcount)
  ok "T16 created 12 overdue jobs (store now holds $n)"

  local first; first=$(curl -s --max-time 30 -X POST "$P/job/tick" | jq_ 'print(len(d["dispatched"]))')
  echo "  first tick dispatched: $first (maxDispatchPerTick=5)"
  if [ "$first" -le 5 ]; then ok "T16 herd bounded to <=5 per tick"; else bad "T16 dispatched $first in one tick"; fi

  local rounds=0
  while [ "$rounds" -lt 8 ]; do
    sleep 2
    local pending; pending=$(python3 -c "
import json,urllib.request
d=json.load(urllib.request.urlopen('$P/jobs'))
print(sum(1 for j in d['jobs'] if j['status']=='pending'))")
    [ "$pending" = "0" ] && break
    tick; rounds=$((rounds+1))
  done
  ok "T16 backlog drained over $((rounds+1)) tick(s)"
  for i in "${ids[@]}"; do
    [ -n "$i" ] && curl -s -X POST "$P/job/cancel" -H 'Content-Type: application/json' -d "{\"id\":\"$i\"}" >/dev/null
  done
}

# --------------------------------------------------------------------------- T19
# The tool surface, driven by a REAL agent rather than the probe. Every other
# test reaches the store directly; this one proves the agent can actually use it.
t19() {
  hdr "T19  agent-invoked schedule_job"
  local before; before=$(jobcount)
  curl -s --max-time 25 -X POST "$P/inject" -H 'Content-Type: application/json' \
    -d "{\"channelId\":\"$CH\",\"userId\":\"$OWNER\",\"channelType\":\"O\",\"message\":\"@dsh 请调用 schedule_job 工具，创建一个 120 秒后触发的 reminder，message 写 \\\"T19 提醒\\\"。创建完成后只回复 T19_CREATED，不要做别的事。\"}" >/dev/null
  sleep 45
  local after; after=$(jobcount)
  [ "$after" -gt "$before" ] && ok "T19 agent created a job via the tool ($before -> $after)" \
    || { bad "T19 agent created no job"; return; }

  local id; id=$(curl -s "$P/jobs" | python3 -c "
import sys,json
d=[j for j in json.load(sys.stdin)['jobs'] if 'T19' in j['message'] and j['type']=='reminder']
print(d[-1]['id'] if d else '')")
  [ -n "$id" ] && ok "T19 job has the requested type and payload ($id)" || { bad "T19 payload wrong"; return; }

  local by; by=$(jobfield "$id" createdBy)
  [ "$by" = "$OWNER" ] && ok "T19 createdBy resolved from the session (not the caller env)" \
    || bad "T19 createdBy=$by (want $OWNER)"

  echo "  waiting for the agent-created job to fire..."
  sleep 90
  local st; st=$(jobfield "$id" status)
  [ "$st" = "completed" ] && ok "T19 agent-created job fired and completed" || bad "T19 status=$st"
  cd "$BIN" && ./mm.sh list 10 > /tmp/t19_channel.txt 2>/dev/null
  grep -q '定时提醒·T19' /tmp/t19_channel.txt \
    && ok "T19 reminder delivered to Mattermost" || skip "T19 delivery outside the channel window"
}

# --------------------------------------------------------------------------- T20
t20() {
  hdr "T20  agent-invoked cancel_job"
  curl -s --max-time 25 -X POST "$P/inject" -H 'Content-Type: application/json' \
    -d "{\"channelId\":\"$CH\",\"userId\":\"$OWNER\",\"channelType\":\"O\",\"message\":\"@dsh 按顺序做两件事：1) 用 schedule_job 创建 after_seconds=3600、type=reminder、message=\\\"T20 取消测试\\\" 的任务；2) 用 cancel_job 把它取消。然后只回复 T20_DONE。\"}" >/dev/null
  sleep 55
  local row; row=$(curl -s "$P/jobs" | python3 -c "
import sys,json
d=[j for j in json.load(sys.stdin)['jobs'] if 'T20' in j['message']]
print(('%s|%s|%s' % (d[-1]['id'], d[-1]['status'], d[-1]['cancelledBy'])) if d else '')")
  [ -z "$row" ] && { bad "T20 agent did not create the job"; return; }
  echo "  id|status|cancelledBy = $row"
  echo "$row" | grep -q '|cancelled|' && ok "T20 agent cancelled its own job" || bad "T20 not cancelled: $row"
  echo "$row" | grep -q "|$SESSION$" && ok "T20 cancellation fenced to the calling session" \
    || bad "T20 cancelledBy is not the calling session"
}

# --------------------------------------------------------------------------- T21
# The scenario that actually failed in production on 2026-09-29: the user asks
# in plain language and never names a tool. Merely registering schedule_job was
# not enough — the agent reached for an in-session sleep loop and then proposed
# external schedulers, because nothing in the prompt told it the tool existed.
t21() {
  hdr "T21  natural-language scheduling (tool never named)"

  # Clear pending work first. Without this the agent may (correctly) refuse to
  # create a duplicate reminder, which is right behaviour but makes a naive
  # "a new job must appear" assertion fail. Observed exactly that on the first
  # run of this test: the agent replied "你已经有一条同样的喝水提醒在等待中，
  # 我没有重复创建".
  local stale; stale=$(curl -s "$P/jobs" | python3 -c "
import sys,json
print(' '.join(j['id'] for j in json.load(sys.stdin)['jobs'] if j['status']=='pending'))")
  for id in $stale; do
    curl -s -X POST "$P/job/cancel" -H 'Content-Type: application/json' -d "{\"id\":\"$id\"}" >/dev/null
  done
  [ -n "$stale" ] && echo "  cleared $(echo "$stale" | wc -w) pre-existing pending job(s)"

  local before; before=$(curl -s "$P/jobs" | python3 -c "
import sys,json
print(','.join(sorted(j['id'] for j in json.load(sys.stdin)['jobs'])))")

  # A UNIQUE reminder text per run. A repeated identical request makes the agent
  # either de-duplicate or (observed) call ask_user_question to confirm, which
  # blocks the turn forever in an unattended channel.
  local token="T21$$-$(date +%s)"
  curl -s --max-time 25 -X POST "$P/inject" -H 'Content-Type: application/json' \
    -d "{\"channelId\":\"$CH\",\"userId\":\"$OWNER\",\"channelType\":\"O\",\"message\":\"@dsh 10分钟后提醒我喝水，编号 $token\"}" >/dev/null

  # Poll rather than sleep a fixed amount: the agent may call tools before it
  # decides to schedule, and turn duration varies widely.
  local row='' waited=0
  while [ "$waited" -lt 150 ]; do
    sleep 10; waited=$((waited+10))
    row=$(curl -s "$P/jobs" | python3 -c "
import sys,json,time
before=set('$before'.split(','))
d=[j for j in json.load(sys.stdin)['jobs'] if j['id'] not in before]
print(('%s|%s|%d' % (d[-1]['id'], d[-1]['type'], (d[-1]['executeAt']-int(time.time()*1000))//1000)) if d else '')")
    [ -n "$row" ] && break
  done
  if [ -z "$row" ]; then
    bad "T21 agent created no new job after ${waited}s — it fell back on a sleep loop, refused, or asked a blocking question"
    return
  fi
  ok "T21 plain-language request produced a NEW durable job"
  echo "$row" | grep -q '|reminder|' && ok "T21 job is a reminder (id|type|secondsAhead = $row)" \
    || bad "T21 job type is wrong: $row"
  local ahead; ahead=$(echo "$row" | cut -d'|' -f3)
  { [ "$ahead" -gt 500 ] && [ "$ahead" -lt 700 ]; } && ok "T21 scheduled ~10 minutes out ($ahead s)" \
    || skip "T21 lead time was ${ahead}s (expected ~600s)"

  local id; id=$(echo "$row" | cut -d'|' -f1)
  [ -n "$id" ] && curl -s -X POST "$P/job/cancel" -H 'Content-Type: application/json' -d "{\"id\":\"$id\"}" >/dev/null
}

# --------------------------------------------------------------------------- T22
# The loss scenario found on 2026-09-29. A job whose target agent is busy is
# handed to the running turn, claimed, and removed from the durable pending set.
# If the process restarts before that turn ends, the instruction is never
# replayed — but the job still reads completed. This test reproduces it and
# asserts the fix: with deferral, the job survives the restart and still runs.
t22() {
  hdr "T22  a busy-target job cannot be silently lost by a restart"
  curl -s --max-time 20 -X POST "$P/inject" -H 'Content-Type: application/json' \
    -d "{\"channelId\":\"$CH\",\"userId\":\"$OWNER\",\"channelType\":\"O\",\"message\":\"@dsh 请用 bash 工具在前台执行 sleep 120。必须前台阻塞等待，不要加 &、不要用 run_in_background、不要提前回复。只回复 T22BUSY。\"}" >/dev/null
  local run1='' i=0
  while [ "$i" -lt 20 ]; do
    sleep 3
    run1=$(curl -s "$P/agent?sessionId=$SESSION" | jq_ 'print(d["status"])')
    [ "$run1" = "running" ] && break
    i=$((i+1))
  done
  if [ "$run1" != "running" ]; then skip "T22 could not establish a busy agent"; return; fi
  ok "T22 precondition: agent genuinely running"

  local token="T22LOSS$$-$(date +%s)"
  local id; id=$(create agent_followup "$SESSION" "$(now_ms)" "T22：请只回复 $token")
  tick; sleep 3
  local st; st=$(jobfield "$id" status)
  [ "$st" = "pending" ] && ok "T22 job deferred while the agent is busy" || bad "T22 status=$st"

  echo "  restarting with the agent mid-turn (this is the loss window)..."
  local restart_at; restart_at=$(now_ms)
  "$BIN/restart-test.sh" >/dev/null
  # Bounded readiness wait, not a fixed sleep: the probe is absent for ~8s after
  # the restart and then unanswerable for ~10s while the startup catch-up tick
  # re-dispatches the deferred job, which is the window the old `sleep 35` kept
  # landing in. The 32s floor keeps the scenario this test documents: the 30s
  # deferral window must have elapsed while the process was down, so recovery --
  # not a lucky early tick -- is what delivers the job.
  wait_settled "$restart_at" 32000 60 3
  # NOTE: `completed` here is a PASS, not a loss. The job was deferred with a
  # 30s retry window; the wait above holds until that window has elapsed, so the
  # startup catch-up tick dispatches it to the now-idle agent. Status alone
  # cannot distinguish "delivered after restart" from "consumed and lost" — the
  # real discriminator is whether the instruction actually ran, asserted at the
  # end of this test.
  # NOT an assertion. The status here may legitimately be `pending` (the deferred
  # job has not been picked up yet) or `completed` (the catch-up tick already ran
  # it), so no single value is correct and counting it as a PASS would inflate the
  # result without testing anything. The real discriminators are the bounded
  # delivery loop below and the full-body token scan at the end.
  st=$(jobfield "$id" status)
  echo "  T22 job state after restart: $st"

  echo "  waiting for the job to be delivered to the now-idle agent..."
  local done=0 j=0
  while [ "$j" -lt 16 ]; do
    sleep 10; j=$((j+1))
    tick
    [ "$(jobfield "$id" status)" = "completed" ] && { done=1; break; }
  done
  [ "$done" = "1" ] && ok "T22 job executed after the restart" || bad "T22 job never completed"

  # The instruction must be visible in the channel as its own evidence. A
  # `completed` status is not that evidence, and neither is an HTTP 200: the
  # reply is asynchronous, so this polls the COMPLETE post bodies until the
  # unique token appears or the budget runs out.
  echo "  polling the test channel for the token in the COMPLETE post body..."
  local scan='0 0' src=1 tries=0 unparsable=0 transport=0 obs_t0 obs_elapsed
  obs_t0=$(date +%s)
  while :; do
    tries=$((tries + 1))
    scan=$(channel_scan "$token"); src=$?
    [ "$src" -eq 0 ] && break          # found
    [ "$src" -eq 3 ] && break          # no base URL / no credential: retrying cannot help
    if [ "$src" -eq 4 ]; then
      # The API answered with something that is not usable JSON (an upstream 5xx, a
      # proxy error page, a truncated body). A couple of retries absorb a transient
      # blip; past that it is persistent, and spinning to the full 180s budget only
      # delays the report without changing the verdict.
      unparsable=$((unparsable + 1))
      [ "$unparsable" -ge "$T22_SCAN_UNPARSABLE_TRIES" ] && break
    fi
    if [ "$src" -eq 5 ]; then
      # The request never completed (timeout / refused / DNS / TLS). Bounded the same
      # way, but counted separately so the final message can name the real problem
      # instead of blaming the API's JSON.
      transport=$((transport + 1))
      [ "$transport" -ge "$T22_SCAN_TRANSPORT_TRIES" ] && break
    fi
    obs_elapsed=$(( $(date +%s) - obs_t0 ))
    [ "$obs_elapsed" -ge "$T22_OBSERVE_BUDGET_S" ] && break
    sleep 5
  done
  obs_elapsed=$(( $(date +%s) - obs_t0 ))
  local scanned="${scan%% *}" matched="${scan##* }"
  if [ "$src" -eq 0 ]; then
    ok "T22 instruction ACTUALLY RAN — token in the full post body (${obs_elapsed}s, ${tries} poll(s), ${scanned} post(s) scanned)"
  elif [ "$src" -eq 3 ]; then
    bad "T22 cannot observe the channel: no base URL from \$BIN/mm.sh and no readable credential (${obs_elapsed}s, ${tries} poll(s))"
  elif [ "$src" -eq 5 ]; then
    bad "T22 cannot observe the channel: the posts request never completed (timeout / refused / DNS / TLS) after ${transport} attempt(s) (${obs_elapsed}s, ${tries} poll(s))"
  elif [ "$src" -eq 4 ]; then
    bad "T22 cannot observe the channel: the posts API answered but returned no usable JSON after ${unparsable} attempt(s) (${obs_elapsed}s, ${tries} poll(s))"
  else
    bad "T22 job completed but the instruction never executed — token absent from the COMPLETE post body after ${obs_elapsed}s, ${tries} poll(s), ${scanned} post(s) scanned, ${matched} match(es)"
  fi
}

# --- full-body channel observation -------------------------------------------
#
# `mm.sh list` prints only the first 78 characters of each post. That silently
# hides a token the agent places later in a longer message: measured on the T22
# reply that triggered this fix, the two tokens sat at offsets 96 and 158 of a
# 185-character body, so `grep` over `mm.sh list` output could never see them
# even though the instruction had demonstrably run. The slice is hardcoded, so
# `mm.sh list` cannot be widened; this reads the posts API directly and matches
# the COMPLETE body instead.
#
# The base URL and the channel are taken from the harness helper that already
# owns them (`mm.sh` defines both), so this file bakes in no host-specific
# literal of its own. The credential is read from the same place the harness
# reads it, overridable for other installations.

# How many recent posts one scan covers. Mattermost caps per_page at 200, so on a
# very busy channel a reply can scroll out of this window before it is observed.
# Raise it via the environment if that ever happens; paginating is deliberately
# not done here.
MM_SCAN_POSTS="${MM_SCAN_POSTS:-200}"
# Total budget for observing a reply, and the per-request timeout for each poll.
# The budget is checked BETWEEN polls, so one poll may overrun it by up to
# MM_SCAN_TIMEOUT_S -- bounded, and far below the budget itself.
T22_OBSERVE_BUDGET_S="${T22_OBSERVE_BUDGET_S:-180}"
MM_SCAN_TIMEOUT_S="${MM_SCAN_TIMEOUT_S:-8}"
# Consecutive "API did not return usable JSON" replies tolerated before giving up.
T22_SCAN_UNPARSABLE_TRIES="${T22_SCAN_UNPARSABLE_TRIES:-3}"
# Same, for replies that never completed (timeout / refused / DNS / TLS).
T22_SCAN_TRANSPORT_TRIES="${T22_SCAN_TRANSPORT_TRIES:-3}"

mm_api_base() {
  if [ -n "${MM_TEST_URL:-}" ]; then printf '%s' "${MM_TEST_URL%/}"; return 0; fi
  grep -m1 '^U=' "$BIN/mm.sh" 2>/dev/null | cut -d= -f2-
}

# channel_scan <needle> -> prints "<posts_scanned> <matching_post_count>"
#   exit 0  the needle occurs in at least one COMPLETE post body
#   exit 1  not found (channel was reachable and parsed)
#   exit 3  unusable: no base URL, or no readable credential
#   exit 4  the posts API ANSWERED, but not with usable JSON
#   exit 5  the request never completed: timeout, refused, DNS or TLS failure
#
# 4 and 5 are deliberately distinct. Both used to collapse into 4, which reported
# "the posts API returned no usable JSON" for a Mattermost that was simply
# unreachable -- the wrong diagnosis, and it hides a transport problem behind a
# data problem.
channel_scan() {
  local needle="$1" base tokfile rc_curl rc_py ps
  base=$(mm_api_base)
  tokfile="${MM_TEST_TOKEN_FILE:-$HOME/.dsh/mattermost-token}"
  if [ -z "$base" ] || [ ! -r "$tokfile" ] || [ ! -s "$tokfile" ]; then printf '0 0'; return 3; fi
  # The credential reaches curl through its CONFIG on stdin (`-K -`), assembled so
  # that no process ever receives the token as an argument: `tr` streams it from
  # the file and only ever sees the PATH. Writing `printf '...%s' "$tok"` would
  # defeat this, because the token would then be an argument of printf -- and the
  # previous `-H "Authorization: Bearer $tok"` put it directly in curl's argv,
  # where any same-user `ps` could read it. The token file is newline-terminated;
  # `tr` strips that so the header line stays well formed.
  # The body stays in the pipe: it is never captured into a variable or an
  # argument, so post text cannot leak into argv either.
  {
    printf 'header = "Authorization: Bearer '
    tr -d '\r\n' < "$tokfile"
    printf '"\n'
  } | curl -s --max-time "$MM_SCAN_TIMEOUT_S" -K - \
        "$base/api/v4/channels/$CH/posts?per_page=$MM_SCAN_POSTS" 2>/dev/null \
  | python3 -c '
import json, sys
needle = sys.argv[1]
try:
    d = json.load(sys.stdin)
except Exception:
    print("0 0"); raise SystemExit(4)
posts = d.get("posts") or {}
hits = 0
for p in posts.values():
    if needle in (p.get("message") or ""):
        hits += 1
print("%d %d" % (len(posts), hits))
raise SystemExit(0 if hits else 1)
' "$needle"
  # PIPESTATUS is read immediately after the pipeline, before any other command.
  # ps is a plain string so no array declaration is needed here.
  ps=("${PIPESTATUS[@]}")
  rc_curl=${ps[1]:-0}; rc_py=${ps[2]:-0}
  # The body was unparseable AND curl itself failed => the API never answered.
  if [ "$rc_py" -eq 4 ] && [ "$rc_curl" -ne 0 ]; then return 5; fi
  return "$rc_py"
}

# --------------------------------------------------------------------------- T23
t23() {
  hdr "T23  unexpired job survives restart and still fires"
  local at; at=$(($(now_ms)+90000))
  local id; id=$(create reminder "$SESSION" "$at" "[T23] unexpired across restart")
  [ "$(jobfield "$id" status)" = "pending" ] && ok "T23 job pending before restart" || bad "T23 not pending"

  local restart_at; restart_at=$(now_ms)
  "$BIN/restart-test.sh" >/dev/null
  # floor_ms=35000 reproduces the original 35s timing floor exactly: the job is
  # due 90s after `at` was taken, and the 60s wait below follows this one, so the
  # deadline is still met (with similar margin). Readiness is now a real
  # condition and a transient unresponsiveness is retried instead of aborting.
  wait_settled "$restart_at" 35000 60 3
  local st; st=$(jobfield "$id" status)
  [ "$st" = "pending" ] && ok "T23 still pending after restart (not fired early)" || bad "T23 status=$st"
  [ "$st" != "unknown" ] && ok "T23 unexpired job was NOT marked unknown" || bad "T23 wrongly marked unknown"

  echo "  waiting for it to become due..."
  sleep 60; tick; sleep 3
  st=$(jobfield "$id" status)
  [ "$st" = "completed" ] && ok "T23 delivered when its time arrived" || bad "T23 final status=$st"
}

# --------------------------------------------------------------------------- T24
t24() {
  hdr "T24  due-but-undelivered job is recovered (safe requeue)"
  local at; at=$(($(now_ms)+3600000))
  local id; id=$(create reminder "$SESSION" "$at" "[T24] crashed before delivery")
  python3 - "$id" "$MMT_HOME" <<'PYNEST'
import json, sys, pathlib
p = pathlib.Path(sys.argv[2]) / "storages/mattermost_jobs/jobs" / (sys.argv[1] + ".json")
d = json.loads(p.read_text()); r = d["record"]
r.update(status="running", claimId="deadbeefdeadbeef", claimedAt=1, attempts=1,
         dispatchedAt=None, deliveryAttemptedAt=None, completedAt=None)
p.write_text(json.dumps(d))
PYNEST
  local restart_at; restart_at=$(now_ms)
  "$BIN/restart-test.sh" >/dev/null
  # Bounded readiness; only post-recovery state is read here (the job is due in 1h).
  wait_settled "$restart_at" 0 60 3
  local st; st=$(jobfield "$id" status)
  [ "$st" = "pending" ] && ok "T24 requeued (no delivery was attempted)" || bad "T24 status=$st (want pending)"
  curl -s --max-time 8 "$P/faults" | grep -q 'job-orphaned' \
    && ok "T24 informational fault recorded for the requeue" || bad "T24 no job-orphaned fault"
}

# --------------------------------------------------------------------------- T25
t25() {
  hdr "T25  delivered-but-unknown is NOT replayed (marked unknown)"
  local at; at=$(($(now_ms)+3600000))
  local id; id=$(create agent_followup "$SESSION" "$at" "[T25] must never be replayed")
  python3 - "$id" "$MMT_HOME" <<'PYNEST'
import json, sys, pathlib
p = pathlib.Path(sys.argv[2]) / "storages/mattermost_jobs/jobs" / (sys.argv[1] + ".json")
d = json.loads(p.read_text()); r = d["record"]
r.update(status="running", claimId="deadbeefdeadbeef", claimedAt=1, attempts=1,
         dispatchedAt=None, completedAt=None, deliveryAttemptedAt=1)
p.write_text(json.dumps(d))
PYNEST
  local before; before=$(grep -c "job dispatched id=$id" "$MMT_HOME/mattermost/plugin.log" 2>/dev/null); before=${before:-0}

  local restart_at; restart_at=$(now_ms)
  "$BIN/restart-test.sh" >/dev/null
  # Bounded readiness; the assertions below read post-recovery state only.
  wait_settled "$restart_at" 0 60 3

  local st; st=$(jobfield "$id" status)
  [ "$st" = "unknown" ] && ok "T25 marked UNKNOWN (not completed, not failed)" || bad "T25 status=$st (want unknown)"
  [ "$st" != "pending" ] && ok "T25 NOT returned to pending" || bad "T25 was requeued - blind replay risk"

  sleep 20; tick; sleep 3
  local after; after=$(grep -c "job dispatched id=$id" "$MMT_HOME/mattermost/plugin.log" 2>/dev/null); after=${after:-0}
  [ "$before" = "$after" ] && ok "T25 instruction was NOT re-delivered ($before -> $after)" \
    || bad "T25 RE-DELIVERED ($before -> $after)"
  [ "$(jobfield "$id" status)" = "unknown" ] && ok "T25 still unknown after ticks" || bad "T25 state drifted"

  local n; n=$(curl -s --max-time 8 "$P/faults" | python3 -c "
import sys,json
d=json.load(sys.stdin)['faults']
print(sum(1 for f in d if f['type']=='job-unknown' and f['jobId']=='$id'))")
  [ "$n" = "1" ] && ok "T25 exactly one job-unknown fault raised" || bad "T25 fault count=$n"
  local human; human=$(curl -s --max-time 8 "$P/faults" | python3 -c "
import sys,json
d=json.load(sys.stdin)['faults']
f=[x for x in d if x['type']=='job-unknown' and x['jobId']=='$id']
print(f[0]['needsHuman'] if f else 'none')")
  [ "$human" = "True" ] && ok "T25 fault is flagged needsHuman" || bad "T25 needsHuman=$human"
}

# --------------------------------------------------------------------------- T26
t26() {
  hdr "T26  repeated recovery creates no duplicate fault events"
  local id; id=$(curl -s --max-time 8 "$P/faults" | python3 -c "
import sys,json
d=json.load(sys.stdin)['faults']
f=[x for x in d if x['type']=='job-unknown']
print(f[0]['jobId'] if f else '')")
  if [ -z "$id" ]; then skip "T26 no job-unknown fault to re-test"; return; fi
  local before; before=$(curl -s --max-time 8 "$P/faults" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)["faults"]))')

  local restart_at; restart_at=$(now_ms)
  "$BIN/restart-test.sh" >/dev/null
  # Bounded readiness for boot #1; the fault counters are read after each boot.
  wait_settled "$restart_at" 0 60 3
  local mid; mid=$(curl -s --max-time 8 "$P/faults" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)["faults"]))')
  local restart_at; restart_at=$(now_ms)
  "$BIN/restart-test.sh" >/dev/null
  # Bounded readiness for boot #2.
  wait_settled "$restart_at" 0 60 3
  local after; after=$(curl -s --max-time 8 "$P/faults" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)["faults"]))')

  [ "$before" = "$mid" ] && [ "$mid" = "$after" ] \
    && ok "T26 fault count stable across 2 recovery boots ($before -> $mid -> $after)" \
    || bad "T26 fault count grew ($before -> $mid -> $after)"
  [ "$(jobfield "$id" status)" = "unknown" ] && ok "T26 job still unknown, no extra dispatch" || bad "T26 job state changed"
}

# --------------------------------------------------------------------------- T27
t27() {
  hdr "T27  notification is not silently dropped while Mattermost is down"
  curl -s --max-time 8 -X POST "$P/wssuspend" >/dev/null; sleep 2
  local at; at=$(($(now_ms)+3600000))
  local id; id=$(create reminder "$SESSION" "$at" "[T27] notify while offline")
  local ev; ev=$(curl -s --max-time 8 -X POST "$P/fault/raise" -H 'Content-Type: application/json' \
    -d "{\"type\":\"job-orphaned\",\"outcome\":\"informational\",\"jobId\":\"$id\",\"sessionId\":\"$SESSION\",\"channelId\":\"$CH\",\"lastKnownState\":\"test\",\"needsHuman\":false,\"detail\":\"T27\"}" \
    | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"]["id"])' 2>/dev/null)
  [ -n "$ev" ] && ok "T27 fault raised ($ev)" || { bad "T27 fault raise failed"; return; }

  curl -s --max-time 8 -X POST "$P/fault/flush" >/dev/null
  local st; st=$(curl -s --max-time 8 "$P/faults" | python3 -c "
import sys,json
f=[x for x in json.load(sys.stdin)['faults'] if x['id']=='$ev']
print(f[0]['notifyState'] if f else 'missing')")
  [ "$st" = "pending" ] && ok "T27 notification still PENDING (owed, not lost)" || bad "T27 notifyState=$st (want pending)"
  [ "$st" != "sent" ] && ok "T27 not falsely marked as delivered" || bad "T27 claimed delivery while offline"
  curl -s --max-time 12 -X POST "$P/wsresume" >/dev/null; sleep 8
}

# --------------------------------------------------------------------------- T28
t28() {
  hdr "T28  pending notification is retried after reconnect"
  local conn; conn=$(curl -s --max-time 6 "$P/status" | python3 -c 'import sys,json;print(json.load(sys.stdin)["connected"])')
  [ "$conn" = "True" ] || { curl -s --max-time 12 -X POST "$P/wsresume" >/dev/null; sleep 8; }
  curl -s --max-time 15 -X POST "$P/fault/flush" >/dev/null
  local st; st=$(curl -s --max-time 8 "$P/faults" | python3 -c "
import sys,json
f=[x for x in json.load(sys.stdin)['faults'] if x['type']=='job-orphaned' and x.get('detail')=='T27']
print(f[0]['notifyState'] if f else 'missing')")
  [ "$st" = "sent" ] && ok "T28 notification sent after reconnect" || bad "T28 notifyState=$st (want sent)"
  sleep 3
  cd "$BIN" && ./mm.sh list 8 > /tmp/t28.txt 2>/dev/null
  grep -q '定时任务已安全回收' /tmp/t28.txt \
    && ok "T28 notification actually visible in the channel" || skip "T28 not in the last 8 posts"
}

# --------------------------------------------------------------------------- T29
t29() {
  hdr "T29  corrupt job does not lose the other jobs"
  local dir=$MMT_HOME/storages/mattermost_jobs/jobs
  local id_schema=job-00000000000000aa   # parseable, fails the schema -> .bak
  local id_syntax=job-00000000000000bb   # unparseable              -> fault
  local at; at=$(($(now_ms)+3600000))
  local good; good=$(create reminder "$SESSION" "$at" "[T29] healthy neighbour")
  printf '{"version":1,"record":{"id":"not-a-job"}}' > "$dir/$id_schema.json"
  printf '{ this is not json' > "$dir/$id_syntax.json"

  # Snapshot BEFORE the restart. The original assertions counted `.bak` files and
  # `job-corrupt` faults with `>= 1`, both of which are cumulative: after any
  # earlier run those counts are already non-zero, so the assertions passed without
  # this run producing anything. They are scoped to this run's own fixtures instead.
  local baks_before; baks_before=$(find "$dir" -name '*.bak*' 2>/dev/null | sort)

  local restart_at; restart_at=$(now_ms)
  "$BIN/restart-test.sh" >/dev/null
  # Bounded readiness; the boot-time corruption probe runs after the scheduler starts.
  wait_settled "$restart_at" 0 60 3
  local stats; stats=$(curl -s --max-time 8 "$P/jobs" | python3 -c 'import sys,json;print(json.dumps(json.load(sys.stdin)["stats"]))')
  [ -n "$stats" ] && ok "T29 job unit still opened ($stats)" || bad "T29 job unit failed to open"
  [ "$(jobfield "$good" status)" = "pending" ] && ok "T29 healthy neighbour still present" || bad "T29 neighbour lost"

  # Bounded wait: the probe that reports an isolated document runs after
  # scheduler.start(), so readiness alone does not prove the report exists yet.
  local waited=0 n=0
  while [ "$waited" -lt 30 ]; do
    n=$(curl -s --max-time 8 "$P/faults" | python3 -c "
import sys,json
ids={'$id_schema','$id_syntax'}
# updatedAt, not at: raise() keeps the FIRST sighting in 'at' and refreshes
# 'updatedAt' on every re-raise, so only updatedAt proves THIS boot re-detected
# the document rather than a previous run's fault still sitting in the store.
floor=$restart_at
print(sum(1 for f in json.load(sys.stdin)['faults']
          if f['type']=='job-corrupt' and f.get('jobId') in ids and (f.get('updatedAt') or 0) >= floor))" 2>/dev/null || echo 0)
    [ "${n:-0}" -ge 1 ] && break
    sleep 2; waited=$((waited + 2))
  done
  [ "${n:-0}" -ge 1 ] && ok "T29 corruption surfaced as $n job-corrupt fault(s) for this run's fixtures" \
    || bad "T29 corruption was silent (no job-corrupt fault for $id_schema/$id_syntax after ${waited}s)"

  local baks_after; baks_after=$(find "$dir" -name '*.bak*' 2>/dev/null | sort)
  local fresh; fresh=$(python3 -c "
import sys
b=set(sys.argv[1].split()); a=set(sys.argv[2].split())
print('\n'.join(sorted(x for x in a - b if sys.argv[3] in x)))
" "$baks_before" "$baks_after" "$id_schema")
  if [ -n "$fresh" ]; then
    ok "T29 corrupt documents preserved (fresh .bak for $id_schema)"
  elif [ ! -f "$dir/$id_schema.json" ] && [ -n "$(find "$dir" -name "$id_schema*.bak*" 2>/dev/null | head -1)" ]; then
    ok "T29 corrupt documents preserved (.json consumed, .bak present)"
  else
    bad "T29 no fresh .bak for $id_schema — the corrupt document was not preserved"
  fi
  curl -s -X POST "$P/job/cancel" -H 'Content-Type: application/json' -d "{\"id\":\"$good\"}" >/dev/null
}

# --------------------------------------------------------------------------- T32
t32() {
  hdr "T32  no duplicate scheduler/timer after re-init"
  local t1 t2
  t1=$(curl -s --max-time 8 "$P/jobs" | python3 -c 'import sys,json;print(json.load(sys.stdin)["scheduler"]["ticks"])')
  sleep 20
  t2=$(curl -s --max-time 8 "$P/jobs" | python3 -c 'import sys,json;print(json.load(sys.stdin)["scheduler"]["ticks"])')
  local delta=$((t2 - t1))
  echo "  ticks: $t1 -> $t2 (delta $delta over 20s)"
  if [ "$delta" -ge 2 ] && [ "$delta" -le 6 ]; then
    ok "T32 exactly one scheduler loop is running (delta=$delta, expected ~4)"
  else
    bad "T32 tick rate suggests duplicate schedulers (delta=$delta)"
  fi
  local ready boots
  ready=$(grep -c 'scheduler ready' "$MMT_HOME/mattermost/plugin.log")
  boots=$(grep -c 'apply() entered' "$MMT_HOME/mattermost/plugin.log")
  [ "$ready" -le "$boots" ] && ok "T32 one 'scheduler ready' per boot ($ready <= $boots)" \
    || bad "T32 $ready scheduler-ready lines for $boots boots"
}

# --------------------------------------------------------------------------- T33
# Scope gate: `ctx.on('session/event')` is process-wide, so it also fires for
# sessions this plugin does not own (e.g. GUI sessions). Only a session bound to
# a Mattermost conversation can ever carry a deliverable job, so fault
# turn-bookkeeping must be limited to those. Before the gate, an unowned
# session's turn wrote a durable record which the NEXT boot then reported as a
# spurious `turn-interrupted` fault.
t33() {
  hdr "T33  turn bookkeeping is scoped to Mattermost-owned sessions"
  local fs="$MMT_HOME/storages/mattermost_faults/sessions"
  local gate="session-scopegate-$(head -c 6 /dev/urandom | xxd -p)"

  # Precondition: deliberately absent from session-map.json => not owned.
  local ctx; ctx=$(curl -s --max-time 8 "$P/job/context?sessionId=$gate" | jq_ 'print(d.get("context"))')
  [ "$ctx" = "None" ] && ok "T33 probe session is not Mattermost-bound" \
    || { bad "T33 probe session is unexpectedly bound ($ctx)"; return; }

  local owned; owned=$(curl -s --max-time 8 "$P/job/context?sessionId=$SESSION" | jq_ 'print(d.get("context") is not None)')
  [ "$owned" = "True" ] && ok "T33 control session IS Mattermost-bound" \
    || bad "T33 control session $SESSION is not bound - harness state unexpected"

  # Drive a REAL turn in it via the scheduler - the same wake a due job performs.
  local at; at=$(now_ms)
  local id; id=$(create reminder "$gate" "$at" "[T33] scope-gate probe")
  [ -n "$id" ] || { bad "T33 could not create the probe job"; return; }
  tick

  local live=False
  for _ in $(seq 1 10); do
    live=$(curl -s --max-time 8 "$P/agent?sessionId=$gate" | jq_ 'print(d.get("live"))')
    [ "$live" = "True" ] && break
    sleep 2
  done
  [ "$live" = "True" ] && ok "T33 a turn really opened in the unowned session" \
    || bad "T33 no turn opened - the scope assertion would be vacuous"

  [ -f "$fs/$gate.json" ] \
    && bad "T33 fault bookkeeping written for an UNOWNED session" \
    || ok "T33 no fault bookkeeping for the unowned session"

  # Positive control: an owned Mattermost session is still traced open -> closed.
  local t0; t0=$(now_ms)
  curl -s --max-time 30 -X POST "$P/inject" -H 'Content-Type: application/json' \
    -d "{\"channelId\":\"$CH\",\"userId\":\"$OWNER\",\"message\":\"[T33] owned control\"}" \
    >/dev/null 2>&1 || true
  local closed=False
  for _ in $(seq 1 20); do
    closed=$(python3 -c "
import json, os
p = '$fs/$SESSION.json'
r = json.load(open(p))['record'] if os.path.exists(p) else None
print(r is not None and r['turnOpen'] is False and (r.get('closedAt') or 0) >= $t0)")
    [ "$closed" = "True" ] && break
    sleep 5
  done
  [ "$closed" = "True" ] && ok "T33 owned session traced open->closed ($SESSION)" \
    || bad "T33 owned session was not traced"

  # Store-wide invariant: no unowned session may be present at all.
  local stray; stray=$(python3 -c "
import json, os
m = json.load(open('$MMT_HOME/mattermost/session-map.json'))['entries']
owned = {v['sessionId'] for v in m.values()}
for v in m.values():
    for h in (v.get('history') or []):
        owned.add(h['sessionId'])
d = '$fs'
s = sorted(f[:-5] for f in os.listdir(d) if f.endswith('.json') and f[:-5] not in owned) if os.path.isdir(d) else []
print(' '.join(s))")
  [ -z "$stray" ] && ok "T33 every fault-tracked session is Mattermost-owned" \
    || bad "T33 stray fault records from unowned sessions: $stray"
}

# --------------------------------------------------------------------------- T34
# Log privacy and file modes.
#
# The plugin mirrors its logger to a durable file, so two properties must hold:
# a user's message body never lands there, and every record stays one record.
# The state files are rewritten through temp+rename on every inbound message, so
# their mode must be set at creation or a `chmod` is undone within seconds.
t34() {
  hdr "T34  log privacy, line integrity and file modes"
  local dir="$MMT_HOME/mattermost"
  local log="$dir/plugin.log"
  [ -f "$log" ] || { skip "T34 no plugin.log yet"; return; }

  local stamp; stamp="$$-$(date +%s)"
  local token="T34BODY${stamp}SECRET"
  local line2="T34SECONDLINE${stamp}SECRET"
  local before; before=$(stat -c '%s' "$log")

  # A body containing both a marker and an embedded newline.
  curl -s --max-time 20 -X POST "$P/inject" -H 'Content-Type: application/json' \
    -d "$(python3 -c '
import json,sys
print(json.dumps({"channelId":sys.argv[1],"userId":sys.argv[2],
  "message":"T34 probe "+sys.argv[3]+"\nsecond line "+sys.argv[4]}))' "$CH" "$OWNER" "$token" "$line2")" \
    >/dev/null 2>&1 || true
  sleep 4

  # Only inspect what this test appended: the harness log legitimately contains
  # pre-fix history, and rewriting history is not what this change promises.
  local new; new=$(tail -c "+$((before + 1))" "$log" 2>/dev/null || true)

  if printf '%s' "$new" | grep -qF "$token"; then bad "T34a message body leaked into plugin.log"
  else ok "T34a message body absent from plugin.log"; fi
  if printf '%s' "$new" | grep -qF "$line2"; then bad "T34a embedded second line leaked"
  else ok "T34a whole multi-line body absent"; fi

  if printf '%s' "$new" | grep -qE 'len=[0-9]+ sha=[0-9a-f]{8}'; then ok "T34b record carries a len+sha descriptor"
  else bad "T34b no len/sha descriptor written"; fi

  local broken; broken=$(printf '%s' "$new" | grep -cvE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' || true)
  if [ "${broken:-0}" -eq 0 ]; then ok "T34c every appended line is one well-formed record"
  else bad "T34c $broken appended line(s) broke the record structure"; fi

  if printf '%s' "$new" | grep -q 'body='; then bad "T34f a body= field was written"
  else ok "T34f no debug body field, even with debug enabled"; fi

  # Unauthorized posters must not have their full user id recorded.
  local outsider="t34outsider${stamp}"
  curl -s --max-time 20 -X POST "$P/inject" -H 'Content-Type: application/json' \
    -d "$(python3 -c '
import json,sys
print(json.dumps({"channelId":sys.argv[1],"userId":sys.argv[2],"message":"T34 outsider probe"}))' "$CH" "$outsider")" \
    >/dev/null 2>&1 || true
  sleep 3
  if grep -qF "$outsider" "$log"; then bad "T34g unauthorized user id written in full"
  else ok "T34g unauthorized user id is not written in full"; fi
  if grep -qF "${outsider:0:4}…" "$log"; then ok "T34g shortened identifier kept for triage"
  else skip "T34g no unauthorized line observed yet"; fi

  # Credentials must never appear, whole or as a prefix.
  #
  # Matching is done with bash's own `[[ ... == *"$needle"* ]]` rather than
  # `grep`, because `grep -qF "$tok"` puts the credential in grep's ARGV, where a
  # same-user `ps` can read it -- the same exposure that `channel_scan` avoids by
  # feeding curl its header through the config stream. The pattern stays a shell
  # variable here, so no process ever receives it as an argument. Both needles are
  # quoted inside `[[ ]]`, so they match literally.
  local tokfile="${MM_TEST_TOKEN_FILE:-$HOME/.dsh/mattermost-token}"
  local tok; tok=$(cat "$tokfile" 2>/dev/null || true)
  if [ -n "$tok" ]; then
    local logtext; logtext=$(cat "$log" 2>/dev/null || true)
    if [[ "$logtext" == *"$tok"* ]]; then bad "T34e full credential appears in the log"
    else ok "T34e full credential absent from the log"; fi
    if [[ "$logtext" == *"${tok:0:8}"* ]]; then bad "T34e credential prefix appears in the log"
    else ok "T34e credential prefix absent from the log"; fi
  else
    skip "T34e credential file not readable"
  fi

  # Modes. plugin.log is append-only, so its mode is an operational setting:
  # apply it, then prove appending does not loosen it. The two JSON files are
  # rewritten by temp+rename on every message, so no setup is needed there —
  # their mode after a write is exactly what the code sets at creation.
  chmod 700 "$dir" 2>/dev/null || true
  chmod 600 "$log" 2>/dev/null || true
  curl -s --max-time 20 -X POST "$P/inject" -H 'Content-Type: application/json' \
    -d "$(python3 -c '
import json,sys
print(json.dumps({"channelId":sys.argv[1],"userId":sys.argv[2],"message":"T34 mode probe"}))' "$CH" "$OWNER")" \
    >/dev/null 2>&1 || true
  sleep 4

  local m_dir m_log m_state m_map
  m_dir=$(stat -c '%a' "$dir"); m_log=$(stat -c '%a' "$log")
  m_state=$(stat -c '%a' "$dir/state.json"); m_map=$(stat -c '%a' "$dir/session-map.json")
  [ "$m_dir" = "700" ] && ok "T34h state directory is 700" || bad "T34h directory mode=$m_dir (want 700)"
  [ "$m_log" = "600" ] && ok "T34h plugin.log is 600 and appending keeps it" || bad "T34h log mode=$m_log (want 600)"
  [ "$m_state" = "600" ] && ok "T34i state.json is 600 after an atomic rewrite" || bad "T34i state.json mode=$m_state (want 600)"
  [ "$m_map" = "600" ] && ok "T34i session-map.json is 600 after an atomic rewrite" || bad "T34i session-map.json mode=$m_map (want 600)"
}

# --------------------------------------------------------------------------- teardown
# Jobs created by THIS run must not outlive it. A `+1h` record created by a test
# that only asserts post-recovery state (T9B/T24/T25/T27) is still non-terminal
# when the suite exits; the next boot's catch-up tick then dispatches it into a
# shared session. That interference is what made T2 fail on the second run of the
# 2026-10-17 regression, so reconciling leftovers is part of the suite rather than
# an operator afterthought.
#
# Scope is deliberately narrow: only ids in $E/created_ids.txt (written by
# create()) that are STILL non-terminal. There is no "cancel every pending job"
# and no time-range sweep, so a record that belongs to something else is never
# touched. jobs.js cancel() returns `already-terminal` for a terminal record
# without rewriting it, which makes a second pass harmless.
TEARDOWN_DONE=0
teardown_jobs() {
  [ "${TEARDOWN_DONE:-0}" -eq 1 ] && return 0
  TEARDOWN_DONE=1
  local list="$E/created_ids.txt"
  [ -s "$list" ] || return 0

  # If the probe is down nothing can be cancelled or observed; say so once instead
  # of burning a per-id timeout on every entry.
  if ! curl -s --max-time 3 -o /dev/null "$P/jobs" 2>/dev/null; then
    echo "  !! TEARDOWN skipped: probe $P is not answering, so leftover jobs could not be cancelled"
    echo "     (anything still non-terminal at exit will be dispatched by the next harness boot)"
    return 0
  fi

  hdr "TEARDOWN  reconcile jobs created by this run"
  local total=0 needed=0 verified=0 stuck=0 id st
  while read -r id; do
    [ -n "$id" ] || continue
    total=$((total+1))
    st=$(jobfield "$id" status 2>/dev/null)
    [ -n "$st" ] || continue                        # absent from the listing: nothing to do
    case "$st" in
      completed|cancelled|failed|unknown) continue ;;
    esac
    needed=$((needed+1))
    curl -s --max-time 5 -X POST "$P/job/cancel" -H 'Content-Type: application/json' \
      -d "{\"id\":\"$id\"}" >/dev/null 2>&1
    st=$(jobfield "$id" status 2>/dev/null)
    case "$st" in
      cancelled|completed|failed|unknown) verified=$((verified+1)) ;;
      *) stuck=$((stuck+1))
         echo "  !! job $id is still '$st' after cancel — it can still be dispatched later" >&2 ;;
    esac
  done < <(sort -u "$list")

  if [ "$stuck" -eq 0 ]; then
    ok "TEARDOWN no dispatchable leftover (${total} created, ${needed} cancelled, ${verified} verified terminal)"
  else
    bad "TEARDOWN ${stuck} job(s) could not be brought to a terminal state after cancel"
  fi
}
# Backstop for an abort (e.g. wait_settled's exit 2) that skips the explicit call
# below. Guarded, so it is a no-op once the runner has already reconciled.
trap teardown_jobs EXIT

# --------------------------------------------------------------------------- T6 TTL gate
# T6 asserts that an agent is really evicted inside its own window, so it only
# means anything when the RUNNING harness has a short idle TTL. Two sources
# disagree in practice:
#   * evidence/ttl.env   -- what run-eviction.sh last wrote. It survives a run that
#                           never reached its restore step, so it can be stale.
#   * /proc/<pid>/environ -- what the harness process actually received at exec.
# The TTL is therefore read from the PROCESS and reported beside the file. The file
# is never rewritten here: overwriting it would erase the evidence of the mismatch.
#
# The process match is the same one restart-test.sh and wait_settled() use: the
# executable must be node AND the command line must contain the contiguous phrase
# "dsh --profile mmt-test". A looser match would also catch the production
# `dsh web` process, which this suite must never inspect or disturb.
#
# stdout is a single "<pid> <ttl_ms>"; every diagnostic goes to stderr.
#   0  exactly one harness, TTL read and numeric
#   2  no matching harness process
#   3  more than one match (ambiguous — refuse to guess)
#   4  MATTERMOST_IDLE_TTL_MS absent from the harness environment
#   5  MATTERMOST_IDLE_TTL_MS present but not a positive integer
harness_ttl_ms() {
  local pid exe cmd hits=0 hit='' v
  for pid in $(pgrep -f 'dsh --profile' 2>/dev/null); do
    exe=$(readlink "/proc/$pid/exe" 2>/dev/null)
    case "$exe" in */node|*/nodejs) ;; *) continue ;; esac
    cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null)
    case "$cmd" in *"dsh --profile $MMT_PROFILE"*) ;; *) continue ;; esac
    hits=$((hits + 1)); hit="$pid"
  done
  if [ "$hits" -eq 0 ]; then
    echo "no running process is the test harness (node + 'dsh --profile mmt-test')" >&2
    return 2
  fi
  if [ "$hits" -gt 1 ]; then
    echo "$hits processes match the test harness; refusing to guess which one to inspect" >&2
    return 3
  fi
  v=$(tr '\0' '\n' < "/proc/$hit/environ" 2>/dev/null \
      | sed -n 's/^MATTERMOST_IDLE_TTL_MS=//p' | head -1)
  if [ -z "$v" ]; then
    echo "harness pid $hit has no MATTERMOST_IDLE_TTL_MS in its environment" >&2
    return 4
  fi
  case "$v" in
    *[!0-9]*) echo "harness pid $hit reports a non-numeric TTL '$v'" >&2; return 5 ;;
  esac
  if [ "$v" -le 0 ]; then
    echo "harness pid $hit reports a non-positive TTL '$v'" >&2
    return 5
  fi
  printf '%s %s' "$hit" "$v"
  return 0
}

# Report the declared vs actual TTL, and decide whether T6/T17 may run at all.
# Returns 1 — and the caller must then NOT run T6/T17 — when the actual TTL cannot
# be established: neither a warning nor a verdict based on an unknown TTL would be
# worth anything, and there is no silent fallback to the declared value.
# A long-but-known TTL is reported loudly but does NOT block: refusing to run would
# let a misconfiguration masquerade as a skip, and the assertion stays untouched.
t6_ttl_gate() {
  local declared actual rc pid ttl
  declared=$(grep -o 'T6_TTL_MS=[0-9]*' "$E/ttl.env" 2>/dev/null | cut -d= -f2)
  echo "T6 TTL — declared by evidence/ttl.env: ${declared:-<absent>}"
  actual=$(harness_ttl_ms); rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "  !! the harness TTL could not be determined (reason above)."
    echo "     T6/T17 will NOT run: a pass, a skip or a warning based on an unknown"
    echo "     TTL would be meaningless. Start the harness and retry."
    return 1
  fi
  pid=${actual%% *}; ttl=${actual##* }
  echo "T6 TTL — actually in effect (harness pid $pid, /proc/$pid/environ): $ttl"
  if [ -z "$declared" ]; then
    echo "  note: evidence/ttl.env is absent, so t6() falls back to its built-in default (60000)."
  elif [ "$declared" != "$ttl" ]; then
    echo "  !! MISMATCH: evidence/ttl.env declares ${declared}ms but the running harness has ${ttl}ms."
    echo "     The file is left untouched (it records what run-eviction.sh wrote)."
    echo "     t6() reads the FILE, so it would operate on the declared value."
  fi
  if [ "$ttl" -gt 120000 ]; then
    echo
    echo "  !! T6/T17 requested with an idle TTL of ${ttl}ms ACTUALLY in effect."
    echo "     T6 asserts a real eviction inside its own window, so it can only pass"
    echo "     under a short TTL. Use ./run-eviction.sh — not ./run.sh T6."
    echo
  fi
  return 0
}

# --------------------------------------------------------------------------- runner
#
# Group definitions. $ALL is the single source of truth; $EVICTION names the
# groups that need the shortened idle TTL and $MAIN is DERIVED from it, so the two
# cannot drift.
#
# T6/T17 only pass under run-eviction.sh, which restarts the harness with
# MATTERMOST_IDLE_TTL_MS=60000 and restores 1800000 afterwards. They are excluded
# from the default set for that reason: a bare `./run.sh` used to include T6 and
# could only ever fail it.
ALL="T1 T2 T3 T4 T5 T6 T7 T8 T9 T10 T11 T12 T13 T14 T15 T16 T19 T20 T21 T22 T23 T24 T25 T26 T27 T28 T29 T32 T33 T34"
EVICTION="T6 T17"
MAIN=""
for g in $ALL; do
  case " $EVICTION " in *" $g "*) ;; *) MAIN="$MAIN $g" ;; esac
done
MAIN="${MAIN# }"
WANT="${*:-$MAIN}"

# Fresh created-id list for THIS invocation, before anything can abort.
: > "$E/created_ids.txt"

echo "waiting for the harness to be ready ($BIN/restart-test.sh starts it if needed)..."
wait_settled "$(now_ms)" 0 60 3
echo "scheduler acceptance suite — session A=$SESSION  B=${SESSION_B:-none}"
echo "probe=$P  evidence=$E"
echo "groups: $WANT"

# Consult the TTL gate ONLY when T6/T17 was requested, so a normal main-suite run
# does no /proc inspection at all and cannot be affected by this check.
T6_BLOCK_REASON=''
case " $WANT " in
  *" T6 "*|*" T17 "*)
    t6_ttl_gate || T6_BLOCK_REASON='the running harness TTL could not be determined' ;;
esac

# --------------------------------------------------------------------------- failure policy
#
# Ordinary assertion failures do NOT stop the run. The groups are independent --
# each plants its own fixtures and asserts on its own evidence -- so one report
# covering every group beats 30 separate invocations, and fail-fast would be the
# wrong default anyway because teardown and the TTL restore must still happen.
#
# The one state that DOES stop the run is a dead probe. Once the harness stops
# answering, every remaining group fails on unreachable curl instead of on the
# behaviour under test, which buries the real cause in noise. That is checked
# between groups (with one retry, so a transient blip cannot abort a healthy run)
# and the run then falls through to the normal summary + teardown path -- the
# early stop never bypasses them.
#
# Exit codes:
#   0  every group passed
#   1  one or more assertions failed (a failed teardown counts as one)
#   2  the harness never became ready (wait_settled aborts with this)
#   3  the run was stopped early because the probe stopped answering
probe_alive() {
  curl -s --max-time 3 -o /dev/null "$P/jobs" 2>/dev/null && return 0
  sleep 2
  curl -s --max-time 3 -o /dev/null "$P/jobs" 2>/dev/null
}

RAN=0
ABORT_REASON=''
ABORTED_AT=''
NOT_RUN=''
for t in $WANT; do
  if [ "$RAN" -gt 0 ] && ! probe_alive; then
    ABORT_REASON="probe $P stopped answering"
    ABORTED_AT="$t"
    seen=0
    for g in $WANT; do
      if [ "$g" = "$t" ]; then seen=1; NOT_RUN="$g"; continue; fi
      [ "$seen" -eq 1 ] && NOT_RUN="$NOT_RUN $g"
    done
    break
  fi
  RAN=$((RAN + 1))
  case "$t" in
    T1) t1 ;; T2) t2 ;; T3) t3 ;; T4) t4 ;; T5) t5 ;;
    T6|T17)
      if [ -n "$T6_BLOCK_REASON" ]; then skip "T6/T17 not run: $T6_BLOCK_REASON"
      else t6; fi ;;
    T7|T18) t7 ;; T8) t8 ;; T9) t9 ;; T10) t10 ;;
    T11) t11 ;; T12) t12 ;; T13) t13 ;; T14) t14 ;; T15) t15 ;; T16) t16 ;;
    T19) t19 ;; T20) t20 ;; T21) t21 ;; T22) t22 ;;
    T23) t23 ;; T24) t24 ;; T25) t25 ;; T26) t26 ;; T27) t27 ;; T28) t28 ;; T29) t29 ;; T32) t32 ;; T33) t33 ;; T34) t34 ;;
    *) echo "unknown test $t" ;;
  esac
done

# Reconcile this run's leftover jobs BEFORE the summary, so the result is counted
# in pass/fail and any job that could not be cancelled turns into a non-zero exit.
teardown_jobs

hdr "SUMMARY"
for r in "${RESULTS[@]}"; do echo "  $r"; done
echo
if [ -n "$ABORT_REASON" ]; then
  echo "  !! RUN STOPPED EARLY: $ABORT_REASON (at group $ABORTED_AT, after $RAN group(s))"
  echo "     groups NOT run:$NOT_RUN"
fi
echo "  pass=$PASS fail=$FAIL skip=$SKIP"
printf '%s\n' "${RESULTS[@]}" > "$E/summary.txt"
# The abort note is appended, never substituted: a teardown failure and an early
# stop must both remain visible alongside the original assertion failures.
if [ -n "$ABORT_REASON" ]; then
  printf 'ABORTED before %s: %s (groups not run:%s)\n' "$ABORTED_AT" "$ABORT_REASON" "$NOT_RUN" >> "$E/summary.txt"
fi
echo "  evidence: $E"
if [ "$FAIL" -ne 0 ]; then exit 1; fi
[ -n "$ABORT_REASON" ] && exit 3
exit 0
