import type { AgentTrigger } from '@personal-growth/shared';
import type { QqConfig } from './config.js';
import { AgentTriggerSchema } from '@personal-growth/shared';
import { QqDurableStateStore } from './durable.js';
import { z } from 'zod';

const TimestampSchema = z.string().datetime({ offset: true }).refine((value) => { const epoch = Date.parse(value); return Number.isFinite(epoch) && epoch >= Date.UTC(2000, 0, 1) && epoch <= Date.UTC(2100, 0, 1); }, 'timestamp is outside supported range');
const InboundSchema = z.object({ peerId: z.string().min(1).max(256), context: z.enum(['private', 'group']), groupId: z.string().max(256).optional(), messageId: z.string().min(1).max(256).refine((value) => !hasControlCharacter(value), 'messageId contains a control character'), text: z.string().min(1).max(4096), at: TimestampSchema.optional() }).strict();
export interface QqInbound { peerId: string; context: 'private' | 'group'; groupId?: string; messageId: string; text: string; at?: string; }
function hasControlCharacter(value: string): boolean { for (const character of value) { const code = character.charCodeAt(0); if (code < 32 || code === 127) return true; } return false; }
export class SingleUserQqGate {
  constructor(private readonly config: QqConfig, private readonly now: () => string = () => new Date().toISOString()) {}
  accept(event: QqInbound): AgentTrigger | null {
    const parsedEvent = InboundSchema.safeParse(event); if (!parsedEvent.success || parsedEvent.data.context !== 'private' || parsedEvent.data.peerId !== this.config.peerId || !parsedEvent.data.text.trim()) return null;
    const trigger = { type: 'user_message' as const, sessionId: `qq:${this.config.peerId}`, text: parsedEvent.data.text, at: parsedEvent.data.at ?? this.now() };
    const parsed = AgentTriggerSchema.safeParse(trigger);
    return parsed.success && TimestampSchema.safeParse(parsed.data.at).success ? parsed.data : null;
  }
  binding(): { peerId: string; context: 'private' } { return { peerId: this.config.peerId, context: 'private' }; }
  /** Explicit opt-in persistence; construction and acceptance never touch the filesystem. */
  async persistBinding(runtimeRoot: string, filePath = this.config.bindingPath): Promise<void> {
    if (!filePath) throw new Error('bindingPath is required to persist QQ binding');
    const store = await QqDurableStateStore.open(filePath, runtimeRoot);
    await store.bind(this.config.peerId);
  }
}
