// Web-origin approval behaviour (Approval Bridge A2).
//
// These tests drive the REAL bridge with stub transport, so they pin behaviour
// rather than source text:
//
//   - a notice never becomes a decision surface (no record, no post map);
//   - a decision card exists only for a verified DM and only its approver can use
//     it, from that DM only;
//   - a delivery failure never settles the Web request;
//   - the Web answerer keeps working and wins when it answers first;
//   - a Mattermost-origin request behaves exactly as it did before A2.
//
// Run: node --test feature-test/approval-web.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'

import { createApprovalBridge, renderApprovalCard, renderApprovalNotice } from '../approvals.js'

const BOT = 'bot0'
const APPROVER = 'u1'
const DM = 'dmchan1'

function webRequest(overrides = {}) {
  return {
    agent: { session: { id: 'web-session-1' } },
    toolName: 'bash',
    callId: 'call-1',
    reason: '需要更高权限',
    displayReason: { zh: '需要更高权限' },
    signal: undefined,
    ...overrides,
  }
}

const ACTIONABLE_ROUTE = {
  mode: 'actionable',
  reason: 'dm-target',
  botId: BOT,
  channelId: DM,
  rootId: undefined,
  chatKey: 'dm:dmchan1',
  chatKind: 'dm',
  targetKind: 'dm',
  oneToOne: true,
  approverMatch: true,
  approvers: [APPROVER],
  priority: 'binding',
}

const NOTICE_ROUTE = {
  mode: 'notification-only',
  reason: 'channel-target',
  botId: BOT,
  channelId: 'chan1',
  rootId: undefined,
  chatKey: 'ch:chan1',
  chatKind: 'ch',
  targetKind: 'channel',
  oneToOne: false,
  approverMatch: false,
  approvers: [APPROVER],
  priority: 'auto',
}

/**
 * One bridge wired to stub transport.
 *
 * `next()` returns a promise the test resolves with `finishNext(outcome)`; the
 * bridge must call it exactly once for a Web-origin request.
 */
function makeBridge({ route = null, lookupTarget, sendCard, cardArguments = 'off' } = {}) {
  const calls = { sent: [], updated: [], audit: [], warns: [], nextCalls: 0, routed: 0 }
  let finishNext
  const nextPromise = new Promise((resolve) => { finishNext = resolve })
  const bridge = createApprovalBridge({
    logger: {
      info: () => {},
      warn: (message) => calls.warns.push(String(message)),
      error: (message) => calls.warns.push(`ERROR ${message}`),
    },
    config: { approvalEnabled: true, approvalTimeoutMs: 30_000, cardArguments },
    deps: {
      lookupTarget: lookupTarget || (() => undefined),
      isAuthorized: (_botId, userId) => String(userId) === APPROVER,
      sendCard: async (...args) => {
        calls.sent.push(args)
        if (sendCard) return sendCard(...args)
        return 'post-1'
      },
      updateCard: async (...args) => { calls.updated.push(args); return true },
      audit: (record) => calls.audit.push(record),
      readToolArguments: async () => undefined,
      resolveWebRoute: async () => { calls.routed += 1; return route },
    },
  })
  const next = () => { calls.nextCalls += 1; return nextPromise }
  return { bridge, calls, next, finishNext: (outcome) => finishNext(outcome) }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20))

/** Everything a reader of one attachment would see, fields included. */
function attachmentText(card) {
  const attachment = card.props.attachments[0]
  const fields = (attachment.fields || []).map((item) => `${item.title}：${item.value}`).join('\n')
  return [card.message, attachment.title, attachment.text, fields, attachment.footer].join('\n')
}

// ---------------------------------------------------------------- notice ---

