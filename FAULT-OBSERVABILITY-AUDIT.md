# Fault Observability & Safe Recovery — Audit

Status: **audit, pre-implementation**
Scope: incremental hardening of `dsh-mattermost`. Not a rewrite.
Baseline: `569dcd3` (`v0.1.0-production` → `841d3f7`)
Runtime: DSH `0.2.0-rc.2`, Node `v24.20.0`, plugin verified alive in production
(served a request 2026-10-15 06:26, replied 06:28, idle-evicted 06:58).

This audit is evidence-first: every "already exists" below was read out of the current
source, and every "gap" was reproduced or traced to a specific line. Nothing is assumed to
be missing merely because this task asks for it.

---

## 1. What already exists (do not rebuild)

| Capability | Where | Evidence |
|---|---|---|
| Durable job store over `ctx.storageDomain` | `jobs.js` | `defineDomain({name:'mattermost_jobs', layout:'per-record', invalidRecords:'backup-and-skip'})` |
| Schema validation at the durable boundary | `jobs.js` | `jobSchema` (zod) applied on the projection; an invalid record is moved aside, not fatal |
| Atomic read-modify-write transitions | `jobs.js` | every transition goes through `table.update()`, single write chain |
| Corruption isolation | `jobs.js` + storage layer | measured: 14 schema-invalid records moved to `*.json.bak.*`, unit still opened |
| Scheduler loop, unref'd, disposed with the plugin | `scheduler.js` | 5 s tick, `timer.unref()` |
| Claim + lease (no double claim) | `jobs.js:claim`, `scheduler.js` | atomic `update` sets `claimId`/`claimedAt` |
| Busy target deferred, never queued into a running turn | `scheduler.js` | `if (agent.status === 'running') store.defer(...)`, attempts rolled back |
| Startup recovery | `jobs.js:recover` | `running`+`dispatchedAt` → `completed`; `running`+stale → `pending` |
| Deterministic message id (inbox de-dup) | `scheduler.js:buildJobMessage` | `id = 'mmjob-' + jobId` |
| Bounded retry + backoff for dispatch failures | `scheduler.js:retryOrFail`, `backoffFor` | `maxAttempts` default 3, 5 s → 5 min |
| Delivery retry with transient classification | `mattermost.js:send` | 4 attempts, `fetch failed`/5xx/429/ECONNRESET; `root_id` 400 → channel fallback |
| WS reconnect + REST backfill + bounded de-dup | `mattermost.js` | `seen` set (5000), `?since=` backfill, `closedByUs` |
| Transport state persistence | `mattermost.js` | `state.json`: `lastSeenAt` + `seen` |
| Session event subscription (already wired) | `index.js:463` | `ctx.on('session/event', …)` → `outbound.js` |
| Turn boundaries already observed | `outbound.js` | handles `turn/start`, `assistant/message`, `turn/end` |
| Durable file mirror of logs | `index.js:write` | `plugin.log` (best-effort append) |
| Inspection surface | `index.js:ctx.provide('mattermost')` | `status()`, `jobs.*`, sweep/ws test hooks |
| Acceptance suite | `scheduler-test/run.sh` | T1–T22, 52 assertions green at baseline |

**Conclusion:** the durability, scheduling, transport-retry and event-subscription primitives
this task needs are already present and tested. The work is to *use* them for fault
observability, not to add parallel machinery.

---

## 2. Real gaps (traced to source)

### G1 — Recovery blind-replays an ambiguous delivery ⚠️ **the important one**

```
claim()               → status=running, claimedAt, attempts++
agent.followup()      → ← the instruction becomes durable HERE
markCompleted()       → status=completed, dispatchedAt   ← only now is dispatchedAt set
```

`recover()` reads:

```js
if (record.dispatchedAt != null)      → markCompleted
else if (staleSince)                  → back to pending      // ← RE-DELIVERS
```

A crash **between** `followup()` and `markCompleted()` leaves `dispatchedAt == null`, so
recovery returns the job to `pending` and the scheduler **re-delivers it**. The instruction
may already be in the durable inbox and mid-execution. `dispatchedAt` is written *after* the
side effect, so it cannot distinguish "never delivered" from "delivered, outcome unknown".

This is exactly what the brief forbids: *"不得把无法确认结果的任务直接重新投递"*.
The window is small but real, and it is the only place where the current code would
**replay a task whose result cannot be confirmed**.

