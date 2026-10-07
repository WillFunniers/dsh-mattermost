# Durable Delayed Jobs — Architecture Design

Status: **design, pre-implementation**
Scope: `dsh-mattermost` (Mattermost ⇄ DSH integration)
Deliverable of the audit + design phase. Implementation follows this document.

---

## 1. Problem

A user asks DSH, through Mattermost:

> "一个小时后帮我看看现在的任务有没有完成。"

The agent's natural implementation is `sleep 3600` (a **background bash job**). That job
lives inside the live agent's process scope, so it dies with the agent.

### 1.1 Observed production incident (2026-09-28)

Reconstructed from `$DSH_HOME/mattermost/plugin.log` (production) and the Mattermost
DM transcript:

```
10:00:42  inbound   user: "目前有在进行的任务对不？一个小时后再帮我看看"
10:02:40  replied   agent answers and creates delayed job `bash-46` = `sleep 3600`
                    (due ≈ 11:01 UTC)
────────────────────────────────────────────────────────────────
10:32:16  evicted   idle agent session=mm-<session-a> idleMs=1800007
────────────────────────────────────────────────────────────────
11:38:58  inbound   user: "一个小时了噢" -> session wakes, job_list empty,
                    `sleep 3600` process gone
```

The eviction fired **29 minutes before the job was due**. The task needed 59 minutes of
survival; the container allowed 30.

### 1.2 Why the job died (mechanism, verified in source)

1. `dsh-mattermost` config `idleAgentTtlMs = 1800000` (30 min).
   `agents.js:sweep()` disposes any agent idle past the TTL that is not `running`.
2. `handle.dispose()` → `@deepseek-ai/dsh-agent-loop`: `machine.cancel({kind:"disposed"})`,
   `machine.scope.dispose()`.
3. Scope teardown reclaims the executor's subprocesses.
   `@deepseek-ai/dsh-bash-local` states it directly:

   > "a still-running background process stays managed (**killed and joined at
   > composition teardown**) even across an executor reload."

So `sleep 3600` was not "lost" — it was **reclaimed by design**. This is a
**lifetime mismatch**, not a scheduler bug: the task needed 59 minutes, the container
offered 30.

### 1.3 A second, independent interrupter

`/etc/systemd/system/dsh-web-restart.timer` → `OnCalendar=*-*-* 04:00:00` →
`systemctl restart dsh-web`. **Every day at 04:00 UTC the whole process restarts**, killing
every live agent in it. Session state is durable and the plugin runs `backfill` on
reconnect, so this is usually invisible — but any background job crossing 04:00 dies too.

`NRestarts=0` does **not** contradict this: systemd counts only failed auto-restarts, not
an external `systemctl restart`.

**Conclusion.** Correctness cannot rest on a live agent. The delayed task must be owned by
something whose lifetime is independent of the agent.

---

## 2. Audit: what DSH core already provides

Audited against DSH `0.1.7-rc.1` at
`/opt/node-v24.20.0/lib/node_modules/@deepseek-ai/dsh/`.

| Capability | Exists | Package | Durable | Reusable by a plugin |
|---|---|---|---|---|
| Durable scheduling / reminders | **yes, but not enabled** | `@deepseek-ai/dsh-schedule` | yes (session event log) | **no — see §2.2** |
| Durable KV storage hub | yes | `@deepseek-ai/dsh-storage` (`ctx.storage`) | — | yes |
| Atomic, fsync'd JSON backend | yes | `@deepseek-ai/dsh-storage-json` | yes | yes (via domain) |
| Schema-validated KV domain | yes | `@deepseek-ai/dsh-storage-domain` (`ctx.storageDomain`) | yes | **yes — chosen** |
| Background job registry | yes, **memory-only** | `dsh-api-job-controller` (`ctx.jobs`) | **no** | no (not durable) |
| Agent tool registration | yes | `@deepseek-ai/dsh-tools` (`ctx.tools.register` + `defineTool`) | — | **yes — chosen** |
| Live agent get/create/resume | yes | `@deepseek-ai/dsh-agent` (`ctx.agents`) | — | yes (already used) |
| Session existence probe | yes | `ctx.sessionQuery.observeSession` | — | yes (already used) |
| Durable agent inbox | yes | `dsh-agent-loop` | **yes** | **yes — chosen for delivery** |
| Process timer | yes | `@deepseek-ai/cordis-plugin-timer` | **no** | no |

