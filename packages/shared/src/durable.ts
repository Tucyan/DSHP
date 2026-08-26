import fs from 'node:fs/promises';
import path from 'node:path';
import { writeJsonAtomic } from './storage.js';
import { z } from 'zod';

export const DEFAULT_DURABLE_LOCK_TIMEOUT_MS = 30_000;

async function nearestRealPath(value: string): Promise<string> {
  let current = value;
  while (true) {
    try { return await fs.realpath(current); }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT' && path.dirname(current) !== current) { current = path.dirname(current); continue; }
      throw error;
    }
  }
}

async function assertSafeTarget(filePath: string, runtimeRoot: string): Promise<void> {
  const root = path.resolve(runtimeRoot); const target = path.resolve(filePath); const relative = path.relative(root, target);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error('durable path must stay inside runtime root');
  const realRoot = await nearestRealPath(root); const realParent = await nearestRealPath(path.dirname(target));
  const parentRelative = path.relative(realRoot, realParent);
  if (parentRelative.startsWith(`..${path.sep}`) || parentRelative === '..' || path.isAbsolute(parentRelative)) throw new Error('durable path resolves outside runtime root');
  try {
    const stat = await fs.lstat(target); if (stat.isSymbolicLink()) throw new Error('durable target must not be a symlink');
    const realTarget = await fs.realpath(target); const targetRelative = path.relative(realRoot, realTarget);
    if (targetRelative.startsWith(`..${path.sep}`) || targetRelative === '..' || path.isAbsolute(targetRelative)) throw new Error('durable path resolves outside runtime root');
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error;
  }
}

async function withLock<T>(lockPath: string, timeoutMs: number, operation: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try { await fs.mkdir(lockPath); break; }
    catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST' || Date.now() >= deadline) throw new Error('durable lock timeout', { cause: error });
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  try { return await operation(); } finally { await fs.rm(lockPath, { recursive: true, force: true }); }
}

export async function durableJsonTransaction<T, R>(statePath: string, runtimeRoot: string, schema: z.ZodType<T>, initial: T, mutate: (state: T) => Promise<R> | R, lockTimeoutMs = DEFAULT_DURABLE_LOCK_TIMEOUT_MS): Promise<{ result: R; state: T }> {
  if (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs < 30_000) throw new Error('durable lock timeout must be at least 30000ms');
  const target = path.resolve(statePath); await assertSafeTarget(target, runtimeRoot); await fs.mkdir(path.dirname(target), { recursive: true }); await assertSafeTarget(target, runtimeRoot);
  return withLock(`${target}.lock`, lockTimeoutMs, async () => {
    await assertSafeTarget(target, runtimeRoot);
    let current: T;
    try { current = schema.parse(JSON.parse(await fs.readFile(target, 'utf8'))); }
    catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') current = schema.parse(initial); else throw error; }
    const cloned = schema.parse(JSON.parse(JSON.stringify(current)));
    const result = await mutate(cloned);
    await assertSafeTarget(target, runtimeRoot);
    await writeJsonAtomic(target, cloned);
    await assertSafeTarget(target, runtimeRoot);
    return { result, state: cloned };
  });
}

export async function durableJsonRead<T>(statePath: string, runtimeRoot: string, schema: z.ZodType<T>, initial: T): Promise<T> {
  const target = path.resolve(statePath); await assertSafeTarget(target, runtimeRoot);
  try { return schema.parse(JSON.parse(await fs.readFile(target, 'utf8'))); }
  catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return schema.parse(initial); throw error; }
}
