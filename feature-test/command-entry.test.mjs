// Command-entry regression tests (D1).
//
// Production defect, measured 2026-11-02: a bare `/session` post was dropped by
// the mention gate before the command layer ever ran, and `@dsh /session` was
// handed to the agent as chat. Both are admission-order bugs, so the tests below
// exercise the admission decision directly — the same functions `handlePost`
// calls, in the same order.
//
// Run: node --test feature-test/command-entry.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  KNOWN_COMMANDS,
  parseCommand,
  stripMention,
  decideTrigger,
  admitInbound,
} from '../index.js'

const BOT = 'dsh'
const cmd = (text) => parseCommand(text, BOT)

/** Admission for a normal post in a single-bot channel. */
function channelAdmit(text, overrides = {}) {
  const parsed = cmd(text)
  return admitInbound({
    isSystem: false,
    isOwn: false,
    channelAllowed: true,
    authorized: true,
    isDirect: false,
    free: false,
    mentioned: /@dsh\b/i.test(text),
    requireMention: true,
    command: parsed,
    ambiguousChannel: false,
    ...overrides,
  })
}

// ---------------------------------------------------------------- parsing ---

test('known commands are exactly the ten documented ones', () => {
  assert.deepEqual(
    [...KNOWN_COMMANDS].sort(),
    ['approvals', 'approve', 'new', 'reject', 'session', 'sessions', 'steer', 'stop', 'switch', 'task'],
  )
})

test('bare command parses at the start of the message', () => {
  const p = cmd('/session')
  assert.equal(p.command, 'session')
  assert.equal(p.known, true)
  assert.equal(p.rest, '')
})

test('a mention in front of a command is stripped with the same pattern', () => {
  const p = cmd('@dsh /switch 2')
  assert.equal(p.command, 'switch')
  assert.equal(p.rest, '2')
  assert.equal(p.stripped, '/switch 2')
})

test('another bot mention is NOT stripped and never becomes a command', () => {
  const p = cmd('@other /session')
  assert.equal(p.command, null)
  assert.equal(p.known, false)
  assert.match(p.stripped, /@other/)
})

test('a command later in the text is not a command', () => {
  const p = cmd('please run /session for me')
  assert.equal(p.command, null)
})

test('unknown slash text parses but is not known', () => {
  const p = cmd('@dsh /whatever now')
  assert.equal(p.command, 'whatever')
  assert.equal(p.known, false)
})

test('stripMention removes only the given bot mention', () => {
  assert.equal(stripMention('@dsh hello @dsh', BOT), 'hello')
  assert.equal(stripMention('@other hello', BOT), '@other hello')
  assert.equal(stripMention('hello', BOT), 'hello')
})

// ------------------------------------------------------------- admission ---

test('1. channel bare /session enters the command path', () => {
  const r = channelAdmit('/session')
  assert.equal(r.allowed, true)
  assert.equal(r.reason, 'ok')
  assert.equal(r.gate.bareCommand, true)
})

test('2. channel @dsh /session enters the same command path', () => {
  const r = channelAdmit('@dsh /session')
  assert.equal(r.allowed, true)
  assert.equal(cmd('@dsh /session').command, 'session')
  assert.equal(r.gate.bareCommand, false, 'it passed by mention, not by the command bypass')
})

test('3. channel bare plain message is still blocked by the mention gate', () => {
  const r = channelAdmit('hello there')
  assert.equal(r.allowed, false)
  assert.equal(r.reason, 'trigger')
})

test('4. channel @dsh plain message is accepted', () => {
  assert.equal(channelAdmit('@dsh hello there').allowed, true)
})

test('5. channel bare /unknown does NOT bypass the mention gate', () => {
  const r = channelAdmit('/unknown')
  assert.equal(r.allowed, false)
  assert.equal(r.gate.bareCommand, false)
})

test('6. an unauthorized user is rejected before the command layer', () => {
  const r = channelAdmit('/session', { authorized: false })
  assert.equal(r.allowed, false)
  assert.equal(r.reason, 'unauthorized')
})

test('7. a non-whitelisted channel is rejected before the command layer', () => {
  const r = channelAdmit('/session', { channelAllowed: false })
  assert.equal(r.allowed, false)
  assert.equal(r.reason, 'channel')
})

test('8. DM keeps its no-mention behaviour, command or not', () => {
  assert.equal(channelAdmit('/session', { isDirect: true }).allowed, true)
  assert.equal(channelAdmit('hello', { isDirect: true }).allowed, true)
})

test('9. the bot never reacts to its own posts', () => {
  const r = channelAdmit('/session', { isOwn: true })
  assert.equal(r.allowed, false)
  assert.equal(r.reason, 'own')
})

test('10. system and deleted posts are rejected first', () => {
  assert.equal(channelAdmit('/session', { isSystem: true }).reason, 'system')
})

test('11. two bots on one channel do not both answer a bare command', () => {
  const r = channelAdmit('/session', { ambiguousChannel: true })
  assert.equal(r.allowed, false, 'bare command must not fire when the channel is shared')
  assert.equal(r.gate.bareCommand, false)
})

test('11b. two bots on one channel still answer their OWN mention', () => {
  const r = channelAdmit('@dsh /session', { ambiguousChannel: true })
  assert.equal(r.allowed, true)
})

test('12. an unknown command that reached the layer is not a chat trigger', () => {
  // It is admitted (a mention was present) but it is NOT a plain-chat message:
  // handlePost replies "unknown command" and returns instead of dispatching.
  const p = cmd('@dsh /nope')
  assert.equal(p.command, 'nope')
  assert.equal(p.known, false)
  const gate = decideTrigger({
    isDirect: false, free: false, mentioned: true, requireMention: true,
    command: p, ambiguousChannel: false,
  })
  assert.equal(gate.allowed, true)
  assert.equal(gate.bareCommand, false)
})

test('requireMention=false does not change the bypass rules', () => {
  const r = channelAdmit('/session', { requireMention: false })
  assert.equal(r.allowed, true)
})

test('freeResponse channel accepts a plain message', () => {
  assert.equal(channelAdmit('hello', { free: true }).allowed, true)
})
