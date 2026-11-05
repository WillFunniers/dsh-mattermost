// A3: dual-answerer arbitration (Web native prompt vs Mattermost DM card).
//
// The properties under test:
//   1. ONE terminal transition per request (`settle` is the only exit);
//   2. the FIRST valid answer wins, the other side can no longer decide;
//   3. the two lifecycles stay distinct — `outcome` (business), `card`
//      (notification), `settledBy` (who won);
//   4. every loser is cleaned up: timer, abort listener, reaction route;
//   5. a notification failure never decides a Web request, and never throws.
//
// Run: node --unhandled-rejections=strict --test feature-test/a3-race.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'

import { createApprovalBridge } from '../approvals.js'

const BOT = 'bot0'
const DM = 'dmchan1'
const APPROVER = 'u1'

const ACTIONABLE = {
  mode: 'actionable', reason: 'dm-target', botId: BOT, channelId: DM, rootId: undefined,
  chatKey: 'dm:dmchan1', chatKind: 'dm', targetKind: 'dm', oneToOne: true,
  approverMatch: true, approvers: [APPROVER], priority: 'binding',
}
const NOTICE = {
  mode: 'notification-only', reason: 'channel-target', botId: BOT, channelId: 'chan1',
  rootId: undefined, chatKey: 'ch:chan1', chatKind: 'ch', targetKind: 'channel',
  oneToOne: false, approverMatch: false, approvers: [APPROVER], priority: 'auto',
}

function request(overrides = {}) {
  return {
    agent: { session: { id: 'web-session' } },
    toolName: 'bash', callId: 'call-1', reason: 'r',
    displayReason: { zh: 'r' }, signal: undefined,
    ...overrides,
  }
}

function makeBridge({
  route = ACTIONABLE, sendCard, updateCard, audit, delayMs = 0, timeoutMs = 30_000,
} = {}) {
  const calls = { sent: [], updated: [], audit: [], warns: [], nextCalls: 0, routed: 0 }
  let resolveNext
  let rejectNext
  const nextPromise = new Promise((resolve, reject) => { resolveNext = resolve; rejectNext = reject })
  const bridge = createApprovalBridge({
    logger: {
      info: () => {},
      warn: (message) => calls.warns.push(String(message)),
      error: (message) => calls.warns.push(`ERROR ${message}`),
    },
    config: { approvalEnabled: true, approvalTimeoutMs: timeoutMs, cardArguments: 'off' },
    deps: {
      lookupTarget: () => undefined,
      isAuthorized: (_botId, userId) => String(userId) === APPROVER,
      sendCard: async (...args) => {
        if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs))
        calls.sent.push(args)
        return sendCard ? sendCard(...args) : 'post-1'
      },
      updateCard: async (...args) => {
        calls.updated.push(args)
        return updateCard ? updateCard(...args) : true
      },
      audit: (record) => { calls.audit.push(record); if (audit) audit(record) },
      readToolArguments: async () => undefined,
      resolveWebRoute: async () => { calls.routed += 1; return route },
    },
  })
  return {
    bridge,
    calls,
    next: () => { calls.nextCalls += 1; return nextPromise },
    resolveNext,
    rejectNext,
  }
}

const settle = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms))
const pendingId = (harness) => harness.bridge.pendingFor(BOT)[0].id
const decide = (harness, id, decision = 'approved', overrides = {}) => harness.bridge.decide({
  requestId: id, userId: APPROVER, botId: BOT, channelId: DM, decision, via: 'reaction', ...overrides,
})

// ============================================================ A. 正常竞速 ===

test('A3-A1: Web approves first — one audit, card voided, the request is approved', async () => {
  const h = makeBridge()
  const done = h.bridge.handle(request(), h.next)
  await settle()
  const id = pendingId(h)

  h.resolveNext('allowed-once')
  assert.equal(await done, 'allowed-once')
  await settle()

  assert.equal(h.calls.audit.length, 1)
  const audit = h.calls.audit[0]
  assert.equal(audit.outcome, 'approved')
  assert.equal(audit.settledBy, 'web')
  assert.equal(audit.card, 'void')
  assert.equal(audit.decidedBy, undefined)
  // Late Mattermost decision is refused.
  assert.equal(decide(h, id, 'rejected').code, 'settled')
  assert.equal(h.calls.audit.length, 1)
})

