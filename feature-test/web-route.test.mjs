// Web-origin approval routing (Approval Bridge A1.1).
//
// The contract under test is a MODE, not just a destination:
//
//   actionable        a verified one-to-one DM whose single peer IS the single
//                     approver — the only place a decision may be offered
//   notification-only a channel, group DM or thread — a notice with no id
//   none              nothing at all
//
// The classification must come from the Mattermost channel record and its
// member list, never from the `dm:` chat-key prefix: a channel created as a DM
// can be a group DM (`type: 'G'`) or can gain a third member.
//
// Run: node --test feature-test/web-route.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_WEB_APPROVAL,
  NOTIFY_MODE,
  TARGET_KIND,
  ROUTE_PRIORITY,
  ROUTE_REASON,
  normalizeWebApproval,
  validateWebApproval,
  describeWebApproval,
  resolveWebRoute,
  classifyChannelTarget,
  countWebPrincipals,
  parseChatKey,
  splitScopedKey,
  resolveFixedChannel,
} from '../web-route.js'
import { Config } from '../index.js'

const HOUR = 60 * 60 * 1_000
const NOW = Date.parse('2026-11-03T00:00:00Z')
const BOT = 'bot0'
const BOT_USER = 'botuser0'
const ALLOWED = ['u1']
const APPROVER = 'u1'
// The DM peer must BE the approver for the route to be actionable.
const PEER = 'u1'

/** A channel descriptor as the router expects it (already fetched). */
function dm({ members = [BOT_USER, PEER], type = 'D', id = 'dmchan1' } = {}) {
  return { id, type, memberIds: members }
}
function channel({ type = 'O', id = 'chan1' } = {}) {
  return { id, type }
}
function groupDm({ members = [BOT_USER, PEER, 'peer2'], id = 'gdm1' } = {}) {
  return { id, type: 'G', memberIds: members }
}

/** One session-map row, in the same shape `sessionMap.entries()` produces. */
function row({
  botId = BOT,
  chatKey = 'dm:dmchan1',
  sessionId = 's1',
  userId = APPROVER,
  channelId = 'dmchan1',
  rootId,
  updatedAt = NOW,
} = {}) {
  return { key: `b${botId}:${chatKey}`, sessionId, userId, channelId, rootId, updatedAt }
}

function cfg(overrides = {}) {
  return { channel: '', binding: {}, auto: false, ttlMs: 24 * HOUR, approvers: [APPROVER], ...overrides }
}

/** Resolve with a DM-by-default world; override `byId` for other shapes. */
function route({
  webApproval = cfg({ auto: true }),
  entries = [row()],
  allowedUsers = ALLOWED,
  channels = [],
  principalCount = 1,
  now = NOW,
  byId = { dmchan1: dm() },
  botId = BOT,
} = {}) {
  return resolveWebRoute({
    botId,
    botUserId: BOT_USER,
    webApproval,
    entries,
    allowedUsers,
    channels,
    principalCount,
    now,
    describeChannel: async (channelId) => byId[channelId],
  })
}

// ------------------------------------------------------------ configuration ---

test('A-01a: a missing webApproval section means the feature is OFF', () => {
  const wa = normalizeWebApproval(undefined)
  assert.deepEqual(wa, {
    channel: '', binding: {}, auto: false, ttlMs: DEFAULT_WEB_APPROVAL.ttlMs, approvers: [],
  })
})

test('A-01b: the plugin config schema defaults to OFF, not to a guessed destination', () => {
  const resolved = Config({})
  assert.deepEqual(resolved.webApproval, {
    channel: '', binding: {}, auto: false, ttlMs: 24 * HOUR, approvers: [],
  })
  assert.equal(resolved.approvalCardArguments, 'off')
})

test('A-01c: with no approvers nothing is announced, whatever else is configured', async () => {
  const result = await route({
    webApproval: { channel: 'dmchan1', binding: { [BOT]: 'dm:dmchan1' }, auto: true, ttlMs: HOUR, approvers: [] },
  })
  assert.deepEqual(result, { mode: NOTIFY_MODE.NONE, reason: ROUTE_REASON.DISABLED, approverCount: 0, approvers: [] })
})

