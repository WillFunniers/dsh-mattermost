/**
 * Outbound router: subscribe to the durable `session/event` bus and deliver the
 * agent's reply back to the Mattermost conversation that owns the session.
 *
 * Deliberately NOT request-scoped: delivery is resolved from the session id, so
 * a task may run for an hour and still answer correctly after the inbound
 * WebSocket frame that started it is long gone.
 *
 * Streaming: Mattermost advertises streaming=false for this adapter, so we never
 * call editMessage (which this adapter intentionally does not implement). Text is
 * accumulated from committed `assistant/message` events and delivered at
 * `turn/end`. `assistant/chunk` is NOT a current session event type — it only
 * exists in the v0 format migration packages — so it is not relied upon.
 */
import { splitForCap } from './markdown.js'

export function createOutbound({ logger, client, clientFor, resolveTarget, maxChars = 12_000 }) {
  /** sessionId -> { buffer, turn, delivered } */
  const state = new Map()

  /**
   * The transport that owns this delivery.
   *
   * Routing is by the target's bot id, not by whichever client happens to be
   * first: with two bots in one channel, using the wrong client would answer as
   * the wrong identity (and, for a DM, fail outright).
   */
  function transportFor(target) {
    if (typeof clientFor === 'function') {
      const resolved = clientFor(target && target.botId)
      if (resolved) return resolved
    }
    return client
  }

  function stateFor(sessionId) {
    let s = state.get(sessionId)
    if (!s) { s = { buffer: '', turn: 0, delivered: 0 }; state.set(sessionId, s) }
    return s
  }

  function textOf(message) {
    return (message && Array.isArray(message.content) ? message.content : [])
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('')
  }

  async function onSessionEvent(session, event) {
    const sessionId = String(session.id)
    const target = resolveTarget(sessionId)
    if (!target) return
    const mm = transportFor(target)
    if (!mm) return
    const s = stateFor(sessionId)

    try {
      switch (event.type) {
        case 'turn/start': {
          s.buffer = ''
          s.turn = event.data?.turn ?? s.turn
          s.delivered = 0
          void mm.sendTyping(target.channelId)
          break
        }
        case 'assistant/message': {
          const text = textOf(event.data?.message)
          if (text) s.buffer += (s.buffer ? '\n\n' : '') + text
          break
        }
        case 'turn/end': {
          const reason = event.data?.reason
          const raw = s.buffer.trim()
          if (raw) {
            const parts = splitForCap(raw, maxChars)
            for (const part of parts) {
              await mm.send(target.channelId, part, target.rootId)
            }
            s.delivered += parts.length
          }
          if (reason && reason.kind && reason.kind !== 'completed') {
            const detail = reason.kind === 'aborted' ? '已中断'
              : reason.kind === 'error' ? `出错：${reason.error?.message || reason.error?.code || '未知'}`
              : reason.kind
            await mm.send(target.channelId, `⚠️ 本轮${detail}`, target.rootId)
          } else if (!raw) {
            await mm.send(target.channelId, '（本轮没有文本输出）', target.rootId)
          }
          logger.info(`replied session=${sessionId} chars=${raw.length}`)
          s.buffer = ''
          break
        }
        default:
          break
      }
    } catch (error) {
      logger.error(`outbound delivery failed for ${sessionId}: ${error.stack || error.message}`)
    }
  }

  function dispose() { state.clear() }

  return { onSessionEvent, dispose }
}
