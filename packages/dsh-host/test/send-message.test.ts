import { describe, expect, it } from 'vitest'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { Session, SessionId, KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import { deliverySource, registerSendMessageTool, type SendMessageInput, type SendMessageResult } from '../src/send-message.js'
import type { DshToolRegistrar } from '../src/plugin.js'
import { PersistenceCoordinator, SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'

function captureTool(send: (input: SendMessageInput) => Promise<SendMessageResult>): ToolDefinition {
  const definitions: ToolDefinition[] = []
  const registrar: DshToolRegistrar = { register(tool) { definitions.push(tool); return () => undefined } }
  registerSendMessageTool(registrar, send)
  return definitions[0]!
}

describe('send_message tool', () => {
  it('cold-loads legacy confirmed deliveries and still rejects unrelated unknown events', async () => {
    const session = Session.create(SessionId('cold-delivery'))
    const tool = captureTool(async () => ({ id: 'confirmed', status: 'sent' }))
    await tool.execute({ text: 'delivered' }, { agent: { id: session.id, session }, callId: 'call' } as never)
    const saved = { meta: session.header, events: session.events, revision: SessionPersistenceRevision('saved') }
    const coordinator = new PersistenceCoordinator({ on() {}, effect() {}, sessions: { get() {}, list() { return [] } } } as never, {
      name: 'test-store', async loadStored() { return structuredClone(saved) }, async readStoredRevision() { return saved.revision },
    } as never)
    const loaded = await coordinator.readFrom(session.id, 0)
    expect(loaded.events).toEqual(session.events)
    const unknown = new PersistenceCoordinator({ on() {}, effect() {}, sessions: { get() {}, list() { return [] } } } as never, {
      name: 'test-store', async loadStored() { const data = structuredClone(saved); data.events = data.events.map(event => ({ ...event, type: 'unrecognized-plugin/event' })) as never; return data },
    } as never)
    await expect(unknown.readFrom(session.id, 0)).rejects.toThrow(/unknown to this harness/)
  })
  it('registers only the Host delivery event with the persistence vocabulary', () => {
    expect(KNOWN_SESSION_EVENT_TYPES.has('personal-growth/message-sent')).toBe(true)
    expect(KNOWN_SESSION_EVENT_TYPES.has('unrecognized-plugin/event')).toBe(false)
  })
  it('classifies the current turn and never borrows an earlier user source', () => {
    const user = { type: 'user/message', data: { source: { kind: 'user' } } }
    const start = { type: 'turn/start', data: { turn: 2 } }
    expect(deliverySource([user, start, { type: 'user/message', data: { source: { kind: 'plugin', plugin: 'dsh-schedule' } } }])).toBe('other')
    expect(deliverySource([start, user])).toBe('user')
    expect(deliverySource([start, { type: 'user/message', data: { message: user.data } }])).toBe('user')
    for (const name of ['heartbeat', 'delivery-repair'] as const) expect(deliverySource([start, { type: 'user/message', data: { message: { source: { kind: 'plugin', plugin: 'personal-growth-dsh-host', sections: [{ name }] } } } }])).toBe(name)
    for (const source of ['heartbeat', 'delivery-repair'] as const) expect(deliverySource([start, { type: 'user/message', data: { source: { kind: 'plugin', plugin: 'personal-growth-dsh-host', sections: [{ name: source }] } } }])).toBe(source)
  })
  it('rejects changing the purpose of a previously confirmed call before dispatch', async () => {
    let calls = 0
    const tool = captureTool(async () => { calls++; return { id: 'stable', status: calls === 1 ? 'sent' : 'already_sent' } })
    const session = Session.create(SessionId('foreground'))
    const exec = { agent: { id: session.id, session }, callId: 'call-progress' } as never
    await tool.execute({ text: 'working', purpose: 'progress' }, exec)
    await expect(tool.execute({ text: 'working', purpose: 'final' }, exec)).rejects.toThrow(/identity conflict/)
    expect(calls).toBe(1)
  })
  it('exposes message text and purpose without destination controls', () => {
    const tool = captureTool(async () => ({ id: 'message-id', status: 'sent' }))
    expect(tool.name).toBe('send_message')
    expect(tool.parameters).toEqual({
      type: 'object',
      properties: { text: { type: 'string', description: 'One complete user-visible message.' }, purpose: { type: 'string', enum: ['progress', 'final'], description: 'progress for an interim update, final for the answer. Defaults to final.' } },
      required: ['text'],
    })
  })

  it('binds delivery to the executing Agent and stable tool call id', async () => {
    const calls: SendMessageInput[] = []
    const tool = captureTool(async input => { calls.push(input); return { id: 'message-id', status: 'sent' } })
    const session = Session.create(SessionId('foreground'))
    let concluded = false
    const result = await tool.execute({ text: '阶段结果' }, { agent: { id: session.id, session }, callId: 'call-1', concludeTurn() { concluded = true } } as never)
    expect(calls).toEqual([{ agentId: 'foreground', callId: 'call-1', text: '阶段结果', executionSource: 'other' }])
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
