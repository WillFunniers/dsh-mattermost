# Scheduler acceptance suite

Runs against an **isolated** DSH harness. Never against production.

## Required environment

The suite deliberately contains no baked-in channel ids, user ids or local
paths. Point it at your own harness:

```bash
export MMT_BIN=/path/to/your/harness/checkout   # holds restart-test.sh and mm.sh
export MM_TEST_CHANNEL=<mattermost-channel-id>  # a channel the bot is in
export MM_TEST_OWNER=<mattermost-user-id>       # an authorized user id
export MMT_HOME=$HOME/.dsh-mmt-test             # optional; the harness DSH_HOME
```

`MMT_BIN` and `MM_TEST_*` are mandatory — the scripts abort with a clear message
if they are unset, rather than guessing.

## Running

```bash
./run.sh                 # T1-T22 (T6 needs a short TTL; see below)
./run.sh T11 T22         # a subset
./run-eviction.sh        # T6/T17: the incident replay, with a shortened idle TTL
./perf.sh                # 100 / 500 / 1000 job performance
```

`T6`/`T17` need `idleAgentTtlMs` short enough that a real eviction happens inside
the test window, so they run through `run-eviction.sh`, which restarts the
harness with `MATTERMOST_IDLE_TTL_MS=60000` and restores the default afterwards.

Evidence (logs, tables) is written to `evidence/`, which is gitignored — it is
regenerated output, not source.

## Notes

* `T22` asserts that a job's instruction **actually ran** (the reply is visible
  in the channel), not merely that the job record says `completed`. A job marked
  complete whose instruction never executed is the exact failure the scheduler
  exists to prevent.
* `T21` uses a unique token per run: a repeated identical reminder request makes
  the agent either de-duplicate or block on a clarifying question.
* The busy-agent tests forbid backgrounding the warm-up command and poll for a
  genuinely `running` agent, reporting a **skip** rather than passing on an
  unverified premise.
