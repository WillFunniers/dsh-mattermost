/**
 * Approval Bridge A1.1 — where a WEB-origin approval request may be announced,
 * and whether that place is allowed to CARRY A DECISION.
 *
 * Scope: decide a destination and a MODE. It does not post, does not settle and
 * does not decide who may approve; `approvals.js` consumes the result.
 *
 * The rule this file exists to enforce:
 *
 *   An actionable approval card may only be delivered to a VERIFIED one-to-one
 *   Mattermost DM whose single peer is the single configured approver.
 *
 * Everything else — a public/private channel, a group DM, a thread, a DM whose
 * peer is somebody else, a configuration with several approvers, a target whose
 * membership cannot be read — either gets a NON-DECIDABLE notice or nothing at
 * all. A notice carries no request id, no tool name and no arguments, so it can
 * never be turned into a decision and reveals nothing about the operation.
 *
 * Why the strictness: a chat key is written as `dm:<channelId>` when the channel
 * was created as a DM, but that says nothing about how many people can read it
 * today (`type: 'G'` group DMs exist, and membership can change). Only the
 * channel's type AND its member list can answer "is this one-to-one", so both
 * are required before a decision is offered.
 *
 * Priority (first match wins):
 *   P1 `webApproval.channel`            explicit fixed conversation
 *   P2 `webApproval.binding[botId]`     explicit per-bot conversation
 *   P3 `webApproval.auto`               single-user automatic route
 *   P4 nothing                          no announcement, Web prompt untouched
 *
 * P1/P2 are operator statements. If an explicit statement is unusable the route
 * STOPS (it never falls back to guessing); only P3 is inference, and it is
 * bounded by the guards below.
 */

import { readFileSync } from 'node:fs'

/** Announcement modes. Only `actionable` may register a decision route. */
export const NOTIFY_MODE = Object.freeze({
  /** A card with ✅/❌ and `/approve <id>` — DM only, approver only. */
  ACTIONABLE: 'actionable',
  /** A notice that says "go to the Web UI": no id, no tool, no arguments. */
  NOTIFICATION_ONLY: 'notification-only',
  /** Nothing is sent; the Web prompt answers exactly as it does today. */
  NONE: 'none',
})

/** What the resolved conversation actually is. */
export const TARGET_KIND = Object.freeze({
  DM: 'dm',
  GROUP_DM: 'group-dm',
  CHANNEL: 'channel',
  THREAD: 'thread',
  UNKNOWN: 'unknown',
})

/** Announcement priorities, in evaluation order. */
export const ROUTE_PRIORITY = Object.freeze(['channel', 'binding', 'auto'])

/** Conversation kinds a chat key can name (see mapping.js `deriveKey`). */
const CHAT_KINDS = new Set(['ch', 'dm', 'th'])

/**
 * Why a route was refused, or why it is not actionable. Stable strings: tests
 * and log greps depend on them.
 */
export const ROUTE_REASON = Object.freeze({
  /** No approvers configured, or startup validation rejected the config. */
  DISABLED: 'disabled',
  /** `webApproval.channel` is not a usable channel reference. */
  INVALID_CHANNEL_CONFIG: 'invalid-channel-config',
  /** The bound conversation is not in the session map (or has no channel). */
  BINDING_INVALID: 'binding-invalid',
  /** P1/P2/P3 resolved a conversation. */
  DM_TARGET: 'dm-target',
  CHANNEL_TARGET: 'channel-target',
  GROUP_DM_TARGET: 'group-dm-target',
  THREAD_TARGET: 'thread-target',
  /** The channel/member lookup failed or did not answer the question. */
  PEER_UNVERIFIED: 'peer-unverified',
  /** A verified DM, but its peer is not the single configured approver. */
  APPROVER_MISMATCH: 'approver-mismatch',
  /** More than one approver: nobody can be picked as THE recipient. */
  MULTIPLE_APPROVERS: 'multiple-approvers',
  /** G1: `web-auth.json` is absent or describes more than one principal. */
  NO_WEB_PRINCIPAL: 'no-web-principal',
  MULTI_PRINCIPAL: 'multi-principal',
  /** G2: the bot's `allowedUsers` is empty, `allowAll`, or more than one id. */
  NO_ALLOWED_USERS: 'no-allowed-users',
  /** G3: the bot never served anyone, or served more than one id. */
  NO_USER: 'no-user',
  MULTI_USER: 'multi-user',
  /** G3b: the single served user is not the single allowed user. */
  IDENTITY_MISMATCH: 'identity-mismatch',
  /** No conversation for that user, or more than one (never "pick the newest"). */
  NO_CANDIDATE: 'no-candidate',
  AMBIGUOUS_CANDIDATES: 'ambiguous-candidates',
  /** The only candidate is older than `ttlMs`. */
  STALE: 'stale',
  /** The candidate channel is outside the bot's configured channel list. */
  CHANNEL_NOT_SERVED: 'channel-not-served',
  /** `describeChannel` failed (deleted channel, no membership, outage). */
  CHANNEL_UNREACHABLE: 'channel-unreachable',
})

