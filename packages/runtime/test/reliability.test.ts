import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DemoModel } from '../src/demo-model.js';
import { createLiveRuntime, createRuntime } from '../src/runtime.js';

class ChangingModel extends DemoModel {
  calls = 0;
  async generateAction() {
    this.calls += 1;
    return { type: 'RESPOND', text: this.calls === 1 ? 'first stable reply' : 'different retry reply' };
  }
}

describe('runtime processing durability', () => {
  it('deduplicates the same QQ message across replay and restart', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pga-inbound-replay-'));
    const runtime = await createRuntime({ repoRoot: root, peerId: 'peer-1' });
    const event = { peerId: 'peer-1', context: 'private' as const, messageId: 'same-message', text: 'hello', at: '2026-08-27T10:00:00.000Z' };
    runtime.qq.pushInbound(event); runtime.qq.pushInbound(event);
    expect(await runtime.processNext()).not.toBeNull();
    expect(await runtime.processNext()).toBeNull();
    const restarted = await createRuntime({ repoRoot: root, peerId: 'peer-1' });
    restarted.qq.pushInbound(event);
    expect(await restarted.processNext()).toBeNull();
    expect((await restarted.queryMainConversation()).trim().split('\n')).toHaveLength(2);
  });

  it('replays the persisted action after a send-side crash without a second model output', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pga-action-replay-')); const model = new ChangingModel();
    const runtime = await createRuntime({ repoRoot: root, peerId: 'peer-1', model });
    const event = { peerId: 'peer-1', context: 'private' as const, messageId: 'crash-message', text: 'hello', at: '2026-08-27T10:00:00.000Z' };
    const originalSend = runtime.qq.send.bind(runtime.qq); let first = true;
    runtime.qq.send = async (message) => { const sent = await originalSend(message); if (first) { first = false; throw new Error('crash after send'); } return sent; };
    runtime.qq.pushInbound(event);
    await expect(runtime.processNext()).rejects.toThrow('crash after send');
    runtime.qq.pushInbound(event);
    await expect(runtime.processNext()).resolves.toMatchObject({ action: { text: 'first stable reply' } });
    expect(model.calls).toBe(1);
    expect(runtime.qq.outbox.filter((item) => item.text === 'first stable reply')).toHaveLength(1);
    expect(runtime.qq.outbox.filter((item) => item.text === 'different retry reply')).toHaveLength(0);
  });

  it('exposes explicit inbound pending reconciliation for recovery operators', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pga-inbound-reconcile-')); const runtime = await createRuntime({ repoRoot: root, peerId: 'peer-1' });
    const event = { peerId: 'peer-1', context: 'private' as const, messageId: 'operator-retry', text: 'hello', at: '2026-08-27T10:00:00.000Z' };
    runtime.qq.pushInbound(event); const envelope = await runtime.qq.receiveEnvelope?.(); expect(envelope?.messageId).toBe('operator-retry');
    expect(await runtime.qq.claimInbound?.('operator-retry')).toBe('claimed'); await runtime.reconcileQqInbound('operator-retry', 'retry');
    runtime.qq.pushInbound(event); expect(await runtime.processNext()).not.toBeNull();
  });
  it('renews the inbound lease through memory consolidation and delivery', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pga-inbound-lease-')); const model = new DemoModel(); let renewed = 0;
    model.compress = async (events) => { await new Promise((resolve) => setTimeout(resolve, 35)); return events.map((event) => event.content).join(';'); };
    const runtime = await createRuntime({ repoRoot: root, peerId: 'peer-1', model, leaseRenewalMs: 5 } as Parameters<typeof createRuntime>[0]);
    runtime.qq.renewInbound = async () => { renewed += 1; };
    runtime.qq.pushInbound({ peerId: 'peer-1', context: 'private', messageId: 'lease-message', text: 'hello', at: '2026-08-27T10:00:00.000Z' });
    await runtime.processNext(); expect(renewed).toBeGreaterThan(0);
  });

  it('rejects unsafe lease renewal intervals', async () => {
    for (const leaseRenewalMs of [0, 1.5, 15_001, 30_000, Number.NaN]) {
      const root = await mkdtemp(path.join(tmpdir(), 'pga-invalid-lease-'));
      await expect(createRuntime({ repoRoot: root, peerId: 'peer-1', leaseRenewalMs })).rejects.toThrow('leaseRenewalMs');
    }
  });
  it('rejects invalid inbound timestamps without creating conversation state', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pga-invalid-inbound-time-')); const runtime = await createRuntime({ repoRoot: root, peerId: 'peer-1' });
    runtime.qq.pushInbound({ peerId: 'peer-1', context: 'private', messageId: 'invalid-time', text: 'hello', at: 'not-a-date' });
    expect(await runtime.processNext()).toBeNull(); expect(await runtime.queryMainConversation()).toBe('');
  });
  it('claims legacy receive messages before processing, so two runtimes process one delivery', async () => {
    const root1 = await mkdtemp(path.join(tmpdir(), 'pga-legacy-one-')); const root2 = await mkdtemp(path.join(tmpdir(), 'pga-legacy-two-')); const event = { type: 'user_message' as const, sessionId: 'qq:peer-1', text: 'legacy message', at: '2026-08-27T10:00:00.000Z' }; let deliveries = 0; const claims = new Set<string>();
    const runtimes = await Promise.all([root1, root2].map((root) => createRuntime({ repoRoot: root, peerId: 'peer-1' })));
    for (const runtime of runtimes) { const qq = runtime.qq as typeof runtime.qq & { receiveEnvelope?: unknown }; qq.receiveEnvelope = undefined; qq.receive = async () => deliveries++ < 2 ? event : null; qq.claimInbound = async (messageId) => { if (claims.has(messageId)) return 'pending'; claims.add(messageId); return 'claimed'; }; qq.completeInbound = async () => undefined; }
    const results = await Promise.all(runtimes.map((runtime) => runtime.processNext())); expect(results.filter(Boolean)).toHaveLength(1); expect(claims.size).toBe(1);
  });
  it('keeps the runtime inbound worker alive while a full inbox waits for capacity', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pga-inbox-backpressure-runtime-')); const at = '2026-08-27T10:00:00.000Z'; const base = Date.parse(at); const started = Date.now(); const now = () => new Date(base + Date.now() - started).toISOString(); const sent: string[] = [];
    async function* stream() { yield { peerId: 'peer-1', context: 'private' as const, messageId: 'retained-stream', text: 'stream message', at }; }
    const runtime = await createLiveRuntime({ repoRoot: root, peerId: 'peer-1', now, model: new DemoModel(), goalPort: { getCurrentGoal: () => undefined }, transport: { sendPrivate: async (_peer, text) => { sent.push(text); } }, inbound: stream(), scheduleTool: { create: async () => ({ id: 'schedule-1' }), list: async () => [], delete: async () => true } });
    const inbound = Object.fromEntries(Array.from({ length: 10_000 }, (_, index) => [`pending-${index}`, { status: 'pending', owner: 'other-owner', leaseUntil: '2026-08-27T10:00:00.100Z', trigger: { type: 'user_message', sessionId: 'qq:peer-1', text: `pending-${index}`, at } }]));
    await writeFile(path.join(runtime.paths.storage, 'qq-binding.json'), JSON.stringify({ binding: { peerId: 'peer-1', context: 'private' }, outbound: {}, inbound }));
    const running = runtime.start(); const deadline = Date.now() + 4_000; while (sent.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10)); await runtime.stop(); await running;
    expect(sent).toHaveLength(2);
  });
});
