import { describe, expect, it } from 'vitest';
import { mkdtemp, access, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { QqDurableStateStore } from '../src/durable.js';
import { DurableQqPort } from '../src/durable-port.js';
import { parseQqConfig } from '../src/config.js';

const config = parseQqConfig({ peerId: 'u-1', appId: 'a', appSecretEnv: 'QQ_SECRET' });
describe('QQ durable binding and outbound ledger', () => {
  it('loads a strict fixed binding and survives restart', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pga-qq-'));
    const store = await QqDurableStateStore.open(path.join(root, 'data', 'qq-state.json'), root);
    await store.bind(config.peerId);
    const restored = await QqDurableStateStore.open(path.join(root, 'data', 'qq-state.json'), root);
    expect(restored.binding()).toEqual({ peerId: 'u-1', context: 'private' });
    await expect(QqDurableStateStore.open(path.join(root, '..', 'escape.json'), root)).rejects.toThrow(/runtime root/i);
  });
  it('does not touch the filesystem during construction', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pga-qq-'));
    const statePath = path.join(root, 'nested', 'state.json');
    new DurableQqPort(config, { sendPrivate: async () => undefined }, statePath, root);
    await expect(access(statePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('dedupes sent messages after restart and fails closed on pending ambiguity', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pga-qq-'));
    const statePath = path.join(root, 'data', 'qq-state.json');
    const transport = { sendPrivate: async () => undefined };
    const first = new DurableQqPort(config, transport, statePath, root);
    await first.ready();
    expect(await first.send({ occurrenceId: 'o1', idempotencyKey: 'k1', text: 'hi', background: false })).toBe(true);
    const second = new DurableQqPort(config, transport, statePath, root);
    await second.ready();
    expect(await second.send({ occurrenceId: 'o1', idempotencyKey: 'k1', text: 'hi', background: false })).toBe(false);
    await second.simulatePending('k2', 'o2');
    await expect(second.send({ occurrenceId: 'o2', idempotencyKey: 'k2', text: 'retry', background: false })).rejects.toThrow(/uncertain/i);
  });
  it('rejects background sends absolutely', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pga-qq-'));
    const port = new DurableQqPort(config, { sendPrivate: async () => undefined }, path.join(root, 'state.json'), root);
    await port.ready();
    await expect(port.send({ occurrenceId: 'o', idempotencyKey: 'k', text: 'hidden', background: true })).rejects.toThrow(/background/i);
  });
  it('serializes claims across independently opened stores', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pga-qq-'));
    const statePath = path.join(root, 'data', 'qq-state.json');
    const first = await QqDurableStateStore.open(statePath, root);
    const second = await QqDurableStateStore.open(statePath, root);
    const results = await Promise.allSettled([first.claim('same', 'o1'), second.claim('same', 'o2')]);
    expect(results.filter((result) => result.status === 'fulfilled' && result.value === 'claimed')).toHaveLength(1);
    await expect(first.claim('same', 'o1')).rejects.toMatchObject({ code: 'OUTBOUND_UNCERTAIN' });
  });
  it('leases inbound claims across runtimes and allows only an expired lease to recover', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pga-qq-inbound-')); const statePath = path.join(root, 'data', 'qq-state.json'); let now = '2026-08-27T10:00:00.000Z';
    const first = await QqDurableStateStore.open(statePath, root, () => now); const second = await QqDurableStateStore.open(statePath, root, () => now);
    expect(await first.claimInbound('message')).toBe('claimed'); expect(await second.claimInbound('message')).toBe('pending');
    now = '2026-08-27T10:00:31.000Z'; expect(await second.claimInbound('message')).toBe('claimed');
    await expect(first.failInbound('message')).rejects.toMatchObject({ code: 'INBOUND_STATE' });
    await second.completeInbound('message'); expect(await first.claimInbound('message')).toBe('completed');
  });
  it('keeps independent concurrent keys in one durable state', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pga-qq-'));
    const statePath = path.join(root, 'data', 'qq-state.json');
    const first = await QqDurableStateStore.open(statePath, root);
    const second = await QqDurableStateStore.open(statePath, root);
    await Promise.all([first.claim('a', 'oa'), second.claim('b', 'ob')]);
    const persisted = JSON.parse(await readFile(statePath, 'utf8')) as { outbound: Record<string, { occurrenceId: string }> };
    expect(Object.keys(persisted.outbound).sort()).toEqual(['a', 'b']);
  });
  it('gates unauthorized receive before durable initialization', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pga-qq-'));
    const statePath = path.join(root, 'nested', 'state.json');
    const port = new DurableQqPort(config, { sendPrivate: async () => undefined }, statePath, root);
    port.pushInbound({ peerId: 'other', context: 'private', text: 'no', messageId: 'm' });
    expect(await port.receive()).toBeNull();
    await expect(access(statePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('retains an uncertain outbound after transport throws post-delivery', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pga-qq-'));
    const statePath = path.join(root, 'state.json');
    const port = new DurableQqPort(config, { sendPrivate: async () => { throw new Error('delivered then throw'); } }, statePath, root);
    await expect(port.send({ occurrenceId: 'o', idempotencyKey: 'ambiguous', text: 'hi', background: false })).rejects.toThrow(/delivered/);
    const restored = new DurableQqPort(config, { sendPrivate: async () => undefined }, statePath, root);
    await expect(restored.send({ occurrenceId: 'o', idempotencyKey: 'ambiguous', text: 'retry', background: false })).rejects.toMatchObject({ code: 'OUTBOUND_UNCERTAIN' });
  });
});
