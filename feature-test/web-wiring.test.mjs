// Wiring test for the A1 routing probe (`ctx.mattermost.webApproval`).
//
// The unit tests pin `resolveWebRoute()`. This one pins the WIRING: the plugin's
// own `apply()` must read the configured approvers, the bot's allowed users, the
// durable session map and the local Web-principal count, and expose exactly that
// to the diagnostic probe. It also pins the failure mode: a configuration that
// reaches beyond `allowedUsers` must come up DISABLED.
//
// No Mattermost, no tokens, no agent: the effect that would start the WebSocket
// is intentionally never executed, so nothing connects and nothing is posted.
//
// Run: node --test feature-test/web-wiring.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../index.js'

const HOUR = 60 * 60 * 1_000

/** Minimal Cordis-ish context: nothing here connects or schedules. */
function stubContext() {
  const services = new Map()
  const disposers = []
  let effectsRegistered = 0
  return {
    logger: () => ({ info() {}, warn() {}, error() {} }),
    get: (name) => services.get(name),
    provide: (name, value) => { services.set(name, value) },
    on: () => () => {},
    // A dependency-gated registration: the `tools` service does not exist here,
    // so the callback must never run.
    inject: () => {},
    effect: () => {
      // Deliberately NOT invoked: startup (WebSocket, agents, scheduler) must not
      // run in a test that only wants to inspect configuration wiring.
      effectsRegistered += 1
      const dispose = () => {}
      disposers.push(dispose)
      return dispose
    },
    waterfall: () => Promise.resolve('unavailable'),
    agents: { get: () => undefined },
    api: () => services,
    effectsRegistered: () => effectsRegistered,
  }
}

/** A temp DSH home with one Web account and one recorded conversation. */
function fixture({ botId = 'bot0', chatKey = 'ch:chan1', sessionId = 's1', users = null, updatedAt = Date.now() - 60_000 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'web-wiring-'))
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'web-auth.json'), JSON.stringify(users || { username: 'local', passwordHash: 'x', secret: 'y' }))
  const stateDir = join(root, 'state')
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, 'session-map.json'), JSON.stringify({
    version: 1,
    entries: {
      [`b${botId}:${chatKey}`]: {
        sessionId,
        generation: 0,
        createdAt: updatedAt - 1_000,
        updatedAt,
        botId,
        userId: 'u1',
        channelId: 'chan1',
        rootId: undefined,
        history: [],
      },
    },
  }))
  return { root, home, stateDir }
}

/** Base plugin config: one bot, one allowed user, no network. */
function pluginConfig(stateDir, webApproval) {
  return {
    baseUrl: 'http://127.0.0.1:1',
    token: 'test-token',
    stateDir,
    allowedUsers: ['u1'],
    requireMention: true,
    webApproval,
  }
}

function boot({ webApproval, fixtureOptions } = {}) {
  const f = fixture(fixtureOptions)
  process.env.DSH_HOME = f.home
  const ctx = stubContext()
  apply(ctx, pluginConfig(f.stateDir, webApproval))
  return { ...f, ctx, api: ctx.api().get('mattermost') }
}

test('A-14a: defaults come up OFF and the probe refuses every route', async () => {
  const booted = boot()
  try {
    const status = booted.api.webApproval.status()
    assert.equal(status.configured, false)
    assert.equal(status.enabled, false)
    assert.equal(status.principals, 1)
    const route = await booted.api.webApproval.route('bot0')
    assert.deepEqual(route, { mode: 'none', reason: 'disabled' })
  } finally {
    rmSync(booted.root, { recursive: true, force: true })
  }
})

test('A-14b: a configured approver list enables the probe, but without a Mattermost client it stays fail-closed', async () => {
  const booted = boot({
    webApproval: { approvers: ['u1'], auto: true, ttlMs: 24 * HOUR },
  })
  try {
    const status = booted.api.webApproval.status()
    assert.equal(status.configured, true)
    assert.equal(status.enabled, true)
    assert.equal(status.auto, true)
    assert.equal(status.approvers, 1)
    assert.deepEqual(status.problems, [])
    // No client is connected in this harness, so the channel/member probe cannot
    // answer. A destination that cannot be classified is never actionable.
    const route = await booted.api.webApproval.route('bot0')
    assert.equal(route.mode, 'none')
    assert.equal(route.reason, 'channel-unreachable')
    assert.equal(route.priority, 'auto')
  } finally {
    rmSync(booted.root, { recursive: true, force: true })
  }
})

