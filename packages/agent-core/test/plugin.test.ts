import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it } from 'vitest';
import { AgentCore, apply, createPersonalAgentCorePlugin } from '../src/index.js';

describe('Cordis plugin adapter', () => {
  it('provides personalAgentCore without leaking Cordis into domain service', async () => {
    const core = new AgentCore({
      contextSource: { getContext: () => ({ soul: 's', mission: 'm', trigger: { type: 'system', reason: 'test', at: 'now' } }) },
      model: { generateAction: () => ({ type: 'NOOP', reason: 'test' }) },
    });
    const context = new Context();
    await context.plugin(createPersonalAgentCorePlugin(core));
    expect((context as unknown as { personalAgentCore: { core: AgentCore } }).personalAgentCore.core).toBe(core);
    await context.fiber.dispose();
  });

  it('loads with the normal no-config plugin shape', async () => {
    const context = new Context();
    await context.plugin(apply);
    expect((context as unknown as { personalAgentCore?: unknown }).personalAgentCore).toBeDefined();
    await context.fiber.dispose();
  });
});
