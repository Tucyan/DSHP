import { describe, expect, it } from 'vitest';
import { AgentCore } from '../src/service.js';
import { PolicyViolation, assertActionAllowed } from '../src/action-policy.js';

const trigger = { type: 'user_message', sessionId: 's', text: 'hi', at: 'now' } as const;
const contextSource = {
  getContext: async () => ({ soul: 'soul', mission: 'mission', profile: 'profile', memories: [], sessionDelta: 'delta', trigger }),
};

function makeModel(action: unknown) {
  return { generateAction: async () => action };
}

describe('AgentCore', () => {
  it('rejects an invalid trigger before any context or model port runs', async () => {
    let contextCalls = 0;
    let modelCalls = 0;
    const traces: unknown[] = [];
    const core = new AgentCore({
      contextSource: { getContext: async () => { contextCalls += 1; return { soul: 'soul', mission: 'mission', trigger }; } },
      model: { generateAction: async () => { modelCalls += 1; return { type: 'NOOP', reason: 'none' }; } },
      trace: { write: (record) => traces.push(record) },
    });
    await expect(core.handle({ type: 'invalid' } as never)).rejects.toThrow();
    expect(contextCalls).toBe(0);
    expect(modelCalls).toBe(0);
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ event: 'action.rejected', data: { reasonCode: 'invalid_trigger' } });
  });

  it('executes NOOP without side effects and traces accepted action', async () => {
    const traces: unknown[] = [];
    const core = new AgentCore({ contextSource, model: makeModel({ type: 'NOOP', reason: 'not now' }), trace: { write: (x) => traces.push(x) } });
    await expect(core.handle(trigger)).resolves.toEqual({ type: 'NOOP', reason: 'not now' });
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ event: 'action.accepted' });
    expect(traces[0]).toMatchObject({ data: { actionType: 'NOOP' } });
    expect(traces[0]).not.toHaveProperty('data.action');
  });

  it('keeps accepted traces to safe action metadata', async () => {
    const traces: unknown[] = [];
    const core = new AgentCore({
      contextSource,
      model: makeModel({ type: 'RESPOND', text: 'Authorization: Bearer top-secret' }),
      trace: { write: (record) => traces.push(record) },
      response: { deliver: async () => undefined },
    });
    await core.handle(trigger);
    const serialized = JSON.stringify(traces[0]);
    expect(traces[0]).toMatchObject({ event: 'action.accepted', data: { actionType: 'RESPOND' } });
    expect(traces[0]).not.toHaveProperty('data.action');
    expect(serialized).not.toContain('Authorization');
    expect(serialized).not.toContain('top-secret');
  });

  it('stores only safe trigger/action type metadata on PolicyViolation', () => {
    let error: unknown;
    try {
      assertActionAllowed({ type: 'user_message', sessionId: 's', text: 'hi', at: 'now' }, { type: 'MESSAGE_USER', text: 'ok', importance: 'normal' });
      throw new Error('expected policy violation');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PolicyViolation);
    expect(error).toMatchObject({ triggerType: 'user_message', actionType: 'MESSAGE_USER' });
    expect(error).not.toHaveProperty('trigger');
    expect(error).not.toHaveProperty('action');
  });

  it('delivers a response through the response port', async () => {
    const delivered: string[] = [];
    const core = new AgentCore({ contextSource, model: makeModel({ type: 'RESPOND', text: 'hello' }), response: { deliver: async (text) => delivered.push(text) } });
    await core.handle(trigger);
    expect(delivered).toEqual(['hello']);
  });

  it('routes proactive, skill, plugin, and reflection effects', async () => {
    const messages: unknown[] = [];
    const skills: unknown[] = [];
    const plugins: unknown[] = [];
    const reflections: unknown[] = [];
    const make = (action: unknown) => new AgentCore({
      contextSource,
      model: makeModel(action),
      userMessage: { deliver: async (message) => messages.push(message) },
      skillWriter: { write: async (skill) => skills.push(skill) },
      pluginWriter: { write: async (plugin) => plugins.push(plugin) },
      reflection: { write: async (reflection) => reflections.push(reflection) },
    });
    await make({ type: 'MESSAGE_USER', text: 'check in', importance: 'high' }).handle({ type: 'foreground_heartbeat', occurrenceId: 'f', at: 'now' });
    await make({ type: 'CREATE_SKILL', name: 'focus', instructions: 'focus' }).handle(trigger);
    await make({ type: 'PROPOSE_PLUGIN', name: 'calendar', capabilityGap: 'events', design: 'port' }).handle(trigger);
    await make({ type: 'REFLECT', summary: 'learned' }).handle({ type: 'background_heartbeat', occurrenceId: 'b', at: 'now' });
    expect(messages).toEqual([{ text: 'check in', importance: 'high' }]);
    expect(skills).toEqual([{ name: 'focus', instructions: 'focus' }]);
    expect(plugins).toEqual([{ name: 'calendar', capabilityGap: 'events', design: 'port' }]);
    expect(reflections).toEqual([{ summary: 'learned' }]);
  });

  it('traces invalid model actions and policy rejections without side effects', async () => {
    const traces: unknown[] = [];
    const delivered: string[] = [];
    const invalid = new AgentCore({ contextSource, model: makeModel({ type: 'BOGUS' }), trace: { write: (x) => traces.push(x) }, response: { deliver: async (text) => delivered.push(text) } });
    await expect(invalid.handle(trigger)).rejects.toThrow();
    expect(delivered).toEqual([]);
    expect(traces[0]).toMatchObject({ event: 'action.rejected' });

    traces.length = 0;
    const forbidden = new AgentCore({ contextSource, model: makeModel({ type: 'RESPOND', text: 'hidden' }), trace: { write: (x) => traces.push(x) }, response: { deliver: async (text) => delivered.push(text) } });
    await expect(forbidden.handle({ type: 'background_heartbeat', occurrenceId: 'b', at: 'now' })).rejects.toThrow();
    expect(delivered).toEqual([]);
    expect(traces[0]).toMatchObject({ event: 'action.rejected' });
  });

  it('traces only safe summaries for cyclic invalid model output', async () => {
    const traces: unknown[] = [];
    const cyclic: Record<string, unknown> = { type: 'BOGUS', password: 'must-not-leak' };
    cyclic.self = cyclic;
    const core = new AgentCore({ contextSource, model: makeModel(cyclic), trace: { write: (record) => traces.push(record) } });
    await expect(core.handle(trigger)).rejects.toThrow();
    expect(traces).toHaveLength(1);
    expect(() => JSON.stringify(traces[0])).not.toThrow();
    expect(traces[0]).toMatchObject({ data: { rawType: 'object', reasonCode: 'invalid_action' } });
    expect(JSON.stringify(traces[0])).not.toContain('must-not-leak');
    expect(JSON.stringify(traces[0])).not.toContain('password');
  });

  it('executes exactly one matching effect for each representative accepted action', async () => {
    const cases = [
      [trigger, { type: 'RESPOND', text: 'reply' }, 'response'],
      [{ type: 'foreground_heartbeat', occurrenceId: 'f', at: 'now' }, { type: 'MESSAGE_USER', text: 'check in', importance: 'normal' }, 'userMessage'],
      [trigger, { type: 'CREATE_SKILL', name: 'focus', instructions: 'focus' }, 'skill'],
      [trigger, { type: 'PROPOSE_PLUGIN', name: 'calendar', capabilityGap: 'events', design: 'port' }, 'plugin'],
      [{ type: 'background_heartbeat', occurrenceId: 'b', at: 'now' }, { type: 'REFLECT', summary: 'learned' }, 'reflection'],
      [trigger, { type: 'NOOP', reason: 'none' }, 'noop'],
    ] as const;
    for (const [caseTrigger, action, expected] of cases) {
      const effects = { response: 0, userMessage: 0, skill: 0, plugin: 0, reflection: 0, noop: 0 };
      const core = new AgentCore({
        contextSource,
        model: makeModel(action),
        response: { deliver: async () => { effects.response += 1; } },
        userMessage: { deliver: async () => { effects.userMessage += 1; } },
        skillWriter: { write: async () => { effects.skill += 1; } },
        pluginWriter: { write: async () => { effects.plugin += 1; } },
        reflection: { write: async () => { effects.reflection += 1; } },
      });
      await core.handle(caseTrigger);
      if (expected === 'noop') {
        expect(Object.values(effects).every((count) => count === 0)).toBe(true);
      } else {
        expect(Object.values(effects).filter((count) => count > 0)).toEqual([1]);
        expect(effects[expected]).toBe(1);
      }
    }
  });
});
