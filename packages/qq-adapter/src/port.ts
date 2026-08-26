import type { AgentTrigger } from '@personal-growth/shared';
import type { QqConfig } from './config.js';
import { SingleUserQqGate, type QqInbound } from './gate.js';

export interface QqOutbound { occurrenceId: string; idempotencyKey: string; text: string; background: boolean; }
export interface QqPort { receive(): Promise<AgentTrigger | null>; send(message: QqOutbound): Promise<boolean>; }
export interface QqTransport { sendPrivate(peerId: string, text: string): Promise<void>; }
/** Thin deployment adapter around Tencent's transport. The QQ protocol remains owned by the official bundle. */
export class TencentQqPort implements QqPort {
  private readonly gate: SingleUserQqGate;
  private readonly sent = new Set<string>();
  private readonly inFlight = new Set<string>();
  constructor(private readonly config: QqConfig, private readonly transport: QqTransport, private readonly inbound: AsyncIterable<QqInbound>, private readonly now: () => string = () => new Date().toISOString()) { this.gate = new SingleUserQqGate(config, now); }
  async receive(): Promise<AgentTrigger | null> { for await (const event of this.inbound) { const trigger = this.gate.accept(event); if (trigger) return trigger; } return null; }
  async send(message: QqOutbound): Promise<boolean> {
    if (message.background) throw new Error('background sessions cannot send QQ messages');
    if (!message.idempotencyKey) throw new Error('idempotencyKey is required');
    if (this.sent.has(message.idempotencyKey) || this.inFlight.has(message.idempotencyKey)) return false;
    this.inFlight.add(message.idempotencyKey);
    try { await this.transport.sendPrivate(this.config.peerId, message.text); this.sent.add(message.idempotencyKey); }
    finally { this.inFlight.delete(message.idempotencyKey); }
    return true;
  }
}
