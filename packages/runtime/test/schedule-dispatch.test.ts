import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRuntime } from '../src/runtime.js';
import { DemoModel } from '../src/demo-model.js';
import type { AgentContext } from '@personal-growth/agent-core';
import type { AgentTrigger } from '@personal-growth/shared';

class FailingScheduleModel extends DemoModel {
  async generateAction(context: AgentContext, trigger: AgentTrigger) { if (trigger.type === 'schedule') throw new Error('simulated crash'); return super.generateAction(context, trigger); }
}
class ConcurrentScheduleModel extends DemoModel {
  async generateAction(context: AgentContext, trigger: AgentTrigger) { if (trigger.type === 'schedule') { await new Promise((resolve) => setTimeout(resolve, 20)); return { type: 'MESSAGE_USER', text: `scheduled:${trigger.prompt}`, importance: 'normal' as const }; } return super.generateAction(context, trigger); }
}

describe('schedule dispatch', () => {
  it('dispatches due once schedules exactly once across restart', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pga-schedule-'));
    const runtime = await createRuntime({ repoRoot: root, peerId: 'peer-1', now: () => '2026-08-27T10:00:00.000Z' });
    await runtime.schedule({ idempotencyKey: 'once', sessionId: 'qq:peer-1', prompt: 'check in', kind: 'once', at: '2026-08-27T09:00:00.000Z' });
    const first = await runtime.dispatchDue('2026-08-27T10:00:00.000Z');
    const restarted = await createRuntime({ repoRoot: root, peerId: 'peer-1', now: () => '2026-08-27T10:00:00.000Z' });
    const second = await restarted.dispatchDue('2026-08-27T10:00:00.000Z');
    expect(first).toHaveLength(1);
    expect(runtime.qq.outbox).toHaveLength(1);
    expect(second).toHaveLength(0);
    expect(restarted.qq.outbox).toHaveLength(0);
  });
  it('advances an interval schedule only after its interval and remains idempotent at the same time', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pga-interval-'));
    const runtime = await createRuntime({ repoRoot: root, peerId: 'peer-1', now: () => '2026-08-27T10:00:00.000Z' });
    await runtime.schedule({ idempotencyKey: 'interval', sessionId: 'qq:peer-1', prompt: 'interval check', kind: 'interval', at: '2026-08-27T10:00:00.000Z', everySeconds: 300 });
    expect(await runtime.dispatchDue('2026-08-27T10:00:00.000Z')).toHaveLength(1);
    expect(await runtime.dispatchDue('2026-08-27T10:02:00.000Z')).toHaveLength(0);
    expect(await runtime.dispatchDue('2026-08-27T10:05:00.000Z')).toHaveLength(1);
    expect(await runtime.dispatchDue('2026-08-27T10:05:00.000Z')).toHaveLength(0);
    expect(runtime.qq.outbox).toHaveLength(2);
  });
  it('retains a pending dispatch for retry after a core failure', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pga-schedule-retry-'));
    const failed = await createRuntime({ repoRoot: root, peerId: 'peer-1', model: new FailingScheduleModel(), now: () => '2026-08-27T10:00:00.000Z' });
    await failed.schedule({ idempotencyKey: 'retry', sessionId: 'qq:peer-1', prompt: 'retry', kind: 'once', at: '2026-08-27T09:00:00.000Z' });
    await expect(failed.dispatchDue('2026-08-27T10:00:00.000Z')).rejects.toThrow('simulated crash');
    const recovered = await (await createRuntime({ repoRoot: root, peerId: 'peer-1', now: () => '2026-08-27T10:00:00.000Z' })).dispatchDue('2026-08-27T10:00:00.000Z');
    expect(recovered).toHaveLength(1);
  });

  it('reconciles a send-success crash without sending the same occurrence twice', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pga-schedule-send-crash-'));
    const runtime = await createRuntime({ repoRoot: root, peerId: 'peer-1', now: () => '2026-08-27T10:00:00.000Z' });
    await runtime.schedule({ idempotencyKey: 'send-crash', sessionId: 'qq:peer-1', prompt: 'send once', kind: 'once', at: '2026-08-27T09:00:00.000Z' });
    const originalSend = runtime.qq.send.bind(runtime.qq); let first = true;
    runtime.qq.send = async (message) => { const sent = await originalSend(message); if (first) { first = false; throw new Error('crash after schedule send'); } return sent; };
    await expect(runtime.dispatchDue('2026-08-27T10:00:00.000Z')).rejects.toThrow('crash after schedule send');
    const restarted = await createRuntime({ repoRoot: root, peerId: 'peer-1', now: () => '2026-08-27T10:01:00.000Z' });
    expect(await restarted.dispatchDue('2026-08-27T10:01:00.000Z')).toHaveLength(1);
    expect(restarted.qq.outbox).toHaveLength(0);
  });
  it('isolates delivery effects when independent schedules run concurrently', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pga-schedule-concurrent-')); const runtime = await createRuntime({ repoRoot: root, peerId: 'peer-1', model: new ConcurrentScheduleModel(), now: () => '2026-08-27T10:00:00.000Z' });
    await runtime.schedule({ idempotencyKey: 'a', sessionId: 'qq:peer-1', prompt: 'alpha', kind: 'once', at: '2026-08-27T09:00:00.000Z' });
    await runtime.schedule({ idempotencyKey: 'b', sessionId: 'qq:peer-1', prompt: 'beta', kind: 'once', at: '2026-08-27T09:00:00.000Z' });
    const [first, second] = await Promise.all([runtime.dispatchDue('2026-08-27T10:00:00.000Z'), runtime.dispatchDue('2026-08-27T10:00:00.000Z')]);
    expect(first.length + second.length).toBe(2); expect(runtime.qq.outbox.map((item) => item.text).sort()).toEqual(['scheduled:alpha', 'scheduled:beta']);
  });
  it('claims one schedule occurrence across independently opened runtimes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pga-schedule-multi-runtime-')); const first = await createRuntime({ repoRoot: root, peerId: 'peer-1', model: new ConcurrentScheduleModel(), now: () => '2026-08-27T10:00:00.000Z' });
    await first.schedule({ idempotencyKey: 'multi', sessionId: 'qq:peer-1', prompt: 'multi', kind: 'once', at: '2026-08-27T09:00:00.000Z' });
    const second = await createRuntime({ repoRoot: root, peerId: 'peer-1', model: new ConcurrentScheduleModel(), now: () => '2026-08-27T10:00:00.000Z' });
    const [a, b] = await Promise.all([first.dispatchDue('2026-08-27T10:00:00.000Z'), second.dispatchDue('2026-08-27T10:00:00.000Z')]);
    expect(a.length + b.length).toBe(1); expect(first.qq.outbox.length + second.qq.outbox.length).toBe(1);
  });
  it('renews a schedule lease through slow delivery', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pga-schedule-lease-')); const runtime = await createRuntime({ repoRoot: root, peerId: 'peer-1', leaseRenewalMs: 5 } as Parameters<typeof createRuntime>[0]);
    await runtime.schedule({ idempotencyKey: 'lease', sessionId: 'qq:peer-1', prompt: 'lease', kind: 'once', at: '2026-08-27T09:00:00.000Z' });
    let renewed = 0; Object.defineProperty(runtime, 'renewDispatchLease', { value: async () => { renewed += 1; } }); const original = runtime.qq.send.bind(runtime.qq);
    runtime.qq.send = async (message) => { await new Promise((resolve) => setTimeout(resolve, 35)); return original(message); };
    await runtime.dispatchDue('2026-08-27T10:00:00.000Z'); expect(renewed).toBeGreaterThan(0);
  });
});
