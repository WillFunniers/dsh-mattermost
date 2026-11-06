/**
 * Approval Bridge: DSH's native one-shot approval seam, answered from Mattermost.
 *
 * The contract this module must never break:
 *
 *   1. It is a LISTENER on the native `approval/request` waterfall (prepended),
 *      never a caller. The decision is handed back as the native outcome
 *      vocabulary; nothing here authorizes anything by itself.
 *   2. It answers ONLY for agents whose session this plugin owns. Every other
 *      request — a DSH Web session, a subagent, an unknown agent — is delegated
 *      with `next()` so the browser answerer stays exactly as it was.
 *   3. It never throws. `ApprovalService.decide()` turns a throwing listener
 *      into the fail-closed `unavailable` for the WHOLE deployment, so a bug in
 *      this file must degrade to `next()`, not to "reject everyone".
 *   4. Fail closed. Unreachable Mattermost, an expired card, an ambiguous state,
 *      a cancelled turn — none of them may ever produce `allowed-once`.
 *
 * Input paths (no inbound HTTP exists in a NAT'd deployment):
 *   - reaction on the card post  (`reaction_added` over the existing WebSocket)
 *   - `/approve <id>` or `/reject <id>` reply in the same channel
 *
 * Idempotency: a request settles exactly once. `settle()` is synchronous, so two
 * humans reacting at the same millisecond still produce one transition.
 */
import { randomBytes } from 'node:crypto'
import { maskSecrets } from './redact.js'

/** Native outcomes this bridge can return. */
const OUTCOME = {
  approved: 'allowed-once',
  rejected: 'rejected',
  cancelled: 'cancelled',
  unavailable: 'unavailable',
}

/**
 * Terminal state of the REQUEST (the business answer).
 *
 * `pending` is the only non-terminal value. There is deliberately no
 * `superseded` here: "another answerer won" is a property of the CARD, not of
 * the request. See `CARD_STATES`.
 */
export const STATES = ['pending', 'approved', 'rejected', 'expired', 'cancelled', 'unavailable']

/** Lifecycle of the Mattermost notification (0..1 per request). */
export const CARD_STATES = ['none', 'posting', 'posted', 'void', 'failed']

/** Which participant produced the terminal request outcome. */
export const SETTLED_BY = ['mattermost', 'web', 'timeout', 'abort', 'shutdown', 'system']

/** Emoji names accepted as a decision, per action. */
const APPROVE_EMOJI = new Set(['white_check_mark', 'heavy_check_mark', 'ballot_box_with_check', '+1', 'thumbsup'])
const REJECT_EMOJI = new Set(['x', '-1', 'thumbsdown', 'no_entry_sign', 'negative_squared_cross_mark'])

/** How much of a tool's arguments the card may show. */
export const ARG_DISPLAY_LIMIT = 800

function clip(text, limit) {
  const value = String(text ?? '')
  if (value.length <= limit) return value
  return `${value.slice(0, limit)}\n…（已截断，原始长度 ${value.length} 字符）`
}

/** Bound one error message to a safe, single-line, redacted field. */
const ERROR_LOG_LIMIT = 200
function oneLineError(error) {
  const raw = error && typeof error === 'object' && 'message' in error ? error.message : error
  let text = String(raw ?? 'unknown-error')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  text = maskSecrets(text)
  if (text.length > ERROR_LOG_LIMIT) text = `${text.slice(0, ERROR_LOG_LIMIT - 1)}…`
  return text || 'unknown-error'
}

/** Mattermost renders one attachment; keep every field bounded and quote-safe. */
function field(title, value, short = false) {
  return { title, value: clip(value || '（无）', 400), short }
}

/**
 * Render the approval card.
 * @param record - the pending request.
 * @param context - `{ botUsername, argumentsText }` for presentation only.
 * @returns `{ message, props }` ready for POST /posts.
 */