export const DEFAULT_WEB_APPROVAL = Object.freeze({
  channel: '',
  binding: {},
  auto: false,
  /** 24h: long enough for a daily user, short enough that a dormant chat expires. */
  ttlMs: 24 * 60 * 60 * 1_000,
  approvers: [],
})

const MIN_TTL_MS = 60_000
const MAX_TTL_MS = 30 * 24 * 60 * 60 * 1_000

/** Coerce whatever the loader produced into the documented shape. */
export function normalizeWebApproval(raw) {
  const value = raw && typeof raw === 'object' ? raw : {}
  const binding = {}
  if (value.binding && typeof value.binding === 'object' && !Array.isArray(value.binding)) {
    for (const [botId, chatKey] of Object.entries(value.binding)) {
      const id = String(botId || '').trim()
      const key = String(chatKey || '').trim()
      if (id && key) binding[id] = key
    }
  }
  const ttl = Number(value.ttlMs)
  return {
    channel: String(value.channel || '').trim(),
    binding,
    auto: value.auto === true,
    ttlMs: Number.isFinite(ttl) ? Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, ttl)) : DEFAULT_WEB_APPROVAL.ttlMs,
    approvers: Array.isArray(value.approvers)
      ? [...new Set(value.approvers.map((u) => String(u || '').trim()).filter(Boolean))]
      : [],
  }
}

/**
 * How many Web principals this DSH home serves.
 *
 * `web-auth.json` holds ONE local account today (VERIFIED); a future version may
 * hold several, and this deployment has no mapping between them and Mattermost
 * ids. Counting is therefore the only honest input: exactly 1 lets the automatic
 * route proceed, 0 or more than 1 must refuse it.
 *
 * A missing or unreadable file counts as 0, never as 1: the automatic route is
 * the only consumer, and there "unknown" has to fail closed.
 */
export function countWebPrincipals(file) {
  if (!file) return 0
  let raw
  try { raw = readFileSync(file, 'utf8') } catch { return 0 }
  try {
    const data = JSON.parse(raw)
    if (!data || typeof data !== 'object') return 0
    if (Array.isArray(data.users)) return data.users.length
    // Current shape: a single top-level account (`username`, `passwordHash`).
    if (typeof data.username === 'string' && data.username) return 1
    return 0
  } catch { return 0 }
}

/** One-line, log-safe description of the routing configuration. */
export function describeWebApproval(webApproval, { enabled, problems = [] } = {}) {
  const wa = normalizeWebApproval(webApproval)
  const bindings = Object.keys(wa.binding).length
  return [
    `enabled=${enabled ? 'yes' : 'no'}`,
    `channel=${wa.channel ? 'set' : 'unset'}`,
    `bindings=${bindings}`,
    `auto=${wa.auto ? 'on' : 'off'}`,
    `ttlMs=${wa.ttlMs}`,
    `approvers=${wa.approvers.length}`,
    'mode=dm-only',
    problems.length ? `problems=${problems.join(';')}` : 'problems=none',
  ].join(' ')
}

/**
 * Startup validation. Fail closed: a configuration that widens authorization
 * beyond `allowedUsers` must never take effect, not even partially.
 *
 * The approver list is global while `allowedUsers` is per bot, so the list must
 * be a subset of EVERY bot's allowed set. A single bot deployment (the only
 * shape that exists today) makes this identical to the documented rule.
 *
 * @returns `{ ok, problems }` — `problems` are log-safe strings, no user data
 *   beyond 8-char id prefixes.
 */
export function validateWebApproval({ webApproval, bots = [] }) {
  const wa = normalizeWebApproval(webApproval)
  const problems = []
  if (wa.approvers.length === 0) return { ok: true, problems: [] }
  for (const bot of bots) {
    const allowed = new Set((Array.isArray(bot.allowedUsers) ? bot.allowedUsers : []).map((u) => String(u)))
    if (bot.allowAll) {
      problems.push(`bot ${bot.id}: allowAll=true has no allow-list to bound approvers`)
      continue
    }
    for (const user of wa.approvers) {
      if (!allowed.has(user)) problems.push(`bot ${bot.id}: approver ${String(user).slice(0, 8)} not in allowedUsers`)
    }
  }
  return { ok: problems.length === 0, problems }
}

