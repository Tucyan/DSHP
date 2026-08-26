import { describe, expect, it } from 'vitest';
import { FakeDshSchedule, type ScheduleRequest } from '../src/schedule.js';

const req: ScheduleRequest = { sessionId: 'qq:123', prompt: 'review goals', kind: 'once', at: '2026-08-27T10:00:00.000Z' };

describe('DSH schedule adapter', () => {
  it('creates, lists, deletes and deduplicates durable bindings', async () => {
    const schedule = new FakeDshSchedule();
    const one = await schedule.create(req, 'occurrence-1');
    const again = await schedule.create(req, 'occurrence-1');
    expect(again.id).toBe(one.id);
    expect((await schedule.list('qq:123'))).toHaveLength(1);
    expect(await schedule.delete(one.id)).toBe(true);
    expect(await schedule.delete(one.id)).toBe(false);
  });
  it('supports periodic schedules only at or above DSH minimum interval', async () => {
    const schedule = new FakeDshSchedule();
    await expect(schedule.create({ ...req, kind: 'interval', everySeconds: 299 })).rejects.toThrow(/300/);
    const binding = await schedule.create({ ...req, kind: 'interval', everySeconds: 300 });
    expect(binding.everySeconds).toBe(300);
  });
  it('rejects reuse of an idempotency key for a different request', async () => {
    const schedule = new FakeDshSchedule();
    await schedule.create(req, 'same-key');
    await expect(schedule.create({ ...req, prompt: 'different' }, 'same-key')).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
  it('is restart-safe and reports overdue as a state, not a fake fire', async () => {
    const schedule = new FakeDshSchedule();
    const binding = await schedule.create(req);
    const restored = new FakeDshSchedule(schedule.snapshot());
    expect((await restored.list('qq:123'))[0]?.id).toBe(binding.id);
    expect(restored.due('2026-08-27T10:01:00.000Z')).toEqual([{ ...binding, status: 'overdue' }]);
  });
  it('binds schedules to a session and has no filesystem side effect by default', async () => {
    const schedule = new FakeDshSchedule();
    await schedule.create(req);
    expect((await schedule.list('other'))).toEqual([]);
  });
});
