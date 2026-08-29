import { describe, expect, it } from 'vitest'
import { buildHeartbeatConfig, parseAgentActionJson } from '../src/plugin.js'

describe('production heartbeat maintenance contracts', () => {
  it('parses only strict action JSON', () => {
    expect(parseAgentActionJson('{"type":"NOOP","reason":"quiet"}')).toEqual({ type: 'NOOP', reason: 'quiet' })
    expect(() => parseAgentActionJson('{"type":"MESSAGE_USER","text":"x"}')).toThrow()
    expect(() => parseAgentActionJson('{"type":"NOOP","reason":"quiet","extra":1}')).toThrow()
    expect(() => parseAgentActionJson('not json')).toThrow()
  })

  it('builds configurable production cadence policy with safe defaults', () => {
    expect(buildHeartbeatConfig({})).toEqual({
      timeZone: 'Asia/Singapore',
      quietHours: { start: '23:00', end: '07:00' },
      cooldownMinutes: 120,
      maxContactsPerDay: 4,
    })
    expect(buildHeartbeatConfig({ PGA_TIMEZONE: 'UTC', PGA_QUIET_START: '01:00', PGA_QUIET_END: '06:00', PGA_COOLDOWN_MINUTES: '30', PGA_MAX_CONTACTS_PER_DAY: '2' })).toMatchObject({
      timeZone: 'UTC', quietHours: { start: '01:00', end: '06:00' }, cooldownMinutes: 30, maxContactsPerDay: 2,
    })
  })
})
