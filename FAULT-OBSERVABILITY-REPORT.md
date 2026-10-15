# Fault Observability & Safe Recovery — Implementation Report

Companion to `FAULT-OBSERVABILITY-AUDIT.md` (the pre-change audit).
Baseline: `569dcd3`. Runtime: DSH `0.2.0-rc.2`, Node `v24.20.0`.

---

## 1. Audit summary (what existed vs what was actually missing)

The audit is `FAULT-OBSERVABILITY-AUDIT.md`; it is evidence-first and was written before any
change. In short:

**Already existed and was reused, not rebuilt:** the durable job store over
`ctx.storageDomain` (zod validation, `per-record` layout, `backup-and-skip`, atomic
`table.update()`), the scheduler with claim/lease and busy-**defer**, startup recovery, the
deterministic message id, `mattermost.js` delivery retry with thread-root fallback, the
WebSocket reconnect + REST backfill, and — importantly — the **already-wired**
`ctx.on('session/event')` subscription that delivers `turn/start` / `turn/end`.

**Genuinely missing (the real gaps):**

| # | Gap | Why it mattered |
|---|---|---|
| G1 | `recover()` returned an ambiguous job to `pending` | `dispatchedAt` is written *after* `followup()`, so a crash in between was indistinguishable from "never delivered" — recovery **re-delivered** a task that might already be executing |
| G2 | no state could express "outcome unknown" | forced a choice between lying (`completed`) and blind replay (`pending`) |
| G3 | no durable fault record | faults existed only as best-effort log lines: no id, no delivery state, nothing to retry |
| G4 | no notification | a lost/interrupted job was invisible until someone asked |
| G5 | interrupted turns not recorded | nothing persisted that a turn was open when the process stopped |
| G6 | notification failure not durable | if Mattermost was down past the 4 send retries, the message was simply gone |
| G7 | corruption handled silently | the storage layer isolated bad records correctly but told nobody |

---

## 2. Change list

| File | Change | Behaviour change |
|---|---|---|
| `jobs.js` | added terminal **`unknown`**; added `deliveryAttemptedAt` + `unknownReason`; added `markDeliveryAttempted()` / `markUnknown()`; **rewrote `recover()`** to decide by evidence and to return the affected ids | recovery no longer blindly requeues; one extra durable write per dispatch |
| `scheduler.js` | persists the delivery **intent before** the side effect: `markDeliveryAttempted()` → `followup()` → `markCompleted()` | closes G1; happy path otherwise unchanged |
| **`faults.js`** (new) | durable fault events + notification queue + turn bookkeeping, reusing the same storage pattern as `jobs.js` | new domain `mattermost_faults`; nothing existing touched |
| `index.js` | opens the fault store beside the job store; turn open/close recorded from the **existing** event subscription; startup fault reporting; corruption probe; notification flush on startup and from the **existing** sweep interval; `faults` inspection surface | additive; fault reporting failures can never affect jobs or the transport |
| `probe/plugin.js` (test scaffold) | `/faults`, `/fault/*` endpoints | test-only |
| `scheduler-test/run.sh` | T23–T29, T32 | test-only |
| `README.md`, `SCHEDULER-DESIGN.md` | fault-observability docs; §8.1 the two decision fields; §10.1 what is and is not guaranteed; §10.2 faults & notifications | documentation |

**Not modified:** `mapping.js`, `markdown.js`, `agents.js`, `outbound.js`, `mattermost.js`.
Admission order, authorization, channel allowlist, bot-chain budget, `idleAgentTtlMs` and every
production config value are untouched. No new dependency, no database, no queue, no new timer.

---

## 3. State semantics

### Job (persisted)