/**
 * Render the approval card.
 *
 * Two shapes live here on purpose:
 *   - a Mattermost-origin request behaves exactly as it always has (arguments
 *     shown when recoverable, the full risk sentence);
 *   - a Web-origin request is a DM-only decision card that says so, states that
 *     the risk was NOT assessed, and hides the arguments unless the operator
 *     explicitly opts in (`cardArguments: 'masked'`).
 *
 * @param record - the pending request.
 * @param context - `{ botUsername, argumentsText }` for presentation only.
 * @returns `{ message, props }` ready for POST /posts.
 */
export function renderApprovalCard(record, { botUsername, argumentsText } = {}) {
  const STATE_LABEL = {
    pending: '待决定',
    approved: '已批准（仅本次）',
    rejected: '已拒绝',
    expired: '已过期（未批准）',
    cancelled: '已取消（未批准）',
    unavailable: '无可用审批通道（未批准）',
  }
  const web = record.source === 'web'
  // A card whose request was settled elsewhere is VOID — a notification
  // lifecycle, not a business outcome.
  const status = record.card === 'void' && record.outcome !== 'pending'
    ? '已失效（另一处已处理，本卡片不能再裁决）'
    : (STATE_LABEL[record.outcome] || record.outcome)
  const showArguments = record.cardArguments === 'masked'
  const lines = []
  // The reason is asker-supplied free text (a justification string), and a model
  // that pastes a command into it can paste a credential with it. Mask it with
  // the same rules the arguments get.
  if (record.reason) lines.push(`**原因**：${clip(maskSecrets(record.reason), 400)}`)
  if (showArguments && argumentsText) {
    // Already masked and clipped to ARG_DISPLAY_LIMIT by the caller; a second
    // clip at the same limit would eat the caller's truncation marker.
    lines.push(`**参数**（仅展示，不作为授权依据）：\n\`\`\`\n${String(argumentsText).slice(0, ARG_DISPLAY_LIMIT + 200)}\n\`\`\``)
  }
  else if (showArguments && record.argumentsUnavailable) lines.push('**参数**：不可用（未能从会话日志中读取该工具调用）')
  else if (web) lines.push('**参数**：本卡片不展示参数正文（Web 来源默认关闭）。')
  if (web) {
    lines.push('')
    lines.push('**这是来自 DSH Web 会话的审批请求。**')
    lines.push('· 本卡片只发送到与该审批人一对一私聊的会话；群聊、频道与线程只会收到不可裁决的提醒。')
    lines.push('· Mattermost 与 Web 界面共享同一次审批：任何一处先处理，另一处即失效。')
  }
  lines.push('')
  lines.push('**如何决定**')
  lines.push('· 给本条消息加 ✅ 表示**批准一次**')
  lines.push('· 给本条消息加 ❌ 表示**拒绝**')
  lines.push(`· 或者在本频道回复 \`/approve ${record.id}\` / \`/reject ${record.id}\``)
  lines.push('')
  lines.push('_本请求只能批准一次；超时、已处理或状态不明的请求不会被批准，操作将失败关闭。_')

  const fields = [
    field('来源', web ? 'DSH Web 会话（Mattermost 为辅助入口）' : 'Mattermost 会话', true),
    field('会话', `\`${record.sessionId.slice(0, 16)}…\`（${record.chatKind || 'chat'}）`, true),
    field('发起人', record.askerUserId ? `\`${record.askerUserId.slice(0, 8)}\`` : '未知', true),
  ]
  if (web) {
    // There is no trustworthy risk source for a Web-origin request: say so
    // instead of copying the Mattermost sentence, which would be a guess.
    fields.push(field('风险', '未评估（DSH 未提供风险等级；批准即允许本次调用以更高权限执行）', false))
  } else {
    fields.push(field('风险', '该操作需要超出当前沙箱范围的权限。批准即允许本次调用以更高权限执行；仅影响这一次请求。', false))
  }
  fields.push(field('通知模式', web ? '可裁决（一对一私聊）' : '可裁决', true))
  fields.push(field('状态', status, true))
  if (record.decidedBy || record.outcome !== 'pending') {
    const via = record.via ? ` · ${record.via}` : ''
    fields.push(field('裁决来源', record.decidedBy ? `${String(record.decidedBy).slice(0, 8)}${via}` : `系统${via}`, true))
  }

  const attachment = {
    fallback: `审批请求 ${record.id}：${record.toolName}`,
    color: record.outcome === 'pending' ? '#4a7ed9' : record.outcome === 'approved' ? '#3db887' : '#c9463d',
    author_name: botUsername ? `@${botUsername}` : 'DSH',
    title: `审批请求 \`${record.id}\` · ${record.toolName}`,
    text: lines.join('\n'),
    fields,
    footer: `请求 ${record.id} · ${new Date(record.createdAt).toISOString()}${record.decidedBy ? ` · 决定人 ${String(record.decidedBy).slice(0, 8)}` : ''}`,
  }
  return { message: `审批请求 \`${record.id}\`：${record.toolName}`, props: { attachments: [attachment] } }
}

