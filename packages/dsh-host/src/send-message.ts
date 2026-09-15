import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'personal-growth/message-sent': { id: string; callId: string; text: string }
  }
}

export const MESSAGE_DELIVERY_PROMPT = 'Use send_message(text) for every user-visible progress update, stage conclusion, and final reply. Each call sends one complete message. After a progress send, continue the task and use other tools as needed. Send only meaningful updates; avoid frequent chatter. Before ending a user task, send the final reply with send_message. Ordinary assistant text is not delivered automatically.'

export type SendMessageStatus = 'sent' | 'already_sent' | 'pending' | 'unknown'
export interface SendMessageInput { agentId: string; callId: string; text: string }
export interface SendMessageResult { id: string; status: SendMessageStatus }
export interface SendMessageToolRegistrar { register(definition: ToolDefinition): () => void }
export type SendMessage = (input: SendMessageInput) => Promise<SendMessageResult>

export function registerSendMessageTool(registrar: SendMessageToolRegistrar, send: SendMessage): () => void {
  return registrar.register(defineTool({
    name: 'send_message',
    description: 'Send one complete message to the user bound to the current foreground conversation, then continue the task.',
    parameters: {
      text: { type: 'string', required: true, description: 'One complete user-visible message.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          status: { type: 'string', enum: ['sent', 'already_sent', 'pending', 'unknown'], required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `message ${value.status} (${value.id})` }],
    },
    async execute(args, exec) {
      const callId = String(exec.callId)
      const result = await send({ agentId: String(exec.agent?.id ?? ''), callId, text: args.text })
      if (result.status !== 'sent' && result.status !== 'already_sent') return result
      const session = exec.agent?.session
      if (!session) throw new Error('send_message requires an executing Agent session')
      const prior = session.events.find(event => event.type === 'personal-growth/message-sent' && (event.data as { id?: string }).id === result.id) as { data: { id: string; callId: string; text: string } } | undefined
      if (prior) {
        if (prior.data.callId !== callId || prior.data.text !== args.text) throw new Error('send_message history identity conflict')
        return result
      }
      session.append('personal-growth/message-sent', { id: result.id, callId, text: args.text })
      return result
    },
  }))
}
