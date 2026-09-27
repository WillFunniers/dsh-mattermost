/**
 * Mattermost transport: WebSocket in, REST out.
 *
 * Reuses the patterns already proven in production by mattermost-mcp/server.mjs
 * and bridge.mjs:
 *   - Bearer header auth on the WS upgrade (verified against the live server:
 *     a header-authenticated socket receives `posted`, an unauthenticated one is
 *     closed with 1006 and receives nothing)
 *   - application-level ping every 30s
 *   - `closedByUs` so an intentional stop never schedules a reconnect
 *   - REST backfill on reconnect (`?since=<update_at>`) + a bounded dedup set,
 *     because WS frames are not a durable queue we can rely on across a long drop
 */
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'

// `ws` ships inside the DSH installation; resolve it there so this plugin needs
// no dependency install of its own.
const require = createRequire('/opt/node-v24.20.0/lib/node_modules/@deepseek-ai/dsh/')
const WebSocket = require('ws')

const PING_INTERVAL_MS = 30_000
const DEDUP_MAX = 5_000

export function createMattermostClient({ baseUrl, token, logger, stateFile, debug }) {
  let ws = null
  let pingTimer = null
  let retryDelay = 1_000
  let closedByUs = false
  let started = false
  let handler = null

  let me = null
  const seen = new Set()
  const seenOrder = []
  let lastSeenAt = 0

  const state = { connected: false, replies: 0, errors: 0, reconnects: 0, backfilled: 0 }

  function log(message) { logger.info(`[mm] ${message}`) }
  function dbg(message) { if (debug) logger.info(`[mm:debug] ${message}`) }

  // ---------------------------------------------------------------- persistence
  function loadState() {
    if (!stateFile || !existsSync(stateFile)) return
    try {
      const parsed = JSON.parse(readFileSync(stateFile, 'utf8'))
      if (Number.isFinite(parsed.lastSeenAt)) lastSeenAt = parsed.lastSeenAt
      if (Array.isArray(parsed.seen)) {
        for (const id of parsed.seen.slice(-DEDUP_MAX)) { seen.add(id); seenOrder.push(id) }
      }
      log(`state loaded: ${seen.size} seen, lastSeen=${lastSeenAt}`)
    } catch (error) {
      logger.warn(`state load failed: ${error.message}`)
    }
  }

  function saveState() {
    if (!stateFile) return
    try {
      mkdirSync(dirname(stateFile), { recursive: true })
      const tmp = `${stateFile}.tmp`
      writeFileSync(tmp, JSON.stringify({ lastSeenAt, seen: seenOrder.slice(-DEDUP_MAX) }))
      renameSync(tmp, stateFile)
    } catch (error) {
      logger.warn(`state save failed: ${error.message}`)
    }
  }

  /** Returns true when this post id is new (and records it). */
  function markSeen(postId) {
    if (seen.has(postId)) return false
    seen.add(postId)
    seenOrder.push(postId)
    if (seenOrder.length > DEDUP_MAX) {
      const dropped = seenOrder.splice(0, seenOrder.length - DEDUP_MAX)
      for (const id of dropped) seen.delete(id)
    }
    return true
  }

  // ---------------------------------------------------------------------- REST
  async function api(method, path, body) {
    const res = await fetch(`${baseUrl}/api/v4/${path.replace(/^\//, '')}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (res.status === 204) return undefined
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`mattermost ${method} ${path} -> HTTP ${res.status} ${data.message || ''}`.trim())
    return data
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  /**
   * Deliver one message.
   *
   * Two failure modes are handled here rather than dropped by the caller, because
   * a lost answer is worse than a late one:
   *   - transient transport errors (`fetch failed`, 5xx, 429) -> bounded retry
   *   - an unusable thread root (deleted root, 400) -> retry once as a channel post
   * Measured before this existed: 1 reply in 10 was lost to a `fetch failed`
   * during a suspend/resume transition.
   */
  async function send(channelId, message, rootId) {
    let useRoot = rootId
    let lastError
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        const result = await api('POST', '/posts', {
          channel_id: channelId,
          message,
          ...(useRoot ? { root_id: useRoot } : {}),
        })
        state.replies += 1
        if (attempt > 1) log(`delivered after ${attempt} attempts`)
        return result
      } catch (error) {
        lastError = error
        const text = String(error && error.message)
        // A rejected thread root is permanent for this send: drop threading, keep the reply.
        if (useRoot && /HTTP 400/.test(text)) {
          logger.warn(`root_id ${String(useRoot).slice(0, 8)} rejected; falling back to a channel post`)
          useRoot = undefined
          continue
        }
        // Transient: back off and retry. Permanent 4xx (other than 400) will not improve.
        const retriable = /fetch failed|HTTP 5\d\d|HTTP 429|ECONNRESET|ETIMEDOUT|socket hang up/i.test(text)
        if (!retriable || attempt === 4) throw error
        await sleep(300 * attempt * attempt)
      }
    }
    throw lastError
  }

  async function sendTyping(channelId) {
    if (!me) return
    try { await api('POST', `/users/${me.id}/typing`, { channel_id: channelId }) } catch { /* best effort */ }
  }

  async function fetchChannel(channelId) {
    try { return await api('GET', `/channels/${channelId}`) } catch { return undefined }
  }

  /**
   * REST catch-up. `since` compares UpdateAt strictly greater, so edits are
   * included; the endpoint caps at 1000 and offers no ordering guarantee, so we
   * page forward until a short batch comes back.
   */
  async function backfill(onPost) {
    if (!lastSeenAt) return 0
    let added = 0
    try {
      const channels = await api('GET', '/users/me/channels')
      for (const channel of channels || []) {
        let since = lastSeenAt
        for (let page = 0; page < 10; page += 1) {
          const list = await api('GET', `/channels/${channel.id}/posts?since=${since}&per_page=200`)
          const posts = Object.values(list?.posts || {})
            .filter((p) => p && p.create_at > lastSeenAt)
            .sort((a, b) => a.create_at - b.create_at)
          if (!posts.length) break
          for (const post of posts) {
            const fresh = markSeen(post.id)
            if (post.create_at > lastSeenAt) lastSeenAt = post.create_at
            if (fresh) { added += 1; await onPost(post, channel, true) }
          }
          const newest = posts[posts.length - 1].create_at
          if (newest <= since || posts.length < 200) break
          since = newest
        }
      }
    } catch (error) {
      logger.warn(`backfill failed: ${error.message}`)
    }
    if (added) { state.backfilled += added; log(`backfilled ${added} message(s)`) }
    saveState()
    return added
  }

  // ----------------------------------------------------------------- WebSocket
  function connect(onPost) {
    if (ws || closedByUs) return
    const wsUrl = `${baseUrl.replace(/^http/, 'ws')}/api/v4/websocket`
    const socket = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${token}` } })
    ws = socket

    socket.on('open', async () => {
      retryDelay = 1_000
      state.connected = true
      log(`websocket connected (bot ${me ? me.username : '?'})`)
      try { await backfill(onPost) } catch { /* logged inside */ }
    })

    socket.on('message', (raw) => {
      let frame
      try { frame = JSON.parse(String(raw)) } catch { return }
      if (frame.event !== 'posted') return
      let post = frame.data?.post
      if (typeof post === 'string') { try { post = JSON.parse(post) } catch { return } }
      if (!post || !post.id || !post.channel_id || !post.user_id) return
      if (!markSeen(post.id)) return
      if (Number.isFinite(post.create_at) && post.create_at > lastSeenAt) {
        lastSeenAt = post.create_at
        saveState()
      }
      const channel = {
        id: post.channel_id,
        type: frame.data?.channel_type,
        name: frame.data?.channel_name,
        display_name: frame.data?.channel_display_name,
      }
      Promise.resolve(onPost(post, channel, false)).catch((error) =>
        logger.error(`post handler failed: ${error.stack || error.message}`))
    })

    socket.on('close', (code) => {
      state.connected = false
      ws = null
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null }
      if (closedByUs) return
      state.reconnects += 1
      log(`websocket closed (${code}); reconnect in ${retryDelay}ms`)
      setTimeout(() => connect(onPost), retryDelay)
      retryDelay = Math.min(60_000, retryDelay * 2)
    })

    socket.on('error', (error) => logger.warn(`websocket error: ${error.message}`))

    if (pingTimer) clearInterval(pingTimer)
    pingTimer = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) {
        try { socket.send(JSON.stringify({ seq: Date.now() % 1_000_000, action: 'ping' })) } catch { /* close handler reconnects */ }
      }
    }, PING_INTERVAL_MS)
  }

  // -------------------------------------------------------------------- public
  async function start(onPost) {
    if (onPost) handler = onPost
    if (started) return
    started = true
    closedByUs = false
    loadState()
    try {
      me = await api('GET', '/users/me')
      log(`bot identity: ${me.username} (${me.id})`)
    } catch (error) {
      logger.warn(`users/me failed: ${error.message}`)
    }
    connect(handler)
  }

  /**
   * TEST-ONLY: hold the transport down so messages genuinely arrive while we are
   * offline, then `resume()` reconnects and the open handler runs backfill.
   * Without this the exponential backoff reconnects in ~1s and the missed-message
   * path is never exercised.
   */
  function suspend() { stop(); return true }
  async function resume() {
    if (!handler) return false
    started = false
    closedByUs = false
    await start(handler)
    return true
  }

  function stop() {
    closedByUs = true
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null }
    const socket = ws
    ws = null
    state.connected = false
    saveState()
    if (socket) { try { socket.close() } catch { /* ignore */ } }
  }

  /**
   * TEST-ONLY: simulate an abrupt transport loss. Deliberately does NOT set
   * closedByUs, so the close handler treats it as a real drop and reconnects,
   * which is what exercises backfill + dedup.
   */
  function dropSocket() {
    const socket = ws
    if (!socket) return false
    try { socket.terminate ? socket.terminate() : socket.close() } catch { /* ignore */ }
    return true
  }

  return { start, stop, suspend, resume, send, sendTyping, fetchChannel, api, state, markSeen, saveState, dropSocket, get me() { return me } }
}
