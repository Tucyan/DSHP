import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bootstrapRuntime } from '../src/bootstrap.js';

describe('runtime bootstrap', () => {
  it('creates isolated runtime directories and preserves human-edited identity files', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pga-runtime-'));
    const first = await bootstrapRuntime({ repoRoot: root });
    expect(await stat(first.paths.dshHome)).toBeTruthy();
    await readFile(path.join(root, 'workspace', 'SOUL.md'), 'utf8');
    await readFile(path.join(root, 'workspace', 'AGENT.md'), 'utf8');
    const soul = path.join(root, 'workspace', 'SOUL.md');
    const edited = '# human edit\n';
    await (await import('node:fs/promises')).writeFile(soul, edited);
    await bootstrapRuntime({ repoRoot: root });
    expect(await readFile(soul, 'utf8')).toBe(edited);
    expect(first.paths.workspace).toContain(path.join(root, 'workspace'));
  });
});