test('A3-A2: Web rejects first — the business outcome is `rejected`, not a card state', async () => {
  const h = makeBridge()
  const done = h.bridge.handle(request(), h.next)
  await settle()
  h.resolveNext('rejected')
  assert.equal(await done, 'rejected')
  await settle()
  assert.equal(h.calls.audit[0].outcome, 'rejected')
  assert.equal(h.calls.audit[0].settledBy, 'web')
})

test('A3-A3: Mattermost approves first — the Web answer arrives late and is ignored', async () => {
  const h = makeBridge()
  const done = h.bridge.handle(request(), h.next)
  await settle()

  assert.equal(decide(h, pendingId(h)).ok, true)
  assert.equal(await done, 'allowed-once')
  await settle()

  h.resolveNext('rejected') // the browser answers after the card won
  await settle()

  assert.equal(h.calls.audit.length, 1)
  const audit = h.calls.audit[0]
  assert.equal(audit.outcome, 'approved')
  assert.equal(audit.settledBy, 'mattermost')
  assert.equal(audit.card, 'posted')
  assert.equal(audit.decidedBy, APPROVER)
})

test('A3-A4: Mattermost rejects via the command path', async () => {
  const h = makeBridge()
  const done = h.bridge.handle(request(), h.next)
  await settle()
  const result = decide(h, pendingId(h), 'rejected', { via: 'command' })
  assert.equal(result.ok, true)
  assert.equal(await done, 'rejected')
  assert.equal(h.calls.audit[0].via, 'command')
})

// ==================================================== B. 并发与重复 =========

test('A3-B1: Web resolves just before a reaction — the first transition wins', async () => {
  const h = makeBridge()
  const done = h.bridge.handle(request(), h.next)
  await settle()
  const id = pendingId(h)

  h.resolveNext('allowed-once')
  await Promise.resolve() // let the native handler run, but no timer
  const late = decide(h, id, 'rejected')
  assert.equal(late.code, 'settled')
  assert.equal(await done, 'allowed-once')
  assert.equal(h.calls.audit.length, 1)
  assert.equal(h.calls.audit[0].settledBy, 'web')
})

test('A3-B2: reaction resolves just before the browser — Mattermost wins', async () => {
  const h = makeBridge()
  const done = h.bridge.handle(request(), h.next)
  await settle()
  assert.equal(decide(h, pendingId(h)).ok, true)
  h.resolveNext('allowed-once')
  assert.equal(await done, 'allowed-once')
  await settle()
  assert.equal(h.calls.audit.length, 1)
  assert.equal(h.calls.audit[0].settledBy, 'mattermost')
})

test('A3-B3: approve and reject arrive together — exactly one outcome survives', async () => {
  const h = makeBridge()
  const done = h.bridge.handle(request(), h.next)
  await settle()
  const id = pendingId(h)

  const a = decide(h, id, 'approved')
  const b = decide(h, id, 'rejected')
  assert.equal(a.ok, true)
  assert.equal(b.ok, false)
  assert.equal(b.code, 'settled')
  const outcome = await done
  assert.equal(outcome, 'allowed-once')
  assert.equal(h.calls.audit.length, 1)
  assert.equal(h.calls.audit[0].outcome, 'approved')
})

test('A3-B4: a repeated reaction is idempotent and never re-audits', async () => {
  const h = makeBridge()
  const done = h.bridge.handle(request(), h.next)
  await settle()
  const id = pendingId(h)
  assert.equal(h.bridge.handleReaction({ botId: BOT, userId: APPROVER, postId: 'post-1', emojiName: 'white_check_mark' }), true)
  // After the first decision the reaction route is closed: the same emoji and a
  // different one are both no longer "ours".
  assert.equal(h.bridge.handleReaction({ botId: BOT, userId: APPROVER, postId: 'post-1', emojiName: 'white_check_mark' }), false)
  assert.equal(h.bridge.handleReaction({ botId: BOT, userId: APPROVER, postId: 'post-1', emojiName: 'x' }), false)
  assert.equal(await done, 'allowed-once')
  await settle()
  assert.equal(h.calls.audit.length, 1)
  assert.ok(h.calls.audit[0].outcome === 'approved')
  assert.equal(decide(h, id).code, 'settled')
})

test('A3-B5: a repeated /approve is refused after the first one', async () => {
  const h = makeBridge()
  const done = h.bridge.handle(request(), h.next)
  await settle()
  const id = pendingId(h)
  assert.equal(decide(h, id, 'approved', { via: 'command' }).ok, true)
  assert.equal(decide(h, id, 'approved', { via: 'command' }).code, 'settled')
  assert.equal(decide(h, id, 'approved', { via: 'command' }).code, 'settled')
  await done
  await settle()
  assert.equal(h.calls.audit.length, 1)
})

