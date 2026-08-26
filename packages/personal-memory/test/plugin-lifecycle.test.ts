import { readdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { MemoryService, apply } from '../src/index.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

it('registers a no-config plugin without creating workspace files', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'personal-memory-plugin-'));
  roots.push(workspace);
  const previous = process.cwd();
  process.chdir(workspace);
  try {
    const context = new Context();
    await context.plugin((ctx) => apply(ctx));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(await readdir(workspace)).toEqual([]);
    await context.fiber.dispose();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(await readdir(workspace)).toEqual([]);
  } finally {
    process.chdir(previous);
  }
});

it('keeps injected memory available without replacing it', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'personal-memory-plugin-'));
  roots.push(workspace);
  const injected = new MemoryService({ workspace });
  const context = new Context();
  await context.plugin((ctx) => apply(ctx, { memory: injected }));
  expect((context as unknown as { personalMemory: { memory: MemoryService } }).personalMemory.memory).toBe(injected);
  await context.fiber.dispose();
});

it('does not start a workspace until the first memory operation', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'personal-memory-plugin-'));
  roots.push(workspace);
  const service = new MemoryService({ workspace });
  expect(await readdir(workspace)).toEqual([]);
  await service.readProfile();
  expect(await readdir(workspace)).toContain('memory');
});
