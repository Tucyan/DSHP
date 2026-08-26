import { describe, expect, it } from 'vitest';
import { AgentCore } from '../src/service.js';

const trigger = { type: 'user_message', sessionId: 's', text: 'hi', at: 'now' } as const;
const contextSource = {
  getContext: async () => ({ soul: 'soul', mission: 'mission', profile: 'profile', memories: [], sessionDelta: 'delta', trigger }),
};

function makeModel(action: unknown) {
  return { generateAction: async () => action };
}

describe('AgentCore', () => {
  it('executes NOOP without side effects and traces accepted action', async () => {
    const traces: unknown[] = [];
    const core = new AgentCore({ contextSource, model: makeModel({ type: 'NOOP', reason: 'not now' }), trace: { write: (x) => traces.push(x) } });
    await expect(core.handle(trigger)).resolves.toEqual({ type: 'NOOP', reason: 'not now' });
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ event: 'action.accepted' });
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
});
