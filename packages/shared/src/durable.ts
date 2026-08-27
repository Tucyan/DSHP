import fs, { type FileHandle } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeJsonAtomic } from './storage.js';
import { z } from 'zod';

export const DEFAULT_DURABLE_LOCK_TIMEOUT_MS = 30_000;
const LOCK_GRACE_MS = 30_000;
export const DurableLockOwnerSchema = z.object({ token: z.string().uuid(), pid: z.number().int().positive(), createdAt: z.string().datetime() }).strict();
export type DurableLockOwner = z.infer<typeof DurableLockOwnerSchema>;
export interface DurableLockHooks {
  ownerWrite?: (handle: FileHandle, owner: DurableLockOwner) => Promise<void>;
  ownerClose?: (handle: FileHandle) => Promise<void>;
}

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

async function removeIfOwnerMatches(lockPath: string, token: string): Promise<boolean> {
  const tombstone = `${lockPath}.${token}.tombstone`;
  try { await fs.rename(lockPath, tombstone); }
  catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return true; throw error; }
  let owner: DurableLockOwner;
  try { owner = DurableLockOwnerSchema.parse(JSON.parse(await fs.readFile(tombstone, 'utf8'))); }
  catch {
    // Never discard a lock whose ownership cannot be proven. Restore it only
    // when the canonical name is still free.
    try { await fs.rename(tombstone, lockPath); } catch { /* leave tombstone for manual recovery */ }
    return false;
  }
  if (owner.token === token) { await fs.unlink(tombstone).catch(() => undefined); return true; }
  try { await fs.rename(tombstone, lockPath); } catch { /* leave replacement/tombstone untouched */ }
  return false;
}

type LockFileIdentity = { dev: number; ino: number };
async function cleanupCreatedLock(lockPath: string, token: string, identity?: LockFileIdentity): Promise<void> {
  if (identity) {
    try {
      const current = await fs.stat(lockPath);
      // The path may only be unlinked when it is still the file opened by this
      // acquisition. This protects a replacement owner from stale cleanup.
      if (current.dev !== identity.dev || current.ino !== identity.ino) return;
      await fs.unlink(lockPath);
      return;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return;
      // If metadata completed, the ownership-safe tombstone protocol can
      // still cleanly remove it; otherwise retain the lock for manual review.
    }
  }
  const removed = await removeIfOwnerMatches(lockPath, token);
  if (!removed) throw new Error('durable lock cleanup could not prove ownership');
}

async function withLock<T>(lockPath: string, timeoutMs: number, operation: () => Promise<T>, hooks: DurableLockHooks = {}): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  const token = crypto.randomUUID();
  while (true) {
    try {
      const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
      let handle: FileHandle;
      try { handle = await fs.open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o600); }
      catch (openError) {
        if (noFollow && openError && typeof openError === 'object' && 'code' in openError && openError.code === 'EINVAL') handle = await fs.open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
        else throw openError;
      }
      const identity = await handle.stat().then((value) => ({ dev: value.dev, ino: value.ino })).catch(() => undefined);
      const owner = { token, pid: process.pid, createdAt: new Date().toISOString() } satisfies DurableLockOwner;
      try {
        if (hooks.ownerWrite) await hooks.ownerWrite(handle, owner);
        else { await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8'); await handle.sync(); }
      } catch (ownerError) {
        let closeError: unknown;
        try { await handle.close(); } catch (error) { closeError = error; }
        let cleanupError: unknown;
        try { await cleanupCreatedLock(lockPath, token, identity); } catch (error) { cleanupError = error; }
        if (closeError || cleanupError) throw new AggregateError([ownerError, closeError, cleanupError].filter(Boolean), 'durable lock owner initialization failed');
        throw ownerError;
      }
      try { if (hooks.ownerClose) await hooks.ownerClose(handle); else await handle.close(); }
      catch (closeError) {
        await handle.close().catch(() => undefined);
        await cleanupCreatedLock(lockPath, token, identity);
        throw closeError;
      }
      break;
    }
    catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error;
      let owner: DurableLockOwner | undefined;
      const transientDeadline = Math.min(deadline, Date.now() + 250);
      while (!owner) {
        let raw: string;
        try { raw = await fs.readFile(lockPath, 'utf8'); }
        catch (ownerError) {
          if (ownerError && typeof ownerError === 'object' && 'code' in ownerError && ownerError.code === 'ENOENT') { owner = undefined; break; }
          throw new Error('durable lock owner metadata is unavailable', { cause: ownerError });
        }
        const trimmed = raw.trim();
        if ((!trimmed || (trimmed.startsWith('{') && !trimmed.endsWith('}'))) && Date.now() < transientDeadline) { await new Promise((resolve) => setTimeout(resolve, 10)); continue; }
        try { owner = DurableLockOwnerSchema.parse(JSON.parse(raw)); }
        catch (ownerError) { throw new Error('durable lock owner metadata is malformed or incomplete', { cause: ownerError }); }
      }
      if (!owner) { if (Date.now() >= deadline) throw new Error('durable lock timeout', { cause: error }); continue; }
      if (Date.now() - Date.parse(owner.createdAt) >= LOCK_GRACE_MS) {
        try { process.kill(owner.pid, 0); } catch (probe) {
          if (probe && typeof probe === 'object' && 'code' in probe && probe.code === 'ESRCH') { await removeIfOwnerMatches(lockPath, owner.token); continue; }
        }
      }
      if (Date.now() >= deadline) throw new Error('durable lock timeout', { cause: error });
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  try { return await operation(); } finally {
    await removeIfOwnerMatches(lockPath, token);
  }
}

export async function durableJsonTransaction<T, R>(statePath: string, runtimeRoot: string, schema: z.ZodType<T>, initial: T, mutate: (state: T) => Promise<R> | R, lockTimeoutMs = DEFAULT_DURABLE_LOCK_TIMEOUT_MS, hooks: DurableLockHooks = {}): Promise<{ result: R; state: T }> {
  if (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs < 30_000) throw new Error('durable lock timeout must be at least 30000ms');
  const target = path.resolve(statePath); const lockPath = `${target}.lock`; await assertSafeTarget(target, runtimeRoot); await assertSafeTarget(lockPath, runtimeRoot); await fs.mkdir(path.dirname(target), { recursive: true }); await assertSafeTarget(target, runtimeRoot); await assertSafeTarget(lockPath, runtimeRoot);
  return withLock(lockPath, lockTimeoutMs, async () => {
    await assertSafeTarget(target, runtimeRoot);
    let current: T;
    try { current = schema.parse(JSON.parse(await fs.readFile(target, 'utf8'))); }
    catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') current = schema.parse(initial); else throw error; }
    const cloned = schema.parse(JSON.parse(JSON.stringify(current)));
    const result = await mutate(cloned);
    // Mutators may have received data from a remote adapter.  Validate the
    // complete post-mutation value before it can reach disk (or the caller's
    // in-memory state).
    const finalState = schema.parse(JSON.parse(JSON.stringify(cloned)));
    await assertSafeTarget(target, runtimeRoot);
    await writeJsonAtomic(target, finalState);
    await assertSafeTarget(target, runtimeRoot);
    return { result, state: finalState };
  }, hooks);
}

export async function durableJsonRead<T>(statePath: string, runtimeRoot: string, schema: z.ZodType<T>, initial: T): Promise<T> {
  const target = path.resolve(statePath); await assertSafeTarget(target, runtimeRoot);
  try { return schema.parse(JSON.parse(await fs.readFile(target, 'utf8'))); }
  catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return schema.parse(initial); throw error; }
}
