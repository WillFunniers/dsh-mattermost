/**
 * Mattermost identity -> chatKey -> DSH sessionId.
 *
 * This is the ONLY place that builds session ids. Nothing else may concatenate
 * one, so the mapping stays auditable and stable across restarts.
 *
 * Conversation key (unscoped — identifies the conversation, not the bot)
 *   DM                         chatKey = dm:<channel_id>
 *   channel root post          chatKey = ch:<channel_id>          (continuous chat, reused)
 *   any thread reply           chatKey = th:<root_post_id>        (one thread = one task context)
 *   explicit /task in a root   chatKey = th:<command_post_id>     (a new thread, hence a new session)
 *
 * Durable key (scoped — what the map is keyed by)
 *   b<botId>:<chatKey>
 *
 * Two bots in one channel must NOT share a session, so the bot id is part of the
 * durable key and of the session-id hash input. The FIRST configured bot also
 * OWNS the pre-multi-bot namespace: an entry stored under the bare `<chatKey>`
 * is still read, and is mirrored (never moved or deleted) into `b<id>:<chatKey>`
 * on first use, so an upgrade keeps every session the deployment already has.
 *
 * Because a `/task` starts a thread whose root is the command post, the thread
 * rule above resolves every later reply to the same session with no alias table.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'

/** How many superseded generations one conversation remembers for /switch. */
export const HISTORY_LIMIT = 20

/** Derive the unscoped conversation key from a Mattermost post + its channel. */
export function deriveKey(post, channel) {
  const channelType = channel && channel.type
  if (channelType === 'D') return `dm:${post.channel_id}`
  if (post.root_id) return `th:${post.root_id}`
  return `ch:${post.channel_id}`
}

/** The thread key a `/task` command starts (root = the command post itself). */
export function taskKey(post) {
  return `th:${post.id}`
}

/** Durable map key for one bot's conversation. */
export function scopedKey(botId, chatKey) {
  return `b${botId}:${chatKey}`
}

/**
 * Session id for one durable key.
 *
 * The bot id is inside `key`, so two bots can never derive the same id for the
 * same channel, and generation N of a conversation can never collide with
 * generation N+1.
 */
export function sessionIdFor(key, generation = 0) {
  const base = `mm-${createHash('sha1').update(key).digest('hex').slice(0, 16)}`
  return generation > 0 ? `${base}-v${generation}` : base
}

/** Normalize one persisted history row; drops anything unusable. */
function historyRow(value) {
  if (!value || typeof value !== 'object') return undefined
  const generation = Number(value.generation)
  const sessionId = typeof value.sessionId === 'string' ? value.sessionId : ''
  if (!sessionId || !Number.isFinite(generation) || generation < 0) return undefined
  return {
    generation,
    sessionId,
    updatedAt: Number(value.updatedAt) || 0,
  }
}

/** Normalize a history list from disk, tolerating anything an older file holds. */
function historyList(value) {
  if (!Array.isArray(value)) return []
  return value.map(historyRow).filter(Boolean).slice(-HISTORY_LIMIT)
}

/**
 * Durable chatKey -> sessionId map with per-key generation history.
 * Generation N is produced by /new or /switch so a fresh conversation gets a
 * fresh session without losing the previous one (still resumable from disk by
 * DSH, and reachable again through /switch).
 */
