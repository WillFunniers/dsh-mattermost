/**
 * Scheduler: the only component that spans the durable/ephemeral boundary.
 *
 * It reads durable jobs and drives ephemeral live agents. It owns no state of
 * its own that matters — every decision is a persisted transition in jobs.js,
 * so a crash at any point is recoverable by re-reading the store.
 *
 * What it must never do:
 *   - wait for a job's agent turn to finish (a 20-minute task must not block
 *     the next job, the Mattermost socket, or any other agent);
 *   - execute a job twice because the process restarted;
 *   - lose a job because the agent that would have run it was evicted.
 *
 * The wake it performs — `ensureAgent(sessionId)` at due time — is exactly the
 * half that DSH core's `schedule` plugin deliberately omits (its reminders are
 * "session-local: ... otherwise becomes overdue until the session is resumed").
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'

/**
 * The message handed to the agent's inbox.
 *
 * The id is DERIVED, not random. `agent.followup()` splices the message into
 * the durable session inbox, and the inbox projection rejects a message whose
 * id is already pending ("message ... is already pending"). A derived id
 * therefore makes a recovery re-dispatch idempotent instead of duplicating the
 * instruction. (`createUserMessage` itself always overwrites `id` with a fresh
 * UUID, so the id is applied after construction.)
 */
export function buildJobMessage(job) {
  const header = job.type === 'reminder'
    ? '[定时提醒]'
    : '[定时任务]'
  const when = new Date(job.executeAt).toISOString()
  const overdueBy = Date.now() - job.executeAt
  const late = overdueBy > 60_000
    ? `\n(该任务原定于 ${when}，已延迟约 ${Math.round(overdueBy / 60_000)} 分钟执行。)`
    : ''
  const instruction = job.type === 'reminder'
    ? '请把下面这件事提醒给用户，保持原意：'
    : '请在当前会话继续执行下面这件事，并汇报结果：'
  const text = `${header} 定时任务触发（job ${job.id}）。\n${instruction}\n\n${job.message}${late}`

  const base = createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
  return { ...base, id: `mmjob-${job.id}` }
}

/** Bounded exponential backoff: 5s, 10s, 20s … capped at 5 minutes. */
export function backoffFor(attempts) {
  return Math.min(2 ** Math.max(0, attempts - 1) * 5_000, 300_000)
}

export function createScheduler({
  logger,
  store,
  ensureAgent,
  onDispatched,
  tickMs = 5_000,
  leaseMs = 300_000,
  maxDispatchPerTick = 5,
  now = () => Date.now(),
} = {}) {
  let timer = null
  let running = false
  let stopped = false
  const inFlight = new Set()
  const stats = { ticks: 0, dispatched: 0, failed: 0, recoveredCompleted: 0, recoveredRequeued: 0, skipped: 0 }

  /**
   * Dispatch one claimed job. Never throws to the caller: a failure is a
   * persisted transition, so the tick keeps going and the job is retried or
   * failed on its own merits.
   */
  async function dispatch(job) {
    try {
      const agent = await ensureAgent(job.sessionId)
      if (!agent || typeof agent.followup !== 'function') {
        throw new Error(`no live agent for session ${job.sessionId}`)
      }
      agent.followup(buildJobMessage(job))
      // Durability checkpoint: only now is the instruction provably in the
      // session inbox. Recording completion BEFORE here would lose the job on a
      // crash; never recording it would risk a duplicate on recovery.
      await store.markCompleted(job.id, now())
      stats.dispatched += 1
      logger.info(`job dispatched id=${job.id} type=${job.type} session=${job.sessionId} attempt=${job.attempts}`)
      if (typeof onDispatched === 'function') {
        try { onDispatched(job) } catch { /* observers never fail a dispatch */ }
      }
      return true
    } catch (error) {
      stats.failed += 1
      const attempts = Number(job.attempts) || 1
      await store.retryOrFail(job.id, error, backoffFor(attempts), now()).catch((storeError) => {
        logger.error(`job ${job.id} transition failed: ${storeError.message}`)
      })
      logger.warn(`job dispatch failed id=${job.id} attempt=${attempts} err=${error.message}`)
      return false
    }
  }

  /** One tick: claim up to the batch cap and dispatch without blocking. */
  async function tick() {
    if (running || stopped) return []
    running = true
    try {
      stats.ticks += 1
      const at = now()
      const due = store.due(at, maxDispatchPerTick)
      if (!due.length) return []
      const claimed = []
      for (const record of due) {
        const claim = await store.claim(record.id, at, record.maxAttempts)
        if (claim) claimed.push(claim)
        else stats.skipped += 1
      }
      const settled = []
      for (const job of claimed) {
        const promise = dispatch(job).finally(() => inFlight.delete(promise))
        inFlight.add(promise)
        settled.push(promise)
      }
      // Deliberately not awaited to completion by callers that only need the
      // tick to make progress; tick() awaits them so tests stay deterministic.
      await Promise.all(settled)
      return claimed.map((job) => job.id)
    } catch (error) {
      logger.error(`scheduler tick failed: ${error.stack || error.message}`)
      return []
    } finally {
      running = false
    }
  }

  /** Startup recovery, then arm the loop. */
  async function start() {
    const recovery = await store.recover(now(), leaseMs)
    stats.recoveredCompleted = recovery.completed
    stats.recoveredRequeued = recovery.requeued
    if (recovery.completed || recovery.requeued) {
      logger.info(`job recovery: completed=${recovery.completed} requeued=${recovery.requeued}`)
    }
    // Catch up immediately: anything already overdue must not wait a tick.
    await tick().catch(() => {})
    timer = setInterval(() => { tick().catch(() => {}) }, tickMs)
    if (typeof timer.unref === 'function') timer.unref()
    return recovery
  }

  async function stop() {
    stopped = true
    if (timer) { clearInterval(timer); timer = null }
    await Promise.allSettled([...inFlight])
  }

  return { start, stop, tick, stats, get running() { return running } }
}
