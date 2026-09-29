/**
 * Durable job store for delayed work that must outlive the live agent.
 *
 * WHY THIS EXISTS
 *   A delayed task implemented as `sleep 3600` inside an agent dies with that
 *   agent: `agents.js:sweep()` disposes an idle live agent after
 *   `idleAgentTtlMs`, `handle.dispose()` disposes its scope, and scope teardown
 *   kills and joins the executor's background processes (dsh-bash-local). A
 *   daily `dsh-web` restart does the same thing to every live agent at once.
 *   Production incident 2026-09-28: a job due at 11:01 was reclaimed at 10:32
 *   when the 30-minute idle eviction fired.
 *
 *   The fix is not a longer TTL. It is to give delayed work a lifetime that is
 *   independent of the live agent. That is this store.
 *
 * STORAGE
 *   `ctx.storageDomain` (the domain layer over `dsh-storage-json`), not a
 *   hand-rolled JSON file and not `ctx.jobs`:
 *     - dsh-storage-json publishes temp file -> fsync -> rename -> parent-dir
 *       fsync, so every accepted write is crash-durable;
 *     - the domain layer validates every record with the zod schema below at
 *       the durable boundary, and exposes an atomic read-modify-write
 *       (`table.update`) on a single per-domain write chain, which is what
 *       makes the claim in scheduler.js race-free;
 *     - `layout: 'per-record'` keeps one document per job, so a store with
 *       1000 jobs rewrites one small document per transition;
 *     - `invalidRecords: 'backup-and-skip'` moves an unreadable record aside
 *       (KvUnit.backupRecord) and keeps opening, which is the corruption
 *       policy for T15.
 *
 *   A job record holds identifiers only. No Mattermost token, no credential
 *   and no session content is ever written here.
 */
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

// zod is not resolvable from this package directly; anchor on a dependency that
// is, so no node_modules link has to exist for this plugin to load.
const require = createRequire(import.meta.resolve('@deepseek-ai/dsh-storage-domain'))
const { z } = require('zod')

export const JOB_DOMAIN = 'mattermost_jobs'
export const JOB_TABLE = 'jobs'
export const JOB_SCHEMA_VERSION = 1

/** The two execution semantics a delayed job can have. */
export const JOB_TYPES = /** @type {const} */ (['reminder', 'agent_followup'])

export const JOB_STATUS = /** @type {const} */ ([
  'pending', 'running', 'completed', 'failed', 'cancelled',
])
const TERMINAL = new Set(['completed', 'failed', 'cancelled'])

/** A job id is also a per-record path segment, so the alphabet is constrained. */
const JOB_ID_RE = /^job-[0-9a-f]{16}$/

export function newJobId() {
  return `job-${randomBytes(8).toString('hex')}`
}

export function isTerminal(status) {
  return TERMINAL.has(status)
}

