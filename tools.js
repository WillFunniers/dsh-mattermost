/**
 * Agent-facing tools for durable delayed jobs.
 *
 * Registered with `ctx.tools.register(defineTool(...))` — the same mechanism
 * `dsh-tool-jobs` uses. No second tool system, no MCP server, and therefore no
 * production profile change is needed to expose these.
 *
 * Authorization is inherited, not re-implemented. A job can only be created
 * from a session that a Mattermost message already authorized (the plugin's
 * admission order rejects unauthorized posts before any session is minted),
 * and only for a session the plugin actually maps to a Mattermost target.
 * Cancel/list are fenced to the calling session.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { JOB_TYPES } from './jobs.js'

const DEFAULT_MAX_HORIZON_MS = 30 * 24 * 60 * 60 * 1000
const MIN_DELAY_MS = 1_000

/** Human-readable one-line summary of a job. */
function describe(job) {
  const when = new Date(job.executeAt).toISOString()
  const late = job.status === 'pending' && job.executeAt <= Date.now() ? ' (overdue)' : ''
  return `${job.id}  ${job.type}  ${job.status}  ${when}${late}  ${job.message.slice(0, 60)}`
}

function textResult(text) {
  return { text }
}

/**
 * Resolve the requested execution time from exactly one selector.
 * Mirrors the core schedule tool's contract: one selector, not zero, not two.
 */
export function resolveExecuteAt(args, now, maxHorizonMs) {
  const hasAfter = args.after_seconds !== undefined && args.after_seconds !== null
  const hasAt = typeof args.at === 'string' && args.at.trim() !== ''
  if (hasAfter === hasAt) {
    throw new Error('provide exactly one of after_seconds or at')
  }
  let executeAt
  if (hasAfter) {
    const seconds = Number(args.after_seconds)
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('after_seconds must be a positive number')
    executeAt = now + Math.trunc(seconds * 1000)
  } else {
    const parsed = Date.parse(args.at)
    if (!Number.isFinite(parsed)) throw new Error(`at is not a valid ISO 8601 date-time: ${args.at}`)
    executeAt = parsed
  }
  if (executeAt < now - 60_000) throw new Error('the requested time is in the past')
  if (executeAt > now + maxHorizonMs) {
    throw new Error(`the requested time is beyond the maximum horizon (${Math.round(maxHorizonMs / 86_400_000)} days)`)
  }
  return executeAt
}

/**
 * Register the three job tools.
 *
 * @param toolCtx - context carrying `tools` (from `ctx.inject(['tools'], …)`)
 * @param deps.resolveContext - sessionId -> { channelId, rootId, userId } | undefined
 */
export function registerJobTools(toolCtx, { logger, store, resolveContext, maxHorizonMs = DEFAULT_MAX_HORIZON_MS }) {
  const disposers = []

  disposers.push(toolCtx.tools.register(defineTool({
    name: 'schedule_job',
    description:
      'Schedule durable delayed work in this conversation. The job is persisted outside the live agent, '
      + 'so it still runs if the agent is idle-evicted or the host restarts. Use type "reminder" to have '
      + 'the user reminded of something, or "agent_followup" to have this session continue a task later. '
      + 'Supply exactly one selector: after_seconds (delay) or at (ISO 8601 date-time). '
      + 'Prefer this over running `sleep` in bash, which does not survive agent eviction.',
    parameters: {
      type: {
        type: 'string',
        required: true,
        description: `Job kind: ${JOB_TYPES.join(' or ')}.`,
      },
      message: {
        type: 'string',
        required: true,
        description: 'What to remind the user of, or the instruction to run later.',
      },
      after_seconds: {
        type: 'number',
        description: 'Delay from now, in seconds. Mutually exclusive with at.',
      },
      at: {
        type: 'string',
        description: 'Absolute ISO 8601 date-time, e.g. 2026-09-29T04:30:00Z. Mutually exclusive with after_seconds.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          job_id: { type: 'string' },
          execute_at: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const sessionId = exec && exec.agent ? String(exec.agent.id) : ''
      if (!sessionId) throw new Error('no calling session')
      const context = resolveContext(sessionId)
      if (!context) {
        throw new Error('this session is not bound to a Mattermost conversation; delayed jobs cannot be delivered here')
      }
      const type = String(args.type || '')
      if (!JOB_TYPES.includes(type)) throw new Error(`type must be one of: ${JOB_TYPES.join(', ')}`)
      const message = String(args.message || '').trim()
      if (!message) throw new Error('message must not be empty')

      const executeAt = resolveExecuteAt(args, Date.now(), maxHorizonMs)
      const job = await store.create({
        type,
        executeAt,
        sessionId,
        channelId: context.channelId,
        rootId: context.rootId,
        createdBy: context.userId,
        message,
      })
      logger.info(`job created id=${job.id} type=${job.type} session=${sessionId} at=${new Date(executeAt).toISOString()}`)
      return {
        text: `已创建定时任务 \`${job.id}\`（${job.type}），将于 ${new Date(executeAt).toISOString()} 执行。`
          + '它独立于当前 agent 生命周期：即使会话空闲被回收或主机重启，到点仍会执行。',
        job_id: job.id,
        execute_at: new Date(executeAt).toISOString(),
      }
    },
  })))

  disposers.push(toolCtx.tools.register(defineTool({
    name: 'list_jobs',
    description: 'List the delayed jobs belonging to this conversation, with id, type, status and due time.',
    parameters: {
      include_finished: {
        type: 'boolean',
        description: 'Include completed, failed and cancelled jobs. Defaults to false.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute(args, exec) {
      const sessionId = exec && exec.agent ? String(exec.agent.id) : ''
      if (!sessionId) throw new Error('no calling session')
      const jobs = store.list({ sessionId, includeTerminal: args.include_finished === true })
      if (!jobs.length) return textResult('（当前会话没有定时任务）')
      const counts = jobs.reduce((acc, job) => { acc[job.status] = (acc[job.status] || 0) + 1; return acc }, {})
      const summary = Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ')
      return textResult(`${jobs.length} 个定时任务（${summary}）：\n${jobs.map((j) => `  ${describe(j)}`).join('\n')}`)
    },
  })))

  disposers.push(toolCtx.tools.register(defineTool({
    name: 'cancel_job',
    description: 'Cancel a pending delayed job in this conversation by its id. A job that already ran cannot be cancelled.',
    parameters: {
      job_id: {
        type: 'string',
        required: true,
        description: 'Job id, e.g. job-0123456789abcdef.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          outcome: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const sessionId = exec && exec.agent ? String(exec.agent.id) : ''
      if (!sessionId) throw new Error('no calling session')
      const result = await store.cancel(String(args.job_id || ''), { sessionId, by: sessionId })
      switch (result.outcome) {
        case 'cancelled':
          return { outcome: 'cancelled', text: `已取消定时任务 \`${args.job_id}\`。` }
        case 'already-terminal':
          return { outcome: 'already-terminal', text: `定时任务 \`${args.job_id}\` 已经是终态（${result.job.status}），无法取消。` }
        case 'forbidden':
          return { outcome: 'forbidden', text: '该定时任务不属于当前会话，拒绝取消。' }
        default:
          return { outcome: 'not-found', text: `找不到定时任务 \`${args.job_id}\`。` }
      }
    },
  })))

  return () => { for (const dispose of disposers) { try { dispose() } catch { /* ignore */ } } }
}