/**
 * Render the NON-DECIDABLE notice used for channels, group DMs and threads.
 *
 * It deliberately contains no request id, no tool name and no arguments: it must
 * be impossible to turn into a decision, and it must not disclose what the
 * operation is to everyone in the room.
 */
export function renderApprovalNotice(route = {}) {
  const where = route.targetKind === 'thread' ? '线程' : route.targetKind === 'group-dm' ? '群聊' : '频道'
  const lines = [
    '有 DSH **Web 会话**的审批请求正在等待处理。',
    '',
    `· 本${where}不支持直接裁决，因此这条消息不包含请求编号、工具名或参数。`,
    '· 请回到 **DSH Web 界面**完成审批。',
    '· 无人处理时会超时，该操作将不会被批准。',
  ]
  const attachment = {
    fallback: '有 Web 会话审批请求等待处理（请到 Web 界面处理）',
    color: '#8a8f98',
    author_name: 'DSH',
    title: '审批提醒（不可在本处裁决）',
    text: lines.join('\n'),
    fields: [field('通知模式', '仅提醒（不可裁决）', true)],
    footer: '本消息不含请求编号，无法在此批准或拒绝任何操作。',
  }
  return { message: '有审批请求等待处理，请到 DSH Web 界面处理。', props: { attachments: [attachment] } }
}

/**
 * Create the bridge.
 *
 * @param options.logger - plugin logger (`info/warn/error`).
 * @param options.config - approval-related config (`approvalEnabled`, `approvalTimeoutMs`).
 * @param options.deps - host wiring, see the deps table in index.js.
 */
