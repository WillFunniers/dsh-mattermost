/**
 * Durable fault events and their notification queue.
 *
 * WHY THIS EXISTS
 *   The plugin can already *log*, but a log line is not a record: `plugin.log`
 *   is a best-effort append whose failures are swallowed, it has no identity, no
 *   per-event delivery state, and nothing to retry. When a job ends in a state a
 *   human has to resolve, that fact must survive the process, be deduplicable,
 *   and be retried until Mattermost actually accepted it.
 *
 * WHAT IT DELIBERATELY IS NOT
 *   Not a second job store, not a queue, not a database. It reuses the same
 *   storage primitives as jobs.js — `ctx.storageDomain`, zod at the durable
 *   boundary, `per-record` layout, `backup-and-skip`, atomic `table.update()` —
 *   and it stores identifiers plus a short reason, never conversation content,
 *   credentials or tool arguments.
 *
 * TWO TABLES, TWO JOBS
 *   events   one durable record per fault, keyed by a STABLE id so repeated
 *            recovery cannot create duplicates.
 *   sessions turn-open bookkeeping. The plugin already subscribes to
 *   `session/event`; persisting whether a turn was open is what makes
 *   "this work was interrupted" assertable after a crash instead of guessed.
 */
import { createRequire } from 'node:module'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

const require = createRequire(import.meta.resolve('@deepseek-ai/dsh-storage-domain'))
const { z } = require('zod')

export const FAULT_DOMAIN = 'mattermost_faults'
export const EVENT_TABLE = 'events'
export const SESSION_TABLE = 'sessions'
export const FAULT_SCHEMA_VERSION = 1

/**
 * Fault kinds. Kept small on purpose: every kind here has a concrete detection
 * path and a concrete thing for the user to check.
 */
export const FAULT_TYPES = /** @type {const} */ ([
  /** Delivery was attempted; whether it executed cannot be established. */
  'job-unknown',
  /** A running job was found at startup and safely returned to pending. */
  'job-orphaned',
  /** The job was delivered but its turn was still open when the process stopped. */
  'turn-interrupted',
  /** A job's target session did not exist and had to be created fresh. */
  'session-recreated',
  /** A job document was isolated by the storage layer (corrupt / schema-incompatible). */
  'job-corrupt',
  /** A notification could not be delivered after its retries. */
  'notify-undeliverable',
])

/** What the plugin can actually claim about the outcome. */
export const FAULT_OUTCOMES = /** @type {const} */ ([
  'unknown', // cannot be determined — must not be reported as success or failure
  'interrupted', // work was in flight and stopped
  'isolated', // a record was quarantined; no outcome was attempted
  'informational', // nothing was at risk
])

const NOTIFY_STATES = /** @type {const} */ (['pending', 'sent', 'failed'])

export const faultEventSchema = z.object({
  id: z.string().min(1).max(200),
  type: z.enum(FAULT_TYPES),
  outcome: z.enum(FAULT_OUTCOMES),
  at: z.number().int(),
  updatedAt: z.number().int(),
  sessionId: z.string().max(200).nullable(),
  jobId: z.string().max(200).nullable(),
  /** The last state that could actually be confirmed. */
  lastKnownState: z.string().max(200).nullable(),
  needsHuman: z.boolean(),
  detail: z.string().max(1000).nullable(),
  /** Notification bookkeeping — separate from the fault itself. */
  notifyState: z.enum(NOTIFY_STATES),
  notifyAttempts: z.number().int().min(0),
  notifiedAt: z.number().int().nullable(),
  channelId: z.string().max(200).nullable(),
  rootId: z.string().max(200).nullable(),
  lastError: z.string().max(500).nullable(),
})

export const faultSessionSchema = z.object({
  sessionId: z.string().min(1).max(200),
  /** True while a turn is in flight. Persisted so a crash leaves evidence. */
  turnOpen: z.boolean(),
  turn: z.number().int().nullable(),
  openedAt: z.number().int().nullable(),
  closedAt: z.number().int().nullable(),
  updatedAt: z.number().int(),
})

export const faultDomainSpec = defineDomain({
  name: FAULT_DOMAIN,
  version: FAULT_SCHEMA_VERSION,
  layout: 'per-record',
  // Fault records are diagnostics. A single unreadable one must never take the
  // rest down — the same posture as the job store.
  invalidRecords: 'backup-and-skip',
  global: {
    schema: z.object({ version: z.literal(FAULT_SCHEMA_VERSION) }),
    initial: { version: FAULT_SCHEMA_VERSION },
  },
  tables: {
    [EVENT_TABLE]: domainTable(faultEventSchema),
    [SESSION_TABLE]: domainTable(faultSessionSchema),
  },
})

