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
  readonly trigger: unknown;
  readonly action: unknown;

  constructor(message: string, trigger: unknown, action: unknown) {
    super(message);
    this.name = 'PolicyViolation';
    this.trigger = trigger;
    this.action = action;
  }
}
export { AgentTriggerActionMatrix };

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
