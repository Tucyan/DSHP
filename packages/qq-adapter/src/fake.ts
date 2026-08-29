import type { AgentTrigger } from '@personal-growth/shared';
import type { QqConfig } from './config.js';
import { SingleUserQqGate, type QqInbound } from './gate.js';
import { validateQqOutbound, type QqOutbound, type QqPort } from './port.js';

export class FakeQqPort implements QqPort {
  private readonly gate: SingleUserQqGate;
  private readonly inbound: QqInbound[] = [];
  private readonly sent = new Set<string>();
  readonly outbox: QqOutbound[] = [];
  constructor(config: QqConfig, now?: () => string) { this.gate = new SingleUserQqGate(config, now); }
  pushInbound(event: QqInbound): void { this.inbound.push(event); }
  async receive(): Promise<AgentTrigger | null> { while (this.inbound.length) { const trigger = this.gate.accept(this.inbound.shift()!); if (trigger) return trigger; } return null; }
  async send(message: QqOutbound): Promise<boolean> { const parsed = validateQqOutbound(message); if (parsed.background) throw new Error('background QQ sends are prohibited'); if (this.sent.has(parsed.idempotencyKey)) return false; this.sent.add(parsed.idempotencyKey); this.outbox.push({ ...parsed }); return true; }
}
