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
#
# TTL SAFETY. Shortening the TTL means an abnormal end could leave the harness on
# 60000ms, silently changing what every later run tests. The restore is therefore
# split in two:
#   * restore_ttl()         performs the restart with an EXPLICIT TTL — it does not
#                           rely on run-test.sh's fallback — at most once;
#   * wait_harness_ttl()    proves it, by reading the TTL the RUNNING harness
#                           process actually received, and fails loudly otherwise.
# An EXIT trap drives both, so a normal exit, a non-zero exit, SIGINT, SIGTERM and
# SIGHUP all restore. SIGKILL and power loss cannot be trapped by anything; if
# that happens, re-run this script (or restart-test.sh) to put the harness back.
set -u
MMT_HOME="${MMT_HOME:-$HOME/.dsh-mmt-test}"
BIN="${MMT_BIN:?set MMT_BIN to the harness checkout that holds restart-test.sh}"
HERE="$(cd "$(dirname "$0")" && pwd)"
TTL_MS="${TTL_MS:-60000}"
SWEEP_MS="${SWEEP_MS:-10000}"
# What to put back. Explicit, so it never depends on the caller's environment or
# on run-test.sh's own default.
RESTORE_TTL_MS="${RESTORE_TTL_MS:-1800000}"
TTL_ENV="$HERE/evidence/ttl.env"
mkdir -p "$HERE/evidence"

# The TTL the running isolated harness actually received. The process environment
# is the only place that shows what was passed at exec time.
harness_ttl_ms() {
  local pid exe cmd v
  for pid in $(pgrep -f 'dsh --profile' 2>/dev/null); do
    exe=$(readlink "/proc/$pid/exe" 2>/dev/null)
    case "$exe" in */node|*/nodejs) ;; *) continue ;; esac
    cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null)
    case "$cmd" in *"dsh --profile mmt-test"*) ;; *) continue ;; esac
    v=$(tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null \
        | sed -n 's/^MATTERMOST_IDLE_TTL_MS=//p' | head -1)
    if [ -n "$v" ]; then printf '%s' "$v"; return 0; fi
  done
  return 1
}

# Bounded: the harness is killed and relaunched, so a dying predecessor can keep
# answering with the OLD value for a moment. Fails loudly rather than reporting a
# misleading success.
wait_harness_ttl() {
  local want="$1" budget="${2:-60}" got='' t0
  t0=$(date +%s)
  while [ $(( $(date +%s) - t0 )) -lt "$budget" ]; do
    got=$(harness_ttl_ms) || got=''
    if [ "$got" = "$want" ]; then
      echo "  harness TTL verified: MATTERMOST_IDLE_TTL_MS=$got"
      return 0
    fi
    sleep 2
  done
  echo "  !! harness TTL is not $want (running harness reports '${got:-<no harness process>}')" >&2
  return 1
}

# ttl.env is T6's input. It is written only AFTER the TTL it describes has been
# verified, and rewritten on restore, so it can never claim a TTL the harness does
# not have.
write_ttl_env() { printf 'T6_TTL_MS=%s\n' "$1" > "$TTL_ENV"; }

RESTORE_DONE=0
restore_ttl() {
  [ "$RESTORE_DONE" -eq 1 ] && return 0
  RESTORE_DONE=1
  MATTERMOST_IDLE_TTL_MS="$RESTORE_TTL_MS" timeout 60 "$BIN/restart-test.sh" >/dev/null 2>&1
}

on_exit() {
  local rc=$?
  # Never let a second signal interrupt the restore, and never re-enter.
  trap '' INT TERM HUP
  echo
  echo "=== restoring the production-equivalent TTL ($RESTORE_TTL_MS) ==="
  restore_ttl
  if wait_harness_ttl "$RESTORE_TTL_MS" 60; then
    write_ttl_env "$RESTORE_TTL_MS"
  else
    echo "  !! RESTORE NOT VERIFIED — the isolated harness may still be running with" >&2
    echo "     MATTERMOST_IDLE_TTL_MS=$TTL_MS. Re-run this script, or $BIN/restart-test.sh," >&2
    echo "     before trusting a later scheduler run. Exit code forced non-zero." >&2
    rc=1
  fi
  exit "$rc"
}
trap on_exit EXIT
# Turn a signal into a normal exit so the single EXIT trap above runs exactly once.
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

echo "=== starting harness with idleAgentTtlMs=${TTL_MS} sweepIntervalMs=${SWEEP_MS} ==="
MATTERMOST_IDLE_TTL_MS="$TTL_MS" MATTERMOST_SWEEP_MS="$SWEEP_MS" timeout 60 "$BIN/restart-test.sh" >/dev/null
# Prove the short TTL is actually in effect before running T6 against it. T6 waits
# for the harness itself (run.sh runs wait_settled first), so no fixed sleep is
# needed here.
if ! wait_harness_ttl "$TTL_MS" 60; then
  echo "  !! refusing to run T6 against a harness whose TTL was not applied" >&2
  exit 1
fi
write_ttl_env "$TTL_MS"

"$HERE/run.sh" T6
rc=$?

exit "$rc"
