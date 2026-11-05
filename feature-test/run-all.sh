#!/usr/bin/env bash
#
# Phase driver for the feature acceptance suite.
#
# The Approval Bridge, Session Navigator and Multi-Bot assertions need three
# DIFFERENT configurations of the same isolated instance (a 30s approval timeout,
# a `never` approval policy, and two configured bots). This script restarts that
# instance between phases and runs the matching group, so `run.sh` never has to
# pretend a setting is in effect when it is not.
#
# Everything is env-driven; nothing here knows a machine path.
#
#   MMT_HOME      isolated DSH home (must be ~/.dsh-mmt-*)
#   MMT_RESTART   script that restarts (and reloads the environment of) that instance
#   PROBE         probe base URL
#   MM_CHANNEL    test channel id
#   MM_USER       authorized human user id
#   MM_BOT        bot's own user id (optional)
#   MM_OTHER_USER an id that is authorized for the SECOND bot only (optional)
set -uo pipefail

: "${MMT_HOME:?set MMT_HOME to the isolated test home}"
: "${MMT_RESTART:?set MMT_RESTART to the isolated restart script}"
PROBE="${PROBE:-http://127.0.0.1:3093}"
MM_CHANNEL="${MM_CHANNEL:?set MM_CHANNEL to the test channel id}"
MM_USER="${MM_USER:?set MM_USER to the authorized user id}"
MM_BOT="${MM_BOT:-}"
MM_OTHER_USER="${MM_OTHER_USER:-not-an-allowed-user}"
export MMT_HOME PROBE MM_CHANNEL MM_USER MM_BOT

HERE="$(cd "$(dirname "$0")" && pwd)"
TOTAL_FAIL=0

wait_ready() {
  local i
  for i in $(seq 1 60); do
    local st; st=$(curl -s --max-time 5 "$PROBE/status")
    case "$st" in
      *'"started":true'*'"connected":true'*) sleep 2; return 0 ;;
    esac
    sleep 2
  done
  return 1
}

phase() { # name, then KEY=VALUE... for the restart
  local name="$1"; shift
  printf '\n##### phase: %s\n' "$name"
  env "$@" "$MMT_RESTART" >/dev/null
  wait_ready || { printf 'phase %s: the instance did not come up\n' "$name" >&2; exit 3; }
}

run_group() { # group...
  bash "$HERE/run.sh" "$@"
  local rc=$?
  [ "$rc" -ne 0 ] && TOTAL_FAIL=$((TOTAL_FAIL+1))
  return $rc
}

printf 'feature acceptance phases\n  home: %s\n  probe: %s\n' "$MMT_HOME" "$PROBE"

# ---------------------------------------------------------------- core (ask)
phase "core (default: policy=ask, approval timeout 300s, one bot)" \
  DSH_PERMISSION_MODE=workspace-write
run_group core

# ---------------------------------------------------------------- expiry
phase "expiry (approval timeout 30s)" \
  DSH_PERMISSION_MODE=workspace-write MATTERMOST_APPROVAL_TIMEOUT_MS=30000
run_group expiry

# ---------------------------------------------------------------- never
phase "never (native policy never)" \
  DSH_PERMISSION_MODE=danger-full-access
run_group never

# ---------------------------------------------------------------- multi-bot
BOTS_JSON=$(python3 - "$MM_CHANNEL" "$MM_USER" "$MM_OTHER_USER" <<'PY'
import json, sys
channel, user, other = sys.argv[1], sys.argv[2], sys.argv[3]
print(json.dumps([
    {"id": "bot0", "tokenRef": "MATTERMOST_TOKEN", "channels": [channel],
     "freeResponseChannels": [channel], "allowedUsers": [user]},
    {"id": "bot1", "tokenRef": "MATTERMOST_TOKEN", "channels": [channel],
     "freeResponseChannels": [], "allowedUsers": [other]},
]))
PY
)
phase "multi-bot (two configured bots, isolated state and namespaces)" \
  DSH_PERMISSION_MODE=workspace-write MATTERMOST_BOTS="$BOTS_JSON"
run_group multibot

# ---------------------------------------------------------------- restore
phase "restore (default single-bot configuration)" \
  DSH_PERMISSION_MODE=workspace-write

printf '\n== phases: %d failing group run(s)\n' "$TOTAL_FAIL"
[ "$TOTAL_FAIL" -eq 0 ] && exit 0 || exit 1