test('normalize clamps the TTL and drops unusable binding/approver entries', () => {
  const wa = normalizeWebApproval({
    channel: '  chan-1  ',
    binding: { [BOT]: 'ch:chan1', '': 'ch:x', bot2: '' },
    auto: 'yes',
    ttlMs: 5,
    approvers: [' u1 ', 'u1', '', 'u2'],
  })
  assert.equal(wa.channel, 'chan-1')
  assert.deepEqual(wa.binding, { [BOT]: 'ch:chan1' })
  assert.equal(wa.auto, false)
  assert.equal(wa.ttlMs, 60_000)
  assert.deepEqual(wa.approvers, ['u1', 'u2'])
})

test('the TTL has an upper bound as well', () => {
  assert.equal(normalizeWebApproval({ ttlMs: 10 * 365 * 24 * HOUR }).ttlMs, 30 * 24 * HOUR)
})

test('chat keys parse into kind + id, and only known kinds are accepted', () => {
  assert.deepEqual(parseChatKey('ch:abc'), { kind: 'ch', id: 'abc' })
  assert.deepEqual(parseChatKey('dm:abc'), { kind: 'dm', id: 'abc' })
  assert.deepEqual(parseChatKey('th:abc'), { kind: 'th', id: 'abc' })
  assert.equal(parseChatKey('xx:abc'), undefined)
  assert.equal(parseChatKey('chan1'), undefined)
  assert.equal(parseChatKey('ch:'), undefined)
})

test('a scoped key splits into its bot and conversation; a bare key is the legacy bot', () => {
  assert.deepEqual(splitScopedKey('bbot0:ch:chan1', 'legacy'), { botId: 'bot0', chatKey: 'ch:chan1' })
  assert.deepEqual(splitScopedKey('ch:chan1', 'legacy'), { botId: 'legacy', chatKey: 'ch:chan1' })
  assert.deepEqual(splitScopedKey('bba:th:r1:x', 'legacy'), { botId: 'ba', chatKey: 'th:r1:x' })
})

test('a fixed channel accepts an id and the ch:/dm: forms, but never a thread key', () => {
  assert.deepEqual(resolveFixedChannel('chan1'), { channelId: 'chan1' })
  assert.deepEqual(resolveFixedChannel('ch:chan1'), { channelId: 'chan1' })
  assert.deepEqual(resolveFixedChannel('dm:chan2'), { channelId: 'chan2' })
  assert.equal(resolveFixedChannel('th:root1'), undefined)
  assert.equal(resolveFixedChannel('   '), undefined)
})

// ------------------------------------------------------- target classification ---

test('C-01: a DM channel with exactly one peer is one-to-one', () => {
  const classified = classifyChannelTarget({ channel: { id: 'd1', type: 'D' }, memberIds: [BOT_USER, PEER], botUserId: BOT_USER })
  assert.equal(classified.kind, TARGET_KIND.DM)
  assert.equal(classified.oneToOne, true)
  assert.equal(classified.peerUserId, PEER)
})

test('C-02: `dm:` prefix is NOT enough — a group DM is not one-to-one', () => {
  const classified = classifyChannelTarget({ channel: { id: 'g1', type: 'G' }, memberIds: [BOT_USER, PEER, 'peer2'], botUserId: BOT_USER })
  assert.equal(classified.kind, TARGET_KIND.GROUP_DM)
  assert.equal(classified.oneToOne, false)
})

test('C-03: a type-D channel that gained a third member is not one-to-one', () => {
  const classified = classifyChannelTarget({ channel: { id: 'd2', type: 'D' }, memberIds: [BOT_USER, PEER, 'peer2'], botUserId: BOT_USER })
  assert.equal(classified.oneToOne, false)
})

test('C-04: a DM without membership data cannot be proven one-to-one', () => {
  const classified = classifyChannelTarget({ channel: { id: 'd3', type: 'D' }, memberIds: undefined, botUserId: BOT_USER })
  assert.equal(classified.kind, TARGET_KIND.DM)
  assert.equal(classified.oneToOne, false)
  assert.equal(classified.verified, false)
})

