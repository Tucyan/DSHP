import { describe, expect, it } from 'vitest'
import { normalizeVisibleMessages } from '../src/activity.js'

describe('visible conversation normalization', () => {
  it('recognizes flat and nested native user messages with their event time', () => {
    const messages = normalizeVisibleMessages([
      { seq: 1, type: 'user/message', time: Date.parse('2026-09-07T12:00:00.000Z'), data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'flat' }] } },
      { seq: 2, type: 'user/message', time: Date.parse('2026-09-07T12:01:00.000Z'), data: { message: { source: { kind: 'user' }, content: [{ type: 'text', text: 'nested' }] } } },
    ])

    expect(messages).toEqual([
      { id: 'session:1', role: 'user', text: 'flat', at: '2026-09-07T12:00:00.000Z' },
      { id: 'session:2', role: 'user', text: 'nested', at: '2026-09-07T12:01:00.000Z' },
    ])
  })

  it('projects only confirmed sent assistant text and deduplicates sent ids', () => {
    const messages = normalizeVisibleMessages([
      { seq: 1, type: 'assistant/message', time: Date.parse('2026-09-07T12:00:00.000Z'), data: { message: { content: [{ type: 'text', text: 'private narration' }] } } },
      { seq: 2, type: 'personal-growth/message-sent', time: Date.parse('2026-09-07T12:01:00.000Z'), data: { id: 'sent-1', text: 'delivered' } },
      { seq: 3, type: 'personal-growth/message-sent', time: Date.parse('2026-09-07T12:02:00.000Z'), data: { id: 'sent-1', text: 'delivered again' } },
    ])

    expect(messages).toEqual([
      { id: 'sent-1', role: 'assistant', text: 'delivered', at: '2026-09-07T12:01:00.000Z' },
    ])
  })

  it('excludes host-injected snapshots and unknown historical assistant bodies', () => {
    const messages = normalizeVisibleMessages([
      { seq: 1, type: 'user/message', time: Date.parse('2026-09-07T12:00:00.000Z'), data: { source: { kind: 'plugin', plugin: 'personal-growth-dsh-host', form: 'snapshot' }, content: [{ type: 'text', text: 'host context' }] } },
      { seq: 2, type: 'assistant/message', time: Date.parse('2026-09-07T12:01:00.000Z'), data: { message: { content: [{ type: 'text', text: 'old assistant body with unknown delivery' }] } } },
    ])

    expect(messages).toEqual([])
  })
})
