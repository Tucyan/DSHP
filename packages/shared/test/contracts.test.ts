import { describe, expect, it } from 'vitest';
import {
  AgentActionSchema,
  AgentTriggerSchema,
  assertActionAllowedForTrigger,
  isActionAllowedForTrigger,
} from '../src/contracts.js';

describe('shared contracts', () => {
  it('validates every frozen trigger and action variant', () => {
    const at = '2026-08-26T00:00:00.000Z';
    const triggers = [
      { type: 'user_message', sessionId: 's1', text: 'hello', at },
      { type: 'foreground_heartbeat', occurrenceId: 'o1', at },
      { type: 'background_heartbeat', occurrenceId: 'o2', at },
      { type: 'schedule', scheduleId: 'sch1', prompt: 'review', at },
      { type: 'system', reason: 'startup', at },
    ] as const;
    const actions = [
      { type: 'NOOP', reason: 'nothing' },
      { type: 'RESPOND', text: 'hello' },
      { type: 'MESSAGE_USER', text: 'check in', importance: 'normal' },
      { type: 'CREATE_SKILL', name: 'focus', instructions: 'do it' },
      { type: 'PROPOSE_PLUGIN', name: 'calendar', capabilityGap: 'events', design: 'port' },
      { type: 'REFLECT', summary: 'learned' },
    ] as const;

    for (const trigger of triggers) expect(AgentTriggerSchema.safeParse(trigger).success).toBe(true);
    for (const action of actions) expect(AgentActionSchema.safeParse(action).success).toBe(true);
    expect(AgentTriggerSchema.safeParse({ type: 'nope' }).success).toBe(false);
    expect(AgentActionSchema.safeParse({ type: 'MESSAGE_USER', text: 'x', importance: 'urgent' }).success).toBe(false);
  });

  it('rejects user-visible actions structurally for background heartbeats', () => {
    const trigger = { type: 'background_heartbeat', occurrenceId: 'o1', at: 'now' } as const;
    const response = { type: 'RESPOND', text: 'not allowed' } as const;
    const message = { type: 'MESSAGE_USER', text: 'not allowed', importance: 'high' } as const;
    expect(isActionAllowedForTrigger(trigger, response)).toBe(false);
    expect(isActionAllowedForTrigger(trigger, message)).toBe(false);
    expect(() => assertActionAllowedForTrigger(trigger, response)).toThrow(/background/i);
    expect(assertActionAllowedForTrigger(trigger, { type: 'REFLECT', summary: 'ok' })).toEqual({ type: 'REFLECT', summary: 'ok' });
  });
});