test('C-05: public and private channels are channels; a thread reply is a thread', () => {
  assert.equal(classifyChannelTarget({ channel: { id: 'p', type: 'P' } }).kind, TARGET_KIND.CHANNEL)
  assert.equal(classifyChannelTarget({ channel: { id: 'd', type: 'D' }, memberIds: [BOT_USER, PEER], botUserId: BOT_USER, rootId: 'r1' }).kind, TARGET_KIND.THREAD)
})

// ------------------------------------------------------------------ priority ---

test('A-02a: the fixed DM wins over a binding and over a valid automatic candidate', async () => {
  const result = await route({
    webApproval: cfg({ channel: 'dmchan1', binding: { [BOT]: 'dm:dmchan1' }, auto: true }),
  })
  assert.equal(result.mode, NOTIFY_MODE.ACTIONABLE)
  assert.equal(result.priority, 'channel')
  assert.equal(result.targetKind, TARGET_KIND.DM)
})

test('A-02b: a fixed channel with an unusable reference is refused, not repaired', async () => {
  const result = await route({ webApproval: cfg({ channel: 'th:root1' }) })
  assert.equal(result.mode, NOTIFY_MODE.NONE)
  assert.equal(result.reason, ROUTE_REASON.INVALID_CHANNEL_CONFIG)
})

test('A-02c: a fixed conversation that cannot be fetched refuses the route', async () => {
  const result = await route({ webApproval: cfg({ channel: 'gone' }), byId: {} })
  assert.equal(result.mode, NOTIFY_MODE.NONE)
  assert.equal(result.reason, ROUTE_REASON.CHANNEL_UNREACHABLE)
})

test('A-03a: an explicit per-bot binding to a one-to-one DM is actionable', async () => {
  const result = await route({ webApproval: cfg({ binding: { [BOT]: 'dm:dmchan1' } }) })
  assert.equal(result.mode, NOTIFY_MODE.ACTIONABLE)
  assert.equal(result.priority, 'binding')
  assert.equal(result.channelId, 'dmchan1')
  assert.equal(result.chatKind, 'dm')
})

test('A-03b: a binding for ANOTHER bot is not this bot\'s binding', async () => {
  const result = await route({ webApproval: cfg({ binding: { bot2: 'ch:chan1' }, auto: true }) })
  assert.equal(result.priority, 'auto')
})

test('A-03c: a binding that is not a chat key is a configuration error', async () => {
  const result = await route({ webApproval: cfg({ binding: { [BOT]: 'chan1' } }) })
  assert.equal(result.reason, ROUTE_REASON.BINDING_INVALID)
})

test('A-03d: a binding with no session-map entry refuses and does NOT fall back to inference', async () => {
  const result = await route({
    webApproval: cfg({ binding: { [BOT]: 'dm:never-seen' }, auto: true }),
    entries: [row()],
  })
  assert.equal(result.mode, NOTIFY_MODE.NONE)
  assert.equal(result.reason, ROUTE_REASON.BINDING_INVALID)
  assert.equal(result.priority, undefined)
})

test('A-03e: a binding to a thread is a notice, never a decision surface', async () => {
  const result = await route({
    webApproval: cfg({ binding: { [BOT]: 'th:root9' } }),
    entries: [row({ chatKey: 'th:root9', sessionId: 's9', channelId: 'dmchan1', rootId: 'root9' })],
  })
  assert.equal(result.mode, NOTIFY_MODE.NOTIFICATION_ONLY)
  assert.equal(result.reason, ROUTE_REASON.THREAD_TARGET)
  assert.equal(result.rootId, 'root9')
})

// ------------------------------------------------------------- automatic route ---

test('A-04a: one DM candidate for the single allowed user is actionable', async () => {
  const result = await route()
  assert.equal(result.mode, NOTIFY_MODE.ACTIONABLE)
  assert.equal(result.priority, 'auto')
  assert.equal(result.channelId, 'dmchan1')
  assert.equal(result.oneToOne, true)
  assert.equal(result.approverMatch, true)
})

