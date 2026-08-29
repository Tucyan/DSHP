import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRuntime } from '../src/runtime.js';

describe('background boundary', () => {
  it('stores background records separately and never delivers them to QQ', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pga-hidden-'));
    const runtime = await createRuntime({ repoRoot: root, peerId: 'peer-1', now: () => '2026-08-27T10:00:00.000Z' });
    await runtime.runBackground('maintenance-1');
    const background = path.join(root, 'runtime', 'sessions', 'background'); const files = await readdir(background); expect(files.length).toBeGreaterThan(0);
    const hidden = (await Promise.all(files.map((file) => readFile(path.join(background, file), 'utf8')))).join('\n');
    expect(hidden).toContain('REFLECT');
    expect(runtime.qq.outbox).toHaveLength(0);
    expect(await runtime.queryMainConversation()).not.toContain('maintenance-1');
  });
});
