# Durable Delayed Jobs — Implementation Report

Repository: `dsh-mattermost`
Baseline: `61608a8` (docs: add MIT license)
Feature head: see §21
Production tag: `v0.1.0-production` → `7bd2ad4d486725e95956f5225b7c9c74f2ffd8b2` (**unmoved**)

---

## 1. Executive Summary

A delayed task expressed as `sleep 3600` inside an agent dies with that agent. Production
demonstrated it: a job due at 11:01 was reclaimed at 10:32 when the plugin's 30-minute idle
eviction disposed the agent, and `dispose()` reclaimed the agent's subprocesses with it.

This work gives delayed work a lifetime independent of the live agent. A new durable job
store (`jobs.js`), a scheduler (`scheduler.js`) and three agent tools (`tools.js`) were added
to the plugin. Jobs are persisted in a zod-validated, atomic, fsynced domain over
`ctx.storageDomain`; at due time the scheduler resumes the target session and hands the
instruction to its durable inbox.

**Result:** 49/49 acceptance assertions pass, including a faithful replay of the original
incident (agent evicted at T+65s, job still executed at T+105s) and a process-restart replay.
Due-scan cost is flat from 100 to 1060 jobs (27 ms → 31 ms). No production configuration was
changed.

**Core claim, verified:** *an agent may die; a job must not die with it.*

---

## 2. Root Cause of the Original Delayed-Task Failure

Reconstructed from the production plugin log and the Mattermost DM transcript:

```
10:00:42  inbound   user: "…一个小时后再帮我看看"
10:02:40  replied   agent creates delayed job `bash-46` = `sleep 3600` (due ≈ 11:01)
10:32:16  evicted   idle agent session=mm-24ccd993c65b8e4c idleMs=1800007
11:38:58  inbound   user: "一个小时了噢" -> job_list empty, process gone
```

The eviction fired **29 minutes before the job was due**.

Mechanism, from source:

1. `agents.js:sweep()` disposes any non-running agent idle past `idleAgentTtlMs` (1800000 ms).
2. `dsh-agent-loop` disposal runs `machine.cancel({kind:"disposed"})` → `machine.scope.dispose()`.
3. Scope teardown reclaims the executor's processes. `dsh-bash-local` states it directly:
   *"a still-running background process stays managed (killed and joined at composition
   teardown)"*.

**This is a lifetime mismatch, not a scheduler defect and not a core bug.** The task needed 59
minutes of survival; the container offered 30. Core's reclamation of a disposed agent's
subprocesses is deliberate.

An **independent second interrupter** was also confirmed:
`/etc/systemd/system/dsh-web-restart.timer` → `OnCalendar=*-*-* 04:00:00` →
`systemctl restart dsh-web` restarts the whole host daily at 04:00 UTC, terminating every live
agent at once. `NRestarts=0` does **not** contradict this — systemd counts only failed
auto-restarts, not an external `systemctl restart`. The previous write-up used that value to
argue "the service did not restart"; that inference was wrong (and, for this incident,
irrelevant — the restart preceded job creation by six hours).

---

## 3. Existing Architecture

`dsh-mattermost` maps a Mattermost conversation to a DSH session
(`dm:<ch>` / `ch:<ch>` / `th:<root>`) and drives an **in-process** live agent:

```
Mattermost WS ──► handlePost (admission order) ──► agents.ensureAgent ──► agent.followup
                                                              │
                                            ctx.agents.get → resume → create
                                                              │
       Mattermost ◄── outbound.onSessionEvent ◄── session/event (turn/end)
```

Admission order is preserved unchanged: system/deleted → own-post → channel allowlist →
**authorization before any state creation** → trigger → bot-chain budget → commands.

The live agent is evictable by design (`sweep()`); the session is durable. The gap was that
nothing owned work whose lifetime exceeded the agent's.

---

## 4. Final Scheduler Architecture

