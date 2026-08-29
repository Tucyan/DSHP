import type { AgentTrigger } from '@personal-growth/shared';
import type { QqConfig } from './config.js';
import { SingleUserQqGate, type QqInbound } from './gate.js';
import { z } from 'zod';

export const QqOutboundSchema = z.object({ occurrenceId: z.string().min(1).max(256), idempotencyKey: z.string().min(1).max(256), text: z.string().min(1).max(4096), background: z.boolean() }).strict();
export interface QqOutbound { occurrenceId: string; idempotencyKey: string; text: string; background: boolean; }
export function validateQqOutbound(message: QqOutbound): QqOutbound { return QqOutboundSchema.parse(message); }
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
    const parsed = validateQqOutbound(message); if (parsed.background) throw new Error('background sessions cannot send QQ messages');
    if (this.sent.has(parsed.idempotencyKey) || this.inFlight.has(parsed.idempotencyKey)) return false;
    this.inFlight.add(parsed.idempotencyKey);
    try { await this.transport.sendPrivate(this.config.peerId, parsed.text); this.sent.add(parsed.idempotencyKey); }
    finally { this.inFlight.delete(parsed.idempotencyKey); }
    return true;
  }
}