*Fix direction:* persist an **intent** marker *before* the side effect
(`deliveryAttemptedAt`), so recovery can separate three cases by evidence rather than guess.

### G2 — No way to express "outcome unknown"

`JOB_STATUS = pending | running | completed | failed | cancelled`. Nothing can say
*"delivered, may have started, result unconfirmed"*. Today that case is either forced to
`completed` (a lie) or `pending` (a blind replay). The brief calls for this distinction.

### G3 — No durable fault-event store

Faults are only *logged* (`plugin.log` append, best-effort; plus the host logger). There is
no record that survives log loss, no stable de-dup id, no per-event notification state, and
nothing to retry. `write()` even swallows failures (`catch { /* best effort */ }`).

### G4 — No notification on any fault

Startup recovery logs a line; nothing reaches the user. A job that was interrupted or could
not be delivered is invisible until someone asks. `outbound.js` only reports what the *agent*
produced during a normal turn.

### G5 — Interrupted turns are not detected

`outbound.js` already receives `turn/start` and `turn/end`, but nothing persists that a turn
was open. If the process dies mid-turn, no record exists that work was in flight — so
"this job's execution was interrupted" cannot be asserted after the fact.

### G6 — Notification delivery failure is not durable

`outbound.js` catches send errors and logs them. `mattermost.js:send` retries 4 times then
throws. If Mattermost is down longer than that, the message is simply gone — and nothing
records that it was owed. The brief requires persisting the pending state and retrying.

### G7 — Job↔session inconsistency is not flagged

If a job's `sessionId` no longer exists, `ensureAgent` will `create` a fresh session and
deliver into it. Nothing reports that the job's target had to be recreated — a silent
substitution rather than a surfaced fault.

---

## 3. Mechanism reuse plan (no new storage system, no new DB)

| Need | Reuse | Not doing |
|---|---|---|
| Durable fault events | `ctx.storageDomain`, same `defineDomain`/`domainTable` pattern as `jobs.js` | a second file store, SQLite, a queue |
| Atomic state transitions | `table.update()` on the domain write chain | new locking |
| Corruption handling | `invalidRecords: 'backup-and-skip'` | bespoke try/catch |
| Notification transport | `mattermost.js:send()` (already retries + falls back) | a second HTTP path |
| Retry scheduling | the existing scheduler tick | a second timer |
| Turn boundaries | the **already-wired** `ctx.on('session/event')` | a new subscription |
| Test harness | `scheduler-test/run.sh` + probe + `restart-test.sh` | new infrastructure |

One extra domain (`mattermost_faults`) with two tables, alongside the existing
`mattermost_jobs` domain. Fault bookkeeping is deliberately kept out of the jobs table so a
fault record can never make a job unreadable.

---

## 4. Proposed changes

| File | Change | Why | Blast radius |
|---|---|---|---|
| `jobs.js` | add `deliveryAttemptedAt`; add terminal `unknown`; `markDeliveryAttempted()`; `markUnknown()`; rewrite `recover()` to use the marker | closes **G1/G2** — no blind replay, unknown is representable | one extra durable write per dispatch; recovery semantics change (deliberate) |
| `scheduler.js` | persist `deliveryAttemptedAt` before `followup()`; surface `unknown` | makes the intent durable *before* the side effect | none to happy path |
| **new** `faults.js` | durable fault events + notification queue, own domain, same pattern as `jobs.js` | closes **G3/G6** | new domain; no change to existing ones |
| `index.js` | wire fault store; record turn-open/closed from the existing event subscription; on startup raise events for recovered/orphaned/unknown; flush pending notifications when the socket connects | closes **G4/G5/G6** | additive; must not gate the transport |
| `outbound.js` | (unchanged) keep delivery as-is | avoid touching a verified module | none |
| `mattermost.js` | (unchanged) reuse `send()` retry | avoid touching a verified module | none |
| docs | README + design + this audit | reviewability | none |

Explicitly **not** changed: `mapping.js`, `markdown.js`, `agents.js`, admission order,
authorization, channel allowlist, bot-chain budget, `idleAgentTtlMs`, and every production
config value.

### Why an intent marker rather than a bigger timeout or a lock

The brief says not to fake information that cannot be obtained. The marker makes the
**decision decidable**:

```
running, no deliveryAttemptedAt          → followup never called → safe to requeue
running, deliveryAttemptedAt, no completedAt → delivery outcome UNKNOWN → never replay, notify
running + dispatchedAt/completedAt       → delivered → completed
```

Only the middle case is genuinely undecidable, and it is the only one that will refuse to
act automatically.

---

## 5. State semantics after the change

| Layer | States | Meaning |
|---|---|---|
| Job (persisted) | `pending` | durable, waiting for its time (the brief's *scheduled* and *pending* are both this state, distinguished by `executeAt` vs now) |
| | `running` | claimed; a delivery attempt may be in progress |
| | `completed` | **the instruction is durably in the session inbox** — *not* that the agent finished |
| | `unknown` | delivery was attempted but its outcome cannot be confirmed → human required, never auto-replayed |
| | `failed` | a confirmed failure (non-retryable, or attempts exhausted) |
| | `cancelled` | user cancelled before delivery |
| Fault event (persisted) | `open` → `notified` / `acked` | needs human attention; notification state tracked separately from the fault itself |
| Notification (persisted, per event) | `pending` → `sent` / `failed` | retried on reconnect; never claimed sent without a success response |

The brief's `scheduled`/`pending`/`dispatched` collapse onto the existing `pending`
(`executeAt` future vs past) and `running`/`completed`; no redundant states are added.

---

## 6. Recovery policy (what auto-recovers vs what escalates)

| Situation | Automatic? | Reason |
|---|---|---|
| Job not yet due, restart | **auto** — stays scheduled | nothing was attempted |
| Job due, never claimed/delivered | **auto** — reclaim and deliver | no side effect yet |
| Job delivered, session idle at restart | **auto** — mark `completed` | durable inbox holds it |
| Job `running`, no delivery attempt recorded | **auto** — requeue | provably nothing was sent |
| Job `running`, delivery attempted, outcome unknown | **notify only** — mark `unknown` | replaying could double-execute a side effect |
| Turn was open when the process died | **notify only** | cannot attribute a result to the job |
| Job references a session that had to be recreated | **notify** | silent substitution surfaced |
| Job record corrupt / schema-incompatible | **auto-isolate + notify** | storage layer already isolates it |
| Notification cannot be sent | **auto-retry** on reconnect | pending state is durable |

---

## 7. Tests to add

Existing suite: **T1–T22** (20 functions). Baseline result recorded *before* any change.

| # | Scenario | Maps to brief |
|---|---|---|
| T23 | unexpired job survives restart and still fires | §三.1 |
| T24 | due-but-undelivered job is recovered and delivered | §三.2 |
| T25 | delivered-but-unknown is **not** replayed; marked `unknown`; notified | §三.3 + §二.A.4 |
| T26 | repeated recovery produces **no duplicate fault events** | §三.4 |
| T27 | Mattermost unavailable → notification is **not** silently dropped | §三.5 |
| T28 | pending notification is **retried after reconnect** | §三.6 |
| T29 | corrupt job does not take other jobs down | §三.7 |
| T30 | busy agent still defers (regression) | §三.8 |
| T31 | authz / channel allowlist / bot-chain / session isolation unchanged (regression) | §三.9 |
| T32 | double init + close leaves no duplicate scheduler, timer or listener | §三.10 |

Failure injection only: simulated crashes by killing the harness mid-flight, direct record
edits followed by a real restart, and the existing `wssuspend`/`wsresume` hooks. No real
production task is used to test duplicate delivery.

---

## 8. Known limits (documented, not papered over)

1. **The plugin cannot report a fully dead process.** It runs inside `dsh web`; if the process
   dies, the plugin cannot send anything. Detecting that needs systemd/journal-level
   monitoring, which the brief explicitly excludes from this task.
2. **Exactly-once is not claimed and will not be.** The residual window is a crash after
   `followup()` succeeded and before completion is persisted. It is *detected* (→ `unknown`)
   but its execution outcome is genuinely unknowable from inside the plugin.
3. **A crash between the marker write and `followup()`** would mark a job `unknown` when
   nothing was actually delivered. This errs toward "ask the human", never toward replay.
4. **Turn-level attribution is approximate.** An interrupted turn is attributed to jobs
   delivered to that session during that window; if several jobs were delivered, all are
   flagged rather than guessing which one ran.