/** Durable job record. Validated on every durable read and write. */
export const jobSchema = z.object({
  id: z.string().regex(JOB_ID_RE),
  type: z.enum(JOB_TYPES),
  status: z.enum(JOB_STATUS),
  /** Epoch ms UTC. */
  executeAt: z.number().int(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  /** Target durable session; the job resumes it at due time. */
  sessionId: z.string().min(1).max(200),
  /** Delivery target, captured at creation so delivery never needs live state. */
  channelId: z.string().min(1).max(200),
  rootId: z.string().max(200).nullable(),
  /** Mattermost user id of the requester; the authorization owner. */
  createdBy: z.string().min(1).max(200),
  /** The action text handed to the agent. Data, never executed by the scheduler. */
  message: z.string().min(1).max(8000),
  attempts: z.number().int().min(0),
  maxAttempts: z.number().int().min(1).max(20),
  claimId: z.string().max(80).nullable(),
  claimedAt: z.number().int().nullable(),
  /** Set once the instruction is durably in the session inbox. */
  dispatchedAt: z.number().int().nullable(),
  lastError: z.string().max(1000).nullable(),
  completedAt: z.number().int().nullable(),
  cancelledBy: z.string().max(200).nullable(),
})

export const jobDomainSpec = defineDomain({
  name: JOB_DOMAIN,
  version: JOB_SCHEMA_VERSION,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  global: {
    schema: z.object({ version: z.literal(JOB_SCHEMA_VERSION) }),
    initial: { version: JOB_SCHEMA_VERSION },
  },
  tables: {
    [JOB_TABLE]: domainTable(jobSchema),
  },
})

/**
 * Open the durable job store.
 *
 * Throws when the storage domain layer is unavailable: the caller must disable
 * the scheduler and say so, never fall back to a memory-only queue.
 */
export async function openJobStore(ctx, { logger, maxPerSession = 50 } = {}) {
  // Must be called with a context that injected 'storageDomain'. Cordis throws
  // on an uninjected service read, which is exactly the loud failure we want:
  // never a memory-only fallback, never a silent degradation.
  const facility = ctx.storageDomain
  if (!facility || typeof facility.open !== 'function') {
    throw new Error('storage domain unavailable (ctx.storageDomain missing); refusing a memory-only job store')
  }
  const domain = await facility.open(jobDomainSpec)
  const table = domain.table(JOB_TABLE)

  function mustGet(id) {
    if (!JOB_ID_RE.test(String(id || ''))) throw new Error(`invalid job id "${id}"`)
    const record = table.get(id)
    if (!record) throw new Error(`job "${id}" not found`)
    return record
  }

  /** How many non-terminal jobs a session already holds. */
  function activeCount(sessionId) {
    let n = 0
    for (const record of table.entries()) {
      if (record[1].sessionId === sessionId && !isTerminal(record[1].status)) n += 1
    }
    return n
  }

  async function create(input) {
    const now = Date.now()
    const record = {
      id: newJobId(),
      type: input.type,
      status: 'pending',
      executeAt: Math.trunc(input.executeAt),
      createdAt: now,
      updatedAt: now,
      sessionId: String(input.sessionId),
      channelId: String(input.channelId),
      rootId: input.rootId ? String(input.rootId) : null,
      createdBy: String(input.createdBy || 'unknown'),
      message: String(input.message),
      attempts: 0,
      maxAttempts: Math.trunc(input.maxAttempts ?? 3),
      claimId: null,
      claimedAt: null,
      dispatchedAt: null,
      lastError: null,
      completedAt: null,
      cancelledBy: null,
    }
    const parsed = jobSchema.parse(record)
    if (activeCount(parsed.sessionId) >= maxPerSession) {
      throw new Error(`session job limit reached (${maxPerSession} active jobs)`)
    }
    await table.put(parsed.id, parsed)
    return parsed
  }

  async function get(id) {
    return table.get(String(id))
  }

  /** All jobs, oldest first. Optionally narrowed to one session. */
  function list({ sessionId, includeTerminal = true } = {}) {
    const out = []
    for (const [, record] of table.entries()) {
      if (sessionId && record.sessionId !== sessionId) continue
      if (!includeTerminal && isTerminal(record.status)) continue
      out.push(record)
    }
    out.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    return out
  }

  /** Pending jobs that are due, oldest first. Pure read of the in-memory domain. */
  function due(now, limit = Number.MAX_SAFE_INTEGER) {
    const out = []
    for (const [, record] of table.entries()) {
      if (record.status === 'pending' && record.executeAt <= now) out.push(record)
    }
    out.sort((a, b) => a.executeAt - b.executeAt || a.createdAt - b.createdAt)
    return out.slice(0, limit)
  }

  /**
   * Atomically move one due job to `running` and hand back the claim.
   * The transform runs on the domain write chain, so two concurrent ticks can
   * never both claim the same job.
   */
  async function claim(id, now, maxAttempts) {
    let claimed
    await table.update(id, (current) => {
      if (current.status !== 'pending') return current
      if (current.executeAt > now) return current
      if (current.attempts >= (maxAttempts ?? current.maxAttempts)) {
        return { ...current, status: 'failed', lastError: 'attempt budget exhausted', updatedAt: now, completedAt: now }
      }
      claimed = {
        ...current,
        status: 'running',
        claimId: randomBytes(8).toString('hex'),
        claimedAt: now,
        attempts: current.attempts + 1,
        updatedAt: now,
        lastError: null,
      }
      return claimed
    })
    return claimed
  }

  /**
   * Terminal success: the instruction is durably committed to the session inbox.
   *
   * There is deliberately NO separate `dispatched` state. Handing the message to
   * `agent.followup()` IS the success condition — the inbox splice is a durable
   * session event — and the agent's actual reply is delivered independently by
   * outbound.js. An intermediate state that nothing ever settles would be a lie
   * about the job's progress, and it made "is this job done?" unanswerable.
   */
  async function markCompleted(id, now = Date.now()) {
    return table.update(id, (current) => (
      isTerminal(current.status)
        ? current
        : {
          ...current,
          status: 'completed',
          dispatchedAt: current.dispatchedAt ?? now,
          completedAt: now,
          updatedAt: now,
        }
    ))
  }

  /**
   * Hand a claimed job back because the target agent is busy.
   *
   * This is NOT a failure and must not consume an attempt: nothing was
   * delivered. The attempt counter is rolled back so a session that stays busy
   * for a long time cannot exhaust a job's budget while it waits.
   *
   * Why defer at all, rather than queueing into the running agent: a message
   * spliced into a BUSY agent is immediately claimed into the in-flight turn,
   * and a claimed message is removed from the durable pending projection. A
   * restart before that turn finishes therefore loses the instruction silently
   * while the job still reads `completed`. Handing work only to an IDLE agent
   * removes that window entirely.
   */
  async function defer(id, until, now = Date.now()) {
    return table.update(id, (current) => (
      current.status === 'running'
        ? {
          ...current,
          status: 'pending',
          executeAt: until,
          attempts: Math.max(0, current.attempts - 1),
          claimId: null,
          claimedAt: null,
          updatedAt: now,
        }
        : current
    ))
  }

  /** Retryable failure: back to pending with backoff, or terminal at the cap. */
  async function retryOrFail(id, error, backoffMs, now = Date.now()) {
    return table.update(id, (current) => {
      if (isTerminal(current.status)) return current
      const message = String(error && error.message ? error.message : error).slice(0, 1000)
      if (current.attempts >= current.maxAttempts) {
        return { ...current, status: 'failed', lastError: message, updatedAt: now, completedAt: now }
      }
      return {
        ...current,
        status: 'pending',
        executeAt: now + backoffMs,
        claimId: null,
        claimedAt: null,
        lastError: message,
        updatedAt: now,
      }
    })
  }

  async function fail(id, error, now = Date.now()) {
    return table.update(id, (current) => (
      isTerminal(current.status)
        ? current
        : {
          ...current,
          status: 'failed',
          lastError: String(error && error.message ? error.message : error).slice(0, 1000),
          updatedAt: now,
          completedAt: now,
        }
    ))
  }

  /**
   * Cancel a pending job. `owner` fences the call to the job's session so one
   * conversation cannot cancel another's work. Returns a discriminated result
   * rather than throwing, so the tool can explain the outcome.
   */
  async function cancel(id, { sessionId, by } = {}) {
    if (!JOB_ID_RE.test(String(id || ''))) return { outcome: 'not-found' }
    const existing = table.get(id)
    if (!existing) return { outcome: 'not-found' }
    if (sessionId && existing.sessionId !== sessionId) return { outcome: 'forbidden' }
    if (isTerminal(existing.status)) return { outcome: 'already-terminal', job: existing }
    let result
    await table.update(id, (current) => {
      if (isTerminal(current.status)) { result = current; return current }
      result = { ...current, status: 'cancelled', cancelledBy: by ? String(by) : null, completedAt: Date.now(), updatedAt: Date.now() }
      return result
    })
    return { outcome: 'cancelled', job: result }
  }

  /**
   * Startup recovery.
   *
   *   running + dispatchedAt  -> the instruction is already committed to the
   *                              durable session inbox, so it WILL run. Mark
   *                              completed; re-dispatching would duplicate it.
   *   running + no dispatchedAt, claim stale
   *                           -> delivery state unknown. Return to pending; the
   *                              deterministic message id makes the re-dispatch
   *                              idempotent while the original is still pending.
   */
  async function recover(now = Date.now(), leaseMs = 300_000) {
    const recovered = { completed: 0, requeued: 0 }
    for (const [id, record] of [...table.entries()]) {
      if (record.status !== 'running') continue
      const staleSince = record.claimedAt == null || now - record.claimedAt >= leaseMs
      if (record.dispatchedAt != null) {
        await markCompleted(id, now)
        recovered.completed += 1
      } else if (staleSince) {
        await table.update(id, (current) => (
          current.status === 'running'
            ? { ...current, status: 'pending', claimId: null, claimedAt: null, updatedAt: now }
            : current
        ))
        recovered.requeued += 1
      }
    }
    return recovered
  }

  function stats() {
    const byStatus = {}
    let earliest = null
    for (const [, record] of table.entries()) {
      byStatus[record.status] = (byStatus[record.status] || 0) + 1
      if (record.status === 'pending' && (earliest === null || record.executeAt < earliest)) earliest = record.executeAt
    }
    return { total: table.size, byStatus, nextExecuteAt: earliest }
  }

  return {
    create, get, list, due, claim, markCompleted,
    retryOrFail, fail, defer, cancel, recover, stats,
    close: () => domain.close(),
    _table: table,
  }
}
