/**
 * Mattermost identity -> chatKey -> DSH sessionId.
 *
 * This is the ONLY place that builds session ids. Nothing else may concatenate
 * one, so the mapping stays auditable and stable across restarts.
 *
 * Mapping rules
 *   DM                         chatKey = dm:<channel_id>
 *   channel root post          chatKey = ch:<channel_id>          (continuous chat, reused)
 *   any thread reply           chatKey = th:<root_post_id>        (one thread = one task context)
 *   explicit /task in a root   chatKey = th:<command_post_id>     (a new thread, hence a new session)
 *
 * Because a `/task` starts a thread whose root is the command post, the thread
 * rule above resolves every later reply to the same session with no alias table.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Derive the conversation key from a Mattermost post + its channel. */
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

export function sessionIdFor(key, generation = 0) {
  const base = `mm-${createHash('sha1').update(key).digest('hex').slice(0, 16)}`
  return generation > 0 ? `${base}-v${generation}` : base
}

/**
 * Durable chatKey -> sessionId map with per-key generation history.
 * Generation N is produced by /new so a fresh conversation gets a fresh session
 * without losing the previous one (still resumable from disk by DSH).
 */
export function createSessionMap({ file, logger }) {
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
          if (entry && typeof entry.sessionId === 'string') byKey.set(key, entry)
        }
      }
    } catch (error) {
      logger.warn(`session map load failed (${file}): ${error.message}`)
    }
  }

  /** Atomic write: temp file + rename, so a kill can never leave a torn map. */
  function persist() {
    try {
      mkdirSync(dirname(file), { recursive: true })
      const payload = { version: 1, entries: Object.fromEntries(byKey) }
      const tmp = `${file}.tmp`
      writeFileSync(tmp, JSON.stringify(payload, null, 2))
      renameSync(tmp, file)
    } catch (error) {
      logger.warn(`session map save failed (${file}): ${error.message}`)
    }
  }

  function entryFor(key) {
    load()
    let entry = byKey.get(key)
    if (!entry) {
      entry = { sessionId: sessionIdFor(key, 0), generation: 0, createdAt: Date.now(), updatedAt: Date.now() }
      byKey.set(key, entry)
      persist()
    }
    return entry
  }

  function touch(key, meta) {
    const entry = entryFor(key)
    Object.assign(entry, meta || {}, { updatedAt: Date.now() })
    persist()
    return entry
  }

  /** Bump to a fresh session id for this key. Returns the new entry. */
  function reset(key) {
    const entry = entryFor(key)
    const generation = (Number(entry.generation) || 0) + 1
    entry.generation = generation
    entry.sessionId = sessionIdFor(key, generation)
    entry.updatedAt = Date.now()
    persist()
    return entry
  }

  function entries() {
    load()
    return [...byKey.entries()].map(([key, entry]) => ({ key, ...entry }))
  }

  return { entryFor, touch, reset, entries }
}
