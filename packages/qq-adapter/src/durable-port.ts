import { access } from 'node:fs/promises';
import type { AgentTrigger } from '@personal-growth/shared';
import type { QqConfig } from './config.js';
import { SingleUserQqGate, type QqInbound } from './gate.js';
import type { QqOutbound, QqPort, QqTransport } from './port.js';
import { QqDurableStateStore, type DurableInboundTrigger } from './durable.js';
export interface QqInboundEnvelope { trigger: AgentTrigger; messageId: string; }

export class DurableQqPort implements QqPort {
  private readonly gate: SingleUserQqGate;
  private store?: QqDurableStateStore;
  private init?: Promise<void>;
  private readonly inbound: QqInbound[] = [];
  private readonly inboundIterator?: AsyncIterator<QqInbound>;
  private inboundNext?: Promise<IteratorResult<QqInbound>>;
  private readonly retryWaiters = new Set<() => void>();
  private closed = false;
  constructor(private readonly config: QqConfig, private readonly transport: QqTransport, private readonly statePath: string, private readonly runtimeRoot: string, private readonly now: () => string = () => new Date().toISOString(), inboundStream?: AsyncIterable<QqInbound>) { this.gate = new SingleUserQqGate(config, now); this.inboundIterator = inboundStream?.[Symbol.asyncIterator](); }
  private async initialize(): Promise<void> { this.store = await QqDurableStateStore.open(this.statePath, this.runtimeRoot, this.now); const binding = this.store.binding(); if (binding && binding.peerId !== this.config.peerId) throw new Error('persisted QQ binding does not match configured peer'); await this.store.bind(this.config.peerId); }
  async ready(): Promise<void> { this.init ??= this.initialize(); await this.init; }
  pushInbound(event: QqInbound): void { this.inbound.push(event); }
  async receive(): Promise<AgentTrigger | null> {
    const envelope = await this.receiveEnvelope(); return envelope?.trigger ?? null;
  }
  async receiveEnvelope(): Promise<QqInboundEnvelope | null> {
    if (this.closed) return null;
    if (this.store) { const restored = await this.store.claimNextInbound(); if (restored) return restored; }
    else { try { await access(this.statePath); await this.ready(); const restored = await this.store!.claimNextInbound(); if (restored) return restored; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
    if (this.inboundIterator) { while (!this.closed) { const next = await this.nextStreamOrLease(); if (next.recovered) return next.recovered; if (next.leaseExpired) return this.store ? await this.store.claimNextInbound() : null; if (next.done) return null; const event = next.value; const trigger = this.gate.accept(event); if (trigger?.type === 'user_message') { await this.ready(); await this.store!.enqueueInbound(event.messageId, trigger); return await this.store!.claimNextInbound(); } } return null; }
    while (!this.closed) {
      while (this.inbound.length) { const event = this.inbound.shift()!; const trigger = this.gate.accept(event); if (trigger?.type === 'user_message') { await this.ready(); await this.store!.enqueueInbound(event.messageId, trigger); return await this.store!.claimNextInbound(); } }
      if (!this.store) return null;
      const waitMs = await this.store.inboundRetryAfterMs();
      if (waitMs === undefined) {
        const recovered = await this.store.claimNextInbound();
        return recovered;
      }
      await this.waitForRetry(waitMs);
      const restored = await this.store.claimNextInbound();
      if (restored) return restored;
    }
    return null;
  }
  async send(message: QqOutbound): Promise<boolean> { await this.ready(); if (message.background) throw new Error('background QQ sends are prohibited'); if (!message.idempotencyKey) throw new Error('idempotencyKey is required'); const result = await this.store!.claim(message.idempotencyKey, message.occurrenceId); if (result === 'sent') return false; await this.transport.sendPrivate(this.config.peerId, message.text); await this.store!.complete(message.idempotencyKey); return true; }
  simulatePending(key: string, occurrenceId: string): Promise<void> { return this.ready().then(() => this.store!.simulatePending(key, occurrenceId)); }
  reconcilePending(key: string, outcome: 'sent' | 'not_sent'): Promise<void> { return this.ready().then(() => this.store!.reconcile(key, outcome)); }
  claimInbound(messageId: string): Promise<'claimed' | 'completed' | 'pending'> { return this.ready().then(() => this.store!.claimInbound(messageId)); }
  enqueueInbound(messageId: string, trigger: DurableInboundTrigger): Promise<'queued' | 'pending' | 'completed'> { return this.ready().then(() => this.store!.enqueueInbound(messageId, trigger)); }
  renewInbound(messageId: string): Promise<void> { return this.ready().then(() => this.store!.renewInbound(messageId)); }
  completeInbound(messageId: string): Promise<void> { return this.ready().then(() => this.store!.completeInbound(messageId)); }
  failInbound(messageId: string): Promise<void> { return this.ready().then(() => this.store!.failInbound(messageId)); }
  private async nextStreamOrLease(): Promise<(IteratorResult<QqInbound> & { leaseExpired?: false; recovered?: undefined }) | { leaseExpired: true; recovered?: undefined } | { recovered: QqInboundEnvelope }> {
    const next = this.inboundNext ??= this.inboundIterator!.next().finally(() => { this.inboundNext = undefined; }); const waitMs = this.store ? await this.store.inboundRetryAfterMs() : undefined;
    if (waitMs === undefined) {
      const recovered = this.store ? await this.store.claimNextInbound() : null;
      if (recovered) return { recovered };
      return { ...(await next), leaseExpired: false };
    }
    let timer: ReturnType<typeof setTimeout> | undefined; const lease = new Promise<{ leaseExpired: true }>((resolve) => { timer = setTimeout(() => resolve({ leaseExpired: true }), waitMs); });
    const winner = await Promise.race([next.then((result) => ({ ...result, leaseExpired: false as const })), lease]); if (timer) clearTimeout(timer); return winner;
  }
  private async waitForRetry(waitMs: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { this.retryWaiters.delete(cancel); resolve(); }, waitMs);
      const cancel = () => { clearTimeout(timer); this.retryWaiters.delete(cancel); resolve(); };
      this.retryWaiters.add(cancel);
    });
  }
  async close(): Promise<void> { this.closed = true; for (const cancel of this.retryWaiters) cancel(); await this.inboundIterator?.return?.(); }
}