test('A-04b: mirrored rows of ONE session count once, and the newest row wins', async () => {
  const result = await route({
    entries: [
      row({ sessionId: 's1', updatedAt: NOW - 2 * HOUR }),
      row({ sessionId: 's1', updatedAt: NOW - HOUR }),
    ],
  })
  assert.equal(result.mode, NOTIFY_MODE.ACTIONABLE)
})

test('A-04c: a bare (legacy) key is ignored — only the scoped mirror is authoritative', async () => {
  const result = await route({
    entries: [
      { key: 'dm:dmchan1', sessionId: 'legacy', userId: APPROVER, channelId: 'dmchan1', updatedAt: NOW - 30 * HOUR },
      row({ updatedAt: NOW - HOUR }),
    ],
  })
  assert.equal(result.mode, NOTIFY_MODE.ACTIONABLE)
})

test('A-05: no candidate means no announcement', async () => {
  const result = await route({ entries: [] })
  assert.deepEqual(result, { mode: NOTIFY_MODE.NONE, reason: ROUTE_REASON.NO_CANDIDATE, approverCount: 1, approvers: [APPROVER] })
})

test('A-06: two candidate conversations are ambiguous (never "newest wins")', async () => {
  const result = await route({
    entries: [
      row({ channelId: 'dmchan1', sessionId: 's1', updatedAt: NOW }),
      row({ chatKey: 'dm:dmchan2', channelId: 'dmchan2', sessionId: 's2', updatedAt: NOW - HOUR }),
    ],
  })
  assert.equal(result.mode, NOTIFY_MODE.NONE)
  assert.equal(result.reason, ROUTE_REASON.AMBIGUOUS_CANDIDATES)
})

test('A-07: a candidate older than the TTL refuses with stale', async () => {
  const result = await route({
    webApproval: cfg({ auto: true, ttlMs: HOUR }),
    entries: [row({ updatedAt: NOW - 2 * HOUR })],
  })
  assert.equal(result.reason, ROUTE_REASON.STALE)
})

test('A-07b: a candidate exactly at the TTL boundary is still usable', async () => {
  const result = await route({
    webApproval: cfg({ auto: true, ttlMs: HOUR }),
    entries: [row({ updatedAt: NOW - HOUR })],
  })
  assert.equal(result.mode, NOTIFY_MODE.ACTIONABLE)
})

test('A-07c: an entry with no usable timestamp is treated as stale, not as fresh', async () => {
  const result = await route({
    webApproval: cfg({ auto: true, ttlMs: HOUR }),
    entries: [row({ updatedAt: 0 })],
  })
  assert.equal(result.reason, ROUTE_REASON.STALE)
})

test('A-08: a channel outside the bot\'s configured list refuses with channel-not-served', async () => {
  const result = await route({ channels: ['some-other-channel'] })
  assert.equal(result.reason, ROUTE_REASON.CHANNEL_NOT_SERVED)
})

// ------------------------------------------------------------------ isolation ---

test('A-09a: another bot\'s conversations are invisible to this bot', async () => {
  const result = await route({
    entries: [row({ botId: 'other', chatKey: 'dm:dmchan-x', sessionId: 'sx', channelId: 'dmchan-x' })],
  })
  assert.equal(result.reason, ROUTE_REASON.NO_CANDIDATE)
})

test('A-09b: two bots\' rows for the same user do not merge into one candidate set', async () => {
  const rows = [
    row({ botId: BOT, chatKey: 'dm:dmchan1', sessionId: 's1', channelId: 'dmchan1' }),
    row({ botId: 'other', chatKey: 'dm:dmchan2', sessionId: 's2', channelId: 'dmchan2' }),
  ]
  const forBot0 = await route({ entries: rows })
  assert.equal(forBot0.channelId, 'dmchan1')
  const forOther = await route({ botId: 'other', entries: rows, byId: { dmchan2: dm({ id: 'dmchan2' }) } })
  assert.equal(forOther.channelId, 'dmchan2')
})

