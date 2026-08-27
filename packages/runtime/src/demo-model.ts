import type { AgentContext } from '@personal-growth/agent-core';
import type { AgentAction, AgentTrigger } from '@personal-growth/shared';
import type { DreamInput } from '@personal-growth/personal-memory';

/** Credential-free deterministic model used by local acceptance and tests. */
export class DemoModel {
  async generateAction(_context: AgentContext, trigger: AgentTrigger): Promise<AgentAction> {
    if (trigger.type === 'user_message') return { type: 'RESPOND', text: `已记录：${trigger.text}` };
    if (trigger.type === 'background_heartbeat') return { type: 'REFLECT', summary: 'Review recent progress and identify the next support improvement.' };
    if (trigger.type === 'foreground_heartbeat') return { type: 'MESSAGE_USER', text: '今天要不要回顾一下近期目标？', importance: 'high' };
    if (trigger.type === 'schedule') return { type: 'MESSAGE_USER', text: `日程提醒：${trigger.prompt}`, importance: 'normal' };
    return { type: 'NOOP', reason: 'demo-noop' };
  }
  async compress(events: readonly { content: string }[]): Promise<string> { return events.map((event) => event.content).join('；').slice(0, 2000); }
  async propose(input: DreamInput): Promise<unknown[]> {
    const text = input.newHistory.map((record) => JSON.stringify(record)).join(' ');
    if (/remember|explicit|long.?term|prefer|preference|习惯|偏好|长期|记住/i.test(text) && /evening|focused|study|学习|专注/i.test(text)) return [{ action: 'CREATE', path: 'contexts/evening-study.md', summary: 'Evening focused study preference', content: 'User prefers focused study in the evening.', sourceEvidence: ['conversation:summary'], importance: 'normal', frequency: 'high' }];
    return [];
  }
}
