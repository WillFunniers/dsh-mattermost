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
 *   - streaming stays false (this adapter implements no editMessage)
 *
 * Admission order (mirrors the production bridge):
 *   own/system/deleted -> channel whitelist -> user authorization
 *   -> trigger -> bot-chain budget -> command layer -> dispatch
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createMattermostClient } from './mattermost.js'
import { createAgentManager } from './agents.js'
import { createOutbound } from './outbound.js'
import { createSessionMap, deriveKey, taskKey, sessionIdFor } from './mapping.js'
import { openJobStore } from './jobs.js'
import { createScheduler } from './scheduler.js'
import { registerJobTools } from './tools.js'

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
  jobMaxPerSession: Schema.number().step(1).min(1).max(1_000).default(50),
  jobMaxHorizonMs: Schema.number().step(1).min(60_000).default(30 * 24 * 60 * 60 * 1_000),

  /** Empty = $DSH_HOME/mattermost. Never default to a test path. */
  stateDir: Schema.string().default(''),
  backfill: Schema.boolean().default(true),
  maxReplyChars: Schema.number().step(1).min(500).default(12_000),
  debug: Schema.boolean().default(false),
})

/** The DSH home, exactly as the rest of the harness resolves it. */
function defaultStateDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'mattermost')
}

export function apply(ctx, config) {
  const stateDir = config.stateDir || defaultStateDir()
  const rawLogger = ctx.logger('dsh-mattermost')

  // Mirrored to a file: the host logger's sink is not readable from a shell, and
  // these tests need evidence, not inference.
  const logFile = `${stateDir}/plugin.log`
  function write(level, message) {
    const line = `${new Date().toISOString()} ${level} ${message}\n`
    try {
      mkdirSync(stateDir, { recursive: true })
      appendFileSync(logFile, line)
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

  const baseUrl = (config.baseUrl || process.env.MATTERMOST_URL || '').replace(/\/+$/, '')
  const cwd = config.cwd || process.cwd()
  write('INFO', `apply() entered; baseUrl=${baseUrl ? 'set' : 'missing'} stateDir=${stateDir}`)

  // Resolve the token without putting the secret in config: prefer the plugin
  // config value, then the DSH credential store, then a plain environment var.
  //
  // The credential provider populates its store inside [Service.init], but
  // resolve() does NOT await that load — it reads the in-memory map directly. A
  // plugin whose apply() runs before that load therefore sees "no value", and if
  // it gives up it stays idle forever. Observed in production: the same config
  // resolved at one boot and returned `token=missing` at the next. So poll until
  // the store answers, then fall back to the environment.
  async function resolveToken() {
    if (config.token) return config.token
    const ref = config.tokenRef || 'MATTERMOST_TOKEN'
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
        logger.warn(`token ref "${ref}" unresolved after 60s (credentials service ${creds ? 'present' : 'absent'})`)
        return ''
      }
      if (!announced) {
        announced = true
        write('INFO', `waiting for credential "${ref}" (credentials service ${creds ? 'present' : 'not ready'})`)
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
  }

  const sessionMap = createSessionMap({ file: `${stateDir}/session-map.json`, logger })

  // sessionId -> where to deliver its output. Rebuilt from the durable map on
  // startup so a resumed session still knows its Mattermost home.
  const targets = new Map()
  function rememberTarget(entry) {
    if (entry && entry.channelId) {
      targets.set(entry.sessionId, {
        channelId: entry.channelId,
        rootId: entry.rootId || undefined,
        // Captured so a durable job can record its delivery target and its
        // authorization owner at creation, without depending on live state.
        userId: entry.userId || undefined,
      })
    }
  }
  for (const entry of sessionMap.entries()) rememberTarget(entry)

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

  let client = null
  let agentManager = null
  let outbound = null
  let started = false
  let jobStore = null
  let scheduler = null
  let jobToolsDispose = null
  let jobPromptDispose = null

  const stats = { authorized: 0, unauthorized: 0, chainRejected: 0, channelRejected: 0, evicted: 0 }

  // ---- R2: bot chain budget, per channel, same shape as the production bridge --
  const chainGuards = new Map()
  function chainGuard(channelId) {
    let g = chainGuards.get(channelId)
    if (!g) { g = { depth: 0, lastBotAt: 0 }; chainGuards.set(channelId, g) }
    return g
  }
  function botTriggerAllowed(channelId) {
    const g = chainGuard(channelId)
    // A quiet period means the exchange is over; the budget starts fresh.
    if (g.lastBotAt && Date.now() - g.lastBotAt > config.botChainWindowMs) g.depth = 0
    return g.depth < config.botChainMax
  }

  // ---- R3: user authorization, default-deny ------------------------------------
  function isAuthorized(userId) {
    if (config.allowAll) return true
    if (!Array.isArray(config.allowedUsers) || config.allowedUsers.length === 0) return false
    return config.allowedUsers.some((u) => String(u) === String(userId))
  }

  function isOwnPost(post) {
    return Boolean(client && client.me && post.user_id === client.me.id)
  }
  function isBotPost(post) {
    return String(post.props?.from_bot) === 'true'
  }
  function isMention(text) {
    const username = client && client.me ? client.me.username : null
    if (!username) return false
    return new RegExp(`@${username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text)
  }
  function allowedChannel(channelId) {
    if (!config.channels || config.channels.length === 0) return true
    return config.channels.includes(channelId)
  }
  function freeResponse(channelId) {
    return Array.isArray(config.freeResponseChannels) && config.freeResponseChannels.includes(channelId)
  }

  async function handlePost(post, channel) {
    if (!post || !post.id) return
    if (post.type) return                      // system posts
    if (Number(post.delete_at) > 0) return     // deleted
    if (isOwnPost(post)) return                // never react to ourselves (no bypass exists)

    if (!allowedChannel(post.channel_id)) {
      stats.channelRejected += 1
      return
    }
    if (post.channel_id === channel.id && channel.type === undefined) {
      channel = (await client.fetchChannel(post.channel_id)) || channel
    }

    // Authorization precedes everything that could create state: an unauthorized
    // post must not mint a session, agent, task or outbound reply.
    if (!isAuthorized(post.user_id)) {
      stats.unauthorized += 1
      logger.warn(`unauthorized inbound userId=${post.user_id} channelId=${post.channel_id} reason=unauthorized`)
      return
    }
    stats.authorized += 1

    const text = String(post.message || '').trim()
    if (!text) return

    const isDirect = channel.type === 'D'
    const botAuthor = isBotPost(post)

    // Any human message resets that channel's bot chain — even one not aimed at us.
    if (!botAuthor) chainGuard(post.channel_id).depth = 0

    const mentioned = isMention(text)
    const triggered = isDirect || freeResponse(post.channel_id) || mentioned
    if (!triggered) return
    if (!isDirect && !freeResponse(post.channel_id) && config.requireMention !== false && !mentioned) return

    if (botAuthor) {
      // A bot must address us explicitly; ambient bot chatter never wakes us.
      if (!isDirect && !mentioned) return
      if (!config.allowBotMentions) {
        logger.info(`bot author ignored userId=${post.user_id} (allowBotMentions=false)`)
        return
      }
      if (!botTriggerAllowed(post.channel_id)) {
        stats.chainRejected += 1
        logger.warn(
          `bot chain budget exhausted userId=${post.user_id} channelId=${post.channel_id} ` +
          `(${config.botChainMax} exchanges within ${config.botChainWindowMs}ms)`,
        )
        return
      }
      const g = chainGuard(post.channel_id)
      g.depth += 1
      g.lastBotAt = Date.now()
      logger.info(`bot trigger accepted userId=${post.user_id} chain=${g.depth}/${config.botChainMax}`)
    }

    logger.info(
      `event post=${post.id.slice(0, 8)} ch=${post.channel_id.slice(0, 8)} ` +
      `root=${(post.root_id || '').slice(0, 8)} bot=${botAuthor} :: ${text.slice(0, 50)}`,
    )

    // ---- command layer: explicit, stable, explainable ------------------------
    const commanded = /^\/(\w+)\s*/.exec(text)
    const command = commanded ? commanded[1].toLowerCase() : null
    const rest = commanded ? text.slice(commanded[0].length).trim() : text
    const replyRoot = post.root_id || undefined

    let key = deriveKey(post, channel)
    let entry
    try {
      if (command === 'task') {
        // A new thread rooted at this post == a new, isolated session.
        if (!rest) { await client.send(post.channel_id, '用法：`/task <任务描述>`', replyRoot); return }
        key = taskKey(post)
        entry = sessionMap.touch(key, {
          channelId: post.channel_id,
          rootId: post.id,
          userId: post.user_id,
          kind: 'task',
        })
        rememberTarget(entry)
        await dispatch(entry, rest, { label: 'task' })
        return
      }

      if (command === 'new') {
        const old = sessionMap.entryFor(key)
        await agentManager.disposeAgent(old.sessionId)
        entry = sessionMap.reset(key)
        await client.send(post.channel_id, '✅ 已开启新会话。', replyRoot)
        return
      }

      if (command === 'stop') {
        const live = ctx.agents.get(sessionMap.entryFor(key).sessionId)
        if (live) { try { live.cancel({ kind: 'user' }) } catch { /* ignore */ } }
        await client.send(post.channel_id, '⏹ 已请求中断当前任务', replyRoot)
        return
      }

      if (command === 'steer') {
        entry = sessionMap.entryFor(key)
        if (!rest) { await client.send(post.channel_id, '用法：`/steer <补充指令>`', replyRoot); return }
        await dispatch(entry, rest, { mode: 'steer', label: 'steer' })
        return
      }

      // ---- default: plain conversation -> followup (queues a new turn) -------
      const mentionless = text.replace(new RegExp(`@${client.me?.username}\\b`, 'ig'), '').trim()
      entry = sessionMap.touch(key, {
        channelId: post.channel_id,
        rootId: replyRoot,
        userId: post.user_id,
        kind: 'chat',
      })
      rememberTarget(entry)
      await dispatch(entry, mentionless || text, { label: 'chat' })
    } catch (error) {
      logger.error(`inbound failed: ${error.stack || error.message}`)
      try { await client.send(post.channel_id, `⚠️ 处理失败：${error.message}`, replyRoot) } catch { /* ignore */ }
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
      `turn=${mode === 'steer' && running ? 'steer' : 'followup'} :: ${text.slice(0, 60)}`,
    )
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
  // still reached for an in-session `sleep` loop (and proposed an external scheduler/systemd
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
      const token = await resolveToken()
      if (!baseUrl || !token) {
        logger.warn(`未配置，插件待机（baseUrl=${baseUrl ? 'set' : 'missing'}, token=${token ? 'set' : 'missing'}）`)
        return
      }
      client = createMattermostClient({
        baseUrl,
        token,
        logger,
        stateFile: `${stateDir}/state.json`,
        debug: Boolean(config.debug),
      })
      agentManager = createAgentManager(ctx, {
        logger,
        cwd,
        idleTtlMs: config.idleAgentTtlMs,
        onEvict: () => { stats.evicted += 1 },
      })
      outbound = createOutbound({
        logger,
        client,
        resolveTarget: (sessionId) => targets.get(sessionId),
        maxChars: config.maxReplyChars,
      })
      ctx.on('session/event', (session, event) => outbound.onSessionEvent(session, event))

      // S1: release idle live agents. Sessions stay durable; the next message for
      // an evicted session goes observeSession -> resume, which is the tested path.
      sweepTimer = setInterval(() => {
        agentManager.sweep().catch((error) => logger.warn(`idle sweep failed: ${error.message}`))
      }, config.idleSweepIntervalMs)

      started = true
      await client.start(handlePost)
      logger.info(
        `ready (cwd=${cwd}, channels=${config.channels.length || 'all'}, ` +
        `allowedUsers=${config.allowAll ? 'ALL' : config.allowedUsers.length}, ` +
        `botChainMax=${config.botChainMax}, idleTtlMs=${config.idleAgentTtlMs})`,
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
            scheduler = createScheduler({
              logger,
              store: jobStore,
              ensureAgent: ensureAgentFor,
              tickMs: config.schedulerTickMs,
              leaseMs: config.jobLeaseMs,
              maxDispatchPerTick: config.maxDispatchPerTick,
            })
            const recovery = await scheduler.start()
            logger.info(
              `scheduler ready (tickMs=${config.schedulerTickMs}, leaseMs=${config.jobLeaseMs}, ` +
              `jobs=${jobStore.stats().total}, recovered=${recovery.completed}+${recovery.requeued})`,
            )
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
      client?.stop()
      if (agentManager) await agentManager.disposeAll().catch(() => {})
      // Closing last drains queued job writes; the records stay on disk and are
      // re-opened, unchanged, by the next process.
      if (jobStore) await jobStore.close().catch(() => {})
    }
  }, 'dsh-mattermost.serve')

  ctx.provide('mattermost', {
    status: () => ({
      started,
      connected: Boolean(client?.state.connected),
      replies: client?.state.replies ?? 0,
      errors: client?.state.errors ?? 0,
      reconnects: client?.state.reconnects ?? 0,
      backfilled: client?.state.backfilled ?? 0,
      sessions: sessionMap.entries(),
      live: agentManager ? [...agentManager.handles.keys()] : [],
      evicted: stats.evicted,
      authorized: stats.authorized,
      unauthorized: stats.unauthorized,
      chainRejected: stats.chainRejected,
      channelRejected: stats.channelRejected,
    }),
    sessionIdFor,
    sessionMap,
    dropSocket: () => Boolean(client && client.dropSocket()),
    suspend: () => Boolean(client && client.suspend()),
    resume: () => Boolean(client && client.resume()),
    /**
     * Internal inbound handler, exposed so the TEST scaffold can synthesize posts
     * (second Mattermost identity is unavailable). Nothing in this plugin calls it;
     * it reaches the exact same code path a real WebSocket frame does.
     */
    inbound: (post, channel) => handlePost(post, channel),
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
  })
}
