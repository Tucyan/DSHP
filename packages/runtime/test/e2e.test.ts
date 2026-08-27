import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRuntime } from '../src/runtime.js';

describe('local runtime loop', () => {
  it('accepts QQ input, persists memory, hides background work, and sends proactive QQ', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pga-e2e-'));
    const runtime = await createRuntime({ repoRoot: root, peerId: 'peer-1', now: () => '2026-08-27T10:00:00.000Z' });
    runtime.qq.pushInbound({ peerId: 'peer-1', context: 'private', messageId: 'm1', text: 'Remember that I prefer focused evening study.', at: '2026-08-27T10:00:00.000Z' });
    expect(await runtime.processNext()).toMatchObject({ trigger: { type: 'user_message' }, action: { type: 'RESPOND' } });
    expect(runtime.qq.outbox).toHaveLength(1);
    await runtime.runBackground('bg-1');
    expect(await runtime.queryMainConversation()).not.toContain('bg-1');
    const proactive = await runtime.runForeground('fg-1', 'high');
    expect(proactive.action?.type).toBe('MESSAGE_USER');
    expect(runtime.qq.outbox.length).toBe(2);
    expect(await runtime.memory.read('contexts/evening-study.md')).toBeTruthy();
    expect(await runtime.memory.readProfile()).toContain('evening');
    const state = JSON.parse(await readFile(runtime.memory.paths.state, 'utf8')) as { memoryCursor?: Record<string, number> };
    expect(state.memoryCursor?.['qq:peer-1']).toBe(2);
    const revisions = await (await import('@personal-growth/shared')).readJsonl(runtime.memory.paths.revisions, (await import('@personal-growth/personal-memory')).RevisionSchema);
    expect(revisions.records.length).toBeGreaterThan(0);
    runtime.qq.pushInbound({ peerId: 'peer-1', context: 'private', messageId: 'm2', text: 'I still prefer focused evening study.', at: '2026-08-27T10:01:00.000Z' });
    await runtime.processNext();
    const history = await (await import('@personal-growth/shared')).readJsonl(runtime.memory.paths.history, (await import('@personal-growth/personal-memory')).HistoryRecordSchema);
    expect(history.errors).toHaveLength(0);
    expect(history.records.at(-1)?.sourceRefs).toEqual(['qq:peer-1:3', 'qq:peer-1:4']);
    expect(await runtime.memory.readIndex()).toContain('evening-study');
  });
});
