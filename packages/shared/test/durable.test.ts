import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { durableJsonTransaction } from '../src/durable.js';

const schema = z.object({ id: z.string().min(1) }).strict();

describe('durable JSON transactions', () => {
  it('validates remote-derived final state before writing and keeps memory rollback-safe', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pga-durable-final-'));
    const statePath = path.join(root, 'state.json');
    await expect(durableJsonTransaction(statePath, root, schema, { id: 'initial' }, (state) => { state.id = ''; })).rejects.toThrow();
    await expect(readFile(statePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(durableJsonTransaction(statePath, root, schema, { id: 'initial' }, (state) => { state.id = 'committed'; })).resolves.toMatchObject({ state: { id: 'committed' } });
    expect(JSON.parse(await readFile(statePath, 'utf8'))).toEqual({ id: 'committed' });
  });

  it('recovers a lock left by a clearly dead owner after the grace period', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pga-durable-stale-'));
    const statePath = path.join(root, 'state.json');
    const lockPath = `${statePath}.lock`;
    await writeFile(lockPath, JSON.stringify({ token: '00000000-0000-4000-8000-000000000001', pid: 2147483647, createdAt: '2000-01-01T00:00:00.000Z' }));
    await expect(durableJsonTransaction(statePath, root, schema, { id: 'recovered' }, (state) => state.id)).resolves.toMatchObject({ state: { id: 'recovered' } });
  });

  it('fails closed when lock ownership metadata is malformed', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pga-durable-malformed-'));
    const statePath = path.join(root, 'state.json');
    await writeFile(`${statePath}.lock`, 'not-json');
    await expect(durableJsonTransaction(statePath, root, schema, { id: 'blocked' }, (state) => state)).rejects.toThrow(/owner metadata/i);
  });

  it('cleans the exclusive lock when owner metadata writing fails', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pga-durable-owner-failure-'));
    const statePath = path.join(root, 'state.json');
    await expect(durableJsonTransaction(statePath, root, schema, { id: 'blocked' }, () => undefined, 30_000, {
      ownerWrite: async () => { throw new Error('injected owner write failure'); },
    })).rejects.toThrow(/owner write failure/i);
    await expect(readFile(`${statePath}.lock`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(durableJsonTransaction(statePath, root, schema, { id: 'recovered' }, (state) => state.id)).resolves.toMatchObject({ state: { id: 'recovered' } });
  });

  it('cleans the lock when closing the owner handle fails', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pga-durable-owner-close-'));
    const statePath = path.join(root, 'state.json');
    await expect(durableJsonTransaction(statePath, root, schema, { id: 'blocked' }, () => undefined, 30_000, {
      ownerClose: async (handle) => { await handle.close(); throw new Error('injected owner close failure'); },
    })).rejects.toThrow(/owner close failure/i);
    await expect(readFile(`${statePath}.lock`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('waits through a transient half-written owner and serializes the contender', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pga-durable-transient-owner-'));
    const statePath = path.join(root, 'state.json');
    let release!: () => void;
    const halfWritten = new Promise<void>((resolve) => { release = resolve; });
    const first = durableJsonTransaction(statePath, root, schema, { id: 'initial' }, (state) => { state.id = 'first'; }, 30_000, {
      ownerWrite: async (handle, owner) => {
        await handle.write('{', 0, 'utf8');
        await new Promise<void>((resolve) => { halfWritten.then(resolve); });
        await handle.truncate(0);
        await handle.write(`${JSON.stringify(owner)}\n`, 0, 'utf8');
        await handle.sync();
      },
    });
    // Let the first creator publish the incomplete owner before starting the contender.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = durableJsonTransaction(statePath, root, schema, { id: 'initial' }, (state) => { state.id = 'second'; });
    await new Promise((resolve) => setTimeout(resolve, 25));
    release();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(['first', 'second']).toContain(JSON.parse(await readFile(statePath, 'utf8')).id);
  });
});