/**
 * Split a session-map key into its bot and conversation halves.
 * A bare key (written before multi-bot existed) belongs to the legacy bot.
 */
export function splitScopedKey(storedKey, legacyBotId = 'bot0') {
  const text = String(storedKey || '')
  const colon = text.indexOf(':')
  if (colon > 1 && text.startsWith('b')) {
    return { botId: text.slice(1, colon), chatKey: text.slice(colon + 1) }
  }
  return { botId: legacyBotId, chatKey: text }
}

/** `ch:<id>` / `dm:<id>` / `th:<root>` → `{ kind, id }`, or undefined. */
export function parseChatKey(chatKey) {
  const text = String(chatKey || '')
  const colon = text.indexOf(':')
  if (colon <= 0) return undefined
  const kind = text.slice(0, colon)
  const id = text.slice(colon + 1)
  if (!CHAT_KINDS.has(kind) || !id) return undefined
  return { kind, id }
}

/**
 * Turn `webApproval.channel` into a channel id.
 * Accepts a raw id and the `ch:` / `dm:` chat-key forms; a thread key is not a
 * channel, so it is rejected rather than guessed at.
 */
export function resolveFixedChannel(value) {
  const text = String(value || '').trim()
  if (!text) return undefined
  const parsed = parseChatKey(text)
  if (!parsed) return { channelId: text }
  if (parsed.kind === 'th') return undefined
  return { channelId: parsed.id }
}

/**
 * Classify one conversation from the CHANNEL RECORD and its MEMBERS — never from
 * the chat-key prefix.
 *
 * @param channel - `{ id, type, name? }` from `GET /channels/{id}`
 * @param memberIds - `string[]` from `GET /channels/{id}/members`; required for
 *   `D`/`G`, ignored otherwise
 * @param botUserId - the bot's own id, excluded from the peer count
 * @param rootId - present means the message will be a thread reply
 * @returns `{ kind, peerUserId?, oneToOne, verified, members }`
 */
export function classifyChannelTarget({ channel, memberIds, botUserId, rootId } = {}) {
  const type = String(channel?.type || '')
  const members = Array.isArray(memberIds) ? memberIds.map(String) : null
  const base = { oneToOne: false, verified: false, members: members || [] }
  if (!channel || !channel.id) return { ...base, kind: TARGET_KIND.UNKNOWN }
  // A thread reply is never a decision surface, whatever the channel is: a
  // thread can be shared, and the requirement is explicit about threads.
  if (rootId) return { ...base, kind: TARGET_KIND.THREAD, verified: type === 'D' || type === 'G' }
  if (type === 'G') return { ...base, kind: TARGET_KIND.GROUP_DM, verified: true }
  if (type === 'O' || type === 'P') return { ...base, kind: TARGET_KIND.CHANNEL, verified: true }
  if (type !== 'D') return { ...base, kind: TARGET_KIND.UNKNOWN }
  if (!members || !botUserId) return { ...base, kind: TARGET_KIND.DM }
  const peers = members.filter((id) => id !== String(botUserId))
  if (peers.length > 1) return { ...base, kind: TARGET_KIND.GROUP_DM, verified: true }
  if (peers.length !== 1) return { ...base, kind: TARGET_KIND.DM }
  return {
    kind: TARGET_KIND.DM,
    peerUserId: peers[0],
    oneToOne: true,
    verified: true,
    members,
  }
}

function none(reason, extra = {}) {
  return { mode: NOTIFY_MODE.NONE, reason, ...extra }
}

/**
 * Resolve where a Web-origin request for `botId` would be announced, and whether
 * that destination may carry a decision.
 *
 * Pure except for the injected `describeChannel(channelId)` probe, which returns
 * `{ id, type, memberIds }` or undefined. Omitting it means "cannot verify", and
 * an unverifiable destination is never actionable.
 *
 * @returns `{ mode, reason, priority?, channelId?, rootId?, chatKey?, chatKind?,
 *   targetKind?, peerUserId?, oneToOne?, peerVerified?, approverMatch?,
 *   approverCount }`
 */