### 2.1 The durable inbox (a load-bearing discovery)

`agent.followup(msg)` is **not** an in-memory queue:

```
followup(input)            -> send(input, "next-turn", true)
send(...)                  -> this.inbox.splice(target, Infinity, 0, [message])
inbox.splice(...)          -> this.session.append("agent/inbox/spliced", splice)
```

`inbox.splice` appends a **durable session event**, and the projection definition
reconstructs pending input from the durable log. The splice validator also rejects a
duplicate id:

> `if (ids.has(message.id)) throw new Error(\`message "${message.id}" is already pending\`)`

Two consequences used by this design:

* **Delivery is durable for an IDLE agent.** When the target is idle, the spliced message is
  claimed and processed immediately, so the work happens and cannot be orphaned.
* **A caller-pinned message id gives inbox-level duplicate rejection.** Note
  `createMessage()` overwrites `id` with a fresh `randomUUID()`, and the inbox projection
  validates inserted messages with `z.custom()` (no shape check). A message may therefore
  be constructed with a deterministic id:
  `{ ...createUserMessage({...}), id: 'mmjob-<jobId>' }`.

> **CORRECTION (2026-09-29, found while answering a production review question).** An earlier
> revision of this design claimed that *"once `followup()` resolves, the instruction is
> committed to the session log and will be processed when the session next runs — even if the
> process dies immediately afterwards."* **That is wrong for a BUSY agent.**
>
> Verified by experiment: a message spliced into a running agent is **claimed into the
> in-flight turn immediately** (the durable log shows `agent/inbox/spliced` with
> `removed=1`), and a claimed message is **removed from the durable pending projection**. If
> the process restarts before that turn ends, the instruction is never replayed — it remains
> in the log as history but does not run — while the job still reads `completed`. That is a
> silent loss: precisely the class of failure this feature exists to eliminate.
>
> **Consequence:** the scheduler must **never hand work to a running agent**. A busy target is
> *deferred* — the job returns to `pending` and is retried on a later tick — so an instruction
> is only ever delivered to an idle agent, where it is claimed and executed in the same
> breath. See §13 and the `defer()` transition in §16.

### 2.2 Why core `schedule` is not used