export function createApprovalBridge({ logger, config, deps }) {
  /**
   * Every request this process knows about, terminal ones included (a late
   * reaction must be able to answer "already settled" instead of "unknown").
   * Bounded: the oldest TERMINAL record is dropped when the map grows past 200.
   */
  const pending = new Map()
  /** postId -> requestId, for reaction routing. Only DELIVERED cards appear. */
  const byPost = new Map()
  const stats = { asked: 0, approved: 0, rejected: 0, expired: 0, cancelled: 0, unavailable: 0, notified: 0, ignored: 0 }

  const timeoutMs = Math.max(30_000, Number(config.approvalTimeoutMs) || 300_000)
  const enabled = config.approvalEnabled !== false
  /** Set once the plugin is disposed: no new cards, no new decision routes. */
  let disposed = false

  function newRequestId() {
    // 8 hex chars (32 bits): short enough to type, wide enough that a mistaken
    // guess cannot land on a live request (and guessing buys nothing anyway —
    // the channel and user are both re-checked).
    return randomBytes(5).toString('hex').slice(0, 8)
  }

  /**
   * JSON-safe view of one record.
   *
   * `state` is kept as an alias of `outcome` for the existing status surface and
   * probes; `card` and `settledBy` make the other two lifecycles explicit instead
   * of overloading one string.
   */
  function serialize(record) {
    return {
      id: record.id,
      botId: record.botId,
      sessionId: record.sessionId,
      chatKey: record.chatKey,
      chatKind: record.chatKind,
      channelId: record.channelId,
      rootId: record.rootId,
      toolName: record.toolName,
      callId: record.callId,
      reason: record.reason,
      askerUserId: record.askerUserId,
      createdAt: record.createdAt,
      decidedAt: record.decidedAt,
      decidedBy: record.decidedBy,
      via: record.via,
      // The request answer…
      outcome: record.outcome,
      state: record.outcome,
      settledBy: record.settledBy,
      // …the Mattermost notification…
      card: record.card,
      postId: record.postId,
      // …and whether the Web prompt was involved at all.
      webSide: record.webSide,
      source: record.source || 'mattermost',
      notificationMode: record.source === 'web'
        ? (record.dmOnly ? 'actionable' : 'notification-only')
        : undefined,
      approvers: record.source === 'web' ? [...(record.approvers || [])] : undefined,
      argumentsUnavailable: record.argumentsUnavailable,
    }
  }

  /** Exactly one audit line per request, written at the terminal transition. */
  function publish(record) {
    try {
      deps.audit({
        at: new Date(record.decidedAt || record.createdAt).toISOString(),
        requestId: record.id,
        botId: record.botId,
        sessionId: record.sessionId,
        chatKey: record.chatKey,
        toolName: record.toolName,
        callId: record.callId,
        asker: record.askerUserId,
        outcome: record.outcome,
        settledBy: record.settledBy,
        decidedBy: record.decidedBy,
        via: record.via,
        source: record.source || 'mattermost',
        card: record.card,
      })
    } catch (error) {
      logger.warn(`approval audit append failed: ${error.message}`)
    }
  }

  function trim() {
    if (pending.size <= 200) return
    for (const [id, candidate] of pending) {
      if (candidate.outcome !== 'pending') { pending.delete(id); break }
    }
  }

  /**
   * The ONE terminal transition for one request.
   *
   * Synchronous check-and-write, so two participants — a reaction, a command, a
   * timer, an abort, the Web answerer, or dispose — can only observe the state
   * the first one wrote. Everything else (listeners, timers, the reaction route,
   * the audit line, the returned promise) is unwound from here, in one order.
   */
  function settle(record, outcome, { by, via, settledBy = 'system' } = {}) {
    if (!record || record.outcome !== 'pending') return false
    record.outcome = outcome
    record.decidedAt = Date.now()
    record.decidedBy = by
    record.via = via
    record.settledBy = settledBy
    // Card lifecycle, derived from WHO won:
    //   mattermost  the card WAS the decision surface; keep it `posted`
    //   anything else (web/timeout/abort/shutdown) it can no longer decide → `void`
    // A card still in flight is void either way: it was never a decision route.
    if (record.card === 'posting') {
      record.card = 'void'
    } else if (record.card === 'posted' && settledBy !== 'mattermost') {
      record.card = 'void'
    }
    if (record.timer) { clearTimeout(record.timer); record.timer = null }
    if (record.onAbort && record.signal) {
      try { record.signal.removeEventListener('abort', record.onAbort) } catch { /* ignore */ }
      record.onAbort = null
    }
    stats[outcome] = (stats[outcome] || 0) + 1
    if (record.postId) byPost.delete(String(record.postId))
    publish(record)
    // Resolve LAST, so an observer of the returned promise sees a final record.
    if (typeof record.resolve === 'function') {
      const resolve = record.resolve
      record.resolve = null
      resolve(OUTCOME[outcome] || 'unavailable')
    }
    try {
      Promise.resolve(deps.updateCard(record.botId, record.postId, renderApprovalCard(record, { botUsername: record.botUsername, argumentsText: record.argumentsText })))
        .then((ok) => logger.info(`approval card updated id=${record.id} outcome=${record.outcome} card=${record.card} ok=${ok}`))
        .catch((error) => logger.warn(`approval card update failed: ${error.message}`))
    } catch (error) {
      // A synchronous throw from updateCard must never escape a decision.
      logger.warn(`approval card update threw: ${error.message}`)
    }
    return true
  }

  function baseRecord({
    sessionId, botId, chatKey, chatKind, channelId, rootId, toolName, callId, reason,
    askerUserId, botUsername, source, dmOnly, approvers, cardArguments, webSide, signal, priority,
  }) {
    const record = {
      id: newRequestId(),
      botId,
      sessionId,
      chatKey,
      chatKind,
      channelId,
      rootId,
      toolName: String(toolName || 'unknown'),
      callId,
      reason,
      askerUserId,
      createdAt: Date.now(),
      outcome: 'pending',
      settledBy: null,
      via: undefined,
      decidedBy: undefined,
      decidedAt: undefined,
      card: 'posting',
      postId: undefined,
      cardArguments,
      source,
      dmOnly: Boolean(dmOnly),
      approvers: Array.isArray(approvers) ? approvers.map(String) : [],
      webSide,
      priority,
      botUsername,
      argumentsUnavailable: false,
      signal,
      resolve: null,
      timer: null,
      onAbort: null,
    }
    record.promise = new Promise((resolve) => { record.resolve = resolve })
    pending.set(record.id, record)
    trim()
    return record
  }

  /** Attach the abort listener and the timeout to one record. */
  function armLifecycle(record, request) {
    if (request && request.signal) {
      if (request.signal.aborted) {
        settle(record, 'cancelled', { by: 'system', via: 'abort', settledBy: 'abort' })
        return false
      }
      const onAbort = () => settle(record, 'cancelled', { by: 'system', via: 'abort', settledBy: 'abort' })
      record.onAbort = onAbort
      try { request.signal.addEventListener('abort', onAbort, { once: true }) } catch { /* ignore */ }
    }
    record.timer = setTimeout(() => {
      settle(record, 'expired', { by: 'system', via: 'timeout', settledBy: 'timeout' })
    }, timeoutMs)
    if (record.timer && typeof record.timer.unref === 'function') record.timer.unref()
    return record.outcome === 'pending'
  }

  /**
   * Post one card and register its decision route.
   *
   * The two sources differ on failure, and that difference is load-bearing:
   *   - a Mattermost-origin request has no other answerer, so a lost card is a
   *     lost approval: fail closed (`unavailable`);
   *   - a Web-origin request has the browser prompt, so a lost card is only a
   *     lost notification: warn and keep the request open.
   */
  function deliverCard(record, sessionId) {
    void (async () => {
      try {
        const argumentsText = record.cardArguments === 'masked' && record.callId
          ? await deps.readToolArguments(sessionId, record.callId)
          : undefined
        if (!argumentsText) record.argumentsUnavailable = true
        else record.argumentsText = argumentsText
        const card = renderApprovalCard(record, { botUsername: record.botUsername, argumentsText })
        const postId = await deps.sendCard(record.botId, record.channelId, record.rootId, card)
        if (!postId) throw new Error('Mattermost did not return a post id')
        record.postId = postId
        // Settled (or disposed) while the card was being delivered: it exists,
        // but it must never become decidable. Rewrite it and stop.
        if (record.outcome !== 'pending' || disposed) {
          record.card = 'void'
          if (!disposed) {
            await deps.updateCard(record.botId, postId, renderApprovalCard(record, { botUsername: record.botUsername, argumentsText: record.argumentsText }))
          }
          return
        }
        record.card = 'posted'
        byPost.set(postId, record.id)
        logger.info(`event=approval_card_posted approvalId=${record.id} cardId=${postId} channelId=${String(record.channelId || '').slice(0, 8)} source=${record.source || 'mattermost'} result=success`)
      } catch (error) {
        record.card = 'failed'
        logger.warn(`event=approval_card_post_failed approvalId=${record.id} source=${record.source || 'mattermost'} result=failure error=${oneLineError(error)}`)
        if (record.source === 'web') {
          // A notification failure must never decide a request the Web UI can
          // still answer; the timer closes it if nobody does.
          logger.warn(`web approval card delivery failed (Web prompt unaffected): ${oneLineError(error)}`)
        } else {
          logger.warn(`approval card delivery failed: ${oneLineError(error)}`)
          settle(record, 'unavailable', { by: 'system', via: 'delivery-failed', settledBy: 'system' })
        }
      }
    })()
  }

  /** Post a non-decidable notice. Nothing is recorded, nothing is decidable. */
  function notifyOnly(route) {
    stats.notified += 1
    logger.info(`web approval notice reason=${route.reason} channel=${String(route.channelId || '').slice(0, 8)}`)
    void Promise.resolve()
      .then(() => deps.sendCard(route.botId, route.channelId, route.rootId, renderApprovalNotice(route)))
      .then((postId) => { if (!postId) logger.warn('web approval notice was not posted') })
      .catch((error) => logger.warn(`web approval notice failed: ${error.message}`))
  }

  /**
   * A request this plugin OWNS (a Mattermost conversation drives the agent).
   * There is no other answerer, so the card is the only way to decide.
   */
  function ownRequest(request, next, sessionId, target) {
    stats.asked += 1
    const record = baseRecord({
      sessionId,
      botId: target.botId,
      chatKey: target.chatKey,
      chatKind: target.chatKind,
      channelId: target.channelId,
      rootId: target.rootId,
      toolName: request.toolName,
      callId: request.callId,
      reason: request.displayReason?.zh || request.displayReason?.en || request.reason,
      askerUserId: target.userId,
      botUsername: target.botUsername,
      source: 'mattermost',
      dmOnly: false,
      approvers: [],
      cardArguments: 'masked',
      webSide: 'not-offered',
      signal: request.signal,
      priority: undefined,
    })
    if (!armLifecycle(record, request)) return record.promise
    deliverCard(record, sessionId)
    return record.promise
  }

  /**
   * A request raised by a DSH WEB session.
   *
   * Order matters: `next()` runs FIRST, so the browser prompt never waits on a
   * Mattermost API call. The router only decides whether an announcement (and
   * which shape) is added on top.
   *
   * Only a verified one-to-one DM whose peer is the single approver gets a
   * decidable card. Channels, group DMs and threads get a notice. Everything
   * else gets nothing, and the Web prompt answers exactly as before.
   */
  function handleWeb(request, next, sessionId) {
    let delegate
    try { delegate = next() } catch (error) {
      logger.warn(`web answerer threw (no announcement): ${error.message}`)
      return Promise.resolve('unavailable')
    }

    let record = null
    let nativeOutcome = null
    const onNative = (outcome) => {
      nativeOutcome = outcome
      if (!record) return
      if (outcome === 'allowed-once' || outcome === 'rejected') {
        settle(record, outcome === 'allowed-once' ? 'approved' : 'rejected', {
          by: undefined,
          via: 'web',
          settledBy: 'web',
        })
      } else if (outcome === 'cancelled') {
        settle(record, 'cancelled', { by: 'system', via: 'abort', settledBy: 'abort' })
      }
      // 'unavailable': the native answerer could not answer. The card is now the
      // only remaining route, so the request keeps waiting (until the timer).
    }
    Promise.resolve(delegate).then(onNative, (error) => {
      // A rejected native answerer means the SESSION side failed, not that the
      // request was denied: the card may still decide.
      logger.warn(`web answerer failed (card may still decide): ${error.message}`)
    })

    return Promise.resolve()
      .then(() => deps.resolveWebRoute(sessionId))
      .then((route) => {
        if (disposed) return handOff(delegate)
        if (!route || route.mode === 'none') {
          if (route) logger.info(`web approval not routed: ${route.reason}`)
          return handOff(delegate)
        }
        if (route.mode === 'notification-only') {
          notifyOnly(route)
          return handOff(delegate)
        }
        // The browser answered before the route was even resolved: a card now
        // would be born void, so announce nothing. `unavailable` is different —
        // it means the native side could not answer, and the card is the only
        // remaining route, so it still gets announced.
        if (nativeOutcome === 'allowed-once' || nativeOutcome === 'rejected' || nativeOutcome === 'cancelled') {
          return handOff(delegate)
        }
        record = baseRecord({
          sessionId,
          botId: route.botId,
          chatKey: route.chatKey,
          chatKind: 'dm',
          channelId: route.channelId,
          rootId: undefined,
          toolName: request.toolName,
          callId: request.callId,
          reason: request.displayReason?.zh || request.displayReason?.en || request.reason,
          askerUserId: undefined,
          botUsername: undefined,
          source: 'web',
          dmOnly: true,
          approvers: route.approvers,
          cardArguments: config.cardArguments === 'masked' ? 'masked' : 'off',
          webSide: 'offered',
          signal: request.signal,
          priority: route.priority,
        })
        if (onNativePending(record, nativeOutcome)) return record.promise
        if (!armLifecycle(record, request)) return record.promise
        deliverCard(record, sessionId)
        return record.promise
      })
      .catch((error) => {
        logger.warn(`web approval routing failed (delegating): ${error.message}`)
        return handOff(delegate)
      })
  }

  /**
   * Hand a request back to the native path.
   *
   * The inner answerer's rejection is the SESSION's problem, not the approval's:
   * a listener that throws takes the whole deployment's approvals closed, so it
   * is converted to the native fail-closed value here.
   */
  function handOff(delegate) {
    return Promise.resolve(delegate).then(
      (outcome) => outcome,
      (error) => {
        logger.warn(`web answerer failed while handing off: ${error.message}`)
        return 'unavailable'
      },
    )
  }

  /**
   * The native outcome may have arrived between the route resolving and the
   * record existing: the microtask order is not ours to choose. Re-apply it
   * synchronously once the record exists.
   */
  function onNativePending(record, outcome) {
    if (outcome === null) return false
    if (outcome === 'allowed-once' || outcome === 'rejected') {
      settle(record, outcome === 'allowed-once' ? 'approved' : 'rejected', { by: undefined, via: 'web', settledBy: 'web' })
    } else if (outcome === 'cancelled') {
      settle(record, 'cancelled', { by: 'system', via: 'abort', settledBy: 'abort' })
    }
    return true
  }

  function handle(request, next) {
    try {
      if (!enabled || disposed) return next()
      const agent = request && request.agent
      const sessionId = agent && agent.session ? String(agent.session.id) : ''
      if (!sessionId) return next()
      const target = deps.lookupTarget(sessionId)
      if (target && target.channelId) return ownRequest(request, next, sessionId, target)
      if (typeof deps.resolveWebRoute === 'function') return handleWeb(request, next, sessionId)
      return next()
    } catch (error) {
      try { logger.error(`approval listener failed (delegating): ${error.stack || error.message}`) } catch { /* ignore */ }
      try { return next() } catch { return Promise.resolve('unavailable') }
    }
  }

  /**
   * Apply one decision from a human.
   * @returns `{ ok, code }` where code is `ok | unknown | settled | expired |
   *   forbidden | wrong-channel | not-allowed | not-posted`.
   */
  function decide({ requestId, userId, botId, channelId, decision, via }) {
    const record = pending.get(String(requestId || ''))
    if (!record) return { ok: false, code: 'unknown' }
    if (record.botId !== botId) return { ok: false, code: 'forbidden' }
    if (!deps.isAuthorized(botId, userId)) return { ok: false, code: 'not-allowed' }
    // A Web-origin request may only be decided in its one-to-one DM, by its one
    // configured approver. Group channels, threads and group DMs never get a
    // record at all, and this re-checks the two independent facts.
    if (record.source === 'web') {
      if (!record.dmOnly) return { ok: false, code: 'forbidden' }
      const approvers = Array.isArray(record.approvers) ? record.approvers.map(String) : []
      if (approvers.length !== 1 || approvers[0] !== String(userId)) return { ok: false, code: 'not-allowed' }
    }
    if (channelId && record.channelId !== channelId) return { ok: false, code: 'wrong-channel' }
    if (record.outcome !== 'pending') {
      return { ok: false, code: record.outcome === 'expired' ? 'expired' : 'settled', record: serialize(record) }
    }
    if (!record.postId || record.card === 'failed' || record.card === 'void') {
      // No delivered card carries this id: a forged request id, or a card that
      // never arrived (a Web notification failure). Nothing to decide.
      return { ok: false, code: 'not-posted', record: serialize(record) }
    }
    if (Date.now() >= record.createdAt + timeoutMs) {
      settle(record, 'expired', { by: 'system', via: 'timeout', settledBy: 'timeout' })
      return { ok: false, code: 'expired', record: serialize(record) }
    }
    const outcome = decision === 'rejected' ? 'rejected' : 'approved'
    const changed = settle(record, outcome, { by: userId, via, settledBy: 'mattermost' })
    return changed
      ? { ok: true, code: 'ok', record: serialize(record) }
      : { ok: false, code: 'settled', record: serialize(record) }
  }

  /**
   * Route one Mattermost reaction.
   * @returns `true` when the reaction belonged to an approval card.
   */
  function handleReaction({ botId, userId, postId, emojiName, removed }) {
    const requestId = byPost.get(String(postId || ''))
    if (!requestId) return false
    if (removed) return true
    const decision = APPROVE_EMOJI.has(emojiName) ? 'approved'
      : REJECT_EMOJI.has(emojiName) ? 'rejected'
      : null
    if (!decision) { stats.ignored += 1; return true }
    const record = pending.get(requestId)
    if (!record) return true
    const result = decide({ requestId, userId, botId, channelId: record.channelId, decision, via: 'reaction' })
    if (!result.ok) {
      stats.ignored += 1
      logger.info(`approval reaction ignored id=${requestId} code=${result.code}`)
    } else {
      logger.info(`approval decided id=${requestId} outcome=${record.outcome} via=reaction`)
    }
    return true
  }

  function pendingFor(botId, chatKey) {
    const rows = []
    for (const record of pending.values()) {
      if (record.outcome !== 'pending') continue
      // An omitted botId means "every bot" (the status surface). Filtering on it
      // unconditionally made the pending counter read 0 forever.
      if (botId !== undefined && record.botId !== botId) continue
      if (chatKey && record.chatKey !== chatKey) continue
      rows.push(serialize(record))
    }
    return rows.sort((a, b) => a.createdAt - b.createdAt)
  }

  function dispose() {
    disposed = true
    for (const record of pending.values()) {
      if (record.outcome === 'pending') {
        settle(record, 'cancelled', { by: 'system', via: 'shutdown', settledBy: 'shutdown' })
      }
    }
    pending.clear()
    byPost.clear()
  }

  return {
    handle,
    decide,
    handleReaction,
    pendingFor,
    pending: (id) => {
      const record = pending.get(String(id || ''))
      return record ? serialize(record) : undefined
    },
    stats: () => ({ ...stats, pending: pendingFor().length, timeoutMs }),
    dispose,
  }
}
