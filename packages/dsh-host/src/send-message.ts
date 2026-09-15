import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'personal-growth/message-sent': { id: string; callId: string; text: string; purpose?: 'progress' | 'final' }
  }
}

export const MESSAGE_DELIVERY_PROMPT = 'Use send_message(text) for every user-visible progress update, stage conclusion, and final reply. Each call sends one complete message. Set purpose=progress for interim updates and purpose=final for the final answer (default final). After a progress send, continue the task and use other tools as needed. Before ending a user request, send a reply with send_message. Ordinary assistant text is not delivered automatically. A heartbeat is an internal periodic wake, not a user request: work on goals if useful, and end silently when there is nothing worth communicating. Heartbeat sends are subject to contact policy; if denied, continue silently and do not bypass it with other channels. Never retry a pending or unknown delivery with a new call.'
export const DELIVERY_REPAIR_PROMPT = '上一轮用户请求尚未收到通过 send_message 发送的最终答复（可能已收到进度消息）。请仅调用 send_message 给出简短的最终答复或准确说明未完成事项，不要重复执行之前的任务或工具。普通 assistant 文本不会送达。不要输出内部思考或工具日志。'
export const DELIVERY_FALLBACK = '这次回复未能正常完成，请再发一条消息，我会继续处理。'

export type SendMessageStatus = 'sent' | 'already_sent' | 'pending' | 'unknown' | 'denied'
export interface SendMessageInput { agentId: string; callId: string; text: string; purpose?: 'progress' | 'final'; executionSource?: 'user' | 'heartbeat' | 'delivery-repair' | 'other' }
export interface SendMessageResult { id: string; status: SendMessageStatus }
export interface SendMessageToolRegistrar { register(definition: ToolDefinition): () => void }
export type SendMessage = (input: SendMessageInput) => Promise<SendMessageResult>

export function deliverySource(events: readonly { type: string; data: unknown }[]): NonNullable<SendMessageInput['executionSource']> {
  const start = events.findLastIndex(event => event.type === 'turn/start')
  for (const event of events.slice(start < 0 ? 0 : start).toReversed()) {
    if (event.type !== 'user/message') continue
    type Source = { kind?: string; plugin?: string; sections?: Array<{ name: string }> }
    const data = event.data as { source?: Source; message?: { source?: Source } }
    const source = data.source ?? data.message?.source
    if (source?.kind === 'user') return 'user'
    if (source?.plugin === 'personal-growth-dsh-host') {
      if (source.sections?.some(section => section.name === 'heartbeat')) return 'heartbeat'
      if (source.sections?.some(section => section.name === 'delivery-repair')) return 'delivery-repair'
      continue
    }
    return 'other'
  }
  return 'other'
}

export function registerSendMessageTool(registrar: SendMessageToolRegistrar, send: SendMessage): () => void {
  return registrar.register(defineTool({
    name: 'send_message',
    description: 'Send one complete message to the user bound to the current foreground conversation, then continue the task.',
    parameters: {
      text: { type: 'string', required: true, description: 'One complete user-visible message.' },
      purpose: { type: 'string', enum: ['progress', 'final'], description: 'progress for an interim update, final for the answer. Defaults to final.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          status: { type: 'string', enum: ['sent', 'already_sent', 'pending', 'unknown', 'denied'], required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `message ${value.status} (${value.id})` }],
    },
    async execute(args, exec) {
      const callId = String(exec.callId)
      const session = exec.agent?.session
      if (!session) throw new Error('send_message requires an executing Agent session')
      const purpose = args.purpose ?? 'final'
      const previousCall = session.events.findLast(event => event.type === 'personal-growth/message-sent' && event.data.callId === callId)
      if (previousCall?.type === 'personal-growth/message-sent' && (previousCall.data.text !== args.text || (previousCall.data.purpose ?? 'final') !== purpose)) throw new Error('send_message history identity conflict')
      const result = await send({ agentId: String(exec.agent?.id ?? ''), callId, text: args.text, ...(args.purpose ? { purpose: args.purpose as 'progress' | 'final' } : {}), executionSource: deliverySource(session.events) })
      if (result.status !== 'sent' && result.status !== 'already_sent') return result
      const prior = session.events.find(event => event.type === 'personal-growth/message-sent' && (event.data as { id?: string }).id === result.id) as { data: { id: string; callId: string; text: string; purpose?: 'progress' | 'final' } } | undefined
      if (prior) {
        if (prior.data.callId !== callId || prior.data.text !== args.text || (prior.data.purpose ?? 'final') !== purpose) throw new Error('send_message history identity conflict')
        return result
      }
      session.append('personal-growth/message-sent', { id: result.id, callId, text: args.text, ...(args.purpose ? { purpose: args.purpose as 'progress' | 'final' } : {}) })
      return result
    },
  }))
}