`@deepseek-ai/dsh-schedule` ("Agent-scoped durable after, at, and fixed-rate reminders over
the session event log") is a near-miss, and the reason it misses is decisive:

* Its own `schedule_create` tool description states:
  > "Delivery is **session-local**: the reminder runs on time **only while this session is
  > live** and otherwise becomes **overdue until the session is resumed**."
* `activeReminders(sessionId)` gates on `ctx.agents.get(sessionId)`; the runtime map is
  keyed by the **live agent object**. Without a live agent there is no runtime.
* It exposes **no service** — no `ctx.provide`. It registers tools and a session projection
  only, so another plugin cannot enumerate, cancel, or drive reminders.
* It is **not enabled**: `dsh-base`, `dsh-web-app` and every preset contain no insertion for
  `@deepseek-ai/dsh-schedule` (only the *client* UI `ui-schedule`). Enabling it would require
  editing the production profile — out of scope for this task.

Core therefore already solves the **durability** half and deliberately omits the
**out-of-session execution** half. Supplying that half *is* this task:

> The reminder must fire at its due time even though the session has no live agent.

Because core's `schedule` cannot execute out-of-session, and cannot be driven by a plugin,
building the job store in `dsh-mattermost` is **not** reinvention — but the storage and
delivery halves **are** reused rather than reimplemented (§4).

---

## 3. Three lifecycles

The design turns on separating three lifetimes that today are conflated.

### 3.1 Durable Session — long-lived
Owns: session id, workspace/cwd, conversation history, agent inbox, the Mattermost
mapping. Survives eviction, restart, machine reboot. **This is the only thing that must
never be lost.**

### 3.2 Live Agent — ephemeral
Owns: the running agent object, the model loop, subprocesses, in-memory tool state.
**Explicitly disposable** — idle eviction, `dsh-web` restart, `dispose()`, `/new`.
Never used as storage.

### 3.3 Durable Job — new, independent
Owns: `executeAt`, target session, action, payload, status, attempts, execution identity.
Lifetime is **independent of the live agent**. A job outlives any number of agent
evictions and process restarts.

The invariant this design establishes:

```
Agent 可以死，Job 不能跟着死
dsh-web 可以重启，未完成 Job 不能跟着消失
Mattermost 可以断线，Job 不能因此丢失
同一个 Job 只能完成一次逻辑执行
```

---

## 4. Architecture

```
Mattermost ──► dsh-mattermost plugin
                    │
                    │ agent calls schedule_job / list_jobs / cancel_job
                    ▼
              ┌───────────────┐
              │  Job store    │  ctx.storageDomain  (durable, atomic, zod-validated)
              │  jobs.json…   │  one document per job (per-record layout)
              └───────┬───────┘
                      │ scheduler loop (in-process, 5s tick, unref'd)
                      │ claim → lease → dispatch
                      ▼
              ┌───────────────┐
              │  ensureAgent  │  live reuse → resume → create   (existing agents.js)
              └───────┬───────┘
                      │ agent.followup(message)   ← durable session inbox
                      ▼
              outbound.js ──► Mattermost channel / thread
```

Reconciliation with the models in play:

| Model | Lifetime | Storage | Killed by eviction/restart |
|---|---|---|---|
| Durable Session | forever | session log (jsonl) | no |
| Live Agent | minutes | process memory | **yes** |
| Durable Job | until executed | storage-domain | **no** |

The scheduler is the only component that spans the boundary: it reads durable jobs and
drives ephemeral agents.

---

## 5. Goals

* **Durable delayed execution** — a job scheduled for T executes at/after T.
* **Restart survival** — jobs survive `dsh-web` restart, including the 04:00 timer.
* **Idle-eviction survival** — jobs survive `agent.dispose()`.
* **Agent-independent lifetime** — job existence never depends on a live agent.
* **Session recovery** — at due time, resume or create the target session's live agent.
* **Duplicate protection** — one logical execution per job across restart/retry.
* **Failure recovery** — retryable vs non-retryable, bounded attempts.
* **Cancellation and listing** — `cancel_job`, `list_jobs`.
* **Zero production regression** — no change to `allowedUsers`, `botChainMax`,
  `idleAgentTtlMs`, `backfill`, mapping, or any profile/systemd config.

## 6. Non-goals

* Not a general cron / calendar system.
* Not a system-level job scheduler, and not a replacement for `systemd`.
* Not distributed — single host, single process, single writer.
* No recurring jobs, no cron syntax, no calendar UI, no buttons, no attachments UI.
* No change to `idleAgentTtlMs` (the task is decoupling, not TTL tuning).
* No second persistence stack: reuse `ctx.storageDomain`.
* Not a general-purpose agent tool: jobs target an existing Mattermost-mapped session.

---

## 7. Job data model

One record per job in the `jobs` table of the `mattermost_jobs` domain.

```
key   = job id, `job-<16 hex>`  (must match /^[a-zA-Z0-9_-]+$/ for per-record layout)
value = z.object({
  id           string          // == key
  type         'reminder' | 'agent_followup'
  status       see §8
  executeAt    number          // epoch ms, UTC
  createdAt    number
  updatedAt    number
  sessionId    string          // target durable session, e.g. mm-…
  channelId    string          // delivery target, resolved at creation (never a secret)
  rootId       string | null   // thread root for the reply, when applicable
  createdBy    string          // Mattermost user id — authorization owner
  message      string          // action payload (reminder text / followup instruction)
  attempts     number
  maxAttempts  number
  claimId      string | null   // execution identity of the current lease
  claimedAt    number | null
  dispatchedAt number | null   // set once handed to the durable inbox
  lastError    string | null
  completedAt  number | null
  cancelledBy  string | null
})
```

Notes.

* `channelId`/`rootId` are stored **in the job**, not read from the in-memory `targets`
  map, so delivery never depends on the process having seen the session. They are
  identifiers, not credentials.
* `message` is the user's own instruction. It is **data**, never executed as a shell
  command by the scheduler; it is delivered to the agent exactly like a normal Mattermost
  message, and therefore inherits every existing admission control.
* No token, no credential, and no secret is ever written to a job (enforced by test).

## 8. State machine

```
                 schedule_job
                      │
                      ▼
                 ┌─────────┐   cancel_job    ┌───────────┐
                 │ pending │ ──────────────► │ cancelled │ (terminal)
                 └────┬────┘                 └───────────┘
                      │ due + claim
                      ▼
                 ┌─────────┐
                 │ running │  claimId leased, claimedAt set
                 └────┬────┘
       followup ok    │   │  dispatch threw
        ┌─────────────┘   └──────────────┐
        ▼                                ▼
  ┌───────────┐               attempts < maxAttempts
  │ completed │  (terminal)        │            │
  └───────────┘                    ▼            ▼
   handed to the              ┌─────────┐   ┌────────┐
   durable inbox              │ pending │   │ failed │ (terminal)
                              │ (retry) │   └────────┘
                              └─────────┘
```

Transitions are applied with `table.update(key, fn)`, which is an **atomic
read-modify-write on the domain's write chain** — concurrent transitions cannot interleave.

`completed` means *"the instruction is durably in the session inbox"*, not *"the agent has
finished the work"*. The agent's answer arrives through the pre-existing `outbound.js`
path, exactly like any other message. This is deliberate: the DSH turn that the job
triggers may run for an hour, and the scheduler must not block on it (§12).

> **Why there is no `dispatched` state.** An earlier revision of this design had
> `running → dispatched → completed`. Implementation showed that nothing ever performs the
> second transition: handing the message to `agent.followup()` *is* the success condition,
> because the inbox commit is durable. An intermediate state that nothing settles makes
> "is this job done?" unanswerable and would have left every successful job parked
> forever. `completed` is therefore the single terminal success state, and `dispatchedAt`
> is retained as a field for observability.

## 9. Persistence strategy

**Chosen: `ctx.storageDomain.open(spec)`** — the domain layer over `dsh-storage-json`.

Rationale against the priority list in the brief (`existing durable storage > SQLite >
atomic JSON > other`):

* It **is** existing durable storage — option 1.
* `dsh-storage-json` publishes with: write same-directory temp file → `fsync` file →
  `rename()` over the target → `fsync` the parent directory. That is crash-durable on
  POSIX, i.e. the exact protocol the brief demands, already implemented and tested.
* The domain layer gives zod validation **at the durable boundary**, so a corrupted record
  is rejected on open rather than surfacing as `undefined` deep in the scheduler.
* `layout: 'per-record'` stores each job in its own document. 1000 jobs are 1000 small
  documents; a single write rewrites ~1 record, not the whole set.
* `invalidRecords: 'backup-and-skip'` moves an unparseable record aside via
  `KvUnit.backupRecord()` and continues, instead of failing the whole unit. This is the
  corruption-recovery policy for T15.
* No new dependency: `dsh-mattermost` already imports `@deepseek-ai/*` internals
  (`schemastery`, `dsh-llm`, `dsh-agent`), and `storage`/`storage-domain` are already
  enabled in the base profile.

Spec sketch:

```js
const spec = defineDomain({
  name: 'mattermost_jobs',
  version: 1,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  global: { schema: z.object({ version: z.literal(1) }), initial: { version: 1 } },
  tables: { jobs: domainTable(jobSchema) },
})
const domain = await ctx.storageDomain.open(spec)
const jobs = domain.table('jobs')
```

Fallback: if `ctx.storageDomain` is unavailable at runtime, the scheduler **does not
start** and logs a warning — it never silently degrades to a memory-only queue.

Explicitly rejected: `Map()`/`setTimeout()` as the store; `ctx.jobs` (memory-only);
hand-rolled `writeFileSync(jobs.json)` over the whole set.

## 10. Duplicate protection

The failure the design must survive:

```
job due → scheduler claims → dispatch → crash → restart → scheduler sees job again
```

Mechanism, in order:

1. **Atomic claim.** `update(id, j => j.status === 'pending' && j.executeAt <= now
   ? { ...j, status:'running', claimId: randomUUID(), claimedAt: now, attempts: j.attempts+1 }
   : j)` — the transform runs on the write chain, so two ticks cannot both claim.
2. **Lease.** A claim is valid for `leaseMs` (default 5 min). On startup, a `running` job
   whose `claimedAt` is older than the lease is *orphaned* and returns to the recovery path.
3. **Durable delivery marker.** Right after `followup()` resolves, persist
   `status:'completed'`, `dispatchedAt`. Because the inbox is durable (§2.1), a job that
   reached `completed` **must not be re-dispatched**: the instruction is already committed
   to the session log and will run.
4. **Deterministic message id.** The followup message carries
   `id = 'mmjob-' + jobId` instead of a random UUID. If a crash occurred between
   `followup()` and the completion write, recovery re-dispatches with the **same** id;
   while the original is still pending the inbox projection rejects it as
   `message "…" is already pending`, which recovery treats as **success** (already
   delivered). This closes the common duplicate path.
5. **Bounded attempts.** `maxAttempts` (default 3) stops a poison job from looping.

**Guarantee, stated precisely.** Delivery is **at-least-once**, with a duplicate window
confined to a crash landing between `followup()` resolving and the `dispatched` record
becoming durable *and* the original inbox message having already been consumed. That window
is sub-millisecond and requires a crash at that exact instant. Steps 3–4 make the
overwhelming majority of crash points exactly-once. The design prefers at-least-once
because for a user-requested check, **a duplicate is a minor annoyance while a silent
loss is a failure**. This residual window is documented as a known limitation (§19 of the
implementation report), not hidden.

Compensating control for `agent_followup`: the delivered text is prefixed with a stable
marker carrying the job id, so a rare duplicate is self-identifying to the user and to the
agent.

## 11. Expired jobs (downtime catch-up)

```
executeAt = 10:00, dsh-web crashed at 10:00, restarted 11:30
```

Policy: **catch-up execution**, bounded.

* A `pending` job with `executeAt <= now` is due immediately on startup.
* To avoid a thundering herd after a long outage, due jobs are dispatched through the
  normal per-tick claim with a **bounded batch** (`maxDispatchPerTick`, default 5) and a
  jittered start. 1000 overdue jobs drain at 5/tick, not all at once.
* Rationale: refused rather than skipped, because these jobs encode an explicit user
  intent ("check on this for me"). Silently skipping would be a silent failure — the exact
  class of bug this work exists to eliminate.
* `reminder` and `agent_followup` both catch up. A reminder whose moment has passed is
  still meaningful ("the thing you asked about an hour ago"); the delivered text includes
  the original scheduled time and how late it is, so the user is never misled about
  staleness.
* Nothing is marked `expired`; the state exists only as a derived *view* (`overdue`), so no
  user intent is discarded.

## 12. Multiple jobs and concurrency

```
session A: +10m, +20m, +60m
session B: +5m,  +30m
```

* Jobs are independent records; ordering across sessions is irrelevant.
* Within a tick, due jobs are sorted by `executeAt` (FIFO fairness) and dispatched up to
  `maxDispatchPerTick`.
* **Dispatch is not awaited to completion.** The scheduler calls `followup()`, which
  resolves as soon as the message is durably queued, and moves on. It never awaits the
  agent's turn — a 20-minute task cannot block job B. This preserves exactly the existing
  agent/session concurrency semantics.
* One job failing (session resume error, storage error) is caught per job and never aborts
  the tick or other jobs.
* Session isolation is inherent: a job carries its own `sessionId`, and delivery goes only
  to that session's target.

## 13. Session recovery at due time

Precedence, reusing the already-frozen `agents.js` resolution order:

1. `ctx.agents.get(sessionId)` → reuse the **live** agent (never create a second one).
2. else `sessionQuery.observeSession(sessionId)` → `exists` → `ctx.agents.resume()`.
3. else → `ctx.agents.create()`.

`observeSession()` is used **only as an existence probe**, exactly as today; it is never
treated as a way to "recover" an agent. Recovery is `ensureAgent()` — the same
single-flight, tested path the Mattermost inbound flow uses.

This is the piece core's `schedule` lacks (§2.2): a due job *causes* the resume.

## 14. Behaviour under each interruption

| Event | Agent | Job | Delivery |
|---|---|---|---|
| Idle eviction (30 min) | disposed | **kept** | fires at due time; session resumed |
| `dsh-web` restart (04:00) | all disposed | **kept** | recovered on startup, then fires |
| Mattermost WS drop | unaffected | **kept** | agent finishes; `outbound.js` retry + backfill deliver |
| Machine reboot | gone | **kept** | recovered from disk on next start |
| `disposeAll()` on plugin teardown | disposed | **kept** | untouched |

**Mattermost disconnected at due time.** The job still runs: the agent is resumed, the
followup is durably queued, the turn executes, and the reply is delivered by
`outbound.js` — whose `client.send()` already performs bounded retry on transient
transport errors and falls back to a channel post on a rejected thread root. A WS outage
therefore delays a reply but never marks the job failed and never loses the work. The
scheduler's job state tracks *dispatch*; it never depends on the socket.

## 15. Scheduler loop

* In-process, started in the plugin's `ctx.effect`, disposed with it.
* Tick interval `schedulerTickMs` (default 5000), `.unref()`'d so it never holds the
  process open.
* Each tick: load due jobs from the in-memory projection (synchronous reads — no disk scan),
  sort, claim, dispatch up to the batch cap. **No filesystem scan per tick.**
* Never blocks the Mattermost WS or any agent: all dispatch is fire-and-forget with
  per-job error containment.
* Startup recovery runs once before the first tick.
* Clean shutdown: the effect disposer stops the timer, awaits in-flight dispatches, and
  closes the domain (draining queued writes).
* **No `sleep`-based waiting anywhere.** `setTimeout`/`sleep` is not the mechanism; the
  durable record plus a tick is.

## 16. Errors and retry

| Failure | Class | Handling |
|---|---|---|
| `ensureAgent` / `resume` throws | retryable | attempts++, back to `pending` with backoff; `failed` at `maxAttempts` |
| `followup` throws | retryable | same |
| storage write rejects | retryable | memory is left untouched by the domain layer (no divergence); retried next tick |
| session id malformed / unknown target | **non-retryable** | straight to `failed` with `lastError` |
| job record fails zod on open | non-retryable | `backup-and-skip`; record moved aside, logged |
| `cancel_job` on a terminal job | n/a | reported as such, no state change |

Backoff: `min(2^attempts * 5s, 5min)`. `maxAttempts` default 3, configurable.
There is **no unbounded retry** — a poison job must not become a bot loop.

## 17. Bot-chain and authorization preservation

* Scheduled `agent_followup` is delivered as an ordinary user message into an existing
  session. It does **not** synthesize a Mattermost post, so it cannot inflate the bot chain
  by itself.
* The agent's reply returns through `outbound.js` as the bot. If that reply @-mentions
  another bot, the *existing* inbound path and `botChainMax=5` budget apply unchanged.
  The scheduler introduces **no** path that bypasses the chain guard.
* **The scheduler adds no new authorization surface.** `schedule_job`, `list_jobs` and
  `cancel_job` are agent tools whose `execute` receives `exec.agent`, and each operation is
  scoped to a session. Cross-session access is refused: a job may be cancelled or listed
  only when its `sessionId` matches the calling agent's session, or its `createdBy` matches
  an authorized user. Job creation is reachable only from a session that a Mattermost
  message already authorized — an unauthorized post never mints a session (existing
  admission order), so it can never mint a job.
* `allowedUsers` semantics are untouched.

## 18. Security

* **No secrets in jobs.** `channelId`/`rootId`/`sessionId` are identifiers. The
  `MATTERMOST_TOKEN` is never read, copied, or logged by the scheduler. Enforced by a test
  that scans the persisted job store and logs for token material.
* **No arbitrary execution.** A job's `message` is delivered to the agent as user text —
  the same trust level as a Mattermost message from an authorized user. The scheduler never
  passes job data to a shell, `systemd`, or `exec`. A job cannot escalate beyond what the
  agent could already do in that session.
* **Logging.** Logs carry job id, session id (truncated), status, and timing — never
  message bodies at INFO, never credentials.
* **Payload validation.** zod at the durable boundary on read and on write.
* Job ids are constrained to `[a-zA-Z0-9_-]+` (a backend requirement for the per-record
  layout), which also removes any path-traversal surface.

## 19. Agent-facing tools

Registered with `ctx.tools.register(defineTool({...}))` in the plugin's `apply`, injecting
`"tools"`. This is the existing, supported mechanism (`dsh-tool-jobs` is the reference
implementation) — no second tool system, no MCP server, and **no production profile
change**.

| Tool | Purpose |
|---|---|
| `schedule_job` | schedule a `reminder` or `agent_followup` for a delay or an absolute time |
| `list_jobs` | list this session's jobs with id, type, status, executeAt |
| `cancel_job` | cancel a pending job by id |

Natural-language entry stays the primary UX ("一个小时后提醒我"), with the agent choosing
the tool — no new user-facing command syntax is required.

## 20. Config additions (all defaulted, all additive)

| Key | Default | Meaning |
|---|---|---|
| `schedulerEnabled` | `true` | master switch |
| `schedulerTickMs` | `5000` | tick interval |
| `jobLeaseMs` | `300000` | claim lease / orphan threshold |
| `jobMaxAttempts` | `3` | retry cap |
| `maxDispatchPerTick` | `5` | due-batch bound (catch-up herd control) |
| `jobMaxPerSession` | `50` | per-session job cap (abuse bound) |
| `jobMaxHorizonMs` | `2592000000` (30d) | max future scheduling horizon |

Existing keys (`allowedUsers`, `allowAll`, `botChainMax`, `idleAgentTtlMs`, `backfill`,
mapping, `channels`) are **not modified**.

## 21. Test plan

Isolated harness only (a throwaway `DSH_HOME`, profile `mmt-test`, port 3090,
probe 3091). Production is never touched.

| # | Test | Method |
|---|---|---|
| T1 | create job | tool call → record present, zod-valid |
| T2 | job executes at due time | short delay → followup observed |
| T3 | cancel job | cancel → terminal, never dispatches |
| T4 | list jobs | reflects all states |
| T5 | agent live at due time | live agent reused, no second agent |
| T6 | **agent evicted before due time** | force `sweepNow()` → job survives → fires |
| T7 | **restart before due time** | restart test instance → job recovered → fires |
| T8 | multiple concurrent jobs | A(+10/+20/+60), B(+5/+30) ordering/isolation |
| T9 | no duplicate execution | crash between dispatch writes → single execution |
| T10 | Mattermost WS disconnect | job still dispatches; reply after resume |
| T11 | agent busy at due time | followup queues, does not steer |
| T12 | session absent | resume path used, `observeSession` not a probe |
| T13 | unauthorized cross-session | other session cannot cancel/list |
| T14 | bot-chain still enforced | chain budget unchanged |
| T15 | storage corruption / partial write | `backup-and-skip`, unit still opens |
| T16 | long offline recovery | overdue backlog drains bounded |
| T17 | **incident replay (33)** | schedule +60m, evict at +30m, fires at +60m |
| T18 | **04:00 restart replay (34)** | schedule for +5h, restart, job survives and fires |

Plus performance: 100 / 500 / 1000 jobs (startup time, tick CPU, memory, lookup, due-scan).

## 22. Production safety and rollback

* All work happens in an isolated clone; production is fast-forwarded only after tests pass.
* No production config, profile, credential, systemd unit, or the legacy bridge is touched.
* `v0.1.0-production` → `7bd2ad4d…` is never moved; no force push.
* Rollback: `git revert` the feature commits (or check out `61608a8`), then restart
  `dsh-web`. The job store lives in `$DSH_HOME/storages/mattermost_jobs/`; removing that
  directory discards pending jobs. Because the feature is additive and inert until the
  first `schedule_job` call, reverting restores the previous behaviour exactly.

---

## Appendix A — Verified source references

| Claim | Location |
|---|---|
| Inbox is durable | `dsh-agent-loop/lib/index.js` — `inbox.splice` → `session.append("agent/inbox/spliced", …)` |
| Duplicate message id rejected | `dsh-agent-loop/lib/index.js` — `message "…" is already pending` |
| Inserted messages unvalidated (`z.custom()`) | `dsh-agent-loop/lib/index.js` — `inboxProjectionSchema` |
| `createMessage` overwrites `id` | `dsh-llm/lib/index.js` — `id: brandString(randomUUID())` |
| `followup` = `next-turn`, `steer` = `next-step` | `dsh-agent-loop/lib/index.js` — `followup()/steer()` |
| Dispose cancels + disposes scope | `dsh-agent-loop/lib/index.js` — agent lifecycle `dispose()` |
| Background procs killed at teardown | `dsh-bash-local/lib/index.js` — executor docblock |
| Atomic durable publish | `dsh-storage-json/lib/index.js` — `atomic` module docblock |
| Domain write chain / durable-first writes | `dsh-storage-domain/lib/types/domain.d.ts` |
| `defineDomain` / `domainTable` | `dsh-storage-domain/lib/types/spec.d.ts` |
| Tool registration | `dsh-tools` — `defineTool`; reference use in `dsh-tool-jobs/lib/index.js` |
| `schedule` is session-local, not enabled | `dsh-schedule/lib/index.js` tool description; absent from all bundle patches |
