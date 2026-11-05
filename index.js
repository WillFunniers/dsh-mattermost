/**
 * dsh-mattermost — Mattermost as a DSH task entry point.
 *
 * Mattermost message -> chatKey -> sessionId -> live agent in THIS process.
 * The agent is created here, so `dsh web` (same process) sees the very same
 * session: the GUI can open it, watch it run, and send into it without ever
 * contending for a cross-process session write lease.
 *
 * FROZEN architecture (do not redesign — each part is backed by a passing test):
 *   - live agent reuse via ctx.agents.get(sessionId)          (V4: sameObject=true)
 *   - sessionQuery.observeSession() for existence             (V4: exists=true)
 *   - followup() queues when the session is busy              (V5: running=true -> followup)
 *   - /steer is the ONLY way to redirect a running task
 *   - /task starts a new thread, hence a new session
 *   - mapping.js is the single source of session ids          (V6)
 *   - thread -> th:<root_post_id>                             (V6)
 *   - streaming stays false (this adapter implements no card editing EXCEPT the
 *     approval card's own status line, which is not conversation streaming)
 *   - approval decisions ride the native `approval/request` waterfall (prepend,
 *     owned agents only, always delegating the rest)
 *   - every bot owns its own client, state file and session namespace
 *
 * Admission order (mirrors the production bridge):
 *   own/system/deleted -> channel whitelist -> user authorization
 *   -> command parse (this bot's mention stripped) -> trigger -> bot-chain
 *   budget -> command layer -> dispatch
 *
 * A KNOWN command is itself a trigger, so `/session` works in a channel that
 * otherwise requires an `@mention`. Unknown `/xxx` still needs the mention, and
 * never falls through to the chat branch.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createMattermostClient } from './mattermost.js'
import { createAgentManager } from './agents.js'
import { createOutbound } from './outbound.js'
import { createSessionMap, deriveKey, taskKey, sessionIdFor } from './mapping.js'
import { resolveBots } from './bots.js'
import { createApprovalBridge } from './approvals.js'
import {
  normalizeWebApproval, validateWebApproval, describeWebApproval, resolveWebRoute, countWebPrincipals,
} from './web-route.js'
import { maskAndClip } from './redact.js'
import {
  parseSelector, pickGeneration, renderSessionList, renderCurrent, switchBlocker, ageText,
} from './navigator.js'
import { openJobStore } from './jobs.js'
import { createScheduler } from './scheduler.js'
import { registerJobTools } from './tools.js'
import { openFaultStore, renderFault, faultId } from './faults.js'
import { digest, oneLine, shortId } from './logsafe.js'

export const name = 'dsh-mattermost'
export const inject = ['agents', 'agentDefaultModel']

export const Config = Schema.object({
  baseUrl: Schema.string().default(''),
  tokenRef: Schema.string().default('MATTERMOST_TOKEN'),
  token: Schema.string().role('secret').default(''),
  cwd: Schema.string().default(''),

  /** Empty = every channel the bot is in. Production must list them explicitly. */
  channels: Schema.array(Schema.string()).default([]),
  /** Channels allowed to answer without an @mention. Production should be empty. */
  freeResponseChannels: Schema.array(Schema.string()).default([]),
  requireMention: Schema.boolean().default(true),

  /** User authorization. Default-deny: allowAll=false + empty list rejects everyone. */
  allowedUsers: Schema.array(Schema.string()).default([]),
  allowAll: Schema.boolean().default(false),

  /** Bot-to-bot loop budget, same semantics as the production bridge. */
  allowBotMentions: Schema.boolean().default(true),
  botChainMax: Schema.number().step(1).min(0).default(5),
  botChainWindowMs: Schema.number().step(1).min(1_000).default(120_000),

  /** Idle live-agent eviction. Sessions stay durable; only the runtime agent is released. */
  idleAgentTtlMs: Schema.number().step(1_000).min(60_000).default(30 * 60_000),
  idleSweepIntervalMs: Schema.number().step(1_000).min(10_000).default(60_000),

  /**
   * Durable delayed jobs.
   *
   * Deliberately NOT tied to `idleAgentTtlMs`: the whole point is that a job's
   * lifetime is independent of the live agent's, so tuning the TTL is never the
   * mechanism that makes delayed work reliable.
   */
  schedulerEnabled: Schema.boolean().default(true),
  schedulerTickMs: Schema.number().step(500).min(1_000).default(5_000),
  jobLeaseMs: Schema.number().step(1_000).min(10_000).default(300_000),
  jobMaxAttempts: Schema.number().step(1).min(1).max(20).default(3),
  maxDispatchPerTick: Schema.number().step(1).min(1).max(100).default(5),
  /**
   * How long to wait before retrying a job whose target session is busy.
   * A running agent is never handed new work (see scheduler.js): a message
   * queued into an in-flight turn can be lost by a restart.
   */
  jobBusyRetryMs: Schema.number().step(1_000).min(1_000).default(30_000),
  jobMaxPerSession: Schema.number().step(1).min(1).max(1_000).default(50),
  jobMaxHorizonMs: Schema.number().step(1).min(60_000).default(30 * 24 * 60 * 60 * 1_000),

  /** Empty = $DSH_HOME/mattermost. Never default to a test path. */
  stateDir: Schema.string().default(''),
  backfill: Schema.boolean().default(true),
  maxReplyChars: Schema.number().step(1).min(500).default(12_000),
  debug: Schema.boolean().default(false),

  /**
   * Approval Bridge.
   *
   * `approvalEnabled` is an operator escape hatch, not a policy: disabled means
   * this plugin declines to answer and every request goes to `next()` (the Web
   * answerer, exactly as before this feature existed). DSH's own `ask` / `never`
   * session policy is never overridden in either position.
   *
   * The timeout must be SHORTER than the tool call's own deadline, so an
   * unanswered card resolves to the fail-closed `unavailable` before the tool
   * aborts — the model then reads "no approval channel" instead of a bare
   * cancellation, which is the honest explanation.
   */
  approvalEnabled: Schema.boolean().default(true),
  approvalTimeoutMs: Schema.number().step(1_000).min(30_000).max(3_600_000).default(300_000),

  /**
   * Where an approval requested by a DSH WEB session would be announced.
   *
   * Off by default in every field: empty `approvers` means "no announcement",
   * which is exactly today's behaviour (the browser prompt alone answers). The
   * destination is chosen by `web-route.js`; it never widens who may decide,
   * because `approvers` must be a subset of the bot's `allowedUsers`.
   *
   *   channel   P1 — fixed channel id (or `ch:`/`dm:` key)
   *   binding   P2 — { botId: chatKey } explicit conversation
   *   auto      P3 — single-user inference; all guards in web-route.js apply
   *   ttlMs     how old a conversation may be and still be used
   *   approvers who may decide a Web-origin request (subset of allowedUsers)
   */
  webApproval: Schema.object({
    channel: Schema.string().default(''),
    binding: Schema.dict(Schema.string()).default({}),
    auto: Schema.boolean().default(false),
    ttlMs: Schema.number().step(60_000).min(60_000).max(30 * 24 * 60 * 60 * 1_000)
      .default(24 * 60 * 60 * 1_000),
    approvers: Schema.array(Schema.string()).default([]),
  }).default({}),

  /**
   * Whether a WEB-origin approval card may render the tool's arguments.
   *
   * `off` (default) shows only "arguments are not displayed". `masked` shows them
   * masked and truncated, exactly like a Mattermost-origin card. This setting
   * never affects Mattermost-origin cards, which keep their existing behaviour.
   */
  approvalCardArguments: Schema.string().default('off'),

  /** `/sessions` shows at most this many generations of the current conversation. */
  navigatorLimit: Schema.number().step(1).min(3).max(20).default(8),

  /**
   * Multiple Mattermost bots.
   *
   * Empty means the flat fields above describe bot #0 — the shape every existing
   * deployment already has. With entries, each bot gets its own token, channels,
   * authorization set, WebSocket, state file and session-key namespace; omitted
   * fields inherit the flat value (see bots.js).
   */
  bots: Schema.array(Schema.object({
    id: Schema.string(),
    baseUrl: Schema.string(),
    tokenRef: Schema.string(),
    token: Schema.string().role('secret'),
    channels: Schema.array(Schema.string()),
    freeResponseChannels: Schema.array(Schema.string()),
    requireMention: Schema.boolean(),
    allowedUsers: Schema.array(Schema.string()),
    allowAll: Schema.boolean(),
    allowBotMentions: Schema.boolean(),
    botChainMax: Schema.number().step(1).min(0),
    botChainWindowMs: Schema.number().step(1).min(1_000),
  })).default([]),
})

/** The DSH home, exactly as the rest of the harness resolves it. */
function defaultStateDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'mattermost')
}

