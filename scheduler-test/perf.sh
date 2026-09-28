#!/usr/bin/env bash
# Performance: store write cost, listing, due-scan, memory and storage at
# 100 / 500 / 1000 jobs.
#
# Measures the real store and the real domain projection. Jobs are created far
# in the future so nothing dispatches mid-measurement, and they are spread over
# synthetic session ids because the plugin's own `jobMaxPerSession` guard (50 by
# default) would otherwise — correctly — refuse the larger batches.
set -u
P=http://127.0.0.1:3091
CH=<your-channel-id>
OWNER=<your-user-id>
PER_SESSION=45
HERE="$(cd "$(dirname "$0")" && pwd)"
E="$HERE/evidence"; mkdir -p "$E"
LOG=$MMT_HOME/mattermost/plugin.log

ms() { python3 -c 'import time;print(int(time.time()*1000))'; }

rss() {
  # The harness is not a systemd unit. Match only a node process whose cmdline
  # contains the contiguous profile phrase — never the calling shell.
  local pid=''
  for p in $(pgrep -f 'dsh --profile mmt-test' 2>/dev/null); do
    case "$(readlink /proc/$p/exe 2>/dev/null)" in */node|*/nodejs) pid=$p ;; esac
  done
  [ -n "$pid" ] && awk '/VmRSS/{printf "%.1f", $2/1024}' "/proc/$pid/status" 2>/dev/null || echo '?'
}

create_many() {
  local n="$1"
  python3 - "$n" "$CH" "$OWNER" "$PER_SESSION" "$(ms)" > /tmp/perf_payloads.jsonl <<'PY'
import json, sys
n, ch, owner, per, base = int(sys.argv[1]), sys.argv[2], sys.argv[3], int(sys.argv[4]), int(sys.argv[5])
target = base + 86400000            # all far in the future
for i in range(n):
    print(json.dumps({
        "type": "reminder",
        "sessionId": "perf-%04d" % (i // per),
        "executeAt": target + i,
        "channelId": ch,
        "createdBy": owner,
        "message": "perf job %d" % i,
    }))
PY
  # Sequential: each create is a durable, fsynced write, which is the cost being
  # measured. Parallelising would measure throughput, not latency.
  while IFS= read -r body; do
    curl -s --max-time 10 -X POST "$P/job/create" -H 'Content-Type: application/json' -d "$body" >/dev/null
  done < /tmp/perf_payloads.jsonl
}

echo "existing jobs: $(curl -s "$P/jobs" | python3 -c 'import sys,json;print(json.load(sys.stdin)["stats"]["total"])')"
echo
printf '%-8s %-11s %-11s %-10s %-9s %-10s %s\n' BATCH create_ms list_ms tick_ms rss_mb dir_kb total
echo '--------------------------------------------------------------------------------'

for N in 100 500 1000; do
  T0=$(ms); create_many "$N"; T1=$(ms)

  L0=$(ms); curl -s --max-time 30 "$P/jobs" >/dev/null; L1=$(ms)
  K0=$(ms); curl -s --max-time 30 -X POST "$P/job/tick" >/dev/null; K1=$(ms)

  TOTAL=$(curl -s --max-time 30 "$P/jobs" | python3 -c 'import sys,json;print(json.load(sys.stdin)["stats"]["total"])')
  SZ=$(du -sk $MMT_HOME/storages/mattermost_jobs 2>/dev/null | cut -f1)
  printf '%-8s %-11s %-11s %-10s %-9s %-10s %s\n' \
    "+$N" "$((T1-T0))" "$((L1-L0))" "$((K1-K0))" "$(rss)" "$SZ" "$TOTAL"
done | tee "$E/perf_table.txt"

echo
echo "=== startup: store open + recovery cost (from plugin.log timestamps) ==="
$WORKDIR/dsh-mattermost/restart-test.sh >/dev/null
sleep 40
python3 - "$LOG" <<'PY' | tee "$E/perf_startup.txt"
import re, sys, datetime
lines = open(sys.argv[1], errors='ignore').read().splitlines()
def ts(l):
    m = re.match(r'(\S+Z)', l)
    if not m: return None
    try: return datetime.datetime.strptime(m.group(1), '%Y-%m-%dT%H:%M:%S.%fZ')
    except ValueError: return None
idx = max((i for i, l in enumerate(lines) if 'apply() entered' in l), default=0)
boot = lines[idx:]
t_apply = ts(boot[0]) if boot else None
t_ready = next((ts(l) for l in boot if 'scheduler ready' in l), None)
t_ws    = next((ts(l) for l in boot if 'websocket connected' in l), None)
if t_apply and t_ready:
    print("  apply -> scheduler ready : %.0f ms  (store open + recovery)" % ((t_ready - t_apply).total_seconds()*1000))
if t_ready and t_ws:
    print("  scheduler ready -> ws up : %.0f ms" % ((t_ws - t_ready).total_seconds()*1000))
print("  " + next((l for l in reversed(boot) if 'scheduler ready' in l), 'n/a').split(' INFO ')[-1])
PY

echo
echo "=== final due-scan with the full store (all far future; nothing dispatches) ==="
curl -s --max-time 30 "$P/jobs" > "$E/perf_jobs.json"
python3 -c "
import json
d=json.load(open('$E/perf_jobs.json'))
print('  stats      :', json.dumps(d['stats']))
print('  scheduler  :', json.dumps(d['scheduler']))
print('  job records:', len(d['jobs']))
" | tee -a "$E/perf_startup.txt"
ls $MMT_HOME/storages/mattermost_jobs/jobs 2>/dev/null | wc -l | xargs echo "  documents on disk:"
