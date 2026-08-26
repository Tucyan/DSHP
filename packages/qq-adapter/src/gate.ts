import type { AgentTrigger } from '@personal-growth/shared';
import type { QqConfig } from './config.js';
import { writeJsonAtomic } from '@personal-growth/shared';
import path from 'node:path';
import { AgentTriggerSchema } from '@personal-growth/shared';

export interface QqInbound { peerId: string; context: 'private' | 'group'; groupId?: string; messageId: string; text: string; at?: string; }
export class SingleUserQqGate {
  constructor(private readonly config: QqConfig, private readonly now: () => string = () => new Date().toISOString()) {}
  accept(event: QqInbound): AgentTrigger | null {
    if (event.context !== 'private' || event.peerId !== this.config.peerId || !event.text.trim()) return null;
    const trigger = { type: 'user_message' as const, sessionId: `qq:${this.config.peerId}`, text: event.text, at: event.at ?? this.now() };
    const parsed = AgentTriggerSchema.safeParse(trigger);
    return parsed.success ? parsed.data : null;
  }
  binding(): { peerId: string; context: 'private' } { return { peerId: this.config.peerId, context: 'private' }; }
  /** Explicit opt-in persistence; construction and acceptance never touch the filesystem. */
  async persistBinding(filePath = this.config.bindingPath): Promise<void> {
    if (!filePath) throw new Error('bindingPath is required to persist QQ binding');
    if (path.basename(filePath).toLowerCase() !== 'qq-binding.json' || filePath.split(/[\\/]/u).includes('..')) throw new Error('binding path must be a safe qq-binding.json path');
    await writeJsonAtomic(filePath, this.binding());
  }
}
