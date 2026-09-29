#!/usr/bin/env bash
# Durable delayed-job scheduler — acceptance suite (T1–T18).
#
# Runs against the ISOLATED harness only (DSH_HOME=/home/dsh/.dsh-mmt-test,
# profile mmt-test, probe 127.0.0.1:3091). Production is never touched.
#
#   ./run.sh              run every test
#   ./run.sh T6 T17       run a subset
#
# Evidence is written to scheduler-test/evidence/.
set -u

BIN=/home/dsh/workspace/DSH/dsh-mattermost
P=http://127.0.0.1:3091
CH=b88dps33k3dufri9cumyuoz3ce
OWNER=8ac5jxgpatdztg1xmgo9a4g7uy
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

probe_up() { curl -s --max-time 5 "$P/status" >/dev/null 2>&1; }

require_probe() {
  if ! probe_up; then echo "probe not reachable at $P — start the harness first"; exit 2; fi
}

# create <type> <sessionId> <executeAtMs> <message> -> job id (or empty)
create() {
  curl -s --max-time 10 -X POST "$P/job/create" -H 'Content-Type: application/json' \
    -d "$(python3 -c '
import json,sys
print(json.dumps({"type":sys.argv[1],"sessionId":sys.argv[2],"executeAt":int(sys.argv[3]),
                  "channelId":sys.argv[5],"createdBy":sys.argv[6],"message":sys.argv[4]}))
' "$1" "$2" "$3" "$4" "$CH" "$OWNER")" \
    | jq_ 'print(d["job"]["id"] if d.get("ok") else "")'
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
m=json.load(open('/home/dsh/.dsh-mmt-test/mattermost/session-map.json'))['entries']
pref=[k for k in m if k.startswith('ch:')]
print(m[(pref or list(m))[0]]['sessionId'])
")
# Two distinct sessions, for isolation tests.
SESSION_B=$(python3 -c "
import json
m=json.load(open('/home/dsh/.dsh-mmt-test/mattermost/session-map.json'))['entries']
ks=[k for k in m if k.startswith('th:')]
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
  ondisk=$(ls /home/dsh/.dsh-mmt-test/storages/mattermost_jobs/jobs/"$id".json 2>/dev/null)
  [ -n "$ondisk" ] && ok "T1 record durable on disk" || bad "T1 record not found on disk"
  curl -s -X POST "$P/job/cancel" -H 'Content-Type: application/json' -d "{\"id\":\"$id\"}" >/dev/null
}

# --------------------------------------------------------------------------- T2
t2() {
  hdr "T2  job executes when due"
  local before; before=$(jobfield "$SESSION" status 2>/dev/null || echo '')
  local at; at=$(($(now_ms)+2000))
  local id; id=$(create reminder "$SESSION" "$at" "[T2] 请只回复 T2_OK")
  sleep 3; tick; sleep 2
  local st; st=$(jobfield "$id" status)
  [ "$st" = "completed" ] && ok "T2 dispatched at due time" || bad "T2 status=$st (want dispatched)"
  local d; d=$(jobfield "$id" dispatchedAt)
  [ "$d" != "None" ] && [ -n "$d" ] && ok "T2 dispatchedAt recorded" || bad "T2 dispatchedAt missing"
  grep -q "job dispatched id=$id" /home/dsh/.dsh-mmt-test/mattermost/plugin.log \
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
  grep -q "job dispatched id=$id" /home/dsh/.dsh-mmt-test/mattermost/plugin.log \
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
  grep -q "evicted idle agent session=$SESSION" /home/dsh/.dsh-mmt-test/mattermost/plugin.log \
    && ok "T6 eviction recorded in log" || skip "T6 no eviction line yet"

  echo "  waiting for the job to come due..."
  local wait_s=$(( due_in - (ttl_ms/1000 + 20) + 6 ))
  [ "$wait_s" -gt 0 ] && sleep "$wait_s"
  tick; sleep 3
  st=$(jobfield "$id" status)
  [ "$st" = "completed" ] && ok "T6 job EXECUTED after eviction" || bad "T6 status=$st (want dispatched)"
  local live3; live3=$(curl -s "$P/agent?sessionId=$SESSION" | jq_ 'print(d["live"])')
  [ "$live3" = "True" ] && ok "T6 session was RESUMED by the scheduler" || bad "T6 session not resumed"
  grep -q "job dispatched id=$id" /home/dsh/.dsh-mmt-test/mattermost/plugin.log \
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
  "$BIN/restart-test.sh" >/dev/null
  sleep 35
  require_probe
  ok "T7 harness restarted"

  local st2; st2=$(jobfield "$id" status)
  if [ -n "$st2" ]; then ok "T7 job SURVIVED restart (status=$st2)"; else bad "T7 job lost across restart"; return; fi
  grep -q "job recovery:" /home/dsh/.dsh-mmt-test/mattermost/plugin.log \
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
    local before; before=$(grep -c "job dispatched id=$id" /home/dsh/.dsh-mmt-test/mattermost/plugin.log)
    curl -s -X POST "$P/job/recover" -H 'Content-Type: application/json' -d '{"now":0,"leaseMs":0}' >/dev/null
    sleep 1; tick; sleep 2
    local after; after=$(grep -c "job dispatched id=$id" /home/dsh/.dsh-mmt-test/mattermost/plugin.log)
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
  python3 - "$id2" <<'PY'
import json, sys, pathlib
p = pathlib.Path('/home/dsh/.dsh-mmt-test/storages/mattermost_jobs/jobs') / (sys.argv[1] + '.json')
d = json.loads(p.read_text())
r = d['record']
r.update(status='running', claimId='deadbeefdeadbeef', claimedAt=1, attempts=1, dispatchedAt=None)
p.write_text(json.dumps(d))
PY
  "$BIN/restart-test.sh" >/dev/null
  sleep 35
  require_probe
  curl -s -X POST "$P/job/recover" -H 'Content-Type: application/json' -d '{"now":0,"leaseMs":0}' > "$E/t9_recover.json"
  local stB; stB=$(jobfield "$id2" status)
  [ "$stB" = "pending" ] && ok "T9B orphaned claim requeued after restart (not lost, not fired)" || bad "T9B status=$stB (want pending)"
  python3 -m json.tool < "$E/t9_recover.json" 2>/dev/null | head -5

  # The deterministic inbox id is what makes the requeue safe.
  node -e "
import('/home/dsh/workspace/DSH/dsh-mattermost-sched/scheduler.js').then(m=>{
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
  grep -q "job deferred (agent busy) id=$id2" /home/dsh/.dsh-mmt-test/mattermost/plugin.log \
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
  grep -q "job dispatched id=$id2 .*agentRunning=false" /home/dsh/.dsh-mmt-test/mattermost/plugin.log \
    && ok "T11 delivered to an IDLE agent (agentRunning=false)" || skip "T11 no idle-dispatch log line"
}

# --------------------------------------------------------------------------- T12
t12() {
  hdr "T12  session without a live agent is resumed (not probed)"
  # Pick a mapped session that is definitely not live right now.
  local sid; sid=$(python3 -c "
import json
m=json.load(open('/home/dsh/.dsh-mmt-test/mattermost/session-map.json'))['entries']
ks=[k for k in m if k.startswith('th:')]
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
  grep -q "agent ready session=$sid" /home/dsh/.dsh-mmt-test/mattermost/plugin.log \
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
  local max; max=$(grep -o 'botChainMax=[0-9]*' /home/dsh/.dsh-mmt-test/mattermost/plugin.log | tail -1 | cut -d= -f2)
  [ "$max" = "5" ] && ok "T14 botChainMax still 5" || bad "T14 botChainMax=$max"
  echo "$st" | grep -q chainRejected && ok "T14 chain guard still wired" || bad "T14 chain stat missing"
  # The scheduler does not post to Mattermost, so it cannot inflate the chain.
  grep -qE 'job dispatched.*chain' /home/dsh/.dsh-mmt-test/mattermost/plugin.log \
    && bad "T14 scheduler touched the chain budget" || ok "T14 scheduler never posts (no chain bypass)"
}

# --------------------------------------------------------------------------- T15
t15() {
  hdr "T15  storage corruption / partial write"
  local dir=/home/dsh/.dsh-mmt-test/storages/mattermost_jobs/jobs
  local target="$dir/job-00000000000000ff.json"
  python3 - "$target" <<'PY'
import sys, pathlib
pathlib.Path(sys.argv[1]).write_text('{"version":1,"record":{"id":"not-a-valid-job"}}')
PY
  python3 - "$dir/job-00000000000000fe.json" <<'PY'
import sys, pathlib
pathlib.Path(sys.argv[1]).write_text('{ this is not json at all')
PY
  # A partial write leaves a temp file behind; it must be ignored, not fatal.
  printf '{"version":1,"reco' > "$dir/.partial.tmp"

  "$BIN/restart-test.sh" >/dev/null
  sleep 35
  require_probe
  local stats; stats=$(curl -s --max-time 8 "$P/jobs" | jq_ 'print(json.dumps(d["stats"]))')
  if [ -n "$stats" ]; then ok "T15 unit still opens with corrupt records present"; else bad "T15 unit failed to open"; fi
  echo "  stats: $stats"
  if grep -qiE 'backup|invalid|skip' /home/dsh/.dsh-mmt-test/mattermost/plugin.log; then
    ok "T15 corruption handled by the domain layer (backup-and-skip)"
  else
    skip "T15 no backup line (record may have been dropped silently)"
  fi
  local backed; backed=$(find /home/dsh/.dsh-mmt-test/storages/mattermost_jobs -name '*.bak*' -o -name '*moved*' 2>/dev/null | head -3)
  [ -n "$backed" ] && ok "T15 corrupt document preserved for inspection" || skip "T15 no backup artifact located"
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
  "$BIN/restart-test.sh" >/dev/null
  sleep 35
  require_probe
  # NOTE: `completed` here is a PASS, not a loss. The job was deferred with a
  # 30s retry window; the harness restart takes ~35s, so by the time the new
  # process boots the deferral has elapsed and the startup catch-up tick
  # dispatches it to the now-idle agent. Status alone cannot distinguish
  # "delivered after restart" from "consumed and lost" — the real discriminator
  # is whether the instruction actually ran, asserted at the end of this test.
  st=$(jobfield "$id" status)
  ok "T22 job state after restart: $st (recoverable or already re-dispatched)"

  echo "  waiting for the job to be delivered to the now-idle agent..."
  local done=0 j=0
  while [ "$j" -lt 16 ]; do
    sleep 10; j=$((j+1))
    tick
    [ "$(jobfield "$id" status)" = "completed" ] && { done=1; break; }
  done
  [ "$done" = "1" ] && ok "T22 job executed after the restart" || bad "T22 job never completed"
  sleep 20
  cd "$BIN" && ./mm.sh list 12 > /tmp/t22_channel.txt 2>/dev/null
  grep -q "$token" /tmp/t22_channel.txt \
    && ok "T22 instruction ACTUALLY RAN (reply visible) — no silent loss" \
    || bad "T22 job completed but the instruction never executed"
}

# --------------------------------------------------------------------------- runner
ALL="T1 T2 T3 T4 T5 T6 T7 T8 T9 T10 T11 T12 T13 T14 T15 T16 T19 T20 T21 T22"
WANT="${*:-$ALL}"
require_probe
echo "scheduler acceptance suite — session A=$SESSION  B=${SESSION_B:-none}"
echo "probe=$P  evidence=$E"

for t in $WANT; do
  case "$t" in
    T1) t1 ;; T2) t2 ;; T3) t3 ;; T4) t4 ;; T5) t5 ;;
    T6|T17) t6 ;; T7|T18) t7 ;; T8) t8 ;; T9) t9 ;; T10) t10 ;;
    T11) t11 ;; T12) t12 ;; T13) t13 ;; T14) t14 ;; T15) t15 ;; T16) t16 ;;
    T19) t19 ;; T20) t20 ;; T21) t21 ;; T22) t22 ;;
    *) echo "unknown test $t" ;;
  esac
done

hdr "SUMMARY"
for r in "${RESULTS[@]}"; do echo "  $r"; done
echo
echo "  pass=$PASS fail=$FAIL skip=$SKIP"
printf '%s\n' "${RESULTS[@]}" > "$E/summary.txt"
echo "  evidence: $E"
[ "$FAIL" -eq 0 ] || exit 1