// ---- command entry ---------------------------------------------------------
//
// A command is recognised from what the user actually typed. Two forms must
// work: `/session` and `@dsh /session`. The mention is therefore stripped
// BEFORE the command is parsed, using the SAME pattern that `isMention` uses
// (`@<this bot's username>\b`), so another bot's mention is never stripped and
// never mistaken for this bot addressing the message.
//
// The functions below are pure and exported on purpose: the trigger decision is
// the part that broke in production (a command typed without a mention was
// silently dropped by the mention gate), and it deserves tests that do not need
// a running Mattermost.
export const KNOWN_COMMANDS = Object.freeze([
  'task', 'new', 'stop', 'steer',
  'session', 'sessions', 'switch',
  'approve', 'reject', 'approvals',
])

/** The mention pattern for one bot username, or null when it is unknown. */
export function mentionPattern(username) {
  if (!username) return null
  const escaped = String(username).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`@${escaped}\\b`, 'ig')
}

/** `@dsh /session` -> `/session`; a message without the mention is returned trimmed. */
export function stripMention(text, username) {
  const raw = String(text == null ? '' : text)
  const pattern = mentionPattern(username)
  return (pattern ? raw.replace(pattern, '') : raw).trim()
}

/**
 * Split a message into its command, if any.
 *
 * `known` distinguishes a real command from a `/`-prefixed chat message: only a
 * KNOWN command may bypass `requireMention`, so `/whatever` keeps obeying it.
 */
export function parseCommand(text, username) {
  const stripped = stripMention(text, username)
  const match = /^\/([A-Za-z0-9_-]+)\s*/.exec(stripped)
  if (!match) return { stripped, command: null, rest: stripped, known: false }
  const command = match[1].toLowerCase()
  return {
    stripped,
    command,
    rest: stripped.slice(match[0].length).trim(),
    known: KNOWN_COMMANDS.includes(command),
  }
}

/**
 * Decide whether one inbound post may proceed.
 *
 * Rules, in the order the production defect got wrong:
 *   - a DM always passes (unchanged);
 *   - a `freeResponseChannels` entry always passes (unchanged);
 *   - a mention always passes (unchanged);
 *   - a KNOWN command passes WITHOUT a mention, because `/session` is an
 *     explicit instruction, not ambient chatter — but only when the channel is
 *     served by exactly one bot, so two bots can never both answer one command;
 *   - everything else still obeys `requireMention`.
 */
export function decideTrigger({ isDirect, free, mentioned, requireMention, command, ambiguousChannel }) {
  // `bareCommand` means the bypass actually stood in for a mention — not merely
  // that it was available.
  const bareCommand = Boolean(command && command.known)
    && !isDirect && !free && !ambiguousChannel && !mentioned
  const triggered = Boolean(isDirect || free || mentioned || bareCommand)
  const mentionBlocked = Boolean(
    !isDirect && !free && requireMention !== false && !mentioned && !bareCommand,
  )
  return { triggered, mentionBlocked, bareCommand, allowed: triggered && !mentionBlocked }
}

/**
 * The whole inbound admission decision, in one order.
 *
 * The order is the contract: identity and authorization come FIRST, so a bare
 * command can never enter before them — `/session` bypasses the mention
 * requirement, never the user or channel checks.
 */
export function admitInbound({
  isSystem, isOwn, channelAllowed, authorized,
  isDirect, free, mentioned, requireMention, command, ambiguousChannel,
}) {
  if (isSystem) return { allowed: false, reason: 'system' }
  if (isOwn) return { allowed: false, reason: 'own' }
  if (!channelAllowed) return { allowed: false, reason: 'channel' }
  if (!authorized) return { allowed: false, reason: 'unauthorized' }
  const gate = decideTrigger({ isDirect, free, mentioned, requireMention, command, ambiguousChannel })
  if (!gate.triggered) return { allowed: false, reason: 'trigger', gate }
  if (gate.mentionBlocked) return { allowed: false, reason: 'mention', gate }
  return { allowed: true, reason: 'ok', gate }
}