```
agent calls schedule_job
        │
        ▼
┌───────────────────────┐
│ jobs.js               │  ctx.storageDomain (durable, atomic, zod, per-record)
│  mattermost_jobs/jobs │
└───────────┬───────────┘
            │ scheduler.js  (5 s tick, unref'd, in-process)
            │ claim → dispatch
            ▼
     ensureAgent(sessionId)          ← the wake core's `schedule` lacks
            │  live reuse → resume → create
            ▼
     agent.followup(message)         ← durable session inbox
            │
            ▼
       outbound.js ──► Mattermost
```

Audit findings that determined this shape:

| Finding | Consequence |
|---|---|
| `dsh-schedule` exists ("durable after/at/every reminders") | near-miss, not used |
| — its tool text: *"session-local … becomes overdue until the session is resumed"* | it cannot execute out-of-session |
| — `activeReminders()` gates on `ctx.agents.get()` | needs a live agent; keyed by agent object |
| — it exposes **no** service (`ctx.provide`) | a plugin cannot drive or enumerate it |
| — absent from `dsh-base`, `dsh-web-app` and every preset | enabling it means editing the production profile |
| `dsh-agent-loop` inbox is **durable**, and rejects duplicate pending ids | delivery is durable; enables idempotent re-dispatch |
| `ctx.jobs` (job registry) is memory-only | unusable for durability |
| `dsh-storage-domain` + `dsh-storage-json` are enabled in base | reused for persistence |

Core therefore already solves **durability** and deliberately omits **out-of-session
execution**. Supplying that half is this work; the storage and delivery halves are reused, not
reinvented.

---

## 5. Job Data Model

One record per job in the `jobs` table of the `mattermost_jobs` domain, validated by zod at
every durable read and write:

```
id           job-<16 hex>          (also a per-record path segment)
type         reminder | agent_followup
status       pending | running | completed | failed | cancelled
executeAt    epoch ms UTC
createdAt / updatedAt / dispatchedAt / completedAt / claimedAt
sessionId    target durable session
channelId    delivery target, captured at creation
rootId       thread root, or null
createdBy    Mattermost user id (authorization owner)
message      the action text (data — never executed by the scheduler)
attempts / maxAttempts
claimId      execution identity of the current lease
lastError / cancelledBy
```

Identifiers only: no token, no credential, no session content.

## 6. State Machine

```
pending ──cancel──► cancelled (terminal)
   │ due + atomic claim
   ▼
running ──followup ok──► completed (terminal)
   │
   └──dispatch threw──► pending (retry, bounded) ──cap──► failed (terminal)
```

`completed` means *the instruction is durably in the session inbox*, not *the agent's work
finished*; the reply arrives via the normal conversation path.

> **Design change made during implementation.** The original design had
> `running → dispatched → completed`. Implementation showed nothing ever performs the second
> transition — handing the message to `followup()` *is* the success condition. An
> intermediate state nothing settles made "is this job done?" unanswerable and parked every
> successful job forever. The state was removed and `SCHEDULER-DESIGN.md` §8 updated to
> record why.

## 7. Persistence Strategy

`ctx.storageDomain.open(spec)` — the domain layer over `dsh-storage-json`:

* publish protocol is temp file → `fsync` → `rename` → parent-dir `fsync`: atomic and
  crash-durable;
* `layout: 'per-record'` — one document per job, so a write rewrites ~1 record;
* `invalidRecords: 'backup-and-skip'` — an unreadable document is moved aside and the unit
  still opens;
* `table.update()` is an atomic read-modify-write on the domain's single write chain;
* the store **refuses to open** without a durable backend. There is no memory-only fallback.

**Observed in practice.** When the `dispatched` status was removed mid-implementation, the 14
records holding it became schema-invalid. On restart the domain moved all 14 aside to
`job-*.json.bak.<stamp>` and opened successfully with the 16 valid records
(`scheduler-test/evidence/t15_backup_and_skip.txt`). Real schema evolution, zero data loss,
no unit failure — this is stronger evidence than the synthetic corruption test.

## 8. Recovery Strategy

On startup, before the first tick:

| Persisted state | Action | Why |
|---|---|---|
| `running` + `dispatchedAt` set | → `completed` | the instruction is already committed to the durable inbox and **will** run; re-dispatching would duplicate it |
| `running` + no `dispatchedAt` + lease stale | → `pending` | delivery state ambiguous; safe to re-dispatch because the message id is deterministic |
| `running` + no `dispatchedAt` + lease fresh | left alone | another dispatch may still be in flight |

After recovery, the first tick runs immediately so already-overdue work does not wait a tick.

## 9. Duplicate Protection

1. **Atomic claim** — `table.update()` transitions `pending → running` and stamps
   `claimId`/`claimedAt`; two ticks cannot both claim.
2. **Lease** — `jobLeaseMs` (5 min) bounds an orphaned claim.
3. **Completion only after durable delivery** — persisted after `followup()` resolves.
4. **Deterministic message id** — `id = 'mmjob-' + jobId`. The inbox projection rejects a
   duplicate pending id (`message "…" is already pending`), so the recovery re-dispatch is
   idempotent while the original is still pending. (`createUserMessage` overwrites `id` with a
   fresh UUID, so the id is applied after construction; the inbox validates inserted messages
   with `z.custom()`, so no shape check rejects it.)
5. **Bounded attempts** — `maxAttempts` (3) prevents a poison job becoming a loop.

**Guarantee, stated precisely: at-least-once.** The residual duplicate window is a crash
landing between `followup()` resolving and the completion record becoming durable *while* the
original inbox entry has already been consumed. It is sub-millisecond and requires a crash at
that exact instant. At-least-once is chosen deliberately: for a user-requested check, a
duplicate is a minor annoyance while a silent loss is a failure. Delivered text carries the
job id, so a rare duplicate is self-identifying.

## 10. Session Recovery

Resolution order is the plugin's existing, already-tested `agents.js` path, reused unchanged:

1. `ctx.agents.get(sessionId)` → reuse the **live** agent (never a second one);
2. else `sessionQuery.observeSession(sessionId)` → exists → `ctx.agents.resume()`;
3. else `ctx.agents.create()`.

`observeSession()` remains an **existence probe only**; it is never used to "recover" an agent.
Single-flight creation is inherited.

## 11. Idle Eviction Behaviour

Verified by replaying the incident with a shortened TTL (60 s), raw log:

```
16:06:46  evicted idle agent session=mm-2325bb0b74214a7f idleMs=65641
16:07:38  agent ready session=mm-2325bb0b74214a7f
16:07:38  job dispatched id=job-87614841873e31e6 type=reminder
```

The agent was evicted and the job still executed — the scheduler resumed the session. Job
record: `status=completed`, `attempts=1`, `dispatchedAt` set.

## 12. dsh-web Restart Behaviour

`T7/T18` schedules a job, restarts the harness, and confirms the job is still `pending` after
restart, that startup recovery runs, and that the job executes when due. This is the same
mechanism that protects the daily 04:00 restart. `T9B` additionally restarts with a job stuck
in an orphaned `running` claim and confirms it is requeued rather than lost or fired twice.

## 13. Mattermost Disconnect Behaviour

`T10` suspends the transport, lets a job come due, and confirms the job dispatches while
offline; the transport is then resumed successfully. Job state tracks *dispatch*, never socket
health. The reply is delivered by the pre-existing `outbound.js` path, which already performs
bounded retry on transient transport errors and falls back to a channel post when a thread
root is rejected (HTTP 400).

## 14. Security Model

* **No secrets in jobs.** `channelId`/`rootId`/`sessionId` are identifiers. The Mattermost
  token is never read, copied or logged by the scheduler.
* **No arbitrary execution.** `message` is delivered to the agent as user text, at the same
  trust level as a Mattermost message from an authorized user. It never reaches a shell,
  `systemd` or `exec`.
* **No new authorization surface.** Jobs can only be created from a session that a Mattermost
  message already authorized (unauthorized posts never mint a session, so they can never mint
  a job), and only for a session the plugin maps to a Mattermost target. `cancel`/`list` are
  fenced to the calling session. `allowedUsers` semantics are untouched.
