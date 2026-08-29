import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DemoModel } from '../src/demo-model.js';
import { createRuntime } from '../src/runtime.js';
import type { AgentContext } from '@personal-growth/agent-core';
import type { AgentTrigger } from '@personal-growth/shared';

class InspectingModel extends DemoModel {
  context?: AgentContext;
  async generateAction(context: AgentContext, trigger: AgentTrigger) { this.context = context; return super.generateAction(context, trigger); }
}

describe('runtime context composition', () => {
  it('supplies profile, text-relevant memory, recent session delta, and injected goal', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pga-context-')); const model = new InspectingModel();
    const runtime = await createRuntime({ repoRoot: root, peerId: 'peer-1', model, goalPort: { getCurrentGoal: () => 'finish the current study milestone' }, now: () => '2026-08-27T10:00:00.000Z' });
    await runtime.memory.rememberExplicit({ path: 'preferences/study.md', summary: 'Study preference', content: 'Focused evening study', importance: 'high', frequency: 'high' });
    runtime.qq.pushInbound({ peerId: 'peer-1', context: 'private', messageId: 'm1', text: 'study', at: '2026-08-27T10:00:00.000Z' });
    const result = await runtime.processNext();
    expect(result).toMatchObject({ action: { type: 'RESPOND' } });
    expect(model.context).toBeDefined();
    expect(model.context?.sections.profile).toContain('Study preference');
    expect(model.context?.sections.memories?.join('\n')).toContain('Focused evening study');
    expect(model.context?.sections.sessionDelta).toContain('study');
    expect(model.context?.sections.currentGoal).toContain('study milestone');
  });
  it('uses a bounded fixed retrieval for heartbeat context instead of an empty query', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pga-heartbeat-context-')); const model = new InspectingModel();
    const runtime = await createRuntime({ repoRoot: root, peerId: 'peer-1', model, now: () => '2026-08-27T10:00:00.000Z' });
    await runtime.memory.rememberExplicit({ path: 'contexts/current-priority.md', summary: 'Current priority', content: 'Long-term growth priority is finishing the study milestone.', importance: 'high', frequency: 'high' });
    await runtime.runBackground('background-context');
    expect(model.context?.sections.memories?.join('\n')).toContain('Current priority');
  });
});