test('A3-B6: a duplicate Web callback cannot produce a second transition', async () => {
  const h = makeBridge()
  const done = h.bridge.handle(request(), h.next)
  await settle()
  h.resolveNext('rejected')
  h.resolveNext('allowed-once') // a promise ignores the second call
  assert.equal(await done, 'rejected')
  await settle()
  assert.equal(h.calls.audit.length, 1)
  assert.equal(h.calls.audit[0].outcome, 'rejected')
})

test('A3-B7: a late reaction after settle is refused and the route is closed', async () => {
  const h = makeBridge()
  const done = h.bridge.handle(request(), h.next)
  await settle()
  assert.equal(decide(h, pendingId(h)).ok, true)
  await done
  await settle()
  // byPost was deleted at settle: the reaction is no longer "ours".
  assert.equal(h.bridge.handleReaction({ botId: BOT, userId: APPROVER, postId: 'post-1', emojiName: 'white_check_mark' }), false)
  assert.equal(h.calls.audit.length, 1)
})

test('A3-B8 (D1 regression): a card delivered AFTER the Web won is never decidable', async () => {
  const h = makeBridge({ delayMs: 120 })
  const done = h.bridge.handle(request(), h.next)
  await settle(10)
  h.resolveNext('allowed-once')
  assert.equal(await done, 'allowed-once')
  await settle(200) // card delivery finishes; it must NOT register a reaction route

  assert.equal(h.calls.sent.length, 1) // the card exists…
  assert.equal(h.bridge.pendingFor(BOT).length, 0)
  assert.equal(h.bridge.handleReaction({ botId: BOT, userId: APPROVER, postId: 'post-1', emojiName: 'white_check_mark' }), false)
  assert.equal(h.calls.audit.length, 1)
  assert.equal(h.calls.audit[0].card, 'void')
})

test('A3-B9: a browser answer before the route resolves means no card at all', async () => {
  const h = makeBridge()
  h.resolveNext('rejected')
  await settle(10) // let the native promise settle before routing resolves
  const done = h.bridge.handle(request(), h.next)
  assert.equal(await done, 'rejected')
  await settle()
  assert.equal(h.calls.sent.length, 0)
  assert.equal(h.calls.audit.length, 0)
})

// ========================================================== C. 生命周期 ====

test('A3-C1: timeout is a terminal `expired`, with the card voided', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = makeBridge()
  const done = h.bridge.handle(request(), h.next)
  return Promise.resolve().then(() => Promise.resolve()).then(async () => {
    const id = pendingId(h)
    t.mock.timers.tick(30_000)
    assert.equal(await done, 'unavailable')
    const audit = h.calls.audit.at(-1)
    assert.equal(audit.outcome, 'expired')
    assert.equal(audit.settledBy, 'timeout')
    assert.equal(decide(h, id).code, 'expired')
  })
})

test('A3-C2: AbortSignal cancels the request and removes its listener', async () => {
  const controller = new AbortController()
  const h = makeBridge()
  const done = h.bridge.handle(request({ signal: controller.signal }), h.next)
  await settle()
  controller.abort()
  assert.equal(await done, 'cancelled')
  await settle()
  const audit = h.calls.audit.at(-1)
  assert.equal(audit.outcome, 'cancelled')
  assert.equal(audit.settledBy, 'abort')
})

test('A3-C3: a reaction after abort is refused', async () => {
  const controller = new AbortController()
  const h = makeBridge()
  const done = h.bridge.handle(request({ signal: controller.signal }), h.next)
  await settle()
  const id = pendingId(h)
  controller.abort()
  await done
  await settle()
  assert.equal(decide(h, id).code, 'settled')
  assert.equal(h.calls.audit.length, 1)
})

test('A3-C4: dispose settles every pending request as cancelled/shutdown', async () => {
  const h = makeBridge()
  const done = h.bridge.handle(request(), h.next)
  await settle()
  h.bridge.dispose()
  assert.equal(await done, 'cancelled')
  assert.deepEqual(h.bridge.pendingFor(BOT), [])
  const audit = h.calls.audit.at(-1)
  assert.equal(audit.settledBy, 'shutdown')
})

