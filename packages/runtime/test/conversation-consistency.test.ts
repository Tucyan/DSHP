import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRuntime } from '../src/runtime.js';
import type { ConversationEvent } from '@personal-growth/personal-memory';

describe('conversation consistency', () => {
  it('keeps concurrent multi-runtime conversation appends parseable and duplicate-free', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pga-conversation-consistency-'));
    const first = await createRuntime({ repoRoot: root, peerId: 'peer-1' }); const second = await createRuntime({ repoRoot: root, peerId: 'peer-1' });
    const appendFirst = (first as unknown as { appendConversationOnce(event: ConversationEvent): Promise<void> }).appendConversationOnce.bind(first);
    const appendSecond = (second as unknown as { appendConversationOnce(event: ConversationEvent): Promise<void> }).appendConversationOnce.bind(second);
    const events: ConversationEvent[] = [1, 2, 3, 4].map((seq) => ({ sessionId: 'qq:peer-1', seq, role: seq % 2 ? 'user' : 'assistant', content: `event-${seq}`, at: '2026-08-27T10:00:00.000Z' }));
    await Promise.all([appendFirst(events[0]), appendSecond(events[1]), appendFirst(events[2]), appendSecond(events[3])]);
    const raw = await first.queryMainConversation(); const lines = raw.trim().split(/\r?\n/).filter(Boolean); const records = lines.map((line) => JSON.parse(line) as { seq: number; role: string });
    expect(records).toHaveLength(4); expect(new Set(records.map((record) => `${record.seq}:${record.role}`)).size).toBe(4); expect(records.every((record) => Number.isInteger(record.seq))).toBe(true);
    await expect(Promise.all(Array.from({ length: 8 }, () => second.queryMainConversation().then((value) => value.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)))))).resolves.toHaveLength(8);
  });
});
