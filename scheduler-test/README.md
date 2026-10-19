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
./run.sh                 # the MAIN suite: every group except T6/T17
./run.sh T11 T22         # a subset, by group name
./run-eviction.sh        # EVICTION only: T6/T17, the incident replay (short idle TTL)
./perf.sh                # 100 / 500 / 1000 job performance
```

`./run.sh` defaults to the **MAIN** suite, which deliberately **excludes**
`T6`/`T17`. Those are the incident replay: they need `idleAgentTtlMs` short enough
that a real eviction happens inside the test window, so they can only pass under
`run-eviction.sh`, which restarts the isolated harness with
`MATTERMOST_IDLE_TTL_MS=60000` and restores `1800000` afterwards — verifying the
restore and failing loudly if it cannot. `./run.sh T6` against a normally-started
harness is expected to fail; the runner prints a warning when the TTL is too long.

The groups are defined in `run.sh` and are the single source of truth:

| group | contents |
| --- | --- |
| `MAIN` | `ALL` minus `EVICTION` — what `./run.sh` runs by default |
| `EVICTION` | `T6 T17` — the short-TTL incident replay |
| `ALL` | every group |

`MAIN` is **derived** from `ALL`, so a group added to `ALL` joins the default run
automatically and the two cannot drift. `ALL` is a definition, not an invocation:
running every group in one process is not supported, because `T6` needs a
different harness TTL from the rest.

Evidence (logs, tables) is written to `evidence/`, which is gitignored — it is
regenerated output, not source.

Every run also reconciles the jobs it created: `create()` records each new job id
in `evidence/created_ids.txt`, and at the end of the run any of those still
non-terminal is cancelled. A job that cannot be brought to a terminal state fails
the run. The reconciliation is scoped to that list only — it never cancels jobs it
did not create.

## Failure policy and exit codes

An ordinary assertion failure does **not** stop the run: the groups are
independent, so one report covering all of them is more useful than fail-fast, and
stopping early would still have to leave teardown and the TTL restore intact. The
only state that stops the run is a dead probe — once the harness stops answering,
every remaining group would fail on unreachable `curl` rather than on the
behaviour under test. That is checked between groups (with one retry) and the run
then falls through to the normal summary and teardown; the summary says which
groups were skipped.

| exit code | meaning |
| --- | --- |
| `0` | every group passed |
| `1` | one or more assertions failed (a failed teardown counts as one) |
| `2` | the harness never became ready |
| `3` | the run stopped early because the probe stopped answering |

Teardown failures and an early stop are **appended** to `evidence/summary.txt`, so
neither can hide the original assertion failures.

## Notes

* `T22` asserts that a job's instruction **actually ran** (the reply is visible
  in the channel), not merely that the job record says `completed`. A job marked
  complete whose instruction never executed is the exact failure the scheduler
  exists to prevent.
* `T2` asserts due-time dispatch against an **idle** target. If the target session
  is busy, the scheduler correctly defers the job (~30s retry window), which is
  `T11`/`T22`'s subject, so `T2` reports a skip instead of failing on a correct
  deferral. Only `completed` passes; `failed`, `unknown` and still-`pending` are
  all failures.
* `T21` uses a unique token per run: a repeated identical reminder request makes
  the agent either de-duplicate or block on a clarifying question.
* The busy-agent tests forbid backgrounding the warm-up command and poll for a
  genuinely `running` agent, reporting a **skip** rather than passing on an
  unverified premise.