test('A3-C5: a card delivered after dispose never becomes a decision route', async () => {
  const h = makeBridge({ delayMs: 120 })
  const done = h.bridge.handle(request(), h.next)
  await settle(10)
  h.bridge.dispose()
  await done
  await settle(200)
  assert.equal(h.bridge.handleReaction({ botId: BOT, userId: APPROVER, postId: 'post-1', emojiName: 'white_check_mark' }), false)
})

test('A3-C7: a decision just after the timeout deadline is `expired`', async () => {
  const h = makeBridge()
  const done = h.bridge.handle(request(), h.next)
  await settle()
  const id = pendingId(h)
  // Move the clock past the deadline without touching the timer.
  const realNow = Date.now
  Date.now = () => realNow() + 31_000
  try {
    assert.equal(decide(h, id).code, 'expired')
  } finally {
    Date.now = realNow
  }
  assert.equal(await done, 'unavailable')
  assert.equal(h.calls.audit.at(-1).outcome, 'expired')
})

// ========================================================== D. 异常故障 ====

test('A3-D1: a Web notification failure keeps the request decidable by the browser', async () => {
  const h = makeBridge({ sendCard: () => { throw new Error('mattermost 500') } })
  const done = h.bridge.handle(request(), h.next)
  await settle()
  assert.ok(h.calls.warns.some((line) => /delivery failed/.test(line)))
  assert.equal(h.calls.audit.length, 0)

  h.resolveNext('allowed-once')
  assert.equal(await done, 'allowed-once')
  await settle()
  assert.equal(h.calls.audit.at(-1).outcome, 'approved')
  assert.equal(h.calls.audit.at(-1).card, 'failed')
})

test('A3-D2: a card-update failure does not change the decision', async () => {
  const h = makeBridge({ updateCard: () => { throw new Error('update failed') } })
  const done = h.bridge.handle(request(), h.next)
  await settle()
  assert.equal(decide(h, pendingId(h)).ok, true)
  assert.equal(await done, 'allowed-once')
  await settle()
  assert.equal(h.calls.audit.at(-1).outcome, 'approved')
  assert.ok(h.calls.warns.some((line) => /update failed/.test(line)))
})

test('A3-D3: a rejected native answerer leaves the card as the only route', async () => {
  const h = makeBridge()
  const done = h.bridge.handle(request(), h.next)
  await settle()
  h.rejectNext(new Error('agent context released'))
  await settle()
  assert.equal(h.calls.audit.length, 0) // rejection is not a decision
  assert.equal(decide(h, pendingId(h)).ok, true)
  assert.equal(await done, 'allowed-once')
})

test('A3-D5: an audit write failure does not change the outcome', async () => {
  const h = makeBridge({ audit: () => { throw new Error('disk full') } })
  const done = h.bridge.handle(request(), h.next)
  await settle()
  h.resolveNext('rejected')
  assert.equal(await done, 'rejected')
  await settle()
  assert.ok(h.calls.warns.some((line) => /audit append failed/.test(line)))
})

test('A3-D6: audit and card update both throwing must not escape settle', async () => {
  const h = makeBridge({
    audit: () => { throw new Error('audit') },
    updateCard: () => { throw new Error('card') },
  })
  const done = h.bridge.handle(request(), h.next)
  await settle()
  assert.equal(decide(h, pendingId(h)).ok, true)
  assert.equal(await done, 'allowed-once')
})

// ================================================ 边界：无卡片 / 提醒 =====

test('A3-E1: a decision without a delivered card is refused as `not-posted`', async () => {
  const h = makeBridge({ sendCard: () => { throw new Error('nope') } })
  const done = h.bridge.handle(request(), h.next)
  await settle()
  const id = pendingId(h)
  assert.equal(decide(h, id).code, 'not-posted')
  h.resolveNext('allowed-once')
  await done
})

test('A3-E2: a notice route creates no record and delegates unchanged', async () => {
  const h = makeBridge({ route: NOTICE })
  const done = h.bridge.handle(request(), h.next)
  h.resolveNext('rejected')
  assert.equal(await done, 'rejected')
  await settle()
  assert.deepEqual(h.bridge.pendingFor(BOT), [])
  assert.equal(h.calls.sent.length, 1)
  assert.equal(h.calls.audit.length, 0)
  assert.match(h.calls.sent[0][3].message, /请到 DSH Web 界面处理/)
})

test('A3-E3: next() is called exactly once and only for Web requests', async () => {
  const h = makeBridge()
  const done = h.bridge.handle(request(), h.next)
  await settle()
  assert.equal(h.calls.nextCalls, 1)
  h.resolveNext('allowed-once')
  await done
})