test('A2-12: a channel gets a NON-DECIDABLE notice and no pending record', async () => {
  const harness = makeBridge({ route: NOTICE_ROUTE })
  const done = harness.bridge.handle(webRequest(), harness.next)
  harness.finishNext('allowed-once')
  assert.equal(await done, 'allowed-once')
  await tick()

  // Exactly one message, and it is the notice.
  assert.equal(harness.calls.sent.length, 1)
  const card = harness.calls.sent[0][3]
  assert.match(card.message, /请到 DSH Web 界面处理/)
  const body = attachmentText(card)
  assert.match(body, /不可裁决/)
  // No request id, no tool name, no arguments.
  assert.doesNotMatch(body, /[0-9a-f]{8}/i)
  assert.doesNotMatch(body, /bash/)
  assert.doesNotMatch(body, /sk-/)
  assert.doesNotMatch(card.message, /bash/)

  // Nothing became decidable.
  assert.deepEqual(harness.bridge.pendingFor(BOT), [])
  assert.equal(harness.bridge.decide({ requestId: 'deadbeef', userId: APPROVER, botId: BOT, channelId: 'chan1', decision: 'approved' }).code, 'unknown')
  assert.equal(harness.bridge.handleReaction({ botId: BOT, userId: APPROVER, postId: 'post-1', emojiName: 'white_check_mark' }), false)
})

test('A2-12b: a notice never blocks the Web prompt — the Web answer is returned unchanged', async () => {
  const harness = makeBridge({ route: NOTICE_ROUTE })
  const done = harness.bridge.handle(webRequest(), harness.next)
  await tick()
  assert.equal(harness.calls.nextCalls, 1)
  harness.finishNext('rejected')
  assert.equal(await done, 'rejected')
})

test('A2-12c: an unroutable request sends nothing and delegates', async () => {
  const harness = makeBridge({ route: { mode: 'none', reason: 'ambiguous-candidates' } })
  const done = harness.bridge.handle(webRequest(), harness.next)
  harness.finishNext('allowed-once')
  assert.equal(await done, 'allowed-once')
  await tick()
  assert.equal(harness.calls.sent.length, 0)
  assert.deepEqual(harness.bridge.pendingFor(BOT), [])
})

// -------------------------------------------------------------- actionable ---

test('A2-3b: the actionable DM card is registered and can be decided by the approver', async () => {
  const harness = makeBridge({ route: ACTIONABLE_ROUTE })
  const done = harness.bridge.handle(webRequest(), harness.next)
  await tick()

  const pending = harness.bridge.pendingFor(BOT)
  assert.equal(pending.length, 1)
  assert.equal(pending[0].source, 'web')
  assert.equal(pending[0].channelId, DM)
  assert.equal(pending[0].notificationMode, 'actionable')

  const id = pending[0].id
  assert.equal(harness.bridge.decide({ requestId: id, userId: APPROVER, botId: BOT, channelId: DM, decision: 'approved', via: 'command' }).ok, true)
  assert.equal(await done, 'allowed-once')

  const audit = harness.calls.audit.at(-1)
  assert.equal(audit.outcome, 'approved')
  assert.equal(audit.settledBy, 'mattermost')
  assert.equal(audit.source, 'web')
  assert.equal(audit.via, 'command')
})

test('A2-7b: a non-approver cannot decide, and the approver cannot decide from another channel', async () => {
  const harness = makeBridge({ route: ACTIONABLE_ROUTE })
  const done = harness.bridge.handle(webRequest(), harness.next)
  await tick()
  const id = harness.bridge.pendingFor(BOT)[0].id

  assert.equal(harness.bridge.decide({ requestId: id, userId: 'u2', botId: BOT, channelId: DM, decision: 'approved' }).code, 'not-allowed')
  assert.equal(harness.bridge.decide({ requestId: id, userId: APPROVER, botId: 'other', channelId: DM, decision: 'approved' }).code, 'forbidden')
  assert.equal(harness.bridge.decide({ requestId: id, userId: APPROVER, botId: BOT, channelId: 'chan1', decision: 'approved' }).code, 'wrong-channel')
  // Still pending after all refusals.
  assert.equal(harness.bridge.pendingFor(BOT).length, 1)

  assert.equal(harness.bridge.decide({ requestId: id, userId: APPROVER, botId: BOT, channelId: DM, decision: 'rejected', via: 'reaction' }).ok, true)
  assert.equal(await done, 'rejected')
})

