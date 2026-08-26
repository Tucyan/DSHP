import { describe, expect, it } from 'vitest';
import { AgentTrigger } from '@personal-growth/shared';
import { ContextBudgetError, ContextBuilder, ContextValidationError } from '../src/context-builder.js';

const trigger: AgentTrigger = {
  type: 'user_message',
  sessionId: 'session-1',
  text: 'Please help',
  at: '2026-08-26T00:00:00.000Z',
};

describe('ContextBuilder', () => {
  it('includes sections in a stable order, including PROFILE', () => {
    const context = new ContextBuilder({ byteBudget: 10_000 }).build({
      soul: 'I am kind.',
      mission: 'Help the user grow.',
      profile: 'The user prefers concise plans.',
      memories: ['Memory A', 'Memory B'],
      sessionDelta: 'The user is choosing a habit.',
      currentGoal: 'Exercise three times weekly.',
      trigger,
    });

    expect(context.text).toContain('PROFILE\nThe user prefers concise plans.');
    expect(context.text.indexOf('SOUL')).toBeLessThan(context.text.indexOf('MISSION'));
    expect(context.text.indexOf('MISSION')).toBeLessThan(context.text.indexOf('PROFILE'));
    const sectionOrder = ['SOUL', 'MISSION', 'PROFILE', 'MEMORY', 'SESSION_DELTA', 'GOAL', 'TRIGGER'];
    const positions = sectionOrder.map((section) => context.text.indexOf(section));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('truncates lower-priority content deterministically within a UTF-8 budget', () => {
    const input = {
      soul: '核心人格',
      mission: '帮助用户成长',
      profile: '用户档案应该被裁剪',
      memories: ['旧记忆一', '旧记忆二'],
      currentGoal: '当前目标',
      sessionDelta: '会话变化内容',
      trigger,
    };
    const builder = new ContextBuilder({ byteBudget: 150 });
    const first = builder.build(input);
    const second = builder.build(input);

    expect(Buffer.byteLength(first.text, 'utf8')).toBeLessThanOrEqual(150);
    expect(first.text).toBe(second.text);
    expect(first.text).toContain('核心人格');
    expect(first.text).toContain('帮助用户成长');
    expect(first.text).toContain('TRIGGER');
  });

  it('exposes only bounded model-facing sections, not raw source fields', () => {
    const context = new ContextBuilder({ byteBudget: 180 }).build({
      soul: 'soul',
      mission: 'mission',
      profile: 'P'.repeat(10_000),
      memories: ['M'.repeat(10_000)],
      sessionDelta: 'D'.repeat(10_000),
      currentGoal: 'G'.repeat(10_000),
      trigger,
    });

    expect(context.byteLength).toBe(Buffer.byteLength(context.text, 'utf8'));
    expect(context.byteLength).toBeLessThanOrEqual(180);
    expect((context as unknown as { profile?: string }).profile).toBeUndefined();
    expect((context as unknown as { memories?: string[] }).memories).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(context), 'utf8')).toBeLessThanOrEqual(context.byteLength + 64);
    expect(JSON.stringify(context)).not.toContain('P'.repeat(100));
    const boundedSectionBytes = [
      context.sections.soul,
      context.sections.mission,
      context.sections.profile,
      ...(context.sections.memories ?? []),
      context.sections.sessionDelta,
      context.sections.currentGoal,
    ].filter((value): value is string => value !== undefined).reduce((total, value) => total + Buffer.byteLength(value, 'utf8'), 0);
    expect(boundedSectionBytes).toBeLessThanOrEqual(context.byteLength);
  });

  it('validates required input, malformed triggers, UTF-8 cuts, exact boundaries, and minimum budgets', () => {
    expect(() => new ContextBuilder({ byteBudget: 100 }).build({ ...({ soul: '', mission: 'mission', trigger } as never) })).toThrow(ContextValidationError);
    expect(() => new ContextBuilder({ byteBudget: 100 }).build({ ...({ soul: 'soul', mission: 'mission', trigger: { type: 'invalid' } } as never) })).toThrow(ContextValidationError);
    expect(() => new ContextBuilder({ byteBudget: 1 }).build({ soul: 'soul', mission: 'mission', trigger })).toThrow(ContextBudgetError);

    const wide = new ContextBuilder({ byteBudget: 10_000 }).build({ soul: '人格', mission: '使命', profile: '档案', trigger });
    const exact = new ContextBuilder({ byteBudget: Buffer.byteLength(wide.text, 'utf8') }).build({ soul: '人格', mission: '使命', profile: '档案', trigger });
    expect(Buffer.byteLength(exact.text, 'utf8')).toBe(Buffer.byteLength(wide.text, 'utf8'));

    const cut = new ContextBuilder({ byteBudget: Buffer.byteLength(wide.text, 'utf8') - 1 }).build({ soul: '人格', mission: '使命', profile: '档案', trigger });
    expect(Buffer.byteLength(cut.text, 'utf8')).toBeLessThanOrEqual(Buffer.byteLength(wide.text, 'utf8') - 1);
    expect(cut.text).not.toContain('\uFFFD');
  });
});
