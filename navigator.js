/**
 * Session Navigator: present and re-point ONE conversation's own sessions.
 *
 * Scope is deliberately narrow, and the narrowness is the safety property:
 *
 *   - only the generations of the current chat key are listed, so no code path
 *     here can even name a session another thread, another user or another bot
 *     is using;
 *   - a switch rewrites one map entry (mapping.bind). It never disposes an
 *     agent, never edits a DSH session, and never touches the DSH session store;
 *   - the DSH Web corpus is never listed or scanned: every id shown came from
 *     this plugin's own map.
 *
 * Rendering is pure so it can be unit-tested without a Host.
 */

/** Relative age, coarse on purpose: this is orientation, not a timestamp. */
export function ageText(ms) {
  const value = Number(ms)
  if (!Number.isFinite(value) || value < 0) return '未知'
  const s = Math.floor(value / 1000)
  if (s < 45) return '刚刚'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d} 天前`
  return `${Math.floor(d / 30)} 个月前`
}

/** One-line state of a session: live agent status, or that it is only on disk. */
export function statusText(liveStatus) {
  if (liveStatus === 'running') return '运行中'
  if (liveStatus) return '空闲（agent 在内存中）'
  return '冷存储（发消息时会恢复）'
}

const KIND_LABEL = { dm: '私聊', ch: '频道', th: '线程' }

/**
 * Parse `/switch <selector>`.
 *
 * A bare number is a 1-based index into the rendered list; anything else is
 * matched as a session-id prefix. Ids are `mm-…`, so the two forms cannot be
 * confused by accident.
 * @returns `{ kind: 'index', index }` | `{ kind: 'id', prefix }` | `{ kind: 'invalid' }`
 */
export function parseSelector(raw) {
  const text = String(raw ?? '').trim().replace(/^#/, '')
  if (!text) return { kind: 'invalid' }
  if (/^\d{1,3}$/.test(text)) return { kind: 'index', index: Number(text) }
  if (/^[A-Za-z0-9._-]{4,64}$/.test(text)) return { kind: 'id', prefix: text.toLowerCase() }
  return { kind: 'invalid' }
}

/**
 * Choose the generation a selector refers to.
 * @param rows - `[{ generation, sessionId, updatedAt, current }]` (oldest first).
 * @param selector - parsed selector.
 * @returns `{ row }` or `{ error }` with an operator-readable reason.
 */
export function pickGeneration(rows, selector) {
  if (!Array.isArray(rows) || rows.length === 0) return { error: '本对话还没有可切换的会话' }
  if (!selector || selector.kind === 'invalid') {
    return { error: '用法：`/switch <序号>` 或 `/switch <sessionId 前缀>`' }
  }
  if (selector.kind === 'index') {
    if (selector.index < 1 || selector.index > rows.length) {
      return { error: `序号超出范围（1–${rows.length}）` }
    }
    return { row: rows[selector.index - 1] }
  }
  const matches = rows.filter((row) => row.sessionId.toLowerCase().startsWith(selector.prefix))
  if (matches.length === 0) return { error: `没有匹配 \`${selector.prefix}\` 的会话` }
  if (matches.length > 1) return { error: `\`${selector.prefix}\` 匹配到多个会话，请写更长一些` }
  return { row: matches[0] }
}

/** Render `/session` — the current conversation's binding. */
export function renderCurrent({ chatKind, generation, sessionId, updatedAt, liveStatus, title }) {
  const lines = ['**当前会话**']
  lines.push(`· 类型：${KIND_LABEL[chatKind] || chatKind || '对话'}`)
  lines.push(`· 会话：\`${sessionId}\``)
  lines.push(`· 代次：第 ${generation} 代`)
  if (title) lines.push(`· 标题：${title}`)
  lines.push(`· 状态：${statusText(liveStatus)}`)
  if (updatedAt) lines.push(`· 最近活动：${ageText(Date.now() - updatedAt)}`)
  lines.push('')
  lines.push('用 `/sessions` 看本对话的历史会话，用 `/switch <序号>` 切换。')
  return lines.join('\n')
}

/**
 * Render `/sessions`.
 * @param options.rows - oldest first; `current` marks the bound one.
 * @param options.titles - `Map<sessionId, string>`; missing entries are omitted.
 * @param options.statuses - `Map<sessionId, string|undefined>` of live status.
 * @param options.limit - how many rows to print (newest kept).
 */
export function renderSessionList({ chatKind, rows, titles, statuses, limit = 10 }) {
  const all = Array.isArray(rows) ? rows : []
  if (all.length === 0) return '本对话还没有会话。'
  const shown = all.slice(-limit)
  const offset = all.length - shown.length
  const lines = [`**本对话的会话**（${KIND_LABEL[chatKind] || chatKind || '对话'} · 共 ${all.length} 个）`]
  shown.forEach((row, index) => {
    const number = offset + index + 1
    const mark = row.current ? '●' : '○'
    const title = titles && titles.get(row.sessionId)
    const status = statuses ? statuses.get(row.sessionId) : undefined
    const bits = [`${number}. ${mark} \`${row.sessionId}\``]
    if (title) bits.push(title)
    if (row.updatedAt) bits.push(ageText(Date.now() - row.updatedAt))
    if (row.current) bits.push('**当前**')
    else if (status === 'running') bits.push('运行中')
    lines.push(bits.join(' · '))
  })
  if (offset > 0) lines.push(`（仅显示最近 ${limit} 个）`)
  lines.push('')
  lines.push('切换：`/switch <序号>`（只影响本对话；正在运行的目标会话不会被切换）')
  return lines.join('\n')
}

/**
 * Why a switch must be refused, or `undefined` when it may proceed.
 *
 * Each refusal is a safety property, not politeness:
 *   - switching to the session already bound is a no-op, not a new generation;
 *   - a running agent must not be re-pointed underneath its in-flight turn;
 *   - a session another conversation currently holds must never be shared,
 *     because one live agent would then serve two threads.
 */
export function switchBlocker({ targetSessionId, currentSessionId, liveStatus, foreignOwnerKey }) {
  if (!targetSessionId) return '目标会话不存在'
  if (targetSessionId === currentSessionId) return 'already-current'
  if (liveStatus === 'running') return '目标会话正在运行，拒绝切换'
  if (foreignOwnerKey) return '该会话正被另一个对话占用，拒绝切换'
  return undefined
}
