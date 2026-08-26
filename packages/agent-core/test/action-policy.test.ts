import { describe, expect, it } from 'vitest';
import { isActionAllowedForTrigger as isSharedActionAllowed } from '@personal-growth/shared';
import { assertActionAllowed, PolicyViolation } from '../src/action-policy.js';

const triggers = {
  user: { type: 'user_message', sessionId: 's', text: 'hi', at: 'now' } as const,
  foreground: { type: 'foreground_heartbeat', occurrenceId: 'f', at: 'now' } as const,
  background: { type: 'background_heartbeat', occurrenceId: 'b', at: 'now' } as const,
  schedule: { type: 'schedule', scheduleId: 's', prompt: 'check', at: 'now' } as const,
  system: { type: 'system', reason: 'startup', at: 'now' } as const,
};
const actions = {
  noop: { type: 'NOOP', reason: 'none' } as const,
  respond: { type: 'RESPOND', text: 'hello' } as const,
  message: { type: 'MESSAGE_USER', text: 'hello', importance: 'normal' } as const,
  skill: { type: 'CREATE_SKILL', name: 'plan', instructions: 'plan' } as const,
  plugin: { type: 'PROPOSE_PLUGIN', name: 'calendar', capabilityGap: 'events', design: 'port' } as const,
  reflect: { type: 'REFLECT', summary: 'learned' } as const,
};

describe('trigger-aware action policy', () => {
  it('matches every allowed action for every trigger', () => {
    const matrix: Record<keyof typeof triggers, readonly keyof typeof actions[]> = {
      user: ['noop', 'respond', 'skill', 'plugin'],
      foreground: ['noop', 'message', 'skill', 'plugin', 'reflect'],
      background: ['noop', 'skill', 'plugin', 'reflect'],
      schedule: ['noop', 'message', 'skill', 'plugin', 'reflect'],
      system: ['noop', 'message', 'skill', 'plugin', 'reflect'],
    };
    for (const [triggerName, allowed] of Object.entries(matrix) as [keyof typeof triggers, readonly (keyof typeof actions)[]][]) {
      for (const [actionName, action] of Object.entries(actions) as [keyof typeof actions, (typeof actions)[keyof typeof actions]][]) {
        if (allowed.includes(actionName)) expect(assertActionAllowed(triggers[triggerName], action)).toEqual(action);
        else expect(() => assertActionAllowed(triggers[triggerName], action)).toThrow(PolicyViolation);
        expect(isSharedActionAllowed(triggers[triggerName], action)).toBe(allowed.includes(actionName));
      }
    }
  });

  it('allows only the trigger matrix and returns a typed violation', () => {
    expect(assertActionAllowed(triggers.user, actions.respond)).toEqual(actions.respond);
    expect(assertActionAllowed(triggers.foreground, actions.message)).toEqual(actions.message);
    expect(assertActionAllowed(triggers.background, actions.reflect)).toEqual(actions.reflect);
    expect(assertActionAllowed(triggers.schedule, actions.message)).toEqual(actions.message);
    expect(assertActionAllowed(triggers.system, actions.reflect)).toEqual(actions.reflect);

    for (const action of [actions.respond, actions.message]) {
      try {
        assertActionAllowed(triggers.background, action);
        throw new Error('expected violation');
      } catch (error) {
        expect(error).toBeInstanceOf(PolicyViolation);
      }
    }
    expect(() => assertActionAllowed(triggers.foreground, actions.respond)).toThrow(PolicyViolation);
    expect(() => assertActionAllowed(triggers.system, actions.respond)).toThrow(PolicyViolation);
  });

  it('rejects malformed actions', () => {
    expect(() => assertActionAllowed(triggers.user, { type: 'NOOP' })).toThrow(PolicyViolation);
  });
});
