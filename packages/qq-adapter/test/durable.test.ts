import { describe, expect, it } from 'vitest';
import { mkdtemp, access, mkdir, readFile, writeFile } from 'node:fs/promises';
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
    const trigger = { type: 'user_message' as const, sessionId: 'qq:u-1', text: 'hello', at: now };
    await first.enqueueInbound('message', trigger); expect(await first.claimInbound('message')).toBe('claimed'); expect(await second.claimInbound('message')).toBe('pending');
    now = '2026-08-27T10:00:31.000Z'; expect(await second.claimInbound('message')).toBe('claimed');
    await expect(first.failInbound('message')).rejects.toMatchObject({ code: 'INBOUND_STATE' });
    await second.completeInbound('message'); expect(await first.claimInbound('message')).toBe('completed');
  });
  it('replays a queued inbound payload after restart without a new stream event', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pga-qq-inbox-')); const statePath = path.join(root, 'data', 'qq-state.json'); const now = '2026-08-27T10:00:00.000Z';
    const first = new DurableQqPort(config, { sendPrivate: async () => undefined }, statePath, root, () => now); await first.ready();
    await first.enqueueInbound('queued-message', { type: 'user_message', sessionId: 'qq:u-1', text: 'queued', at: now });
    const restored = new DurableQqPort(config, { sendPrivate: async () => undefined }, statePath, root, () => now); const envelope = await restored.receiveEnvelope();
    expect(envelope).toMatchObject({ messageId: 'queued-message', trigger: { text: 'queued' } });
  });
  it('durably enqueues accepted stream events before delivering them', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pga-qq-stream-inbox-')); const statePath = path.join(root, 'data', 'qq-state.json');
    async function* stream() { yield { peerId: 'u-1', context: 'private' as const, messageId: 'stream-message', text: 'streamed', at: '2026-08-27T10:00:00.000Z' }; }
    const port = new DurableQqPort(config, { sendPrivate: async () => undefined }, statePath, root, () => '2026-08-27T10:00:00.000Z', stream());
    expect(await port.receiveEnvelope()).toMatchObject({ messageId: 'stream-message' });
    const restored = new DurableQqPort(config, { sendPrivate: async () => undefined }, statePath, root, () => '2026-08-27T10:00:31.000Z');
    expect(await restored.receiveEnvelope()).toMatchObject({ messageId: 'stream-message' });
  });
  it('reclaims an expired pending stream event without waiting forever for new input', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pga-qq-stream-expired-')); const statePath = path.join(root, 'data', 'qq-state.json'); const now = '2026-08-27T10:00:00.000Z';
    const firstStore = await QqDurableStateStore.open(statePath, root, () => now); await firstStore.bind('u-1'); await firstStore.enqueueInbound('expired-stream', { type: 'user_message', sessionId: 'qq:u-1', text: 'recover', at: now }); await expect(firstStore.claimInbound('expired-stream')).resolves.toBe('claimed');
    const persisted = JSON.parse(await readFile(statePath, 'utf8')) as { inbound: Record<string, { leaseUntil: string }> }; persisted.inbound['expired-stream'].leaseUntil = '2026-08-27T10:00:00.040Z'; await writeFile(statePath, JSON.stringify(persisted));
    const base = Date.parse(now); const started = Date.now(); const tickingNow = () => new Date(base + Date.now() - started).toISOString(); async function* noNewEvents() { yield await new Promise<never>(() => undefined); }
    const restored = new DurableQqPort(config, { sendPrivate: async () => undefined }, statePath, root, tickingNow, noNewEvents());
    await expect(restored.receiveEnvelope()).resolves.toMatchObject({ messageId: 'expired-stream' });
  });
  it('waits for an unexpired pending lease even after the inbound stream ends', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pga-qq-stream-done-')); const statePath = path.join(root, 'data', 'qq-state.json'); const now = '2026-08-27T10:00:00.000Z';
    const firstStore = await QqDurableStateStore.open(statePath, root, () => now); await firstStore.bind('u-1'); await firstStore.enqueueInbound('done-stream', { type: 'user_message', sessionId: 'qq:u-1', text: 'recover', at: now }); await firstStore.claimInbound('done-stream');
    const persisted = JSON.parse(await readFile(statePath, 'utf8')) as { inbound: Record<string, { leaseUntil: string }> }; persisted.inbound['done-stream'].leaseUntil = '2026-08-27T10:00:01.000Z'; await writeFile(statePath, JSON.stringify(persisted));
    const base = Date.parse(now); const started = Date.now(); const tickingNow = () => new Date(base + Date.now() - started).toISOString(); async function* done() { yield* []; }
    const restored = new DurableQqPort(config, { sendPrivate: async () => undefined }, statePath, root, tickingNow, done());
    await expect(restored.receiveEnvelope()).resolves.toMatchObject({ messageId: 'done-stream' });
  });
  it('reclaims an expired pending payload without a new stream or push event', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pga-qq-queue-recovery-')); const statePath = path.join(root, 'data', 'qq-state.json'); const now = '2026-08-27T10:00:00.000Z';
    const firstStore = await QqDurableStateStore.open(statePath, root, () => now); await firstStore.bind('u-1'); await firstStore.enqueueInbound('queued-recovery', { type: 'user_message', sessionId: 'qq:u-1', text: 'recover', at: now }); await firstStore.claimInbound('queued-recovery');
    const persisted = JSON.parse(await readFile(statePath, 'utf8')) as { inbound: Record<string, { leaseUntil: string }> }; persisted.inbound['queued-recovery'].leaseUntil = '2026-08-27T10:00:00.040Z'; await writeFile(statePath, JSON.stringify(persisted));
    const base = Date.parse(now); const started = Date.now(); const tickingNow = () => new Date(base + Date.now() - started).toISOString(); const restored = new DurableQqPort(config, { sendPrivate: async () => undefined }, statePath, root, tickingNow);
    await expect(restored.receiveEnvelope()).resolves.toMatchObject({ messageId: 'queued-recovery' });
  });
  it('prunes completed outbound history before accepting new messages at the bound', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pga-qq-ledger-bound-')); const statePath = path.join(root, 'data', 'qq-state.json');
    const outbound = Object.fromEntries(Array.from({ length: 10_000 }, (_, index) => [`key-${index}`, { status: 'sent', occurrenceId: `occurrence-${index}` }]));
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify({ binding: { peerId: 'u-1', context: 'private' }, outbound, inbound: {} }));
    const port = new DurableQqPort(config, { sendPrivate: async () => undefined }, statePath, root); await port.ready();
    await expect(port.send({ occurrenceId: 'new-occurrence', idempotencyKey: 'new-key', text: 'new', background: false })).resolves.toBe(true);
    const persisted = JSON.parse(await readFile(statePath, 'utf8')) as { outbound: Record<string, unknown> }; expect(Object.keys(persisted.outbound).length).toBe(10_000);
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
  it('retains a pushed event when the durable inbox is at capacity until space is available', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pga-qq-inbox-capacity-')); const statePath = path.join(root, 'data', 'qq-state.json'); const at = '2026-08-27T10:00:00.000Z';
    const inbound = Object.fromEntries(Array.from({ length: 10_000 }, (_, index) => [`pending-${index}`, { status: 'pending', owner: 'other-owner', leaseUntil: '2026-08-27T10:30:00.000Z', trigger: { type: 'user_message', sessionId: 'qq:u-1', text: `pending-${index}`, at } }]));
    await mkdir(path.dirname(statePath), { recursive: true }); await writeFile(statePath, JSON.stringify({ binding: { peerId: 'u-1', context: 'private' }, outbound: {}, inbound }));
    const port = new DurableQqPort(config, { sendPrivate: async () => undefined }, statePath, root, () => at); const event = { peerId: 'u-1', context: 'private' as const, messageId: 'retained-push', text: 'retain me', at };
    port.pushInbound(event); await expect(port.receiveEnvelope()).resolves.toBeNull();
    const current = JSON.parse(await readFile(statePath, 'utf8')) as { inbound: Record<string, unknown> }; delete current.inbound['pending-0']; await writeFile(statePath, JSON.stringify(current));
    await expect(port.receiveEnvelope()).resolves.toMatchObject({ messageId: 'retained-push' });
  });
  it('fails closed with an actionable error for payloadless legacy inbound records', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pga-qq-legacy-inbound-')); const statePath = path.join(root, 'data', 'qq-state.json');
    await mkdir(path.dirname(statePath), { recursive: true }); await writeFile(statePath, JSON.stringify({ binding: { peerId: 'u-1', context: 'private' }, outbound: {}, inbound: { old: { status: 'pending' } } }));
    await expect(QqDurableStateStore.open(statePath, root)).rejects.toMatchObject({ code: 'INBOUND_MIGRATION' });
  });
  it('bounds outbound text and makes close idempotent', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pga-qq-outbound-bounds-')); const statePath = path.join(root, 'data', 'qq-state.json'); let returns = 0;
    const inbound: AsyncIterable<never> = { [Symbol.asyncIterator]: () => ({ next: async () => await new Promise<IteratorResult<never>>(() => undefined), return: async () => { returns += 1; return { done: true, value: undefined }; } }) };
    const port = new DurableQqPort(config, { sendPrivate: async () => undefined }, statePath, root, undefined, inbound);
    await expect(port.send({ occurrenceId: 'o', idempotencyKey: 'k', text: 'x'.repeat(4097), background: false })).rejects.toThrow(); await port.close(); await port.close(); expect(returns).toBe(1);
  });
});
