import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRuntime } from '../src/runtime.js';

describe('background boundary', () => {
  it('stores background records separately and never delivers them to QQ', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pga-hidden-'));
    const runtime = await createRuntime({ repoRoot: root, peerId: 'peer-1', now: () => '2026-08-27T10:00:00.000Z' });
    await runtime.runBackground('maintenance-1');
    const hidden = await readFile(path.join(root, 'runtime', 'sessions', 'background', 'maintenance-1.jsonl'), 'utf8');
    expect(hidden).toContain('REFLECT');
    expect(runtime.qq.outbox).toHaveLength(0);
    expect(await runtime.queryMainConversation()).not.toContain('maintenance-1');
  });
});
