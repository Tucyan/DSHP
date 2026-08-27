import type { AgentTrigger } from '@personal-growth/shared';
import type { QqConfig } from './config.js';
import { AgentTriggerSchema } from '@personal-growth/shared';
import { QqDurableStateStore } from './durable.js';

export interface QqInbound { peerId: string; context: 'private' | 'group'; groupId?: string; messageId: string; text: string; at?: string; }
export class SingleUserQqGate {
  constructor(private readonly config: QqConfig, private readonly now: () => string = () => new Date().toISOString()) {}
  accept(event: QqInbound): AgentTrigger | null {
    if (event.context !== 'private' || event.peerId !== this.config.peerId || !event.text.trim() || typeof event.messageId !== 'string' || !event.messageId || event.messageId.length > 256 || /[\u0000-\u001f\u007f]/u.test(event.messageId)) return null;
    const trigger = { type: 'user_message' as const, sessionId: `qq:${this.config.peerId}`, text: event.text, at: event.at ?? this.now() };
    const parsed = AgentTriggerSchema.safeParse(trigger);
    return parsed.success ? parsed.data : null;
  }
  binding(): { peerId: string; context: 'private' } { return { peerId: this.config.peerId, context: 'private' }; }
  /** Explicit opt-in persistence; construction and acceptance never touch the filesystem. */
  async persistBinding(runtimeRoot: string, filePath = this.config.bindingPath): Promise<void> {
    if (!filePath) throw new Error('bindingPath is required to persist QQ binding');
    const store = await QqDurableStateStore.open(filePath, runtimeRoot);
    await store.bind(this.config.peerId);
  }
}
