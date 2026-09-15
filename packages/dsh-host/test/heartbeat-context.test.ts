import { describe, expect, it } from 'vitest'
import { buildHeartbeatContext, recentUserConversation } from '../src/heartbeat-context.js'

const sources = {
  identity: async () => ({ soul: 'soul', mission: 'mission' }), profile: async () => 'profile', memories: async () => ['memory'],
  recent: async () => [{ role: 'user' as const, text: 'exam tomorrow', at: '2026-09-08T00:00:00Z' }],
  goal: async () => ({ objective: 'prepare exam', phase: 'active' }), schedules: async () => [{ id: 'reminder', prompt: 'review tonight' }],
  lastContact: async () => '2026-09-07T12:00:00Z',
}
describe('production heartbeat context', () => {
  it('provides actual goal, schedules, recent conversation and contact evidence', async () => {
    const result = await buildHeartbeatContext(sources, { at: '2026-09-08T00:00:00Z', timeZone: 'Asia/Singapore', triggerId: 'one' })
    expect(result.ready).toBe(true)
    for (const text of ['prepare exam', 'review tonight', 'exam tomorrow', '2026-09-07T12:00:00Z', 'soul', 'mission']) expect(result.prompt).toContain(text)
  })
  it('distinguishes source failure from an empty goal and refuses uninformed proactive decisions', async () => {
    const failed = await buildHeartbeatContext({ ...sources, goal: async () => { throw new Error('private error') } }, { at: '', timeZone: 'UTC', triggerId: 'two' })
    expect(failed.ready).toBe(false); expect(failed.prompt).toContain('unavailable'); expect(failed.prompt).not.toContain('private error')
    const empty = await buildHeartbeatContext({ ...sources, goal: async () => null }, { at: '', timeZone: 'UTC', triggerId: 'three' })
    expect(empty.ready).toBe(true)
  })
  it('bounds Unicode context without emitting invalid JSON', async () => {
    const large = await buildHeartbeatContext({ ...sources, profile: async () => '中'.repeat(20000), memories: async () => Array(30).fill('中'.repeat(2000)) }, { at: '', timeZone: 'UTC', triggerId: 'size' })
    expect(Buffer.byteLength(large.prompt)).toBeLessThanOrEqual(12000)
    expect(() => JSON.parse(large.prompt)).not.toThrow()
    expect(large.truncated).toBe(true)
  })
  it('excludes injected snapshots and schedule prompts from real recent conversation', () => {
    const user = (kind: string, text: string) => ({ type: 'user/message', time: 1788825600000, data: { source: { kind }, content: [{ type: 'text', text }] } })
    const events = [user('user', 'real question'), user('plugin', 'internal context'), { type: 'assistant/message', time: 1788825600001, data: { message: { content: [{ type: 'text', text: 'real reply' }] } } }]
    expect(recentUserConversation(events).map(value => value.text)).toEqual(['real question', 'real reply'])
  })
})