export async function resolveWebRoute({
  botId,
  botUserId,
  webApproval,
  entries = [],
  allowedUsers = [],
  channels = [],
  principalCount = 0,
  now = Date.now(),
  describeChannel,
} = {}) {
  const wa = normalizeWebApproval(webApproval)
  const approverCount = wa.approvers.length
  const approvers = wa.approvers
  if (approverCount === 0) return none(ROUTE_REASON.DISABLED, { approverCount, approvers })

  const target = await resolveTarget({ botId, webApproval: wa, entries, allowedUsers, channels, principalCount, now, describeChannel })
  if (!target.ok) return none(target.reason, { ...target.detail, approverCount, approvers })

  const channel = typeof describeChannel === 'function' ? await probe(describeChannel, target.channelId) : undefined
  if (!channel) {
    // A destination we cannot classify is a destination we cannot trust with a
    // decision. It is also not worth a notice: we do not know who would read it.
    return none(ROUTE_REASON.CHANNEL_UNREACHABLE, { ...common(target), approverCount, approvers })
  }
  if (channel.type === 'D' && !channel.memberIds) {
    // A DM without membership data cannot be proven one-to-one.
    return none(ROUTE_REASON.PEER_UNVERIFIED, { ...common(target), approverCount, approvers })
  }

  const classified = classifyChannelTarget({
    channel,
    memberIds: channel.memberIds,
    botUserId,
    rootId: target.rootId,
  })
  const shape = {
    ...common(target),
    // A fixed-channel target has no stored chat key; derive it from what the
    // channel actually is, so the record/status do not claim `ch:` for a DM.
    ...(target.priority === 'channel'
      ? {
          chatKey: classified.kind === TARGET_KIND.DM ? `dm:${target.channelId}` : `ch:${target.channelId}`,
          chatKind: classified.kind === TARGET_KIND.DM ? 'dm' : 'ch',
        }
      : {}),
    targetKind: classified.kind,
    oneToOne: classified.oneToOne,
    peerVerified: classified.verified,
    approverMatch: classified.oneToOne ? classified.peerUserId === wa.approvers[0] : false,
    approverCount,
    approvers,
  }

  // Two or more approvers: there is no single reader to hand a decision to.
  if (approverCount > 1) {
    return { ...shape, mode: NOTIFY_MODE.NOTIFICATION_ONLY, reason: ROUTE_REASON.MULTIPLE_APPROVERS }
  }

  if (classified.kind === TARGET_KIND.THREAD) {
    return { ...shape, mode: NOTIFY_MODE.NOTIFICATION_ONLY, reason: ROUTE_REASON.THREAD_TARGET }
  }
  if (classified.kind === TARGET_KIND.GROUP_DM) {
    return { ...shape, mode: NOTIFY_MODE.NOTIFICATION_ONLY, reason: ROUTE_REASON.GROUP_DM_TARGET }
  }
  if (classified.kind === TARGET_KIND.CHANNEL) {
    return { ...shape, mode: NOTIFY_MODE.NOTIFICATION_ONLY, reason: ROUTE_REASON.CHANNEL_TARGET }
  }
  if (classified.kind !== TARGET_KIND.DM || !classified.oneToOne) {
    return none(ROUTE_REASON.PEER_UNVERIFIED, shape)
  }
  if (!shape.approverMatch) {
    // Notifying a non-approver about a pending approval is noise at best and a
    // disclosure at worst: send nothing.
    return none(ROUTE_REASON.APPROVER_MISMATCH, shape)
  }
  return { ...shape, mode: NOTIFY_MODE.ACTIONABLE, reason: ROUTE_REASON.DM_TARGET }
}

function common(target) {
  return {
    priority: target.priority,
    channelId: target.channelId,
    rootId: target.rootId,
    chatKey: target.chatKey,
    chatKind: target.chatKind,
  }
}

async function probe(describeChannel, channelId) {
  try {
    const channel = await describeChannel(channelId)
    if (!channel || !channel.id) return undefined
    return {
      id: String(channel.id),
      type: String(channel.type || ''),
      memberIds: Array.isArray(channel.memberIds) ? channel.memberIds.map(String) : undefined,
    }
  } catch {
    return undefined
  }
}