test('A-10a: two distinct users in the map refuse with multi-user', async () => {
  const result = await route({
    entries: [
      row({ sessionId: 's1', channelId: 'dmchan1' }),
      row({ chatKey: 'dm:dmchan2', sessionId: 's2', channelId: 'dmchan2', userId: 'u2' }),
    ],
  })
  assert.equal(result.reason, ROUTE_REASON.MULTI_USER)
})

test('A-10b: no user id at all refuses with no-user', async () => {
  const result = await route({ entries: [row({ userId: null })] })
  assert.equal(result.reason, ROUTE_REASON.NO_USER)
})

test('A-10c: a single served user who is not the single allowed user refuses', async () => {
  const result = await route({ entries: [row({ userId: 'u2' })] })
  assert.equal(result.reason, ROUTE_REASON.IDENTITY_MISMATCH)
})

test('A-10d: zero or two allowed users refuses with no-allowed-users', async () => {
  assert.equal((await route({ allowedUsers: [] })).reason, ROUTE_REASON.NO_ALLOWED_USERS)
  assert.equal((await route({ allowedUsers: ['u1', 'u2'] })).reason, ROUTE_REASON.NO_ALLOWED_USERS)
})

test('A-10e: zero or several Web principals refuses before any candidate is considered', async () => {
  assert.equal((await route({ principalCount: 0 })).reason, ROUTE_REASON.NO_WEB_PRINCIPAL)
  const many = await route({ principalCount: 3 })
  assert.equal(many.reason, ROUTE_REASON.MULTI_PRINCIPAL)
})

test('A-10f: the auto flag off means no inference at all', async () => {
  const result = await route({ webApproval: cfg() })
  assert.equal(result.reason, ROUTE_REASON.NO_CANDIDATE)
})

// ------------------------------------------------------------- authorization ---

test('A-11a: approvers that are all inside allowedUsers validate', () => {
  const check = validateWebApproval({
    webApproval: cfg({ approvers: ['u1'] }),
    bots: [{ id: BOT, allowedUsers: ['u1', 'u2'], allowAll: false }],
  })
  assert.equal(check.ok, true)
})

test('A-11b: one approver outside allowedUsers invalidates the WHOLE configuration', () => {
  const check = validateWebApproval({
    webApproval: cfg({ approvers: ['u1', 'intruder-long-id'] }),
    bots: [{ id: BOT, allowedUsers: ['u1'], allowAll: false }],
  })
  assert.equal(check.ok, false)
  assert.match(check.problems[0], /intrude/)
  assert.doesNotMatch(check.problems[0], /intruder-long-id/)
})

test('A-11c: allowAll has no list to bound approvers, so it cannot carry them', () => {
  const check = validateWebApproval({
    webApproval: cfg({ approvers: ['u1'] }),
    bots: [{ id: BOT, allowedUsers: [], allowAll: true }],
  })
  assert.equal(check.ok, false)
})

test('A-11d: with several bots the approver list must fit EVERY bot', () => {
  const check = validateWebApproval({
    webApproval: cfg({ approvers: ['u1'] }),
    bots: [
      { id: 'a', allowedUsers: ['u1'], allowAll: false },
      { id: 'b', allowedUsers: ['u2'], allowAll: false },
    ],
  })
  assert.equal(check.ok, false)
})

test('A-11e: an empty approver list is always valid and simply means OFF', () => {
  const check = validateWebApproval({
    webApproval: cfg({ approvers: [] }),
    bots: [{ id: BOT, allowedUsers: [], allowAll: true }],
  })
  assert.equal(check.ok, true)
})

// ------------------------------------------------------------- observability ---

test('A-12a: the description carries counts and never a user id', () => {
  const text = describeWebApproval(cfg({ approvers: ['u-secret-id'] }), { enabled: true })
  assert.match(text, /approvers=1/)
  assert.match(text, /mode=dm-only/)
  assert.doesNotMatch(text, /u-secret-id/)
})