* **Bot chain.** The scheduler does not post to Mattermost, so it cannot inflate the chain;
  `agent_followup` replies travel the existing inbound path and remain subject to
  `botChainMax`.
* **Validation.** zod at the durable boundary; job ids constrained to `[a-zA-Z0-9_-]+`, which
  also removes any path-traversal surface.

## 15. Test Matrix

Harness: `DSH_HOME=/home/dsh/.dsh-mmt-test`, profile `mmt-test`, probe `127.0.0.1:3091`.
Production was never touched.

| # | Test | Result |
|---|---|---|
| T1 | create job | PASS |
| T2 | executes at due time | PASS |
| T3 | cancel (never fires) | PASS |
| T4 | list / record shape | PASS |
| T5 | live agent reused, `sameObject` | PASS |
| T6/T17 | **survives idle eviction (incident replay)** | PASS |
| T7/T18 | **survives process restart** | PASS |
| T8 | 5 jobs / 2 sessions, isolation, independent dispatch | PASS |
| T9 | duplicate protection (delivered + crash window) | PASS |
| T10 | executes while Mattermost disconnected | PASS |
| T11 | busy session → followup, never steer | PASS (see caveat) |
| T12 | session with no live agent → resume | PASS |
| T13 | cross-session cancel/list refused | PASS |
| T14 | bot-chain unchanged | PASS |
| T15 | corruption / partial write / **schema change** | PASS |
| T16 | offline backlog drained in bounded batches | PASS |

**Totals:** 42/42 (`run_full.log`), 7/7 eviction replay (`run_eviction.log`), 49 assertions,
0 failures, 0 skips.

**Honest caveat on T11.** The assertion that the scheduler never steers is structural — the
dispatch path contains no `steer` call at all — and dispatch into a session mid-turn was
observed. But the *precondition* (agent `running` at the instant the job lands) was not
reliably established in the automated run; one run showed `before=idle`. The test therefore
proves "the scheduler uses followup", not "followup was exercised against a genuinely busy
agent". Treat the busy-agent queueing semantics as inherited from the already-verified
`handlePost` path rather than freshly proven here.

## 16. Test Results — Evidence Files

```
scheduler-test/evidence/
  run_full.log                42/42 assertions
  run_eviction.log             7/7  incident replay, real eviction
  t6_eviction_evidence.txt     raw eviction → resume → dispatch log lines
  t15_backup_and_skip.txt      14 schema-invalid records moved aside, unit opened
  run_perf.log                 performance table
  perf_table.txt / perf_startup.txt
  summary.txt
```

## 17. Performance Results

| batch | create | list | due-scan (tick) | RSS | disk | total jobs |
|---|---:|---:|---:|---:|---:|---:|
| +100 | 8,594 ms | 51 ms | 27 ms | 312.4 MB | 408 KB | 100 |
| +500 | 39,505 ms | 47 ms | 43 ms | 316.2 MB | 2,092 KB | 515 |
| +1000 | 51,108 ms | 58 ms | 31 ms | 316.8 MB | 4,304 KB | 1,060 |

* **Create** ≈ 51 ms/job — one fsynced durable write plus an HTTP round trip. This is
  per-job latency (deliberately measured sequentially), not throughput.
* **List and due-scan are flat**: 47–58 ms and 27–43 ms from 100 to 1060 jobs. The domain
  holds an in-memory projection, so the tick reads memory and never scans the filesystem.
* **Memory** ≈ +4.2 KB per job marginal; **disk** ≈ 4.1 KB per job.
* **Startup** store-open + recovery = **1,481 ms for 1,060 jobs** (~1.4 ms/job); the
  transport is up 25 ms after the scheduler.

**Verdict: no optimisation needed and none attempted.** JSON-domain storage is comfortably
adequate at this scale; SQLite would be premature.

## 18. Production Verification