test('A2-13: a group-channel command cannot decide a Web request', async () => {
  // No DM record exists at all for a notice route; the command path therefore
  // has nothing to find, and a forged id is unknown.
  const harness = makeBridge({ route: NOTICE_ROUTE })
  const done = harness.bridge.handle(webRequest(), harness.next)
  await tick()
  const result = harness.bridge.decide({
    requestId: 'anything', userId: APPROVER, botId: BOT, channelId: 'chan1', decision: 'approved', via: 'command',
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'unknown')
  harness.finishNext('allowed-once')
  await done
})

test('A2-14: a Mattermost-origin request is unchanged (arguments, source, decision path)', async () => {
  const harness = makeBridge({
    route: ACTIONABLE_ROUTE,
    lookupTarget: () => ({
      botId: BOT, chatKey: 'ch:chan1', chatKind: 'ch', channelId: 'chan1', rootId: undefined,
      userId: APPROVER, botUsername: 'dsh',
    }),
  })
  // Give this harness a masked-arguments bridge by re-creating it (the card mode
  // is per bridge); the Mattermost path ignores `cardArguments` anyway.
  const bridge = createApprovalBridge({
    logger: { info() {}, warn() {}, error() {} },
    config: { approvalEnabled: true, approvalTimeoutMs: 30_000, cardArguments: 'off' },
    deps: {
      lookupTarget: () => ({
        botId: BOT, chatKey: 'ch:chan1', chatKind: 'ch', channelId: 'chan1', rootId: undefined,
        userId: APPROVER, botUsername: 'dsh',
      }),
      isAuthorized: () => true,
      sendCard: async () => 'mm-post-1',
      updateCard: async () => true,
      audit: () => {},
      readToolArguments: async () => '{"cmd":"ls"}',
      resolveWebRoute: async () => { throw new Error('must not be consulted for an owned session') },
    },
  })
  const seen = []
  const done = bridge.handle(webRequest(), () => { seen.push(1); return Promise.resolve('unavailable') })
  await tick()
  const pending = bridge.pendingFor(BOT)
  assert.equal(pending.length, 1)
  assert.equal(pending[0].source, 'mattermost')
  const id = pending[0].id
  assert.equal(bridge.decide({ requestId: id, userId: APPROVER, botId: BOT, channelId: 'chan1', decision: 'approved', via: 'reaction' }).ok, true)
  assert.equal(await done, 'allowed-once')
  assert.equal(seen.length, 0) // never delegated: the bridge OWNS this session
  assert.equal(harness.calls.routed, 0)
})

// ------------------------------------------------------- delivery / race ---

test('A2-15: a card delivery failure never settles the Web request', async () => {
  const failing = makeBridge({
    route: ACTIONABLE_ROUTE,
    sendCard: async () => { throw new Error('mattermost 500') },
  })
  const done = failing.bridge.handle(webRequest(), failing.next)
  await tick()

  // The failure is logged and produces NO pending decision path…
  assert.equal(failing.bridge.pendingFor(BOT).length, 1) // record exists, but…
  assert.ok(failing.calls.warns.some((line) => /delivery failed/.test(line)))
  assert.equal(failing.calls.audit.length, 0) // …nothing was settled

  // …and the Web answer still decides the request.
  failing.finishNext('allowed-once')
  assert.equal(await done, 'allowed-once')

  // The record carries the REAL business outcome, attributed to the Web side,
  // and the card is marked failed (it never existed).
  const record = failing.calls.audit.at(-1)
  assert.equal(record.outcome, 'approved')
  assert.equal(record.settledBy, 'web')
  assert.equal(record.card, 'failed')
})

test('A2-15b: a Web answer that arrives first wins, and the card is retired', async () => {
  const harness = makeBridge({ route: ACTIONABLE_ROUTE })
  const done = harness.bridge.handle(webRequest(), harness.next)
  await tick()
  assert.equal(harness.bridge.pendingFor(BOT).length, 1)

  harness.finishNext('rejected')
  assert.equal(await done, 'rejected')
  await tick()

  const audit = harness.calls.audit.at(-1)
  assert.equal(audit.outcome, 'rejected')
  assert.equal(audit.settledBy, 'web')
  assert.equal(audit.card, 'void')
  // A late Mattermost decision is refused, and the post map is closed.
  assert.equal(harness.bridge.decide({ requestId: audit.requestId, userId: APPROVER, botId: BOT, channelId: DM, decision: 'approved' }).code, 'settled')
  assert.equal(harness.bridge.handleReaction({ botId: BOT, userId: APPROVER, postId: 'post-1', emojiName: 'white_check_mark' }), false)
})

test('A2-15c: next() is called exactly once for a Web request', async () => {
  const harness = makeBridge({ route: ACTIONABLE_ROUTE })
  const done = harness.bridge.handle(webRequest(), harness.next)
  await tick()
  harness.finishNext('allowed-once')
  await done
  assert.equal(harness.calls.nextCalls, 1)
})

test('A2-15d: without a router dependency the bridge delegates exactly as before', async () => {
  const bridge = createApprovalBridge({
    logger: { info() {}, warn() {}, error() {} },
    config: { approvalEnabled: true, approvalTimeoutMs: 30_000 },
    deps: {
      lookupTarget: () => undefined,
      isAuthorized: () => true,
      sendCard: async () => 'x',
      updateCard: async () => true,
      audit: () => {},
      readToolArguments: async () => undefined,
    },
  })
  assert.equal(await bridge.handle(webRequest(), () => Promise.resolve('unavailable')), 'unavailable')
  assert.deepEqual(bridge.pendingFor(BOT), [])
})

// ------------------------------------------------------------------ cards ---

test('A2-16: the Web card hides arguments by default and marks the risk as unassessed', () => {
  const card = renderApprovalCard({
    id: 'abcd1234', sessionId: 'web-session-1', chatKind: 'dm', toolName: 'bash',
    state: 'pending', createdAt: Date.now(), source: 'web', cardArguments: 'off',
    argumentsUnavailable: false,
  }, { botUsername: 'dsh', argumentsText: '{"cmd":"rm -rf /"}' })
  const body = attachmentText(card)
  assert.match(body, /未评估/)
  assert.match(body, /不展示参数正文/)
  assert.doesNotMatch(body, /rm -rf/)
  assert.match(card.message, /bash/) // the tool name stays on a DM-only card
})

test('A2-16b: opting in shows masked arguments, and the Mattermost card keeps its sentence', () => {
  const web = renderApprovalCard({
    id: 'abcd1234', sessionId: 'web-session-1', chatKind: 'dm', toolName: 'bash',
    state: 'pending', createdAt: Date.now(), source: 'web', cardArguments: 'masked',
  }, { argumentsText: '{"cmd":"ls"}' })
  assert.match(web.props.attachments[0].text, /参数/)

  const mm = renderApprovalCard({
    id: 'abcd1234', sessionId: 'mm-1', chatKind: 'ch', toolName: 'bash',
    state: 'pending', createdAt: Date.now(), source: 'mattermost', cardArguments: 'masked',
  }, { argumentsText: '{"cmd":"ls"}' })
  const text = attachmentText(mm)
  assert.match(text, /超出当前沙箱范围/)
  assert.doesNotMatch(text, /未评估/)
})

test('A2-16c: a card voided by another answerer says it can no longer decide', () => {
  const card = renderApprovalCard({
    id: 'abcd1234', sessionId: 'web-session-1', chatKind: 'dm', toolName: 'bash',
    outcome: 'rejected', card: 'void', createdAt: Date.now(), source: 'web', cardArguments: 'off',
    decidedBy: undefined, via: 'web',
  })
  assert.match(attachmentText(card), /已失效/)
})

test('A2-16d: the notice renderer carries no id, tool or arguments', () => {
  const notice = renderApprovalNotice({ targetKind: 'thread' })
  const body = attachmentText(notice)
  assert.match(body, /线程/)
  assert.match(body, /不可裁决/)
  assert.doesNotMatch(body, /[0-9a-f]{8}/i)
})
