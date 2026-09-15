import { describe, expect, it } from 'vitest'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { registerSendMessageTool, type SendMessageInput, type SendMessageResult } from '../src/send-message.js'
import type { DshToolRegistrar } from '../src/plugin.js'

function captureTool(send: (input: SendMessageInput) => Promise<SendMessageResult>): ToolDefinition {
  const definitions: ToolDefinition[] = []
  const registrar: DshToolRegistrar = { register(tool) { definitions.push(tool); return () => undefined } }
  registerSendMessageTool(registrar, send)
  return definitions[0]!
}

describe('send_message tool', () => {
  it('exposes text as its only model-controlled argument', () => {
    const tool = captureTool(async () => ({ id: 'message-id', status: 'sent' }))
    expect(tool.name).toBe('send_message')
    expect(tool.parameters).toEqual({
      type: 'object',
      properties: { text: { type: 'string', description: 'One complete user-visible message.' } },
      required: ['text'],
    })
  })

  it('binds delivery to the executing Agent and stable tool call id', async () => {
    const calls: SendMessageInput[] = []
    const tool = captureTool(async input => { calls.push(input); return { id: 'message-id', status: 'sent' } })
    const session = Session.create(SessionId('foreground'))
    let concluded = false
    const result = await tool.execute({ text: '阶段结果' }, { agent: { id: session.id, session }, callId: 'call-1', concludeTurn() { concluded = true } } as never)
    expect(calls).toEqual([{ agentId: 'foreground', callId: 'call-1', text: '阶段结果' }])
    expect(result).toEqual({ id: 'message-id', status: 'sent' })
    expect(concluded).toBe(false)
  })

  it('appends one durable sent-message event after confirmed delivery without duplicating it on retry', async () => {
    const statuses: SendMessageResult['status'][] = ['sent', 'already_sent']
    const tool = captureTool(async () => ({ id: 'stable-message-id', status: statuses.shift()! }))
    const session = Session.create(SessionId('foreground'))
    const exec = { agent: { id: session.id, session }, callId: 'call-1' } as never
    await tool.execute({ text: '已发送' }, exec)
    await tool.execute({ text: '已发送' }, exec)
    const sent = session.events.filter(event => event.type === 'personal-growth/message-sent')
    expect(sent).toHaveLength(1)
    expect(sent[0]?.data).toEqual({ id: 'stable-message-id', callId: 'call-1', text: '已发送' })
  })

  it.each(['pending', 'unknown'] as const)('preserves a %s delivery result without recording an unconfirmed message', async status => {
    const tool = captureTool(async () => ({ id: 'uncertain-message-id', status }))
    const session = Session.create(SessionId('foreground'))
    const result = await tool.execute({ text: '结果尚未确认' }, { agent: { id: session.id, session }, callId: 'call-uncertain' } as never)
    expect(result).toEqual({ id: 'uncertain-message-id', status })
    expect(session.events.some(event => event.type === 'personal-growth/message-sent')).toBe(false)
  })
})
