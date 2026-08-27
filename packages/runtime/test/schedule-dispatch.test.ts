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
});
