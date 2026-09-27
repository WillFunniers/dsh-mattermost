/**
 * Agent lifecycle for one Mattermost conversation.
 *
 * The whole point of the plugin architecture: the agent is created IN THIS
 * PROCESS, so `dsh web` and Mattermost share one live agent per session and no
 * cross-process session.lock (flock) contention can occur.
 *
 * FROZEN resolution order — exactly what the web host itself does
 * (dsh-api-session-controller `createOrAdopt`):
 *   1. live agent in this process      -> reuse it (never re-resume)
 *   2. persisted session on disk       -> agents.resume()
 *   3. neither                         -> agents.create()
 *
 * Existence is probed with `sessionQuery.observeSession(id)`, NOT
 * `sessionPersistence.list()` — list() returns snapshots ({header,...}) in
 * 0.1.7-rc.1, so `.id` on an element is undefined and every session would look
 * missing (the exact bug that made dsh-messaging always call create()).
 *
 * S1 (idle eviction): a live agent holds an open session.lock descriptor for as
 * long as it lives, and DSH has no idle reaper of its own. Measured: 100 short
 * tasks left 104 live agents and 104 session.lock FDs, forever. `sweep()`
 * releases agents that are idle past the TTL — never a running one, never one
 * with recent activity. Sessions stay durable, so the next message for an
 * evicted session takes the already-tested observeSession -> resume path and
 * continues in the SAME sessionId with the SAME history.
 */
import { installModelSelection } from '@deepseek-ai/dsh-agent'

const NOT_FOUND = 'SESSION_QUERY_SESSION_NOT_FOUND'

export function createAgentManager(ctx, { logger, cwd, idleTtlMs = 30 * 60_000, onEvict } = {}) {
  /** sessionId -> AgentHandle (kept whole, so dispose() stays reachable) */
  const handles = new Map()
  /** sessionId -> in-flight creation promise (single-flight) */
  const creations = new Map()
  /** sessionId -> last inbound/outbound activity timestamp */
  const activity = new Map()

  function touchActivity(sessionId) {
    activity.set(sessionId, Date.now())
  }

  function installSelection(agentCtx) {
    const defaults = ctx.get('agentDefaultModel')
    if (!defaults || typeof defaults.currentSelection !== 'function') return
    installModelSelection(agentCtx, {
      get current() { return defaults.currentSelection() },
      set current(_next) { /* per-session override not supported */ },
      assembled: undefined,
    })
  }

  async function composeSetup() {
    const presets = ctx.get('agentPresets')
    if (!presets) return { agentPreset: undefined, setup: async (c) => { installSelection(c) } }
    const resolved = await presets.resolve(undefined)
    return {
      agentPreset: resolved && resolved.id,
      setup: async (agentCtx) => {
        installSelection(agentCtx)
        await presets.mount(agentCtx, resolved.id)
      },
    }
  }

  function modelOptions() {
    const defaults = ctx.get('agentDefaultModel')
    const sel = defaults && typeof defaults.currentSelection === 'function' ? defaults.currentSelection() : undefined
    return sel ? { provider: sel.provider, model: sel.model } : {}
  }

  /** True when the session is persisted and observable. Never uses list(). */
  async function sessionExists(sessionId) {
    const query = ctx.get('sessionQuery')
    if (!query || typeof query.observeSession !== 'function') {
      logger.warn('sessionQuery.observeSession unavailable; falling back to resume-then-create')
      return undefined
    }
    try {
      await query.observeSession(sessionId)
      return true
    } catch (error) {
      if (error && error.code === NOT_FOUND) return false
      logger.warn(`observeSession(${sessionId}) failed: ${error.message}`)
      return undefined
    }
  }

  async function open(sessionId) {
    const composition = await composeSetup()
    const agentOptions = modelOptions()
    const setup = composition.setup
    const meta = { cwd, ...(composition.agentPreset ? { agentPreset: composition.agentPreset } : {}) }

    const exists = await sessionExists(sessionId)
    if (exists === true) {
      return ctx.agents.resume({ resumeSessionId: sessionId, agentOptions, setup })
    }
    if (exists === false) {
      return ctx.agents.create({ sessionId, meta, agentOptions, setup })
    }
    try {
      return await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions, setup })
    } catch (error) {
      logger.warn(`resume(${sessionId}) failed (${error.message}); attempting create`)
      return ctx.agents.create({ sessionId, meta, agentOptions, setup })
    }
  }

  /**
   * Resolve the live agent for a session id, creating or resuming it at most once.
   * Concurrent callers for the same id share one creation promise.
   */
  async function ensureAgent(sessionId) {
    const live = ctx.agents.get(sessionId)
    if (live) return live

    let creation = creations.get(sessionId)
    if (!creation) {
      creation = (async () => {
        const wasLive = Boolean(ctx.agents.get(sessionId))
        const handle = await open(sessionId)
        handles.set(sessionId, handle)
        touchActivity(sessionId)
        logger.info(`agent ready session=${sessionId} ${wasLive ? '(adopted)' : ''}`.trim())
        return handle.agent
      })()
        .catch((error) => {
          const concurrent = ctx.agents.get(sessionId)
          if (concurrent) return concurrent
          throw error
        })
        .finally(() => { creations.delete(sessionId) })
      creations.set(sessionId, creation)
    }
    return creation
  }

  async function disposeAgent(sessionId) {
    const handle = handles.get(sessionId)
    handles.delete(sessionId)
    activity.delete(sessionId)
    if (!handle) return false
    try { await handle.dispose() } catch (error) { logger.warn(`dispose(${sessionId}) failed: ${error.message}`) }
    return true
  }

  async function disposeAll() {
    const owned = [...handles.values()]
    handles.clear()
    activity.clear()
    for (const handle of owned) {
      try { await handle.dispose() } catch (error) { logger.warn(`dispose failed: ${error.message}`) }
    }
  }

  /**
   * Release agents that have been idle past the TTL.
   *
   * Guards, in order:
   *   - never a running agent (a queued followup keeps status 'running')
   *   - never an agent with activity newer than the TTL
   *   - never while a creation for that id is still in flight
   *
   * The session itself is untouched: mapping, durable log and history all remain,
   * so the next message resumes the SAME sessionId.
   */
  async function sweep(now = Date.now()) {
    const evicted = []
    for (const [sessionId, handle] of [...handles]) {
      if (creations.has(sessionId)) continue
      let status
      try { status = handle.agent.status } catch { status = undefined }
      if (status === 'running') { touchActivity(sessionId); continue }
      const last = activity.get(sessionId)
      if (last === undefined) { touchActivity(sessionId); continue }
      if (now - last < idleTtlMs) continue

      handles.delete(sessionId)
      activity.delete(sessionId)
      try {
        await handle.dispose()
        evicted.push(sessionId)
        logger.info(`evicted idle agent session=${sessionId} idleMs=${now - last}`)
        if (typeof onEvict === 'function') onEvict(sessionId)
      } catch (error) {
        logger.warn(`evict(${sessionId}) failed: ${error.message}`)
      }
    }
    return evicted
  }

  return { ensureAgent, disposeAgent, disposeAll, touchActivity, sweep, handles, activity }
}
