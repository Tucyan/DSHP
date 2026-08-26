import type { AgentTrigger } from '@personal-growth/shared';
import type { QqConfig } from './config.js';
import { SingleUserQqGate, type QqInbound } from './gate.js';
import type { QqOutbound, QqPort } from './port.js';

export class FakeQqPort implements QqPort {
  private readonly gate: SingleUserQqGate;
  private readonly inbound: QqInbound[] = [];
  private readonly sent = new Set<string>();
  readonly outbox: QqOutbound[] = [];
  constructor(config: QqConfig, now?: () => string) { this.gate = new SingleUserQqGate(config, now); }
  pushInbound(event: QqInbound): void { this.inbound.push(event); }
  async receive(): Promise<AgentTrigger | null> { while (this.inbound.length) { const trigger = this.gate.accept(this.inbound.shift()!); if (trigger) return trigger; } return null; }
  async send(message: QqOutbound): Promise<boolean> { if (message.background) throw new Error('background QQ sends are prohibited'); if (!message.idempotencyKey) throw new Error('idempotencyKey is required'); if (this.sent.has(message.idempotencyKey)) return false; this.sent.add(message.idempotencyKey); this.outbox.push({ ...message }); return true; }
}