test('A-12b: startup problems are visible in the description', () => {
  const text = describeWebApproval(cfg(), { enabled: false, problems: ['bot a: x'] })
  assert.match(text, /problems=bot a: x/)
})

test('A-12c: the declared priority order is fixed', () => {
  assert.deepEqual([...ROUTE_PRIORITY], ['channel', 'binding', 'auto'])
})

// ------------------------------------------------------------- web principals ---

test('A-13: Web principal count is 0 unless the auth file describes exactly one account', () => {
  const dir = mkdtempSync(join(tmpdir(), 'web-auth-'))
  try {
    const single = join(dir, 'single.json')
    writeFileSync(single, JSON.stringify({ username: 'local', passwordHash: 'x', secret: 'y' }))
    assert.equal(countWebPrincipals(single), 1)

    const multi = join(dir, 'multi.json')
    writeFileSync(multi, JSON.stringify({ users: [{}, {}, {}] }))
    assert.equal(countWebPrincipals(multi), 3)

    const empty = join(dir, 'empty.json')
    writeFileSync(empty, '{}')
    assert.equal(countWebPrincipals(empty), 0)

    assert.equal(countWebPrincipals(join(dir, 'absent.json')), 0)

    const broken = join(dir, 'broken.json')
    writeFileSync(broken, 'not json')
    assert.equal(countWebPrincipals(broken), 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// =====================================================================
// A2 acceptance: the mode table, one case per required scenario
// =====================================================================

test('A2-1: P1 fixed channel that is a one-to-one DM with matching approver is actionable', async () => {
  const result = await route({ webApproval: cfg({ channel: 'dmchan1' }) })
  assert.equal(result.mode, NOTIFY_MODE.ACTIONABLE)
  assert.equal(result.targetKind, TARGET_KIND.DM)
  assert.equal(result.oneToOne, true)
  assert.equal(result.approverMatch, true)
})

test('A2-2: P1 fixed channel that is a public channel gets a notice, not a decision', async () => {
  const result = await route({ webApproval: cfg({ channel: 'chan1' }), byId: { chan1: channel() } })
  assert.equal(result.mode, NOTIFY_MODE.NOTIFICATION_ONLY)
  assert.equal(result.reason, ROUTE_REASON.CHANNEL_TARGET)
  assert.equal(result.targetKind, TARGET_KIND.CHANNEL)
})

test('A2-3: P2 binding to a one-to-one DM is actionable', async () => {
  const result = await route({ webApproval: cfg({ binding: { [BOT]: 'dm:dmchan1' } }) })
  assert.equal(result.mode, NOTIFY_MODE.ACTIONABLE)
})

test('A2-4: P2 binding to a channel gets a notice', async () => {
  const result = await route({
    webApproval: cfg({ binding: { [BOT]: 'ch:chan1' } }),
    entries: [row({ chatKey: 'ch:chan1', sessionId: 's2', channelId: 'chan1' })],
    byId: { chan1: channel() },
  })
  assert.equal(result.mode, NOTIFY_MODE.NOTIFICATION_ONLY)
  assert.equal(result.reason, ROUTE_REASON.CHANNEL_TARGET)
})

test('A2-5: P3 automatic route to a one-to-one DM is actionable', async () => {
  const result = await route()
  assert.equal(result.mode, NOTIFY_MODE.ACTIONABLE)
  assert.equal(result.priority, 'auto')
})

test('A2-6: P3 automatic route to a group channel gets a notice', async () => {
  const result = await route({
    entries: [row({ chatKey: 'ch:chan1', channelId: 'chan1' })],
    byId: { chan1: channel() },
  })
  assert.equal(result.mode, NOTIFY_MODE.NOTIFICATION_ONLY)
  assert.equal(result.reason, ROUTE_REASON.CHANNEL_TARGET)
})

test('A2-7: a DM whose peer is not the approver produces nothing at all', async () => {
  const result = await route({ byId: { dmchan1: dm({ members: [BOT_USER, 'someone-else'] }) } })
  assert.equal(result.mode, NOTIFY_MODE.NONE)
  assert.equal(result.reason, ROUTE_REASON.APPROVER_MISMATCH)
  assert.equal(result.approverMatch, false)
})

test('A2-8: a group DM (type G) gets a notice even when the peer list is small', async () => {
  const result = await route({ byId: { dmchan1: groupDm() } })
  assert.equal(result.mode, NOTIFY_MODE.NOTIFICATION_ONLY)
  assert.equal(result.reason, ROUTE_REASON.GROUP_DM_TARGET)
  assert.equal(result.targetKind, TARGET_KIND.GROUP_DM)
})

test('A2-8b: a type-D channel that gained a third member is treated as a group DM', async () => {
  const result = await route({ byId: { dmchan1: dm({ members: [BOT_USER, PEER, 'peer2'] }) } })
  assert.equal(result.mode, NOTIFY_MODE.NOTIFICATION_ONLY)
  assert.equal(result.reason, ROUTE_REASON.GROUP_DM_TARGET)
})

test('A2-8c: a thread reply is a notice, even inside a one-to-one DM', async () => {
  const result = await route({
    webApproval: cfg({ binding: { [BOT]: 'th:root9' } }),
    entries: [row({ chatKey: 'th:root9', sessionId: 's9', channelId: 'dmchan1', rootId: 'root9' })],
  })
  assert.equal(result.mode, NOTIFY_MODE.NOTIFICATION_ONLY)
  assert.equal(result.reason, ROUTE_REASON.THREAD_TARGET)
})

test('A2-9: several approvers never produce an actionable card', async () => {
  const result = await route({ webApproval: cfg({ auto: true, approvers: ['u1', 'u2'] }) })
  assert.equal(result.mode, NOTIFY_MODE.NOTIFICATION_ONLY)
  assert.equal(result.reason, ROUTE_REASON.MULTIPLE_APPROVERS)
  assert.equal(result.approverCount, 2)
})

test('A2-10: an empty approver list produces nothing', async () => {
  const result = await route({ webApproval: cfg({ channel: 'dmchan1', auto: true, approvers: [] }) })
  assert.equal(result.mode, NOTIFY_MODE.NONE)
  assert.equal(result.reason, ROUTE_REASON.DISABLED)
})

test('A2-11: a DM whose membership cannot be read is never actionable', async () => {
  const noMembers = await route({ byId: { dmchan1: { id: 'dmchan1', type: 'D' } } })
  assert.equal(noMembers.mode, NOTIFY_MODE.NONE)
  assert.equal(noMembers.reason, ROUTE_REASON.PEER_UNVERIFIED)

  const unknownBot = await resolveWebRoute({
    botId: BOT,
    // No bot id means the bot cannot be excluded from its own member list, so a
    // DM can never be proven one-to-one.
    botUserId: undefined,
    webApproval: cfg({ channel: 'dmchan1' }),
    entries: [row()],
    allowedUsers: ALLOWED,
    principalCount: 1,
    now: NOW,
    describeChannel: async () => dm(),
  })
  assert.equal(unknownBot.mode, NOTIFY_MODE.NONE)
  assert.equal(unknownBot.reason, ROUTE_REASON.PEER_UNVERIFIED)
})

test('A2-11b: an unreadable channel refuses the route entirely (no notice either)', async () => {
  const result = await route({ byId: {} })
  assert.equal(result.mode, NOTIFY_MODE.NONE)
  assert.equal(result.reason, ROUTE_REASON.CHANNEL_UNREACHABLE)
})

test('A2-11c: a throwing channel probe counts as unreadable, not as success', async () => {
  const result = await resolveWebRoute({
    botId: BOT,
    botUserId: BOT_USER,
    webApproval: cfg({ channel: 'dmchan1' }),
    entries: [row()],
    allowedUsers: ALLOWED,
    principalCount: 1,
    now: NOW,
    describeChannel: async () => { throw new Error('boom') },
  })
  assert.equal(result.mode, NOTIFY_MODE.NONE)
  assert.equal(result.reason, ROUTE_REASON.CHANNEL_UNREACHABLE)
})