export function createSessionMap({ file, logger, legacyBotId = 'bot0' }) {
  const byKey = new Map()
  let loaded = false

  function load() {
    if (loaded) return
    loaded = true
    if (!existsSync(file)) return
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (parsed && typeof parsed === 'object' && parsed.entries) {
        for (const [key, entry] of Object.entries(parsed.entries)) {
          if (entry && typeof entry.sessionId === 'string') {
            entry.history = historyList(entry.history)
            byKey.set(key, entry)
          }
        }
      }
    } catch (error) {
      logger.warn(`session map load failed (${file}): ${error.message}`)
    }
  }

  /** Atomic write: temp file + rename, so a kill can never leave a torn map. */
  function persist() {
    try {
      // Explicit modes: this map is rewritten on every inbound message, so a
      // `chmod` on the live file would be undone within seconds by the rename
      // below. The mode must be set on the temp file that becomes the target.
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
      const payload = { version: 1, entries: Object.fromEntries(byKey) }
      const tmp = `${file}.tmp`
      writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 })
      renameSync(tmp, file)
    } catch (error) {
      logger.warn(`session map save failed (${file}): ${error.message}`)
    }
  }

  /**
   * Read one bot's entry without creating anything.
   *
   * Also performs the one-way legacy migration: a bare key that belongs to the
   * legacy bot is COPIED into the scoped namespace (same sessionId, same
   * generation, same history) and the bare key is left untouched on disk.
   */
  function peek(botId, chatKey) {
    load()
    const key = scopedKey(botId, chatKey)
    const found = byKey.get(key)
    if (found) return found
    if (botId !== legacyBotId) return undefined
    const legacy = byKey.get(chatKey)
    if (!legacy) return undefined
    const mirrored = { ...legacy, botId, history: historyList(legacy.history) }
    byKey.set(key, mirrored)
    persist()
    logger.info(`session map migrated legacy key into b${botId}: namespace`)
    return mirrored
  }

  function entryFor(botId, chatKey) {
    const existing = peek(botId, chatKey)
    if (existing) return existing
    const key = scopedKey(botId, chatKey)
    const entry = {
      sessionId: sessionIdFor(key, 0),
      generation: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      botId,
      history: [],
    }
    byKey.set(key, entry)
    persist()
    return entry
  }

  /** Remember the outgoing generation so /switch can come back to it. */
  function pushHistory(entry) {
    if (!entry || typeof entry.sessionId !== 'string') return
    const history = Array.isArray(entry.history) ? entry.history : []
    const row = {
      generation: Number(entry.generation) || 0,
      sessionId: entry.sessionId,
      updatedAt: Number(entry.updatedAt) || Date.now(),
    }
    const without = history.filter((h) => h.sessionId !== row.sessionId)
    without.push(row)
    entry.history = without.slice(-HISTORY_LIMIT)
  }

  function touch(botId, chatKey, meta) {
    const entry = entryFor(botId, chatKey)
    Object.assign(entry, meta || {}, { updatedAt: Date.now() })
    entry.botId = botId
    persist()
    return entry
  }

  /** Bump to a fresh session id for this conversation. Returns the new entry. */
  function reset(botId, chatKey) {
    const entry = entryFor(botId, chatKey)
    pushHistory(entry)
    const generation = (Number(entry.generation) || 0) + 1
    entry.generation = generation
    entry.sessionId = sessionIdFor(scopedKey(botId, chatKey), generation)
    entry.updatedAt = Date.now()
    entry.botId = botId
    persist()
    return entry
  }

  /**
   * Point this conversation at an already-known generation of itself.
   *
   * This is the ONLY write path /switch uses. It never touches another
   * conversation's entry, so a switch cannot move a different thread's agent.
   */
  function bind(botId, chatKey, { sessionId, generation }) {
    const entry = entryFor(botId, chatKey)
    if (entry.sessionId === sessionId) return entry
    pushHistory(entry)
    entry.sessionId = sessionId
    entry.generation = Number(generation) || 0
    entry.updatedAt = Date.now()
    entry.botId = botId
    persist()
    return entry
  }

  function entries() {
    load()
    return [...byKey.entries()].map(([key, entry]) => ({ key, ...entry }))
  }

  function entriesFor(botId) {
    return entries().filter(
      (entry) => entry.botId === botId || (entry.botId === undefined && botId === legacyBotId),
    )
  }

  /**
   * Every session id this conversation may switch to, current last.
   * @returns `[{ generation, sessionId, updatedAt, current }]`
   */
  function generationsFor(botId, chatKey) {
    const entry = entryFor(botId, chatKey)
    const rows = [{
      generation: Number(entry.generation) || 0,
      sessionId: entry.sessionId,
      updatedAt: Number(entry.updatedAt) || 0,
    }]
    for (const row of entry.history || []) {
      if (row.sessionId !== entry.sessionId) rows.push(row)
    }
    return rows
      .sort((a, b) => a.generation - b.generation)
      .map((row) => ({ ...row, current: row.sessionId === entry.sessionId }))
  }

  /** Which conversation currently holds a session id, across every bot. */
  function ownerOfSession(sessionId) {
    for (const entry of entries()) {
      if (entry.sessionId === sessionId) return entry
    }
    return undefined
  }

  return {
    peek,
    entryFor,
    touch,
    reset,
    bind,
    entries,
    entriesFor,
    generationsFor,
    ownerOfSession,
    get file() { return file },
  }
}