test('A-14g: an automatic candidate older than the TTL is refused as stale', async () => {
  const booted = boot({
    webApproval: { approvers: ['u1'], auto: true, ttlMs: 24 * HOUR },
    fixtureOptions: { updatedAt: Date.now() - 25 * HOUR },
  })
  try {
    const route = await booted.api.webApproval.route('bot0')
    assert.equal(route.mode, 'none')
    assert.equal(route.reason, 'stale')
  } finally {
    rmSync(booted.root, { recursive: true, force: true })
  }
})

test('A-14c: an approver outside allowedUsers disables the feature and is logged as an error', async () => {
  const booted = boot({
    webApproval: { approvers: ['u1', 'intruder-long-id'], auto: true },
  })
  try {
    const status = booted.api.webApproval.status()
    assert.equal(status.configured, true) // configured, but…
    assert.equal(status.enabled, false) // …refused
    assert.equal(status.problems.length, 1)
    const route = await booted.api.webApproval.route('bot0')
    assert.deepEqual(route, { mode: 'none', reason: 'disabled' })

    const log = readFileSync(join(booted.stateDir, 'plugin.log'), 'utf8')
    assert.match(log, /web approval configuration rejected/)
    assert.match(log, /approver intrude/) // 8-char prefix only
    assert.doesNotMatch(log, /intruder-long-id/)
  } finally {
    rmSync(booted.root, { recursive: true, force: true })
  }
})

test('A-14d: two Web accounts stop the automatic route at the principal guard', async () => {
  const booted = boot({
    webApproval: { approvers: ['u1'], auto: true },
    fixtureOptions: { users: { users: [{}, {}] } },
  })
  try {
    assert.equal(booted.api.webApproval.status().principals, 2)
    const route = await booted.api.webApproval.route('bot0')
    assert.equal(route.mode, 'none')
    assert.equal(route.reason, 'multi-principal')
  } finally {
    rmSync(booted.root, { recursive: true, force: true })
  }
})

test('A-14e: an explicit binding is selected first, and still needs a readable channel to become actionable', async () => {
  const bound = boot({
    webApproval: { approvers: ['u1'], binding: { bot0: 'dm:dmchan1' } },
    fixtureOptions: { chatKey: 'dm:dmchan1' },
  })
  try {
    const route = await bound.api.webApproval.route('bot0')
    assert.equal(route.priority, 'binding')
    assert.equal(route.channelId, 'chan1')
    assert.equal(route.mode, 'none') // no client → cannot verify one-to-one
    assert.equal(route.reason, 'channel-unreachable')
  } finally {
    rmSync(bound.root, { recursive: true, force: true })
  }

  const fixed = boot({
    webApproval: { approvers: ['u1'], channel: 'chan-fixed', binding: { bot0: 'ch:chan1' } },
  })
  try {
    const route = await fixed.api.webApproval.route('bot0')
    assert.equal(route.priority, 'channel')
    assert.equal(route.channelId, 'chan-fixed')
    assert.equal(route.mode, 'none')
  } finally {
    rmSync(fixed.root, { recursive: true, force: true })
  }
})

test('A-14f: startup performs no approval work — no audit file, no pending record', () => {
  const booted = boot({ webApproval: { approvers: ['u1'], auto: true } })
  try {
    assert.equal(existsSync(join(booted.stateDir, 'approvals.log')), false)
    assert.deepEqual(booted.api.approvals.pending(), [])
    assert.equal(booted.api.approvals.stats().asked, 0)
    // The WebSocket/agent startup effect was registered but never executed.
    assert.equal(booted.ctx.effectsRegistered(), 1)
  } finally {
    rmSync(booted.root, { recursive: true, force: true })
  }
})
