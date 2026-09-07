import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { foldScheduleEvents, scheduleView } from '@deepseek-ai/dsh-schedule'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { PromptStore } from './prompts.js'
import { AdminError } from './files.js'
import type { AdminSessions } from './backend.js'
import { randomUUID } from 'node:crypto'

export function installManagedPrompt(ctx: Context, id: string, prompts: PromptStore) {
  prompts.beginTurn(id)
  ctx.systemPrompt.variable('personal_growth_identity', () => prompts.textFor(id))
  ctx.systemPrompt.section({ name: 'deployment:persona', order: 0, text: '{{personal_growth_identity}}' })
}
export function adminSessions(ctx: Context): AdminSessions {
  return {
    async list() { return (await ctx.sessionPersistence.listSnapshots()).map(item => ({ id: String(item.header.id), ...JSON.parse(JSON.stringify(item.header)) })) },
    async read(id, from) {
      const result = await ctx.sessionPersistence.readFrom(SessionId(id), from)
      return { events: result.events.map(event => ({ ...event })) }
    },
  }
}
export function adminSchedule(ctx: Context, sessionId: string, ensureForeground: () => Promise<unknown>) {
  return async (operation: 'list' | 'create' | 'delete', args: unknown): Promise<unknown> => {
    if (operation === 'list') {
      const exists = (await ctx.sessionPersistence.listSnapshots()).some(item => String(item.header.id) === sessionId)
      if (!exists) return []
      const view = await ctx.sessionPersistence.inspect(SessionId(sessionId))
      return foldScheduleEvents(view.events, view.meta.seedLength ?? 0).active.map(item => scheduleView(item, Date.now()))
    }
    await ensureForeground()
    const agent = ctx.agents.get(SessionId(sessionId)); if (!agent) throw new AdminError(503, 'agent_unavailable')
    const name = operation === 'create' ? 'schedule_create' : 'schedule_delete'
    const result = await agent.ctx.tools.execute({ callId: `admin-${randomUUID()}` as never, name, arguments: args, agent, signal: AbortSignal.timeout(30000) })
    if (result.isError) throw new AdminError(400, 'schedule_tool_failed')
    if (result.value && typeof result.value === 'object' && 'code' in result.value && !('deleted' in result.value)) throw new AdminError(400, 'schedule_rejected')
    return result.value
  }
}