/**
 * Stable, deduplicating event id.
 *
 * Deterministic on purpose: recovery runs on every boot, so the same underlying
 * condition must map to the same id or every restart would raise a new fault.
 * `discriminator` is what distinguishes genuinely separate occurrences (for
 * example the job's attempt number or the turn that was interrupted).
 */
export function faultId(type, subject, discriminator = '') {
  const raw = `${type}|${subject || '-'}|${discriminator || '-'}`
  // Short, path-safe, and stable: the per-record layout requires [A-Za-z0-9_-].
  let h = 0x811c9dc5
  for (let i = 0; i < raw.length; i += 1) {
    h ^= raw.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `fault-${type}-${h.toString(16).padStart(8, '0')}`
}

export async function openFaultStore(ctx, { logger } = {}) {
  const facility = ctx.storageDomain
  if (!facility || typeof facility.open !== 'function') {
    throw new Error('storage domain unavailable; refusing a memory-only fault store')
  }
  const domain = await facility.open(faultDomainSpec)
  const events = domain.table(EVENT_TABLE)
  const sessions = domain.table(SESSION_TABLE)

  /**
   * Raise a fault. Idempotent by construction: an existing event with the same
   * stable id is updated (never duplicated), and a notification that already
   * succeeded is not re-queued.
   */
  async function raise(input) {
    const now = Date.now()
    const id = input.id || faultId(input.type, input.jobId || input.sessionId, input.discriminator)
    const existing = events.get(id)

    if (existing) {
      // Keep the original `at` (first sighting) and the sent state if it was sent.
      const next = {
        ...existing,
        updatedAt: now,
        lastKnownState: input.lastKnownState ?? existing.lastKnownState,
        detail: input.detail ?? existing.detail,
        needsHuman: input.needsHuman ?? existing.needsHuman,
      }
      if (existing.notifyState !== 'sent') {
        next.notifyState = 'pending'
        next.channelId = input.channelId ?? existing.channelId
        next.rootId = input.rootId ?? existing.rootId
      }
      await events.put(id, faultEventSchema.parse(next))
      return { id, created: false, event: next }
    }

    const event = faultEventSchema.parse({
      id,
      type: input.type,
      outcome: input.outcome,
      at: now,
      updatedAt: now,
      sessionId: input.sessionId ?? null,
      jobId: input.jobId ?? null,
      lastKnownState: input.lastKnownState ?? null,
      needsHuman: input.needsHuman ?? true,
      detail: (input.detail ?? null) && String(input.detail).slice(0, 1000),
      notifyState: input.channelId ? 'pending' : 'failed',
      notifyAttempts: 0,
      notifiedAt: null,
      channelId: input.channelId ?? null,
      rootId: input.rootId ?? null,
      lastError: input.channelId ? null : 'no delivery target resolved for this fault',
    })
    await events.put(id, event)
    return { id, created: true, event }
  }

  function get(id) {
    return events.get(id)
  }

  function list({ needsHuman, notifyState, includeAll = true } = {}) {
    const out = []
    for (const [, event] of events.entries()) {
      if (needsHuman !== undefined && event.needsHuman !== needsHuman) continue
      if (notifyState !== undefined && event.notifyState !== notifyState) continue
      out.push(event)
    }
    out.sort((a, b) => a.at - b.at)
    return includeAll ? out : out.filter((e) => e.needsHuman)
  }

  /** Events whose notification is still owed. */
  function pendingNotifications(limit = 20) {
    const out = []
    for (const [, event] of events.entries()) {
      if (event.notifyState === 'pending' && event.channelId) out.push(event)
    }
    out.sort((a, b) => a.at - b.at)
    return out.slice(0, limit)
  }

  async function markNotified(id, now = Date.now()) {
    return events.update(id, (current) => (
      current.notifyState === 'sent'
        ? current
        : { ...current, notifyState: 'sent', notifiedAt: now, notifyAttempts: current.notifyAttempts + 1, lastError: null, updatedAt: now }
    ))
  }

  /**
   * A failed notification stays `pending` (so it is retried) until it has failed
   * `maxAttempts` times, at which point it becomes `failed` so it stops
   * pretending it will arrive. The fault itself is never dropped either way.
   */
  async function markNotifyFailed(id, error, maxAttempts = 5, now = Date.now()) {
    return events.update(id, (current) => {
      if (current.notifyState === 'sent') return current
      const attempts = current.notifyAttempts + 1
      return {
        ...current,
        notifyAttempts: attempts,
        notifyState: attempts >= maxAttempts ? 'failed' : 'pending',
        lastError: String(error && error.message ? error.message : error).slice(0, 500),
        updatedAt: now,
      }
    })
  }

  /** Record that a fault no longer needs attention. */
  async function ack(id, now = Date.now()) {
    return events.update(id, (current) => (
      current.needsHuman ? { ...current, needsHuman: false, updatedAt: now } : current
    ))
  }

  // ---- turn bookkeeping -----------------------------------------------------

  /** A turn started in this session. Durable, so a crash leaves evidence. */
  async function turnOpened(sessionId, turn, now = Date.now()) {
    const id = String(sessionId)
    await sessions.put(id, faultSessionSchema.parse({
      sessionId: id,
      turnOpen: true,
      turn: Number.isInteger(turn) ? turn : null,
      openedAt: now,
      closedAt: sessions.get(id)?.closedAt ?? null,
      updatedAt: now,
    }))
  }

  async function turnClosed(sessionId, now = Date.now()) {
    const id = String(sessionId)
    const current = sessions.get(id)
    if (!current) return
    await sessions.put(id, faultSessionSchema.parse({
      ...current,
      turnOpen: false,
      openedAt: null,
      closedAt: now,
      updatedAt: now,
    }))
  }

  /** Sessions whose turn was still open — i.e. work that was cut off. */
  function interruptedSessions() {
    const out = []
    for (const [, record] of sessions.entries()) {
      if (record.turnOpen) out.push(record)
    }
    return out
  }

  async function clearTurn(sessionId) {
    const id = String(sessionId)
    const current = sessions.get(id)
    if (!current) return
    await sessions.put(id, faultSessionSchema.parse({ ...current, turnOpen: false, openedAt: null, updatedAt: Date.now() }))
  }

  function stats() {
    const byType = {}
    let pending = 0
    let needsHuman = 0
    for (const [, event] of events.entries()) {
      byType[event.type] = (byType[event.type] || 0) + 1
      if (event.notifyState === 'pending') pending += 1
      if (event.needsHuman) needsHuman += 1
    }
    return { total: events.size, byType, pendingNotifications: pending, needsHuman, openTurns: interruptedSessions().length }
  }

  return {
    raise, get, list, pendingNotifications, markNotified, markNotifyFailed, ack,
    turnOpened, turnClosed, interruptedSessions, clearTurn,
    stats,
    close: () => domain.close(),
  }
}

/** Human-readable, deliberately free of conversation content. */
export function renderFault(event) {
  const labels = {
    'job-unknown': '定时任务结果未知',
    'job-orphaned': '定时任务已安全回收',
    'turn-interrupted': '执行被中断',
    'session-recreated': '会话被重建',
    'job-corrupt': '任务记录损坏',
    'notify-undeliverable': '故障通知未能送达',
  }
  const outcome = {
    unknown: '**无法确认执行结果**',
    interrupted: '执行过程中断,结果未知',
    isolated: '已隔离,未尝试执行',
    informational: '仅记录,无需处理',
  }[event.outcome] ?? event.outcome

  const lines = [
    `⚠️ **${labels[event.type] ?? event.type}**`,
    '',
    `- 结果:${outcome}`,
    `- 最后可确认状态:\`${event.lastKnownState ?? 'unknown'}\``,
  ]
  if (event.jobId) lines.push(`- 任务:\`${event.jobId}\``)
  if (event.sessionId) lines.push(`- 会话:\`${event.sessionId}\``)
  if (event.detail) lines.push(`- 说明:${event.detail}`)
  lines.push('')
  if (event.needsHuman) {
    lines.push('**需要你人工处理**:插件不会自动重放结果未知的任务。')
    lines.push('建议回到 DSH Web 打开该会话,确认它实际执行到了哪一步,再决定是否重新发起。')
  } else {
    lines.push('无需人工介入,仅作记录。')
  }
  lines.push('')
  lines.push(`_事件 ID:\`${event.id}\`(相同 ID 不会重复通知)_`)
  return lines.join('\n')
}
