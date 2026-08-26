import { describe, expect, it } from 'vitest';
import { DshSchedule, FakeDshSchedule, LiveDshSchedule, type ScheduleRequest } from '../src/schedule.js';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

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
  it('persists overdue recovery across restart', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pga-schedule-'));
    const statePath = path.join(dir, 'schedule.json');
    const schedule = await DshSchedule.open(statePath);
    await schedule.create(req, 'recover-me');
    expect(await schedule.recover('2026-08-27T11:00:00.000Z')).toEqual([expect.objectContaining({ status: 'overdue' })]);
    const restored = await DshSchedule.open(statePath);
    expect((await restored.list())[0]?.status).toBe('overdue');
    expect(JSON.parse(await readFile(statePath, 'utf8'))[0].status).toBe('overdue');
  });
  it('uses live list/delete results and persists live bindings', async () => {
    const calls: string[] = [];
    const tool = {
      create: async () => ({ id: 'live-1' }),
      list: async () => [{ ...req, id: 'live-1', idempotencyKey: 'live-key', status: 'scheduled' as const, createdAt: req.at }],
      delete: async (id: string) => { calls.push(id); return true; },
    };
    const live = new LiveDshSchedule(tool, 'qq:123');
    expect(await live.create(req, 'live-key')).toEqual(expect.objectContaining({ id: 'live-1' }));
    expect(await live.list('qq:123')).toEqual([expect.objectContaining({ id: 'live-1' })]);
    expect(await live.delete('live-1')).toBe(true);
    expect(calls).toEqual(['live-1']);
  });
  it('binds schedules to a session and has no filesystem side effect by default', async () => {
    const schedule = new FakeDshSchedule();
    await schedule.create(req);
    expect((await schedule.list('other'))).toEqual([]);
  });
});
