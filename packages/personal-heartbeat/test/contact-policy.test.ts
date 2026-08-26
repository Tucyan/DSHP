import { describe, expect, it } from 'vitest';
import { evaluateContactPolicy, HeartbeatConfigSchema, type ContactHistory } from '../src/index.js';

const config = HeartbeatConfigSchema.parse({ timeZone: 'America/New_York', quietHours: { start: '22:00', end: '08:00' }, cooldownMinutes: 120, maxContactsPerDay: 2 });
const history = (...ats: string[]): ContactHistory => ({ contacts: ats.map((at) => ({ occurrenceId: `o-${at}`, at, actionType: 'MESSAGE_USER' as const, importance: 'normal' as const })) });

describe('contact policy', () => {
  it('blocks quiet hours including high importance and treats start=end as no window', () => {
    expect(evaluateContactPolicy(config, history(), '2026-01-15T03:00:00Z', 'high').code).toBe('quiet_hours');
    const open = HeartbeatConfigSchema.parse({ timeZone: 'UTC', quietHours: { start: '08:00', end: '08:00' }, cooldownMinutes: 0, maxContactsPerDay: 4 });
    expect(evaluateContactPolicy(open, history(), '2026-01-15T08:00:00Z', 'normal').code).toBe('allowed');
  });

  it('handles quiet boundaries, cooldown, and local calendar cap', () => {
    expect(evaluateContactPolicy(config, history(), '2026-01-15T13:00:00Z', 'normal').code).toBe('allowed'); // 08:00 local, end boundary
    const recent = history('2026-01-15T12:00:00Z');
    expect(evaluateContactPolicy(config, recent, '2026-01-15T13:59:59Z', 'normal').code).toBe('cooldown');
    const capped = history('2026-01-15T13:00:00Z', '2026-01-15T14:00:00Z');
    expect(evaluateContactPolicy({ ...config, cooldownMinutes: 0 }, capped, '2026-01-15T20:00:00Z', 'low').code).toBe('daily_cap');
    expect(evaluateContactPolicy({ ...config, cooldownMinutes: 0 }, capped, '2026-01-16T05:00:00Z', 'low').code).toBe('quiet_hours');
  });

  it('lets high importance bypass cooldown and cap but not quiet hours', () => {
    const capped = history('2026-01-15T13:00:00Z', '2026-01-15T14:00:00Z');
    expect(evaluateContactPolicy(config, capped, '2026-01-15T14:01:00Z', 'high').code).toBe('allowed');
    expect(evaluateContactPolicy(config, history('2026-01-15T14:00:00Z'), '2026-01-15T14:01:00Z', 'high').metadata.cooldownBypassed).toBe(true);
  });

  it('uses configured timezone rather than process timezone across DST', () => {
    const ny = HeartbeatConfigSchema.parse({ timeZone: 'America/New_York', quietHours: { start: '00:00', end: '00:00' }, cooldownMinutes: 0, maxContactsPerDay: 1 });
    const atBefore = evaluateContactPolicy(ny, history('2026-03-08T06:30:00Z'), '2026-03-08T06:59:00Z', 'normal');
    expect(atBefore.code).toBe('daily_cap');
    const afterLocalDay = evaluateContactPolicy(ny, history('2026-03-08T06:30:00Z'), '2026-03-09T04:30:00Z', 'normal');
    expect(afterLocalDay.code).toBe('allowed');
  });

  it('handles the repeated fall-back hour using the configured local day/minute', () => {
    const ny = HeartbeatConfigSchema.parse({ timeZone: 'America/New_York', quietHours: { start: '01:00', end: '02:00' }, cooldownMinutes: 0, maxContactsPerDay: 4 });
    expect(evaluateContactPolicy(ny, history(), '2026-11-01T05:30:00Z', 'normal').code).toBe('quiet_hours');
    expect(evaluateContactPolicy(ny, history(), '2026-11-01T06:30:00Z', 'normal').code).toBe('quiet_hours');
    expect(evaluateContactPolicy({ ...ny, quietHours: { start: '00:00', end: '00:00' }, cooldownMinutes: 120 }, history('2026-11-01T05:30:00Z'), '2026-11-01T06:30:00Z', 'normal').code).toBe('cooldown');
  });
});
