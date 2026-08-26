import { describe, expect, it } from 'vitest';
import { mkdtemp, access } from 'node:fs/promises';
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
});
