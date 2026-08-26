import { readdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { apply } from '../src/index.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

it('registers lazily without filesystem pollution when unconfigured', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'heartbeat-plugin-')); roots.push(workspace);
  const previous = process.cwd(); process.chdir(workspace);
  try {
    const context = new Context(); await context.plugin((ctx) => apply(ctx));
    expect(await readdir(workspace)).toEqual([]);
    expect((context as unknown as { personalHeartbeat?: unknown }).personalHeartbeat).toBeDefined();
    await context.fiber.dispose(); expect(await readdir(workspace)).toEqual([]);
  } finally { process.chdir(previous); }
});