| State | Means | Terminal |
|---|---|---|
| `pending` | durable; `executeAt` in the future (the brief's *scheduled*), or due and awaiting delivery (*pending*) | no |
| `running` | claimed; a delivery attempt may be in flight | no |
| `completed` | **the instruction is durably in the session inbox** — *not* that the agent finished | yes |
| `unknown` | delivery was attempted and the outcome cannot be established | yes — human required |
| `failed` | a **confirmed** failure (non-retryable, or attempts exhausted) | yes |
| `cancelled` | cancelled before delivery | yes |

The brief's five-way split maps onto this without redundant states: *scheduled* and *pending*
are both `pending` (differing only by `executeAt` vs now), *dispatched* is `running`→`completed`,
and `unknown` is the new, necessary one.

### Agent vs Job vs Fault

* **Agent state** (`idle`/`running`) is ephemeral and never used as a record.
* **Job state** records *delivery*.
* **Fault event** records *what a human needs to know*. Delivery succeeded and execution was
  interrupted are **different facts**, so an interrupted turn does **not** rewrite the job:
  the job stays `completed` (an accurate statement about delivery) and the fault carries the
  unknown-execution fact.

### Fault event

`type` ∈ {`job-unknown`, `job-orphaned`, `turn-interrupted`, `session-recreated`,
`job-corrupt`, `notify-undeliverable`} ·
`outcome` ∈ {`unknown`, `interrupted`, `isolated`, `informational`} ·
`needsHuman` · `notifyState` ∈ {`pending`, `sent`, `failed`}.

Notification state is tracked **on the event**, so a fault is never conflated with whether it
was announced.

---

## 4. Recovery policy

| Situation | Automatic | Reason |
|---|---|---|
| Not yet due across a restart | ✅ stays scheduled | nothing attempted |
| Due, never claimed | ✅ reclaimed and delivered | no side effect yet |
| Claimed, **no** delivery intent recorded | ✅ requeued | provably nothing was sent |
| Claimed, delivery intent recorded, no completion | ❌ **`unknown` + notify** | replay could double-execute |
| Delivered, turn still open at stop | ❌ **notify**, correlated to the job | result unknowable |
| Corrupt / schema-incompatible record | ✅ isolated **and** notified | storage layer already isolates; now it is visible |
| Notification undeliverable | ✅ retried | durable pending state |

**Rule: act automatically only on proof. Where there is no proof, ask.**

---

## 5. Test results

| | Assertions | Pass | Fail | Skip |
|---|---:|---:|---:|---:|
| **Before** (`BEFORE-baseline.log`, T1–T22) | 64 | 63 | 0 | 1 |
| **After** (`AFTER-full.log`, T1–T32) | 89 | 88 | 0 | 1 |
| Eviction replay (`AFTER-eviction.log`, T6/T17) | 7 | 7 | 0 | 0 |

**+25 assertions, zero regressions.** The one skip is the same cosmetic T15 sub-assertion in
both runs (the storage layer's backup is verified directly; the log line is not always present).

New cases, all passing:

| # | Scenario | Result |
|---|---|---|
| T23 | unexpired job survives restart, stays `pending`, fires on time, **not** marked unknown | PASS |
| T24 | claimed-but-never-delivered is requeued **and** recorded as an informational fault | PASS |
| **T25** | **delivered-but-unknown is marked `unknown`, NOT requeued, NOT re-delivered, raises exactly one `needsHuman` fault** | PASS |
| T26 | two further recovery boots produce **no duplicate fault events** (2 → 2 → 2) | PASS |
| T27 | with Mattermost suspended, a notification stays **pending** and is **not** marked sent | PASS |
| T28 | after reconnect the owed notification is sent and is **visible in the channel** | PASS |
| T29 | two corrupt job documents: unit still opens, healthy neighbours survive, 2 faults raised, documents preserved | PASS |
| T32 | exactly one scheduler loop (tick delta 4/20 s), one `scheduler ready` per boot | PASS |

Regression coverage retained and green: T11 (busy → **defer**, no steer), T13 (cross-session
fencing), T14 (bot-chain unchanged), T2/T5/T8/T10/T12/T19–T22.

Failure injection was used throughout: record edits followed by a **real** harness restart, and
the existing `wssuspend`/`wsresume` hooks. No production task was used to test duplicate delivery.

---

## 6. Residual risks

1. **Process-death blind spot.** The plugin cannot report a fully dead `dsh web`; it lives
   inside it. Detecting that needs systemd/journal monitoring — explicitly out of scope.
2. **`unknown` is genuinely unknown.** Whether the upstream turn started cannot be observed
   from inside the plugin. The change is that this is now *recorded and escalated* rather than
   silently re-run.
3. **Over-reporting at one boundary.** A crash between the intent marker and `followup()`
   marks a job `unknown` although nothing was delivered. It errs toward asking a human, never
   toward replaying.
4. **Turn attribution is correlational, not certain.** An interrupted turn is linked to jobs
   delivered into it (tight, because jobs are only dispatched to an **idle** agent, so a
   delivery is what opens the turn). If several jobs land in the window, all are named rather
   than guessing.
5. **Corruption detection is best-effort.** It reads the storage layout
   (`$DSH_HOME/storages/<domain>/<table>/`). If that convention changes, the probe is skipped
   and logged; the storage layer's own isolation still protects the data.
6. **Notification retry needs a live socket.** Pending notifications drain on the sweep tick
   once connected. A permanently dead Mattermost leaves them `pending` forever — which is
   visible in `faults.stats()`, and never falsely `sent`.
7. **Not verified against a real hard process kill.** The crash window was reproduced by
   editing persisted records and restarting, which exercises the same recovery path but not
   the in-kernel abrupt termination.

---

## 7. Rollback

The change is additive apart from the recovery semantics, so rollback is a checkout:

```bash
cd "$WORKDIR/dsh-mattermost-prod"
git log --oneline -3                 # note the fault-observability commits
git revert --no-edit <first>..<last> # or: git reset --hard 569dcd3
# then, if and only if you choose to activate it:
systemctl restart dsh-web            # requires your approval; not done by this task
```

Data rollback (optional, and safe to leave):

```bash
# The fault domain is additive; removing it only discards fault history.
rm -rf $DSH_HOME/storages/mattermost_faults
# Jobs written by the new code carry two extra nullable fields. The OLD schema
# would reject them, and the storage layer would move them aside to *.bak.*
# (verified behaviour) rather than fail. Revert before creating new jobs if you
# want to avoid that.
```

Note the job-schema caveat if you revert **after** new jobs have been created.

---

## 8. Deployment advice

**Not applied.** Production was not restarted and not reconfigured during this task.

1. **Nothing is live until `dsh-web` restarts.** Production currently runs the pre-change code
   (`569dcd3`); the fault-observability code loads at the next restart (the 04:00 timer, or a
   manual restart if you prefer).
2. **Recommended first check after activation** (read-only):
   ```bash
   grep -E 'fault store ready|scheduler ready' "$DSH_HOME/mattermost/plugin.log" | tail -2
   ls -la "$DSH_HOME/storages/mattermost_faults" 2>/dev/null || echo 'no faults yet (healthy)'
   ```
   Expected: a `fault store ready (events=…, pendingNotifications=…)` line. `events=0` is the
   healthy starting state.
3. **Watch the first restart's recovery line.** `recovered=A+B+C` now has three components;
   the third (`unknown`) should be `0` in normal operation. A non-zero value means a job was
   interrupted and you will have received a Mattermost notice explaining what to check.
4. **No configuration change is required.** The feature has no new config keys; it activates
   with the existing defaults and cannot gate the transport (fault-store failure is logged and
   degrades only visibility).
5. **Keep the old bridge out of production while this runs.** A legacy external bridge and the
   plugin consume the same bot; that is a deployment concern outside this task, but it will
   produce duplicate replies if both are enabled.

---

## 9. Direct answers to the questions this work had to satisfy

* **Which tasks can be safely recovered after a DSH restart?**
  Those not yet due, and those claimed but provably never delivered (no intent marker). Both
  are re-established automatically.

* **Which can only be marked as unknown?**
  Any job where delivery was attempted and completion was not recorded. It becomes `unknown`,
  is never replayed, and is reported.

* **Which faults will notify me?**
  Unknown-outcome jobs (needs human), interrupted turns (needs human when a job is involved),
  isolated/corrupt job records, and rows that had to be recreated instead of resumed.
  Safe requeues are recorded as informational.

* **How are failed notifications retried?**
  The event's `notifyState` stays `pending` and the durable record keeps the channel, job and
  session; the existing sweep interval retries until Mattermost accepts it, and only a
  successful response sets `sent`.

* **What must I judge myself?**
  Anything marked `unknown` or `interrupted`: open the session in the DSH Web GUI, confirm how
  far it actually got, and decide whether to re-run it. The plugin will not decide that for you.
