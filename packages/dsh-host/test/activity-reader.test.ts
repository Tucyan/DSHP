import { describe, expect, it } from 'vitest'
import { ActivityReader } from '../src/activity-reader.js'

describe('ActivityReader', () => {
  it('aggregates today user and confirmed delivery counts deterministically', async () => {
    const asOf = '2026-09-07T13:00:00.000Z'
    const persistence = {
      async listSnapshots() { return [{ header: { id: 'session-a' } }] },
      async inspect() {
        return { revision: 'r1', events: [
          { seq: 1, type: 'user/message', time: Date.parse('2026-09-07T10:00:00Z'), data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'one' }] } },
          { seq: 2, type: 'user/message', time: Date.parse('2026-09-07T11:00:00Z'), data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'two' }] } },
          { seq: 3, type: 'user/message', time: Date.parse('2026-09-07T12:00:00Z'), data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'three' }] } },
        ] }
      },
    }
    const bridgeState = { async readOutboundRecords() { return [
      { key: 'reply-1', status: 'sent', text: 'reply', metadata: { origin: 'user_reply', purpose: 'final', sessionId: 'session-a', firstAttemptAt: '2026-09-07T10:05:00Z', confirmedAt: '2026-09-07T10:05:01Z' } },
      { key: 'heartbeat-1', status: 'sent', text: 'ping', metadata: { origin: 'heartbeat', purpose: 'final', sessionId: 'session-a', firstAttemptAt: '2026-09-07T11:05:00Z', confirmedAt: '2026-09-07T11:05:01Z' } },
      { key: 'unknown-1', status: 'unknown', text: 'uncertain', metadata: { origin: 'legacy_unknown', purpose: 'final', sessionId: 'session-a', firstAttemptAt: '2026-09-07T12:05:00Z' } },
    ] } }
    const reader = new ActivityReader({ sessionPersistence: persistence, bridgeState, histories: async () => [] })
    const result = await reader.read({ date: '2026-09-07', timeZone: 'UTC', asOf, limit: 50 })
    expect(result.counts).toMatchObject({ user: 3, sent: 2, unknown: 1 })
    expect((await reader.read({ date: '2026-09-07', timeZone: 'UTC', asOf, limit: 50 })).nextCursor).toBe(result.nextCursor)
  })
})
