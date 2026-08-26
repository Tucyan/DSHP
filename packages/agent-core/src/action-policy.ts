import {
  AgentActionSchema,
  AgentTriggerSchema,
  AgentTriggerActionMatrix,
  assertActionAllowedForTrigger,
  isActionAllowedForTrigger,
  type AgentAction,
} from '@personal-growth/shared';

export class PolicyViolation extends Error {
  readonly code = 'POLICY_VIOLATION';
  readonly triggerType: string;
  readonly actionType: string;

  constructor(message: string, trigger: unknown, action: unknown) {
    super(message);
    this.name = 'PolicyViolation';
    this.triggerType = safeType(trigger, new Set(Object.keys(AgentTriggerActionMatrix)));
    this.actionType = safeType(action, new Set(Object.values(AgentTriggerActionMatrix).flat()));
  }
}
export { AgentTriggerActionMatrix };

function safeType(value: unknown, allowed: ReadonlySet<string>): string {
  try {
    if (value === null || typeof value !== 'object') return 'unknown';
    const candidate = (value as { type?: unknown }).type;
    return typeof candidate === 'string' && allowed.has(candidate) ? candidate : 'unknown';
  } catch {
    return 'unknown';
  }
}

export function assertActionAllowed(trigger: unknown, action: unknown): AgentAction {
  const parsedTrigger = AgentTriggerSchema.safeParse(trigger);
  if (!parsedTrigger.success) {
    throw new PolicyViolation(`Invalid agent trigger: ${parsedTrigger.error.message}`, trigger, action);
  }
  const parsedAction = AgentActionSchema.safeParse(action);
  if (!parsedAction.success) {
    throw new PolicyViolation(`Invalid agent action: ${parsedAction.error.message}`, trigger, action);
  }
  try {
    return assertActionAllowedForTrigger(parsedTrigger.data, parsedAction.data);
  } catch (error) {
    throw new PolicyViolation(error instanceof Error ? error.message : 'Action policy rejected', trigger, action);
  }
}

export function isActionAllowed(trigger: unknown, action: unknown): action is AgentAction {
  return isActionAllowedForTrigger(trigger, action);
}

export { isActionAllowedForTrigger };
