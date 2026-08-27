import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRuntime } from '../src/runtime.js';

describe('trace query', () => {
  it('returns bounded redacted metadata and rejects raw content', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pga-trace-'));
    const runtime = await createRuntime({ repoRoot: root, peerId: 'peer-1', now: () => '2026-08-27T10:00:00.000Z' });
    runtime.qq.pushInbound({ peerId: 'peer-1', context: 'private', messageId: 'm1', text: 'remember focused study', at: '2026-08-27T10:00:00.000Z' });
    await runtime.processNext();
    const records = await runtime.queryTrace(20);
    expect(records.length).toBeGreaterThan(0);
    expect(JSON.stringify(records)).not.toContain('remember focused study');
    await expect(runtime.queryTrace(101)).rejects.toThrow();
  });
});
