import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRuntime } from '../src/runtime.js';

describe('runtime restart recovery', () => {
  it('does not duplicate QQ binding, outbound, heartbeat occurrence, or schedule state', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pga-restart-'));
    const a = await createRuntime({ repoRoot: root, peerId: 'peer-1', now: () => '2026-08-27T10:00:00.000Z' });
    a.qq.pushInbound({ peerId: 'peer-1', context: 'private', messageId: 'm1', text: 'remember focused evening study', at: '2026-08-27T10:00:00.000Z' });
    await a.processNext();
    await a.schedule({ idempotencyKey: 'daily', sessionId: 'qq:peer-1', prompt: 'check in', kind: 'once', at: '2026-08-28T10:00:00.000Z' });
    const first = await a.runForeground('once-1', 'high');
    const b = await createRuntime({ repoRoot: root, peerId: 'peer-1', now: () => '2026-08-27T10:00:00.000Z' });
    const duplicate = await b.runForeground('once-1', 'high');
    expect(first.status).toBe('completed');
    expect(duplicate.status).toBe('duplicate');
    expect(await b.scheduleList()).toHaveLength(1);
    const memoryState = JSON.parse(await readFile(path.join(root, 'workspace', 'memory', 'state.json'), 'utf8')) as { memoryCursor?: Record<string, number> };
    expect(memoryState.memoryCursor).toBeDefined();
    expect(await b.memory.readProfile()).toContain('evening');
    const qqState = JSON.parse(await readFile(path.join(root, 'runtime', 'storage', 'qq-binding.json'), 'utf8')) as { binding?: { peerId: string }; outbound?: Record<string, { status: string }> };
    expect(qqState.binding?.peerId).toBe('peer-1');
    expect(Object.values(qqState.outbound ?? {}).some((entry) => entry.status === 'sent')).toBe(true);
  });
});
