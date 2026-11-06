/**
 * Bot set resolution: the flat single-bot config and the `bots[]` list are one
 * model, not two.
 *
 * Why a normalizer instead of duplicating every field: the flat config is the
 * production contract that predates multi-bot, and a second parallel code path
 * is how "the same rule in two places" drifts. Everything downstream reads
 * `{ id, baseUrl, tokenRef, token, channels, allowedUsers, ... }` and never has
 * to know which shape the operator wrote.
 *
 * The FIRST resolved bot owns the legacy session-key namespace `<kind>:<rest>`
 * (see mapping.js), so an existing deployment keeps every mapping and every
 * session id it already has. Later bots only ever use the `b<id>:` namespace.
 */

/** Bot ids become part of a durable map key, so they must be boring. */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/

/** The id the implicit single-bot configuration reports. */
export const LEGACY_BOT_ID = 'bot0'

/** Which flat-config fields a bot entry may inherit when it omits them. */
const INHERITED = [
  'channels',
  'freeResponseChannels',
  'requireMention',
  'allowedUsers',
  'allowAll',
  'allowBotMentions',
  'botChainMax',
  'botChainWindowMs',
]

function cloneList(value) {
  return Array.isArray(value) ? value.map(String) : []
}

/**
 * Resolve the effective bot list.
 *
 * @param config - the plugin config object (flat fields + optional `bots`).
 * @returns `[{ id, baseUrl, tokenRef, token, channels, freeResponseChannels,
 *   requireMention, allowedUsers, allowAll, allowBotMentions, botChainMax,
 *   botChainWindowMs, legacy }]` in configuration order.
 * @throws when two bots share an id, or an id is not `[A-Za-z0-9._-]`.
 */
export function resolveBots(config) {
  const raw = Array.isArray(config.bots) ? config.bots.filter((b) => b && typeof b === 'object') : []
  const flat = {
    baseUrl: String(config.baseUrl || ''),
    tokenRef: String(config.tokenRef || 'MATTERMOST_TOKEN'),
    token: String(config.token || ''),
    channels: cloneList(config.channels),
    freeResponseChannels: cloneList(config.freeResponseChannels),
    requireMention: config.requireMention !== false,
    allowedUsers: cloneList(config.allowedUsers),
    allowAll: Boolean(config.allowAll),
    allowBotMentions: config.allowBotMentions !== false,
    botChainMax: Number(config.botChainMax),
    botChainWindowMs: Number(config.botChainWindowMs),
  }

  if (raw.length === 0) {
    return [{ id: LEGACY_BOT_ID, ...flat, legacy: true }]
  }

  const bots = raw.map((entry, index) => {
    const id = String(entry.id || (index === 0 ? LEGACY_BOT_ID : `bot${index}`))
    const bot = {
      id,
      baseUrl: String(entry.baseUrl || flat.baseUrl || ''),
      tokenRef: String(entry.tokenRef || flat.tokenRef || 'MATTERMOST_TOKEN'),
      token: String(entry.token || ''),
      legacy: index === 0,
    }
    for (const field of INHERITED) {
      bot[field] = entry[field] === undefined || entry[field] === null ? flat[field] : entry[field]
    }
    // Arrays are copied so two bots can never alias one config array and then
    // mutate each other's authorization set at runtime.
    bot.channels = cloneList(bot.channels)
    bot.freeResponseChannels = cloneList(bot.freeResponseChannels)
    bot.allowedUsers = cloneList(bot.allowedUsers)
    bot.allowAll = Boolean(bot.allowAll)
    bot.requireMention = bot.requireMention !== false
    bot.allowBotMentions = bot.allowBotMentions !== false
    bot.botChainMax = Number(bot.botChainMax)
    bot.botChainWindowMs = Number(bot.botChainWindowMs)
    return bot
  })

  const seen = new Set()
  for (const bot of bots) {
    if (!ID_RE.test(bot.id)) {
      throw new Error(`bots: invalid bot id ${JSON.stringify(bot.id)} (must match ${ID_RE})`)
    }
    if (seen.has(bot.id)) throw new Error(`bots: duplicate bot id ${JSON.stringify(bot.id)}`)
    seen.add(bot.id)
  }
  return bots
}
