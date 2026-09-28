#!/usr/bin/env bash
# T6 / T17 — the incident replay, which needs a SHORT idle TTL so a real
# eviction happens inside the test window instead of waiting 30 minutes.
#
#   incident:  job due at +60m, agent evicted at +30m, job must still fire
#   here:      job due at +TTL+45s, agent evicted at +TTL, job must still fire
#
# The production TTL (1800000) is restored afterwards. Neither the production
# profile nor the production process is touched: only this isolated harness
# (DSH_HOME=$MMT_HOME) is restarted, with an env override.
set -u
BIN=$WORKDIR/dsh-mattermost
HERE="$(cd "$(dirname "$0")" && pwd)"
TTL_MS="${TTL_MS:-60000}"
SWEEP_MS="${SWEEP_MS:-10000}"

echo "=== starting harness with idleAgentTtlMs=${TTL_MS} sweepIntervalMs=${SWEEP_MS} ==="
MATTERMOST_IDLE_TTL_MS="$TTL_MS" MATTERMOST_SWEEP_MS="$SWEEP_MS" "$BIN/restart-test.sh" >/dev/null
sleep 35

# T6 reads the TTL from this file.
echo "T6_TTL_MS=$TTL_MS" > "$HERE/evidence/ttl.env"

"$HERE/run.sh" T6
rc=$?

echo
echo "=== restoring the production-equivalent TTL (1800000) ==="
"$BIN/restart-test.sh" >/dev/null
sleep 35
grep -o 'idleTtlMs=[0-9]*' $MMT_HOME/mattermost/plugin.log | tail -1

exit $rc
