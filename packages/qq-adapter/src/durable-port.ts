import type { AgentTrigger } from '@personal-growth/shared';
import type { QqConfig } from './config.js';
import { SingleUserQqGate, type QqInbound } from './gate.js';
import type { QqOutbound, QqPort, QqTransport } from './port.js';
import { QqDurableStateStore } from './durable.js';
export interface QqInboundEnvelope { trigger: AgentTrigger; messageId: string; }

export class DurableQqPort implements QqPort {
  private readonly gate: SingleUserQqGate;
  private store?: QqDurableStateStore;
  private init?: Promise<void>;
  private readonly inbound: QqInbound[] = [];
  private readonly inboundIterator?: AsyncIterator<QqInbound>;
  private closed = false;
  constructor(private readonly config: QqConfig, private readonly transport: QqTransport, private readonly statePath: string, private readonly runtimeRoot: string, private readonly now: () => string = () => new Date().toISOString(), inboundStream?: AsyncIterable<QqInbound>) { this.gate = new SingleUserQqGate(config, now); this.inboundIterator = inboundStream?.[Symbol.asyncIterator](); }
  private async initialize(): Promise<void> { this.store = await QqDurableStateStore.open(this.statePath, this.runtimeRoot); const binding = this.store.binding(); if (binding && binding.peerId !== this.config.peerId) throw new Error('persisted QQ binding does not match configured peer'); await this.store.bind(this.config.peerId); }
  async ready(): Promise<void> { this.init ??= this.initialize(); await this.init; }
  pushInbound(event: QqInbound): void { this.inbound.push(event); }
  async receive(): Promise<AgentTrigger | null> {
    const envelope = await this.receiveEnvelope(); return envelope?.trigger ?? null;
  }
  async receiveEnvelope(): Promise<QqInboundEnvelope | null> {
    if (this.closed) return null;
    if (this.inboundIterator) { while (!this.closed) { const next = await this.inboundIterator.next(); if (next.done) return null; const event = next.value; const trigger = this.gate.accept(event); if (trigger) { await this.ready(); return { trigger, messageId: event.messageId }; } } return null; }
    while (this.inbound.length) { const event = this.inbound.shift()!; const trigger = this.gate.accept(event); if (trigger) { await this.ready(); return { trigger, messageId: event.messageId }; } }
    return null;
  }
  async send(message: QqOutbound): Promise<boolean> { await this.ready(); if (message.background) throw new Error('background QQ sends are prohibited'); if (!message.idempotencyKey) throw new Error('idempotencyKey is required'); const result = await this.store!.claim(message.idempotencyKey, message.occurrenceId); if (result === 'sent') return false; await this.transport.sendPrivate(this.config.peerId, message.text); await this.store!.complete(message.idempotencyKey); return true; }
  simulatePending(key: string, occurrenceId: string): Promise<void> { return this.ready().then(() => this.store!.simulatePending(key, occurrenceId)); }
  reconcilePending(key: string, outcome: 'sent' | 'not_sent'): Promise<void> { return this.ready().then(() => this.store!.reconcile(key, outcome)); }
  claimInbound(messageId: string): Promise<'claimed' | 'completed' | 'pending'> { return this.ready().then(() => this.store!.claimInbound(messageId)); }
  renewInbound(messageId: string): Promise<void> { return this.ready().then(() => this.store!.renewInbound(messageId)); }
  completeInbound(messageId: string): Promise<void> { return this.ready().then(() => this.store!.completeInbound(messageId)); }
  failInbound(messageId: string): Promise<void> { return this.ready().then(() => this.store!.failInbound(messageId)); }
  async close(): Promise<void> { this.closed = true; await this.inboundIterator?.return?.(); }
}