export function apply(ctx, config) {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const stateDir = config.stateDir || defaultStateDir()
  const rawLogger = ctx.logger('dsh-mattermost')

  // Mirrored to a file: the host logger's sink is not readable from a shell, and
  // these tests need evidence, not inference.
  const logFile = `${stateDir}/plugin.log`
  function write(level, message) {
    // `oneLine` is applied centrally so no caller can hand a raw external value
    // (a message body, an error stack) straight into a line-oriented file.
    const line = `${new Date().toISOString()} ${level} ${oneLine(message)}\n`
    try {
      // Explicit modes: this directory holds user-adjacent operational data, and
      // the process umask (0022) would otherwise create it 0755/0644.
      mkdirSync(stateDir, { recursive: true, mode: 0o700 })
      appendFileSync(logFile, line, { mode: 0o600 })
    } catch { /* best effort */ }
    try {
      if (level === 'ERROR') rawLogger.error(message)
      else if (level === 'WARN') rawLogger.warn(message)
      else rawLogger.info(message)
    } catch { /* best effort */ }
  }
  const logger = {
    info: (m) => write('INFO', m),
    warn: (m) => write('WARN', m),
    error: (m) => write('ERROR', m),
  }

  const cwd = config.cwd || process.cwd()

  // Resolve the bot set exactly once, at load. A malformed id or a duplicate is
  // a composition error: it throws here (the fiber reports FAILED) instead of
  // silently collapsing two bots into one namespace.
  let bots
  try {
    bots = resolveBots(config)
  } catch (error) {
    write('ERROR', `bot configuration rejected: ${error.message}`)
    throw error
  }
  const primaryBot = bots[0]
  for (const bot of bots) {
    if (!bot.baseUrl && process.env.MATTERMOST_URL) bot.baseUrl = process.env.MATTERMOST_URL
    bot.baseUrl = String(bot.baseUrl || '').replace(/\/+$/, '')
  }
  write(
    'INFO',
    `apply() entered; bots=${bots.map((b) => `${b.id}${b.baseUrl ? '' : '(no url)'}`).join(',')} ` +
    `stateDir=${stateDir}`,
  )

  // ---- A1: Web-origin approval routing (configuration only) ----------------
  //
  // Resolved once at load so an approver list that reaches beyond `allowedUsers`
  // is a startup error instead of a surprise at the first request. Nothing on the
  // approval path consumes this yet: A2 posts the card, A3 adds the second
  // answerer. Until then the only effect is one log line and a read-only probe on
  // the plugin's status surface.
  const webApproval = normalizeWebApproval(config.webApproval)
  const webApprovalCheck = validateWebApproval({ webApproval, bots })
  const webApprovalEnabled = webApprovalCheck.ok && webApproval.approvers.length > 0
  if (!webApprovalCheck.ok) {
    logger.error(`web approval configuration rejected (Web notifications stay OFF): ${webApprovalCheck.problems.join('; ')}`)
  }
  write(
    'INFO',
    `web approval routing ${describeWebApproval(webApproval, {
      enabled: webApprovalEnabled,
      problems: webApprovalCheck.ok ? [] : webApprovalCheck.problems,
    })}`,
  )

  // Resolve the token without putting the secret in config: prefer the plugin
  // config value, then the DSH credential store, then a plain environment var.
  //
  // The credential provider populates its store inside [Service.init], but
  // resolve() does NOT await that load — it reads the in-memory map directly. A
  // plugin whose apply() runs before that load therefore sees "no value", and if
  // it gives up it stays idle forever. Observed in production: the same config
  // resolved at one boot and returned `token=missing` at the next. So poll until
  // the store answers, then fall back to the environment.
  async function resolveTokenFor(bot) {
    if (bot.token) return bot.token
    const ref = bot.tokenRef || 'MATTERMOST_TOKEN'
    const deadline = Date.now() + 60_000
    let announced = false
    for (;;) {
      const creds = ctx.get('credentials')
      if (creds) {
        try {
          const { credentialRef } = await import('@deepseek-ai/dsh-credentials')
          const hit = await creds.resolve(credentialRef(ref))
          if (hit && hit.value) return hit.value
        } catch (error) {
          logger.warn(`credential lookup failed: ${error.message}`)
        }
      }
      const fromEnv = process.env[ref] || process.env.MATTERMOST_TOKEN
      if (fromEnv) return fromEnv
      if (Date.now() >= deadline) {
        logger.warn(`token ref "${ref}" unresolved after 60s for bot ${bot.id} (credentials service ${creds ? 'present' : 'absent'})`)
        return ''
      }
      if (!announced) {
        announced = true
        write('INFO', `waiting for credential "${ref}" for bot ${bot.id} (credentials service ${creds ? 'present' : 'not ready'})`)
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
  }

  const sessionMap = createSessionMap({
    file: `${stateDir}/session-map.json`,
    logger,
    legacyBotId: primaryBot.id,
  })

  // sessionId -> where to deliver its output. Rebuilt from the durable map on
  // startup so a resumed session still knows its Mattermost home.
  const targets = new Map()
  function rememberTarget(botId, chatKey, entry) {
    if (entry && entry.channelId) {
      targets.set(entry.sessionId, {
        botId,
        chatKey,
        // Captured so a durable job can record its delivery target and its
        // authorization owner at creation, without depending on live state.
        channelId: entry.channelId,
        rootId: entry.rootId || undefined,
        userId: entry.userId || undefined,
      })
    }
  }

  /**
   * Rebuild the sessionId -> Mattermost home index.
   *
   * A scoped key is `b<botId>:<chatKey>`; the bot id is authoritative (it is in
   * the key), so an entry written before multi-bot existed resolves to the
   * legacy bot. Every lookup that decides "do I own this agent?" or "where does
   * this reply go?" goes through this map, so an unlisted session is by
   * definition not ours.
   */
  function chatKeyOf(storedKey) {
    const text = String(storedKey || '')
    const colon = text.indexOf(':')
    if (colon > 1 && text.startsWith('b')) {
      return { botId: text.slice(1, colon), chatKey: text.slice(colon + 1) }
    }
    return { botId: primaryBot.id, chatKey: text }
  }
  for (const entry of sessionMap.entries()) {
    const { botId, chatKey } = chatKeyOf(entry.key)
    rememberTarget(botId, chatKey, entry)
  }

  /**
   * Which OTHER conversation currently holds `sessionId`, if any.
   *
   * Returns the raw key only when the holder is a different (bot, chatKey)
   * pair, so a legacy bare key and its scoped mirror — the same conversation —
   * never count as a foreign owner.
   */
  function foreignOwnerOf(botId, chatKey, sessionId) {
    for (const entry of sessionMap.entries()) {
      if (entry.sessionId !== sessionId) continue
      const owner = chatKeyOf(entry.key)
      if (owner.botId !== botId || owner.chatKey !== chatKey) return entry.key
    }
    return undefined
  }

  /**
   * Where a session's output goes, and who owns it. A job records both at
   * creation, so its delivery never depends on this process having seen the
   * session before. Returns undefined for a session that is not bound to a
   * Mattermost conversation — such a session cannot schedule a deliverable job.
   */
  function resolveJobContext(sessionId) {
    const target = targets.get(sessionId)
    if (!target || !target.channelId) return undefined
    return { channelId: target.channelId, rootId: target.rootId, userId: target.userId || 'unknown' }
  }

  function requireJobStore() {
    if (!jobStore) throw new Error('定时任务存储尚未就绪（scheduler unavailable）')
    return jobStore
  }

  /** botId -> Mattermost client (one WebSocket and one state file each). */
  const clients = new Map()
  let agentManager = null
  let outbound = null
  let started = false
  let jobStore = null
  let scheduler = null
  let jobToolsDispose = null
  let jobPromptDispose = null
  let faultStore = null

  const stats = { authorized: 0, unauthorized: 0, chainRejected: 0, channelRejected: 0, evicted: 0 }

  /** The client for one bot, or undefined before startup. */
  function clientFor(botId) {
    return clients.get(botId)
  }
  /** Coarse "is anything connected" used by /status. */
  function primaryClient() {
    return clients.get(primaryBot.id) || clients.values().next().value
  }

  /** A connected client for `botId`, else any connected one. */
  function connectedClient(botId) {
    if (botId) {
      const preferred = clients.get(botId)
      if (preferred && preferred.state.connected) return preferred
    }
    for (const mm of clients.values()) if (mm.state.connected) return mm
    return undefined
  }

  /** The bot that should deliver one fault notification about `event`. */
  function faultTransport(event) {
    const target = event && event.sessionId ? targets.get(String(event.sessionId)) : undefined
    return connectedClient(target && target.botId)
  }

  // ---- R2: bot chain budget, per (bot, channel), same shape as the production bridge --
  //
  // Keyed with the bot id: two bots conversing in one channel are two separate
  // budgets. A shared budget would let bot A's traffic silence bot B.
  const chainGuards = new Map()
  function chainGuard(botId, channelId) {
    const key = `${botId}:${channelId}`
    let g = chainGuards.get(key)
    if (!g) { g = { depth: 0, lastBotAt: 0 }; chainGuards.set(key, g) }
    return g
  }
  function botTriggerAllowed(bot, channelId) {
    const g = chainGuard(bot.id, channelId)
    // A quiet period means the exchange is over; the budget starts fresh.
    if (g.lastBotAt && Date.now() - g.lastBotAt > bot.botChainWindowMs) g.depth = 0
    return g.depth < bot.botChainMax
  }

  // ---- R3: user authorization, default-deny, PER BOT --------------------------
  function isAuthorized(bot, userId) {
    if (bot.allowAll) return true
    if (!Array.isArray(bot.allowedUsers) || bot.allowedUsers.length === 0) return false
    return bot.allowedUsers.some((u) => String(u) === String(userId))
  }

  function isOwnPost(bot, post) {
    const mm = clientFor(bot.id)
    return Boolean(mm && mm.me && post.user_id === mm.me.id)
  }
  function isBotPost(post) {
    return String(post.props?.from_bot) === 'true'
  }
  function isMention(text, bot) {
    const mm = clientFor(bot.id)
    const username = mm && mm.me ? mm.me.username : null
    if (!username) return false
    return new RegExp(`@${username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text)
  }
  function allowedChannel(bot, channelId) {
    if (!bot.channels || bot.channels.length === 0) return true
    return bot.channels.includes(channelId)
  }
  function freeResponse(bot, channelId) {
    return Array.isArray(bot.freeResponseChannels) && bot.freeResponseChannels.includes(channelId)
  }

  // ---- Approval Bridge ------------------------------------------------------
  //
  // Presentation data for the card: the tool call's own arguments, looked up by
  // `callId` in the LIVE session's log. Three deliberate limits:
  //   - read-only, and only from a session this plugin already owns;
  //   - bounded scan (400 events) so a long session cannot make an approval slow;
  //   - masked and clipped before it leaves this function, and never logged.
  const ARG_SCAN_WINDOW = 400
  function readToolArguments(sessionId, callId) {
    try {
      const live = ctx.agents.get(sessionId)
      const session = live && live.session
      if (!session || typeof session.eventAt !== 'function') return undefined
      const seq = Number(session.seq) || 0
      const floor = Math.max(0, seq - ARG_SCAN_WINDOW)
      for (let index = seq - 1; index >= floor; index -= 1) {
        const event = session.eventAt(index)
        if (!event || event.type !== 'tool/call' || !event.data) continue
        if (String(event.data.callId) !== String(callId)) continue
        if (typeof event.data.arguments !== 'string') return undefined
        return maskAndClip(event.data.arguments, 800).text
      }
      return undefined
    } catch (error) {
      logger.warn(`tool arguments lookup failed: ${error.message}`)
      return undefined
    }
  }

  function botUsername(botId) {
    const mm = clientFor(botId)
    return mm && mm.me ? mm.me.username : undefined
  }

  /**
   * Channel + membership lookup used by the Web-approval router.
   *
   * A chat key says `dm:` when the channel was CREATED as a direct message; it
   * says nothing about how many people can read it now. The decision card may
   * only exist in a verified one-to-one DM, so the member list is part of the
   * answer, not an optimisation.
   */
  async function describeChannelFor(bot, channelId) {
    const mm = clientFor(bot.id) || connectedClient(bot.id)
    if (!mm) return undefined
    const channel = await mm.fetchChannel(channelId)
    if (!channel || !channel.id) return undefined
    const type = String(channel.type || '')
    let memberIds
    if (type === 'D' || type === 'G') {
      const members = typeof mm.fetchMembers === 'function' ? await mm.fetchMembers(channelId) : undefined
      memberIds = Array.isArray(members) ? members.map((entry) => String(entry.user_id)) : undefined
    }
    return { id: String(channel.id), type, name: channel.name, memberIds }
  }

  /**
   * Resolve the announcement destination for a Web-origin request.
   *
   * The caller is the approval bridge; the decision to make it `actionable`
   * belongs entirely to `web-route.js`. `botId` is added here because the router
   * deliberately does not know how to reach a Mattermost client.
   */
  function webRouteFor(bot, sessionId) {
    if (!webApprovalEnabled) return Promise.resolve({ mode: 'none', reason: 'disabled', botId: bot.id })
    const mm = clientFor(bot.id)
    return resolveWebRoute({
      botId: bot.id,
      botUserId: mm && mm.me ? String(mm.me.id) : undefined,
      webApproval,
      entries: sessionMap.entries(),
      allowedUsers: bot.allowAll ? [] : bot.allowedUsers,
      channels: bot.channels,
      principalCount: countWebPrincipals(join(dshHome, 'web-auth.json')),
      describeChannel: (channelId) => describeChannelFor(bot, channelId),
    }).then((route) => ({ ...route, botId: bot.id, sessionId }))
  }

  const approvals = createApprovalBridge({
    logger,
    config: { ...config, cardArguments: config.approvalCardArguments },
    deps: {
      /**
       * "Do I own this agent?" — answered from the durable map, never guessed.
       * A session that is not in `targets` is not ours, and `next()` lets the
       * Web answerer handle it exactly as it did before this feature existed.
       */
      lookupTarget: (sessionId) => {
        const target = targets.get(sessionId)
        if (!target) return undefined
        return {
          botId: target.botId,
          chatKey: target.chatKey,
          chatKind: String(target.chatKey || '').split(':')[0],
          channelId: target.channelId,
          rootId: target.rootId,
          userId: target.userId,
          botUsername: botUsername(target.botId),
        }
      },
      sendCard: async (botId, channelId, rootId, card) => {
        const mm = clientFor(botId)
        if (!mm) return undefined
        return mm.sendCard(channelId, rootId, card)
      },
      updateCard: async (botId, postId, card) => {
        const mm = clientFor(botId)
        if (!mm || !postId) return false
        return mm.updatePost(postId, card)
      },
      isAuthorized: (botId, userId) => {
        const bot = bots.find((b) => b.id === botId)
        return bot ? isAuthorized(bot, userId) : false
      },
      /**
       * Where (and whether) a Web-origin request may be announced.
       *
       * Resolved per request, not per boot: the session map, the channel
       * membership and the local Web-principal count all change at runtime, and
       * a stale decision here would be a stale permission.
       */
      resolveWebRoute: (sessionId) => webRouteFor(primaryBot, sessionId),
      readToolArguments,
      /**
       * Durable, append-only audit line per request. Deliberately excludes the
       * reason text and the tool arguments: those live in the DSH session log
       * (the native `approval/asked` / `approval/decided` pair) and must not be
       * duplicated into a second, less-protected file.
       */
      audit: (record) => {
        try {
          mkdirSync(stateDir, { recursive: true, mode: 0o700 })
          appendFileSync(`${stateDir}/approvals.log`, `${oneLine(JSON.stringify(record))}\n`, { mode: 0o600 })
        } catch (error) {
          logger.warn(`approval audit write failed: ${error.message}`)
        }
      },
    },
  })

  /** Route one Mattermost reaction frame to the bridge, scoped to its bot. */
  async function handleReaction(reaction, botId) {
    const postId = reaction && reaction.postId
    if (!postId) return
    const bot = bots.find((b) => b.id === botId)
    if (!bot) return
    if (!isAuthorized(bot, reaction.userId)) {
      stats.unauthorized += 1
      logger.warn(`unauthorized reaction bot=${botId} userId=${shortId(reaction.userId)}`)
      return
    }
    // The post must live in a channel this bot is allowed to serve. This is the
    // same fence inbound posts pass, so a reaction cannot reach a conversation
    // the bot would refuse to answer in.
    if (reaction.channelId && !allowedChannel(bot, reaction.channelId)) return
    approvals.handleReaction({
      botId,
      userId: reaction.userId,
      postId,
      emojiName: reaction.emojiName,
      removed: Boolean(reaction.removed),
    })
  }

  // PREPENDED on purpose: the Web answerer is registered earlier and, when a
  // browser has the session open, it would claim the request and the Mattermost
  // card would never be posted. Prepending makes this plugin first for ITS OWN
  // agents only; every other request is delegated untouched (see approvals.js).
  const approvalListenerDispose = ctx.on(
    'approval/request',
    (request, next) => approvals.handle(request, next),
    { prepend: true },
  )

  /** Best-effort session title: never holds a command for more than 1.2s. */
  async function safeTitle(sessionId) {
    const query = ctx.get('sessionQuery')
    if (!query || typeof query.readTitle !== 'function') return undefined
    let timer
    try {
      const snapshot = await Promise.race([
        query.readTitle(sessionId),
        new Promise((resolve) => { timer = setTimeout(() => resolve(undefined), 1_200) }),
      ])
      const title = snapshot && typeof snapshot.title === 'string' ? snapshot.title.trim() : ''
      return title ? oneLine(title).slice(0, 60) : undefined
    } catch {
      return undefined
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /** Reply through the bot that owns the conversation (never through another). */
  async function say(bot, channelId, text, rootId) {
    const mm = clientFor(bot.id)
    if (!mm) return false
    try {
      await mm.send(channelId, text, rootId)
      return true
    } catch (error) {
      logger.warn(`reply failed bot=${bot.id}: ${error.message}`)
      return false
    }
  }

  /** Human-readable result of one approve/reject attempt. */
  function decisionReply(result, wanted) {
    switch (result.code) {
      case 'ok': return wanted === 'approved' ? '✅ 已批准（仅本次）' : '⛔ 已拒绝'
      case 'unknown': return '⚠️ 没有找到这个审批请求（可能已被清理）。'
      case 'settled': return '⚠️ 该请求已经处理过，不能再次决定。'
      case 'expired': return '⌛ 该请求已过期，未获批准。'
      case 'not-allowed': return '🚫 你没有审批权限。'
      case 'wrong-channel': return '🚫 只能在发起审批的频道里处理该请求。'
      case 'forbidden': return '🚫 该请求不属于这个机器人。'
      default: return `⚠️ 无法处理（${result.code}）`
    }
  }

  async function handlePost(post, channel, botId = primaryBot.id) {
    const bot = bots.find((b) => b.id === botId) || primaryBot
    if (!post || !post.id) return

    // Channel metadata may arrive without a type (probe / backfill). Fetch it
    // before the DM decision; it is a read and creates no state.
    if (channel && post.channel_id === channel.id && channel.type === undefined
      && allowedChannel(bot, post.channel_id)) {
      const mm = clientFor(bot.id)
      channel = (mm && (await mm.fetchChannel(post.channel_id))) || channel
    }

    const text = String(post.message || '').trim()
    const isDirect = channel.type === 'D'
    const free = freeResponse(bot, post.channel_id)
    const mentioned = isMention(text, bot)
    // Only THIS bot's mention is stripped, so another bot's `@other /session`
    // stays a plain message and never becomes a command here.
    const parsed = parseCommand(text, botUsername(bot.id))
    // Two bots serving one channel must never both answer a bare command.
    const sharedChannel = bots.filter((b) => allowedChannel(b, post.channel_id)).length > 1

    // One place decides admission, in one order: system/own/channel/authorization
    // FIRST (nothing may create state before them), then the trigger rules.
    const admission = admitInbound({
      isSystem: Boolean(post.type) || Number(post.delete_at) > 0,
      isOwn: isOwnPost(bot, post),
      channelAllowed: allowedChannel(bot, post.channel_id),
      authorized: isAuthorized(bot, post.user_id),
      isDirect,
      free,
      mentioned,
      requireMention: bot.requireMention,
      command: parsed,
      ambiguousChannel: sharedChannel,
    })
    if (!admission.allowed) {
      if (admission.reason === 'channel') stats.channelRejected += 1
      if (admission.reason === 'unauthorized') {
        stats.unauthorized += 1
        logger.warn(`unauthorized inbound bot=${bot.id} userId=${shortId(post.user_id)} channelId=${shortId(post.channel_id)} reason=unauthorized`)
      }
      return
    }
    stats.authorized += 1
    if (!text) return
    if (admission.gate && admission.gate.bareCommand) {
      logger.info(`command entry without mention bot=${bot.id} ch=${shortId(post.channel_id)} cmd=/${parsed.command}`)
    }

    const botAuthor = isBotPost(post)

    // Any human message resets that channel's bot chain — even one not aimed at us.
    if (!botAuthor) chainGuard(bot.id, post.channel_id).depth = 0

    if (botAuthor) {
      // A bot must address us explicitly; ambient bot chatter never wakes us.
      if (!isDirect && !mentioned) return
      if (!bot.allowBotMentions) {
        logger.info(`bot author ignored bot=${bot.id} userId=${shortId(post.user_id)} (allowBotMentions=false)`)
        return
      }
      if (!botTriggerAllowed(bot, post.channel_id)) {
        stats.chainRejected += 1
        logger.warn(
          `bot chain budget exhausted bot=${bot.id} userId=${shortId(post.user_id)} channelId=${shortId(post.channel_id)} ` +
          `(${bot.botChainMax} exchanges within ${bot.botChainWindowMs}ms)`,
        )
        return
      }
      const g = chainGuard(bot.id, post.channel_id)
      g.depth += 1
      g.lastBotAt = Date.now()
      logger.info(`bot trigger accepted bot=${bot.id} userId=${shortId(post.user_id)} chain=${g.depth}/${bot.botChainMax}`)
    }

    logger.info(
      `event bot=${bot.id} post=${shortId(post.id)} ch=${shortId(post.channel_id)} ` +
      `root=${shortId(post.root_id)} bot=${botAuthor} :: ${digest(text)}`,
    )

    // ---- command layer: explicit, stable, explainable ------------------------
    // `parsed` already had this bot's mention stripped, so `@dsh /session` and
    // `/session` reach the same branch with the same arguments.
    const command = parsed.command
    const rest = parsed.rest
    const replyRoot = post.root_id || undefined

    let key = deriveKey(post, channel)
    let entry
    try {
      if (command === 'task') {
        // A new thread rooted at this post == a new, isolated session.
        if (!rest) { await say(bot, post.channel_id, '用法：`/task <任务描述>`', replyRoot); return }
        key = taskKey(post)
        entry = sessionMap.touch(bot.id, key, {
          channelId: post.channel_id,
          rootId: post.id,
          userId: post.user_id,
          kind: 'task',
        })
        rememberTarget(bot.id, key, entry)
        await dispatch(entry, rest, { label: 'task' })
        return
      }

      if (command === 'new') {
        const old = sessionMap.entryFor(bot.id, key)
        await agentManager.disposeAgent(old.sessionId)
        entry = sessionMap.reset(bot.id, key)
        targets.delete(old.sessionId)
        await say(bot, post.channel_id, '✅ 已开启新会话。用 `/sessions` 可以切回之前的会话。', replyRoot)
        return
      }

      if (command === 'stop') {
        const live = ctx.agents.get(sessionMap.entryFor(bot.id, key).sessionId)
        if (live) { try { live.cancel({ kind: 'user' }) } catch { /* ignore */ } }
        await say(bot, post.channel_id, '⏹ 已请求中断当前任务', replyRoot)
        return
      }

      if (command === 'steer') {
        entry = sessionMap.entryFor(bot.id, key)
        if (!rest) { await say(bot, post.channel_id, '用法：`/steer <补充指令>`', replyRoot); return }
        await dispatch(entry, rest, { mode: 'steer', label: 'steer' })
        return
      }

      // ---- Session Navigator (this conversation's own generations only) ----
      if (command === 'session') {
        const current = sessionMap.entryFor(bot.id, key)
        const live = ctx.agents.get(current.sessionId)
        const title = await safeTitle(current.sessionId)
        await say(bot, post.channel_id, renderCurrent({
          chatKind: key.split(':')[0],
          generation: Number(current.generation) || 0,
          sessionId: current.sessionId,
          updatedAt: current.updatedAt,
          liveStatus: live ? live.status : undefined,
          title,
        }), replyRoot)
        return
      }

      if (command === 'sessions') {
        const rows = sessionMap.generationsFor(bot.id, key)
        const shown = rows.slice(-config.navigatorLimit)
        const titles = new Map()
        const statuses = new Map()
        for (const row of shown) {
          const live = ctx.agents.get(row.sessionId)
          statuses.set(row.sessionId, live ? live.status : undefined)
        }
        // Titles are looked up CONCURRENTLY: each one is independently capped at
        // 1.2s, and doing them in sequence would let a slow title make the whole
        // command take (limit x 1.2s) seconds.
        const found = await Promise.all(shown.map(async (row) => [row.sessionId, await safeTitle(row.sessionId)]))
        for (const [sessionId, title] of found) if (title) titles.set(sessionId, title)
        await say(bot, post.channel_id, renderSessionList({
          chatKind: key.split(':')[0],
          rows: shown,
          titles,
          statuses,
          limit: config.navigatorLimit,
        }), replyRoot)
        return
      }

      if (command === 'switch') {
        const current = sessionMap.entryFor(bot.id, key)
        const rows = sessionMap.generationsFor(bot.id, key)
        const picked = pickGeneration(rows, parseSelector(rest))
        if (picked.error) { await say(bot, post.channel_id, `⚠️ ${picked.error}`, replyRoot); return }
        const target = picked.row
        // Ownership is compared as (botId, chatKey), not as a raw map key: a
        // pre-multi-bot conversation legitimately has BOTH the bare legacy key
        // and its scoped mirror pointing at the same session, and treating that
        // as "another conversation owns it" would refuse every switch there.
        const foreignOwnerKey = foreignOwnerOf(bot.id, key, target.sessionId)
        const targetLive = ctx.agents.get(target.sessionId)
        const currentLive = ctx.agents.get(current.sessionId)
        const blocker = switchBlocker({
          targetSessionId: target.sessionId,
          currentSessionId: current.sessionId,
          liveStatus: targetLive ? targetLive.status : undefined,
          foreignOwnerKey,
        })
        if (blocker === 'already-current') {
          await say(bot, post.channel_id, 'ℹ️ 这已经是当前会话。', replyRoot)
          return
        }
        if (blocker) { await say(bot, post.channel_id, `⚠️ ${blocker}`, replyRoot); return }
        // Switching away from a running turn is refused too: the new messages
        // would enter a different session while the old one is still talking.
        if (currentLive && currentLive.status === 'running') {
          await say(bot, post.channel_id, '⚠️ 当前会话正在运行，拒绝切换（先 `/stop` 或等待本轮结束）', replyRoot)
          return
        }
        entry = sessionMap.bind(bot.id, key, { sessionId: target.sessionId, generation: target.generation })
        sessionMap.touch(bot.id, key, { channelId: post.channel_id, rootId: replyRoot, userId: post.user_id, kind: key.split(':')[0] === 'th' ? 'task' : 'chat' })
        targets.delete(current.sessionId)
        rememberTarget(bot.id, key, entry)
        logger.info(`session switched bot=${bot.id} chatKey=${key} generation=${target.generation}`)
        await say(bot, post.channel_id, `✅ 已切换到第 ${target.generation} 代会话 \`${target.sessionId}\`。`, replyRoot)
        return
      }

      // ---- Approval decisions (fallback path; reactions are the primary) ----
      if (command === 'approve' || command === 'reject') {
        if (!rest) { await say(bot, post.channel_id, `用法：\`/${command} <审批编号>\``, replyRoot); return }
        const result = approvals.decide({
          requestId: rest.split(/\s+/)[0],
          userId: post.user_id,
          botId: bot.id,
          channelId: post.channel_id,
          decision: command === 'approve' ? 'approved' : 'rejected',
          via: 'command',
        })
        logger.info(`approval command bot=${bot.id} action=${command} code=${result.code}`)
        await say(bot, post.channel_id, decisionReply(result, command === 'approve' ? 'approved' : 'rejected'), replyRoot)
        return
      }

      if (command === 'approvals') {
        const rows = approvals.pendingFor(bot.id, key)
        if (rows.length === 0) { await say(bot, post.channel_id, '当前没有待处理的审批。', replyRoot); return }
        const lines = ['**待处理的审批**']
        for (const row of rows.slice(0, 5)) {
          lines.push(`· \`${row.id}\` · ${row.toolName} · ${ageText(Date.now() - row.createdAt)}`)
        }
        lines.push('用 `/approve <编号>` 或 `/reject <编号>` 处理。')
        await say(bot, post.channel_id, lines.join('\n'), replyRoot)
        return
      }

      // A `/`-prefixed message that matched none of the branches above is an
      // UNKNOWN command, not a chat message. Saying so is the only outcome that
      // cannot be mistaken for the agent answering; falling through to dispatch
      // is exactly the "silently becomes chat" failure this change removes.
      if (command) {
        logger.info(`unknown command bot=${bot.id} ch=${shortId(post.channel_id)} cmd=/${command}`)
        await say(
          bot,
          post.channel_id,
          `⚠️ 未知命令 \`/${command}\`。可用：` +
          KNOWN_COMMANDS.map((c) => `\`/${c}\``).join(' '),
          replyRoot,
        )
        return
      }

      // ---- default: plain conversation -> followup (queues a new turn) -------
      entry = sessionMap.touch(bot.id, key, {
        channelId: post.channel_id,
        rootId: replyRoot,
        userId: post.user_id,
        kind: 'chat',
      })
      rememberTarget(bot.id, key, entry)
      await dispatch(entry, parsed.stripped || text, { label: 'chat' })
    } catch (error) {
      logger.error(`inbound failed bot=${bot.id}: ${error.stack || error.message}`)
      try { await say(bot, post.channel_id, `⚠️ 处理失败：${error.message}`, replyRoot) } catch { /* ignore */ }
    }
  }

  /** Agent ready (in-process) -> hand the message to that same live agent. */
  async function dispatch(entry, text, { mode = 'followup', label = 'chat' } = {}) {
    const agent = await ensureAgentFor(entry.sessionId)
    const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
    const running = agent.status === 'running'
    if (mode === 'steer' && running) agent.steer(message)
    else agent.followup(message)
    agentManager.touchActivity(entry.sessionId)
    logger.info(
      `inbound ${label} session=${entry.sessionId} running=${running} mode=${mode} ` +
      `turn=${mode === 'steer' && running ? 'steer' : 'followup'} :: ${digest(text)}`,
    )
  }

  /**
   * Deliver every fault notification that is still owed.
   *
   * Called at startup and from the existing idle-sweep interval, so a Mattermost
   * outage simply delays notifications instead of dropping them: the pending
   * state is durable and each event has a stable id, so a retry cannot produce a
   * duplicate. A send is only recorded as `sent` when Mattermost actually
   * accepted it — never optimistically.
   */
  async function flushFaultNotifications() {
    if (!faultStore) return 0
    if (![...clients.values()].some((mm) => mm.state.connected)) return 0
    const due = faultStore.pendingNotifications(10)
    let sent = 0
    for (const event of due) {
      try {
        // A fault notification belongs to whichever bot owns the session it is
        // about; without that information, to any connected bot. Never to a
        // disconnected one — that send would only fail and re-queue.
        const mm = faultTransport(event)
        if (!mm) return sent
        await mm.send(event.channelId, renderFault(event), event.rootId || undefined)
        await faultStore.markNotified(event.id)
        sent += 1
        logger.info(`fault notified id=${event.id} type=${event.type}`)
      } catch (error) {
        await faultStore.markNotifyFailed(event.id, error).catch(() => {})
        logger.warn(`fault notify failed id=${event.id}: ${error.message}`)
      }
    }
    return sent
  }

  /**
   * Turn recovery facts into durable, deduplicated fault events.
   *
   * Every event carries a STABLE id derived from its subject, so running
   * recovery on every boot cannot multiply events for one underlying condition.
   *
   * Note what is deliberately NOT done here: a job whose delivery outcome is
   * unknown is recorded and reported, never replayed. And a job whose *turn* was
   * interrupted is left as `completed`, because `completed` means "delivered" —
   * an accurate statement. What is unknown is the EXECUTION, and that is what the
   * fault says. Rewriting the job's status would conflate the two.
   */
  async function reportRecoveryFaults(recovery) {
    if (!faultStore || !jobStore) return { raised: 0 }

    let raised = 0

    // (a) delivery attempted, outcome unknowable
    for (const id of recovery.unknownIds || []) {
      const job = jobStore.get(id)
      if (!job) continue
      const target = resolveJobContext(job.sessionId)
      await faultStore.raise({
        id: faultId('job-unknown', id),
        type: 'job-unknown',
        outcome: 'unknown',
        jobId: id,
        sessionId: job.sessionId,
        lastKnownState: 'running (delivery attempted, completion not recorded)',
        needsHuman: true,
        detail: '进程在投递前后停止,无法确认该任务是否已执行。按设计不会自动重放。',
        channelId: target?.channelId,
        rootId: target?.rootId,
      })
      raised += 1
    }

    // (b) a claimed job that provably never reached the inbox -> safely requeued
    for (const id of recovery.requeuedIds || []) {
      const job = jobStore.get(id)
      if (!job) continue
      const target = resolveJobContext(job.sessionId)
      await faultStore.raise({
        id: faultId('job-orphaned', id),
        type: 'job-orphaned',
        outcome: 'informational',
        jobId: id,
        sessionId: job.sessionId,
        lastKnownState: 'running -> pending (no delivery was attempted)',
        needsHuman: false,
        detail: '该任务在投递前进程停止,已安全回到待执行,无需处理。',
        channelId: target?.channelId,
        rootId: target?.rootId,
      })
      raised += 1
    }

    // (c) turns that were still open when the process stopped
    for (const sess of faultStore.interruptedSessions()) {
      const target = resolveJobContext(sess.sessionId)
      // Correlate with a job delivered into that very turn. Jobs are only ever
      // dispatched to an IDLE agent, so a delivered job is what OPENED this turn
      // — which makes the correlation tight rather than speculative.
      let related = []
      try {
        related = jobStore.list({ sessionId: sess.sessionId, includeTerminal: true })
          .filter((j) => j.status === 'completed' && j.completedAt != null
            && j.completedAt >= (sess.openedAt ?? 0) - 5_000)
      } catch { /* correlation is best-effort */ }
      const jobIds = related.map((j) => j.id)

      await faultStore.raise({
        id: faultId('turn-interrupted', sess.sessionId, String(sess.turn ?? sess.openedAt ?? '')),
        type: 'turn-interrupted',
        outcome: 'interrupted',
        sessionId: sess.sessionId,
        jobId: jobIds[0] ?? null,
        lastKnownState: `turn ${sess.turn ?? '?'} still open when the process stopped`,
        needsHuman: jobIds.length > 0,
        detail: jobIds.length
          ? `该会话的一轮执行被中断,涉及定时任务 ${jobIds.join(', ')};其结果未知。`
          : '该会话的一轮执行被中断;没有关联的定时任务,结果未知但无需处理。',
        channelId: target?.channelId,
        rootId: target?.rootId,
      })
      raised += 1

      // The turn is no longer open; clear it so it is not reported again.
      await faultStore.clearTurn(sess.sessionId).catch(() => {})
    }

    return { raised }
  }

  /**
   * Best-effort detection of job documents the storage layer isolated.
   *
   * The storage layer quarantines a corrupt or schema-incompatible record by
   * moving it to `<name>.json.bak.<stamp>` and opening without it. That protects
   * the other jobs (verified), but it does so SILENTLY as far as the plugin is
   * concerned. Comparing the documents on disk with the records actually loaded
   * is what turns that into something the user is told about.
   *
   * Deliberately best-effort and non-fatal: it reads a storage-layout convention
   * (per-record documents under $DSH_HOME/storages/<domain>/<table>/), so any
   * failure here is logged and ignored rather than affecting the plugin.
   */
  async function detectCorruptJobs() {
    if (!faultStore || !jobStore) return 0
    try {
      const home = process.env.DSH_HOME || join(homedir(), '.dsh')
      const dir = join(home, 'storages', 'mattermost_jobs', 'jobs')
      if (!existsSync(dir)) return 0
      const loaded = new Set(jobStore.list({ includeTerminal: true }).map((j) => j.id))
      let found = 0
      for (const file of readdirSync(dir)) {
        if (!file.startsWith('job-') || !file.endsWith('.json')) continue
        const id = file.slice(0, -'.json'.length)
        if (loaded.has(id)) continue
        await faultStore.raise({
          id: faultId('job-corrupt', id),
          type: 'job-corrupt',
          outcome: 'isolated',
          jobId: id,
          lastKnownState: 'document present on disk but not loaded',
          needsHuman: false,
          detail: '该任务记录无法解析或与当前 schema 不兼容,已被存储层隔离(原文件保留为 .bak),其他任务不受影响。',
        })
        found += 1
      }
      if (found) logger.warn(`fault store: ${found} isolated job document(s) recorded`)
      return found
    } catch (error) {
      logger.warn(`corruption probe skipped: ${error.message}`)
      return 0
    }
  }

  async function ensureAgentFor(sessionId) {
    const agent = await agentManager.ensureAgent(sessionId)
    agentManager.touchActivity(sessionId)
    return agent
  }

  // Agent-facing tools. Registered as soon as the `tools` service is up, so the
  // agent can ask about jobs even while Mattermost is still connecting; every
  // handler refuses loudly when the durable store is not open.
  ctx.inject(['tools'], (toolCtx) => {
    jobToolsDispose = registerJobTools(toolCtx, {
      logger,
      store: {
        create: (input) => requireJobStore().create(input),
        list: (options) => requireJobStore().list(options),
        cancel: (id, options) => requireJobStore().cancel(id, options),
      },
      resolveContext: resolveJobContext,
      maxHorizonMs: config.jobMaxHorizonMs,
    })
  })

  // Advertise the capability in the system prompt.
  //
  // Registering a tool is NOT sufficient. Measured in production on 2026-09-29:
  // `schedule_job` was present in the agent's tool list from 04:00 yet the agent
  // still reached for an in-session `sleep` loop (and proposed external-scheduler
  // workarounds) because nothing told it the tool existed and its own history
  // was full of "in-session timers do not survive". A tool the model never
  // considers is indistinguishable from a missing tool.
  ctx.inject(['systemPrompt'], (promptCtx) => {
    jobPromptDispose = promptCtx.systemPrompt.section({
      name: 'tool:delayed-jobs',
      // No TOOL_SCHEDULE slot exists; sit immediately after the background-jobs
      // section, which is the neighbouring concept.
      order: promptCtx.systemPrompt.getSectionOrder('TOOL_JOBS') + 1,
      text: 'For anything that must happen later — a reminder, or checking on work after a delay — '
        + 'use schedule_job, and manage those with list_jobs / cancel_job. Do NOT implement a delay '
        + 'with `sleep` in bash or an in-session polling loop: those are reclaimed when this agent is '
        + 'idle-evicted or the host restarts, so the work silently disappears. A scheduled job is '
        + 'persisted independently of this agent and still runs after this session goes idle or the '
        + 'process restarts, so you do not need to stay awake waiting for it.',
    })
  })

  ctx.effect(() => {
    let sweepTimer = null
    ;(async () => {
      // One client per configured bot. Each gets its own token, WebSocket,
      // dedup/backfill state file and reconnect loop, so a failure or an outage
      // in one bot cannot silence another.
      const ready = []
      for (const bot of bots) {
        const token = await resolveTokenFor(bot)
        if (!bot.baseUrl || !token) {
          logger.warn(
            `bot ${bot.id} 未配置，已跳过（baseUrl=${bot.baseUrl ? 'set' : 'missing'}, ` +
            `token=${token ? 'set' : 'missing'}）`,
          )
          continue
        }
        clients.set(bot.id, createMattermostClient({
          baseUrl: bot.baseUrl,
          token,
          botId: bot.id,
          logger,
          // The FIRST bot keeps the historical `state.json` name. Renaming it
          // would migrate nothing and would break every existing operator
          // script, audit note and test that already refers to it; additional
          // bots get their own file, which is what isolation actually needs.
          stateFile: bot.legacy ? `${stateDir}/state.json` : `${stateDir}/state.${bot.id}.json`,
          debug: Boolean(config.debug),
        }))
        ready.push(bot)
      }
      if (clients.size === 0) {
        logger.warn('没有可用的 bot，插件待机（检查 baseUrl / tokenRef）')
        return
      }
      agentManager = createAgentManager(ctx, {
        logger,
        cwd,
        idleTtlMs: config.idleAgentTtlMs,
        onEvict: () => { stats.evicted += 1 },
      })
      outbound = createOutbound({
        logger,
        clientFor,
        resolveTarget: (sessionId) => targets.get(sessionId),
        maxChars: config.maxReplyChars,
      })
      ctx.on('session/event', (session, event) => {
        outbound.onSessionEvent(session, event)
        // Turn bookkeeping for interrupted-work detection. Deliberately added
        // here rather than inside outbound.js: that module is verified and its
        // delivery semantics must not change. The event subscription already
        // existed, so this adds no new listener lifecycle.
        if (!faultStore) return
        // `session/event` is process-wide: it also fires for GUI sessions this
        // plugin does not own. Only a session bound to a Mattermost conversation
        // can ever carry a deliverable job, so tracking anything else would grow
        // the fault store without bound and raise turn-interrupted faults for
        // work that is none of this plugin's business. `targets` is the durable
        // sessionId -> Mattermost home map: restored from session-map.json at
        // startup and populated on inbound before the first turn opens.
        if (!targets.has(String(session.id))) return
        if (event && event.type === 'turn/start') {
          faultStore.turnOpened(String(session.id), event.data?.turn)
            .catch((error) => logger.warn(`fault turn-open failed: ${error.message}`))
        } else if (event && event.type === 'turn/end') {
          faultStore.turnClosed(String(session.id))
            .catch((error) => logger.warn(`fault turn-close failed: ${error.message}`))
        }
      })

      // S1: release idle live agents. Sessions stay durable; the next message for
      // an evicted session goes observeSession -> resume, which is the tested path.
      sweepTimer = setInterval(() => {
        agentManager.sweep().catch((error) => logger.warn(`idle sweep failed: ${error.message}`))
        // Retry any notification Mattermost has not accepted yet. Reuses this
        // timer so a fault feature cannot leak an extra interval.
        flushFaultNotifications().catch((error) => logger.warn(`fault flush failed: ${error.message}`))
      }, config.idleSweepIntervalMs)

      for (const bot of ready) {
        // Per-bot limits are logged separately from the aggregate "ready" line:
        // with several bots the aggregate cannot name one budget, and operators
        // (and the acceptance suite) need the effective value for each.
        logger.info(
          `bot ready id=${bot.id} channels=${bot.channels.length || 'all'} ` +
          `freeResponse=${bot.freeResponseChannels.length} ` +
          `allowedUsers=${bot.allowAll ? 'ALL' : bot.allowedUsers.length} ` +
          `botChainMax=${bot.botChainMax} botChainWindowMs=${bot.botChainWindowMs}`,
        )
        const mm = clients.get(bot.id)
        // The bot id is bound HERE, in the per-client closure: an inbound frame
        // can never be attributed to the wrong bot, and a reaction is routed to
        // the client whose identity the user actually reacted to.
        await mm.start({
          onPost: (post, channel) => handlePost(post, channel, bot.id),
          onReaction: (reaction) => handleReaction(reaction, bot.id),
        })
      }
      // Only now is the plugin actually serving: every transport has a handler
      // and has been told to connect. Publishing this earlier let a caller see
      // started=true, suspend a client that had never started, and then wait
      // forever for a resume that had nothing to resume.
      started = true
      logger.info(
        `ready (cwd=${cwd}, bots=${ready.map((b) => b.id).join(',')}, ` +
        `idleTtlMs=${config.idleAgentTtlMs}, approvals=${config.approvalEnabled ? 'on' : 'off'})`,
      )

      // ---- durable delayed jobs ------------------------------------------
      // Started AFTER the transport, so storage availability can never gate
      // Mattermost itself. A job that comes due while Mattermost is down still
      // runs; outbound.js delivers the reply once the socket returns. The
      // scheduler resumes the target session at due time — the wake a bare
      // `sleep` can never provide.
      if (!config.schedulerEnabled) {
        logger.info('scheduler disabled by config')
      } else {
        // Scoped injection: the plugin must NOT declare storageDomain as a hard
        // dependency, or a storage problem would take Mattermost down with it.
        ctx.inject(['storageDomain'], async (storageCtx) => {
          try {
            jobStore = await openJobStore(storageCtx, { logger, maxPerSession: config.jobMaxPerSession })
            // A SEPARATE domain from the jobs: a fault record can never make a
            // job unreadable, and a job can never hide a fault. If it fails to
            // open we lose visibility but keep scheduling — logged, never silent.
            try {
              faultStore = await openFaultStore(storageCtx, { logger })
            } catch (faultError) {
              faultStore = null
              logger.error(`fault store unavailable (fault visibility reduced): ${faultError.message}`)
            }
            scheduler = createScheduler({
              logger,
              store: jobStore,
              ensureAgent: ensureAgentFor,
              tickMs: config.schedulerTickMs,
              leaseMs: config.jobLeaseMs,
              maxDispatchPerTick: config.maxDispatchPerTick,
              busyRetryMs: config.jobBusyRetryMs,
            })
            const recovery = await scheduler.start()
            logger.info(
              `scheduler ready (tickMs=${config.schedulerTickMs}, leaseMs=${config.jobLeaseMs}, ` +
              `jobs=${jobStore.stats().total}, ` +
              `recovered=${recovery.completed}+${recovery.requeued}+${recovery.unknown})`,
            )
            // Turn recovery facts into durable, deduplicated fault events, then
            // record any job document the storage layer had to isolate.
            try {
              const rep = await reportRecoveryFaults(recovery)
              const isolated = await detectCorruptJobs()
              if (faultStore) {
                logger.info(
                  `fault store ready (events=${faultStore.stats().total}, ` +
                  `pendingNotifications=${faultStore.stats().pendingNotifications}, ` +
                  `raisedThisBoot=${rep.raised}, isolated=${isolated})`,
                )
              }
            } catch (reportError) {
              logger.warn(`fault reporting failed (jobs unaffected): ${reportError.message}`)
            }
            // Anything owed from a previous process goes out as soon as the
            // socket is up; failures stay pending and are retried by the sweep.
            await flushFaultNotifications().catch(() => {})
          } catch (error) {
            const store = jobStore
            scheduler = null
            jobStore = null
            if (store) await store.close().catch(() => {})
            logger.error(`scheduler disabled (durable jobs unavailable): ${error.stack || error.message}`)
          }
        })
      }
    })().catch((error) => logger.error(`startup failed (dsh keeps running): ${error.stack || error.message}`))

    return async () => {
      if (sweepTimer) clearInterval(sweepTimer)
      if (scheduler) await scheduler.stop().catch(() => {})
      if (jobToolsDispose) { try { jobToolsDispose() } catch { /* ignore */ } }
      if (jobPromptDispose) { try { jobPromptDispose() } catch { /* ignore */ } }
      outbound?.dispose()
      // Settle every pending approval as cancelled BEFORE the sockets close, so
      // no agent is left waiting on a card nobody can answer any more.
      approvals.dispose()
      for (const mm of clients.values()) { try { mm.stop() } catch { /* ignore */ } }
      if (agentManager) await agentManager.disposeAll().catch(() => {})
      // Closing last drains queued job writes; the records stay on disk and are
      // re-opened, unchanged, by the next process.
      if (jobStore) await jobStore.close().catch(() => {})
      if (faultStore) await faultStore.close().catch(() => {})
    }
  }, 'dsh-mattermost.serve')

  ctx.provide('mattermost', {
    status: () => {
      const primary = primaryClient()
      return {
        started,
        connected: Boolean(primary && primary.state.connected),
        replies: primary?.state.replies ?? 0,
        errors: primary?.state.errors ?? 0,
        reconnects: primary?.state.reconnects ?? 0,
        backfilled: primary?.state.backfilled ?? 0,
        sessions: sessionMap.entries(),
        live: agentManager ? [...agentManager.handles.keys()] : [],
        evicted: stats.evicted,
        authorized: stats.authorized,
        unauthorized: stats.unauthorized,
        chainRejected: stats.chainRejected,
        channelRejected: stats.channelRejected,
        bots: bots.map((bot) => {
          const mm = clients.get(bot.id)
          return {
            id: bot.id,
            configured: Boolean(bot.baseUrl),
            started: Boolean(mm),
            connected: Boolean(mm && mm.state.connected),
            username: mm && mm.me ? mm.me.username : undefined,
            channels: bot.channels.length,
            allowedUsers: bot.allowAll ? 'ALL' : bot.allowedUsers.length,
            reconnects: mm?.state.reconnects ?? 0,
            replies: mm?.state.replies ?? 0,
          }
        }),
        approvals: approvals.stats(),
      }
    },
    sessionIdFor,
    sessionMap,
    /**
     * A1 diagnostic: where WOULD a Web-origin approval for `botId` be announced?
     *
     * Read-only — it posts nothing, records nothing and cannot settle a request.
     * A2 will call `resolveWebRoute()` with the same inputs from the approval
     * listener, so this probe is the cheapest honest way to prove the wiring
     * (config, session map, allowed users, channel probe) before any card exists.
     */
    webApproval: {
      status: () => ({
        configured: webApproval.approvers.length > 0,
        enabled: webApprovalEnabled,
        problems: webApprovalCheck.problems,
        principals: countWebPrincipals(join(dshHome, 'web-auth.json')),
        channel: Boolean(webApproval.channel),
        bindings: Object.keys(webApproval.binding).length,
        auto: webApproval.auto,
        ttlMs: webApproval.ttlMs,
        approvers: webApproval.approvers.length,
      }),
      route: (botId) => {
        // The probe reports what the FEATURE would do, and a rejected
        // configuration means the feature is off — not "off except when asked".
        if (!webApprovalEnabled) return Promise.resolve({ mode: 'none', reason: 'disabled' })
        const bot = bots.find((b) => b.id === botId) || primaryBot
        return webRouteFor(bot)
      },
    },
    approvals: {
      stats: () => approvals.stats(),
      pending: (botId, chatKey) => approvals.pendingFor(botId, chatKey),
      get: (id) => approvals.pending(id),
      decide: (input) => approvals.decide(input),
      /**
       * TEST-ONLY: ask the native seam exactly the way a tool consumer does
       * (open turn -> approval.request -> close turn). This exists so the
       * acceptance suite exercises the REAL service — its turn guard, its
       * policy fold and its audit pair — rather than only our listener.
       */
      /**
       * TEST-ONLY: call the REAL service with no open turn.
       *
       * Deliberately does not synthesize a turn. Appending `turn/start` from
       * outside the agent loop is what the format validator rejects ("turn/start
       * does not open the expected turn"), and a rejected append leaves the
       * session corrupt on reload — measured twice. The safe instrument for the
       * happy path is `waterfall` (the same dispatch the service performs); this
       * hook exists only to prove the native turn guard is NOT bypassed.
       */
      ask: async ({ sessionId, toolName, callId, reason }) => {
        const service = ctx.get('approval')
        if (!service) throw new Error('approval service unavailable (dsh-user-approval not mounted)')
        const agent = await ensureAgentFor(sessionId)
        return service.request({ agent, toolName, callId, reason })
      },
      /**
       * TEST-ONLY: tool calls visible in one live session, WITHOUT their
       * arguments. The suite needs a real `callId` to prove the argument lookup
       * path; it must not need (or receive) the arguments themselves, which are
       * exactly what the card is supposed to mask.
       */
      calls: (sessionId, limit = 5) => {
        const live = ctx.agents.get(sessionId)
        const session = live && live.session
        if (!session || typeof session.eventAt !== 'function') return []
        const out = []
        for (let index = (Number(session.seq) || 0) - 1; index >= 0 && out.length < limit; index -= 1) {
          const event = session.eventAt(index)
          if (!event || event.type !== 'tool/call' || !event.data) continue
          out.push({
            callId: String(event.data.callId),
            name: String(event.data.name),
            argumentLength: typeof event.data.arguments === 'string' ? event.data.arguments.length : 0,
          })
        }
        return out
      },
      /** TEST-ONLY: run the `approval/request` waterfall without the service. */
      waterfall: async ({ sessionId, toolName, callId, reason, abortAfterMs }) => {
        const { scopeTarget } = await import('@deepseek-ai/dsh-scope')
        const agent = await ensureAgentFor(sessionId)
        // `abortAfterMs` exercises the withdrawal path: the asker gives up, the
        // request must settle `cancelled` and a later answer must be discarded.
        let timer
        const controller = abortAfterMs ? new AbortController() : undefined
        if (controller) timer = setTimeout(() => controller.abort(), Number(abortAfterMs))
        try {
          return await ctx.waterfall(
            scopeTarget(agent, agent),
            'approval/request',
            { agent, toolName, callId, reason, ...(controller ? { signal: controller.signal } : {}) },
            () => Promise.resolve('unavailable'),
          )
        } finally {
          if (timer) clearTimeout(timer)
        }
      },
    },
    navigator: {
      generations: (botId, chatKey) => sessionMap.generationsFor(botId, chatKey),
      current: (botId, chatKey) => sessionMap.entryFor(botId, chatKey),
      bind: (botId, chatKey, target) => {
        const entry = sessionMap.bind(botId, chatKey, target)
        rememberTarget(botId, chatKey, entry)
        return entry
      },
      parseSelector,
      pickGeneration,
      /** TEST-ONLY: create a mapping without starting an agent turn. */
      ensure: (botId, chatKey, meta) => {
        const entry = sessionMap.touch(botId, chatKey, meta || {})
        rememberTarget(botId, chatKey, entry)
        return entry
      },
    },
    /** TEST-ONLY: feed one reaction frame through the real routing path. */
    reaction: (input) => handleReaction(input, input.botId || primaryBot.id),
    dropSocket: () => Boolean(primaryClient() && primaryClient().dropSocket()),
    suspend: () => {
      let any = false
      for (const mm of clients.values()) { if (mm.suspend()) any = true }
      return any
    },
    resume: async () => {
      let any = false
      for (const mm of clients.values()) { if (await mm.resume()) any = true }
      return any
    },
    /**
     * Internal inbound handler, exposed so the TEST scaffold can synthesize posts
     * (second Mattermost identity is unavailable). Nothing in this plugin calls it;
     * it reaches the exact same code path a real WebSocket frame does.
     */
    inbound: (post, channel, botId) => handlePost(post, channel, botId || primaryBot.id),
    /** TEST-ONLY: clear bot-chain budgets so a scenario starts clean. */
    resetChain: () => { chainGuards.clear(); return true },
    /** TEST-ONLY: force one idle sweep now instead of waiting for the timer. */
    sweepNow: () => (agentManager ? agentManager.sweep() : []),
    /**
     * Durable delayed-job surface. Inspection and manual ticking exist so the
     * harness can drive recovery and eviction scenarios deterministically
     * instead of sleeping through real delays.
     */
    jobs: {
      list: (options) => (jobStore ? jobStore.list(options) : []),
      get: (id) => (jobStore ? jobStore.get(id) : undefined),
      stats: () => (jobStore ? jobStore.stats() : null),
      schedulerStats: () => (scheduler ? scheduler.stats : null),
      tick: () => (scheduler ? scheduler.tick() : []),
      recover: (now, leaseMs) => (jobStore ? jobStore.recover(now, leaseMs) : null),
      create: (input) => requireJobStore().create(input),
      cancel: (id, options) => requireJobStore().cancel(id, options),
      resolveContext: (sessionId) => resolveJobContext(sessionId),
    },
    /** Durable fault surface (probe/test): inspection and manual notification flush. */
    faults: {
      list: (options) => (faultStore ? faultStore.list(options) : []),
      get: (id) => (faultStore ? faultStore.get(id) : undefined),
      stats: () => (faultStore ? faultStore.stats() : null),
      pending: (limit) => (faultStore ? faultStore.pendingNotifications(limit) : []),
      raise: (input) => (faultStore ? faultStore.raise(input) : null),
      ack: (id) => (faultStore ? faultStore.ack(id) : null),
      interrupted: () => (faultStore ? faultStore.interruptedSessions() : []),
      flush: () => flushFaultNotifications(),
      render: (id) => {
        const e = faultStore ? faultStore.get(id) : undefined
        return e ? renderFault(e) : null
      },
    },
  })
}
