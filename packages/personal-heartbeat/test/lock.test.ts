import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { HeartbeatLedger, LockOwnerSchema } from '../src/index.js';
import { mkdtemp } from 'node:fs/promises';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const root = async () => { const value = await mkdtemp(join(tmpdir(), 'heartbeat-lock-')); roots.push(value); return value; };

it('reclaims a provably dead stale owner', async () => {
  const workspace = await root(); const lock = join(workspace, 'data', '.heartbeat.lock');
  await mkdir(join(workspace, 'data'), { recursive: true }); await writeFile(lock, JSON.stringify({ token: '00000000-0000-4000-8000-000000000001', pid: 4242, createdAt: 0 }));
  const ledger = new HeartbeatLedger(workspace, 100, { monotonicNow: () => 60_000, isProcessAlive: () => false });
  await expect(ledger.claim('reclaim', 'background', '2026-01-01T00:00:00Z')).resolves.toMatchObject({ duplicate: false });
});

it('fails closed for malformed or live lock ownership', async () => {
  const malformed = await root(); const malformedLock = join(malformed, 'data', '.heartbeat.lock'); await mkdir(join(malformed, 'data'), { recursive: true }); await writeFile(malformedLock, 'not-json');
  await expect(new HeartbeatLedger(malformed, 10, { monotonicNow: () => 60_000, isProcessAlive: () => false }).claim('x', 'background', '2026-01-01T00:00:00Z')).rejects.toThrow(/malformed|manual/i);
  const live = await root(); const liveLock = join(live, 'data', '.heartbeat.lock'); await mkdir(join(live, 'data'), { recursive: true }); await writeFile(liveLock, JSON.stringify({ token: '00000000-0000-4000-8000-000000000002', pid: 4242, createdAt: 0 }));
  await expect(new HeartbeatLedger(live, 10, { monotonicNow: () => 60_000, isProcessAlive: () => true }).claim('x', 'background', '2026-01-01T00:00:00Z')).rejects.toThrow(/live|manual/i);
});

it('does not remove a replacement owner during original release', async () => {
  const workspace = await root(); const ledger = new HeartbeatLedger(workspace, 100);
  const replacement = { token: '00000000-0000-4000-8000-000000000003', pid: 4242, createdAt: 1 };
  await ledger.transact(async (transaction) => {
    await transaction.save();
    await rm(join(workspace, 'data', '.heartbeat.lock'));
    await writeFile(join(workspace, 'data', '.heartbeat.lock'), `${JSON.stringify(replacement)}\n`);
  });
  expect(LockOwnerSchema.parse(JSON.parse(await readFile(join(workspace, 'data', '.heartbeat.lock'), 'utf8')))).toEqual(replacement);
});

it('retries an empty creation-window owner file before failing closed', async () => {
  const workspace = await root(); const lock = join(workspace, 'data', '.heartbeat.lock'); await mkdir(join(workspace, 'data'), { recursive: true }); await writeFile(lock, '');
  let waits = 0;
  const ledger = new HeartbeatLedger(workspace, 100, { monotonicNow: (() => { const now = 0; return () => now; })(), delay: async () => { waits++; await rm(lock, { force: true }); } });
  await expect(ledger.claim('window', 'background', '2026-01-01T00:00:00Z')).resolves.toMatchObject({ duplicate: false });
  expect(waits).toBeGreaterThan(0);
});

it('rejects an invalid monotonic clock before writing owner metadata', async () => {
  const workspace = await root();
  await expect(new HeartbeatLedger(workspace, 100, { monotonicNow: () => Number.NaN }).claim('bad-clock', 'background', '2026-01-01T00:00:00Z')).rejects.toThrow(/monotonic/i);
  await expect(new HeartbeatLedger(workspace, 100, { monotonicNow: () => -1 }).claim('negative-clock', 'background', '2026-01-01T00:00:00Z')).rejects.toThrow(/monotonic/i);
});