/** P1 → P2 → P3. Returns a destination or a refusal reason; no mode logic here. */
async function resolveTarget({ botId, webApproval, entries, allowedUsers, channels, principalCount, now }) {
  const wa = webApproval

  // ---- P1: fixed conversation ---------------------------------------------
  if (wa.channel) {
    const fixed = resolveFixedChannel(wa.channel)
    if (!fixed) return { ok: false, reason: ROUTE_REASON.INVALID_CHANNEL_CONFIG }
    return { ok: true, priority: 'channel', channelId: fixed.channelId, rootId: undefined, chatKey: `ch:${fixed.channelId}`, chatKind: 'ch' }
  }

  // ---- P2: explicit per-bot binding ---------------------------------------
  const bound = wa.binding[botId]
  if (bound) {
    const parsed = parseChatKey(bound)
    // A binding that is not a chat key is a configuration error, not a hint.
    if (!parsed) return { ok: false, reason: ROUTE_REASON.BINDING_INVALID, detail: { chatKey: bound } }
    const entry = entries.find((row) => {
      const owner = splitScopedKey(row.key, botId)
      return owner.botId === botId && owner.chatKey === bound
    })
    if (!entry || !entry.channelId) return { ok: false, reason: ROUTE_REASON.BINDING_INVALID, detail: { chatKey: bound } }
    return {
      ok: true,
      priority: 'binding',
      channelId: entry.channelId,
      rootId: entry.rootId || undefined,
      chatKey: bound,
      chatKind: parsed.kind,
    }
  }

  // ---- P3: single-user automatic route ------------------------------------
  if (!wa.auto) return { ok: false, reason: ROUTE_REASON.NO_CANDIDATE }

  // G1 — one local Web principal.
  if (principalCount === 0) return { ok: false, reason: ROUTE_REASON.NO_WEB_PRINCIPAL }
  if (principalCount > 1) return { ok: false, reason: ROUTE_REASON.MULTI_PRINCIPAL, detail: { principals: principalCount } }

  // G2 — one allowed user for this bot.
  if (!Array.isArray(allowedUsers) || allowedUsers.length !== 1) {
    return { ok: false, reason: ROUTE_REASON.NO_ALLOWED_USERS, detail: { allowed: Array.isArray(allowedUsers) ? allowedUsers.length : 0 } }
  }
  const allowedUser = String(allowedUsers[0])

  // Only scoped keys carry a trustworthy bot id and `updatedAt`; a bare key is
  // the same conversation under a legacy name and is skipped here (it is still
  // reachable through the scoped mirror).
  const prefix = `b${botId}:`
  const rows = []
  for (const entry of entries) {
    const key = String(entry && entry.key || '')
    if (!key.startsWith(prefix)) continue
    if (!entry.channelId) continue
    rows.push({
      chatKey: key.slice(prefix.length),
      sessionId: String(entry.sessionId || ''),
      userId: entry.userId ? String(entry.userId) : '',
      channelId: String(entry.channelId),
      rootId: entry.rootId || undefined,
      updatedAt: Number(entry.updatedAt) || 0,
    })
  }

  // Nothing was ever served here: that is an empty candidate set, not a user
  // distinctness problem, and the reason string should say so.
  if (rows.length === 0) return { ok: false, reason: ROUTE_REASON.NO_CANDIDATE }

  // G3 — exactly one user id ever served by this bot.
  const userIds = new Set(rows.map((row) => row.userId).filter(Boolean))
  if (userIds.size === 0) return { ok: false, reason: ROUTE_REASON.NO_USER }
  if (userIds.size > 1) return { ok: false, reason: ROUTE_REASON.MULTI_USER, detail: { users: userIds.size } }
  const userId = [...userIds][0]
  if (userId !== allowedUser) return { ok: false, reason: ROUTE_REASON.IDENTITY_MISMATCH }

  // One conversation per session id; the newest row of a session wins.
  const bySession = new Map()
  for (const row of rows) {
    if (row.userId !== userId) continue
    if (!parseChatKey(row.chatKey)) continue
    const previous = bySession.get(row.sessionId)
    if (previous && previous.updatedAt >= row.updatedAt) continue
    bySession.set(row.sessionId, row)
  }
  const candidates = [...bySession.values()].filter((row) => row.sessionId)
  if (candidates.length === 0) return { ok: false, reason: ROUTE_REASON.NO_CANDIDATE }
  if (candidates.length > 1) return { ok: false, reason: ROUTE_REASON.AMBIGUOUS_CANDIDATES, detail: { candidates: candidates.length } }

  const candidate = candidates[0]
  if (now - candidate.updatedAt > wa.ttlMs) return { ok: false, reason: ROUTE_REASON.STALE, detail: { ageMs: now - candidate.updatedAt } }
  if (Array.isArray(channels) && channels.length > 0 && !channels.includes(candidate.channelId)) {
    return { ok: false, reason: ROUTE_REASON.CHANNEL_NOT_SERVED }
  }

  return {
    ok: true,
    priority: 'auto',
    channelId: candidate.channelId,
    rootId: candidate.rootId,
    chatKey: candidate.chatKey,
    chatKind: String(candidate.chatKey).split(':')[0],
  }
}
