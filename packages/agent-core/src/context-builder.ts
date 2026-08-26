import { AgentTriggerSchema, type AgentTrigger } from '@personal-growth/shared';
import { z } from 'zod';

export interface ContextBuildInput {
  soul: string;
  mission: string;
  profile?: string;
  memories?: readonly string[];
  sessionDelta?: string;
  currentGoal?: string;
  trigger: AgentTrigger;
}

export interface BoundedContextSections {
  readonly soul: string;
  readonly mission: string;
  readonly profile?: string;
  readonly memories?: readonly string[];
  readonly sessionDelta?: string;
  readonly currentGoal?: string;
}

export interface AgentContext {
  text: string;
  byteLength: number;
  readonly trigger: AgentTrigger;
  readonly sections: BoundedContextSections;
}

export interface ContextBuilderOptions {
  byteBudget: number;
}

interface Section {
  name: string;
  value: string;
  required: boolean;
  priority: number;
}

export class ContextValidationError extends Error {
  readonly code = 'CONTEXT_VALIDATION_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'ContextValidationError';
  }
}

export class ContextBudgetError extends Error {
  readonly code = 'CONTEXT_BUDGET_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'ContextBudgetError';
  }
}

const ContextBuildInputSchema = z.object({
  soul: z.string().min(1),
  mission: z.string().min(1),
  profile: z.string().optional(),
  memories: z.array(z.string()).optional(),
  sessionDelta: z.string().optional(),
  currentGoal: z.string().optional(),
  trigger: AgentTriggerSchema,
});

const byteLength = (value: string): number => Buffer.byteLength(value, 'utf8');

const firstCodePoint = (value: string): string => value.codePointAt(0) === undefined ? '' : String.fromCodePoint(value.codePointAt(0)!);

/** Returns the longest prefix that is valid UTF-8 and fits in the byte budget. */
function prefixByBytes(value: string, budget: number): string {
  if (budget <= 0) return '';
  let result = '';
  let used = 0;
  for (const character of value) {
    const size = byteLength(character);
    if (used + size > budget) break;
    result += character;
    used += size;
  }
  return result;
}

function render(sections: readonly Section[]): string {
  return sections
    .filter((section) => section.value.length > 0)
    .map((section) => `${section.name}\n${section.value}`)
    .join('\n\n');
}

function triggerText(trigger: AgentTrigger): string {
  switch (trigger.type) {
    case 'user_message':
      return `type=${trigger.type}\nsessionId=${trigger.sessionId}\ntext=${trigger.text}\nat=${trigger.at}`;
    case 'foreground_heartbeat':
    case 'background_heartbeat':
      return `type=${trigger.type}\noccurrenceId=${trigger.occurrenceId}\nat=${trigger.at}`;
    case 'schedule':
      return `type=${trigger.type}\nscheduleId=${trigger.scheduleId}\nprompt=${trigger.prompt}\nat=${trigger.at}`;
    case 'system':
      return `type=${trigger.type}\nreason=${trigger.reason}\nat=${trigger.at}`;
  }
}

export class ContextBuilder {
  private readonly byteBudget: number;

  constructor(options: ContextBuilderOptions) {
    if (!Number.isInteger(options.byteBudget) || options.byteBudget <= 0) {
      throw new ContextBudgetError('Context byte budget must be a positive integer');
    }
    this.byteBudget = options.byteBudget;
  }

  build(input: ContextBuildInput): AgentContext {
    const validated = ContextBuildInputSchema.safeParse(input);
    if (!validated.success) {
      throw new ContextValidationError(validated.error.message);
    }
    const source = validated.data;
    const sections: Section[] = [
      { name: 'SOUL', value: source.soul, required: true, priority: 100 },
      { name: 'MISSION', value: source.mission, required: true, priority: 90 },
      { name: 'PROFILE', value: source.profile ?? '', required: false, priority: 70 },
      { name: 'MEMORY', value: (source.memories ?? []).join('\n'), required: false, priority: 50 },
      { name: 'SESSION_DELTA', value: source.sessionDelta ?? '', required: false, priority: 40 },
      { name: 'GOAL', value: source.currentGoal ?? '', required: false, priority: 60 },
      { name: 'TRIGGER', value: triggerText(source.trigger), required: true, priority: 110 },
    ];

    const minimum = render(sections.map((section) => ({
      ...section,
      value: section.required ? firstCodePoint(section.value) : '',
    })));
    if (byteLength(minimum) > this.byteBudget) {
      throw new ContextBudgetError('Context byte budget is too small for required sections');
    }

    // Lowest priority sections are reduced first. A section may disappear entirely;
    // required sections retain at least one Unicode code point.
    for (const section of [...sections].sort((a, b) => a.priority - b.priority)) {
      const current = render(sections);
      const excess = byteLength(current) - this.byteBudget;
      if (excess <= 0) break;
      const floor = section.required ? firstCodePoint(section.value) : '';
      const available = byteLength(section.value) - byteLength(floor);
      section.value = prefixByBytes(section.value, Math.max(0, available - excess)) || floor;
    }

    const text = render(sections);
    if (byteLength(text) > this.byteBudget) {
      throw new ContextBudgetError('Unable to satisfy context byte budget');
    }
    const getSection = (name: string): string => sections.find((section) => section.name === name)?.value ?? '';
    const boundedSections: BoundedContextSections = {
      soul: getSection('SOUL'),
      mission: getSection('MISSION'),
      profile: getSection('PROFILE') || undefined,
      memories: getSection('MEMORY') ? getSection('MEMORY').split('\n') : undefined,
      sessionDelta: getSection('SESSION_DELTA') || undefined,
      currentGoal: getSection('GOAL') || undefined,
    };
    const context = { text, byteLength: byteLength(text) } as AgentContext;
    Object.defineProperties(context, {
      trigger: { value: source.trigger, enumerable: false, writable: false },
      sections: { value: boundedSections, enumerable: false, writable: false },
    });
    return context;
  }
}

export function buildContext(input: ContextBuildInput, options: ContextBuilderOptions): AgentContext {
  return new ContextBuilder(options).build(input);
}