* Production was never edited in place: all work happened in an isolated clone
  (`/home/dsh/workspace/DSH/dsh-mattermost-sched`), because the production profile loads the
  plugin **directly** from `dsh-mattermost-prod` (`profiles/web/node_modules/dsh-mattermost →
  …/dsh-mattermost-prod`) with `patchReload: live`.
* Integration is a fast-forward of tested commits, preceded by a snapshot (§20).
* No production config, profile, credential, systemd unit or the legacy bridge was modified.
* `idleAgentTtlMs` was **not** changed; the fix does not depend on it.
* The test harness's plugin symlink was repointed to the clone for testing (its original
  target is recorded in §20) — this affects only the isolated harness.

## 19. Known Limitations

1. **At-least-once**, with the sub-millisecond duplicate window described in §9.
2. `completed` means delivered, not finished; there is no tracking of the agent's work.
3. Not a cron: no recurring jobs, no cron syntax, no calendar UI.
4. Single host, single process, single writer; not distributed.
5. Jobs only run while the host runs — a powered-off machine executes nothing until it returns
   (then catch-up applies).
6. Only sessions the plugin maps to a Mattermost target can schedule deliverable work.
7. The scheduler shares `dsh-web`'s fault domain, as the whole plugin does.
8. Busy-agent queueing is inherited from the existing path, not freshly stress-tested (§15).
9. `maxDispatchPerTick` bounds a backlog per tick; a very large backlog drains over several
   ticks rather than instantly (by design).

## 20. Rollback Procedure

Rollback is a plain revert; the feature is additive and inert until a job is created.

```bash
# 1. Snapshot taken before integration (production config + plugin source list)
ls -la /home/dsh/.dsh/sched-snapshot-<stamp>/

# 2. Revert the feature commits in the production repo
cd /home/dsh/workspace/DSH/dsh-mattermost-prod
git revert --no-edit <feature-head>..<baseline>     # or: git reset --hard 61608a8
systemctl restart dsh-web                            # requires explicit approval

# 3. Discard pending jobs (optional; records are inert JSON)
rm -rf /home/dsh/.dsh/storages/mattermost_jobs
```

The legacy `mattermost-dsh-bridge` unit is left `inactive` and **enabled** as a rollback asset;
it was not touched.

## 21. Git Commits

In the working clone, ready to fast-forward into `dsh-mattermost-prod`:

```
a6f93c3  docs: document scheduler architecture
f427305  feat: add durable job store
de2eea5  feat: add scheduler loop, recovery and agent tools
21bb460  test: add scheduler acceptance suite
377513b  docs: document delayed jobs and correct the incident write-up
```

Baseline remains `61608a8`; `v0.1.0-production` remains
`7bd2ad4d486725e95956f5225b7c9c74f2ffd8b2`. No force push, no tag movement.

Also corrected outside this repository (a plain directory, not a git repo):
`mattermost-mcp/ISSUE-attachment-support.md` §8 — the claim that the delayed-task loss was a
suspected DSH-core/harness defect was withdrawn and replaced with the verified lifetime
mismatch, plus the 04:00 restart finding and the `NRestarts=0` caveat.

## 22. Recommended Future Work

1. **Surface jobs in the GUI.** The core `ui-schedule` client plugin is present; a jobs view
   would make durable jobs visible where sessions already are.
2. **Push a completion notice.** Today a job's outcome appears only as the agent's reply. An
   explicit "job X delivered" note (or a failure notice after `maxAttempts`) would close the
   loop on silent failures.
3. **Recurring jobs.** Only if a real need appears; deliberately out of scope.
4. **Own the 04:00 restart decision.** The daily timer is an accepted operational choice, but
   it should be a documented one, and its interruption of live agents recorded in the runbook.
5. **Reconsider core `dsh-schedule` integration** if it ever exposes a service and an
   out-of-session delivery mode — this plugin's wake driver could then be retired.
6. **Stress the busy-agent path** with a deterministic busy precondition (§15 caveat).
7. **Consolidate the persisted dedup set.** `mattermost.js` keeps a 5,000-entry seen-set for
   backfill; a durable, bounded alternative would survive restarts.
