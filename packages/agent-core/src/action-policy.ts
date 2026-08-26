import {
  AgentActionSchema,
  AgentTriggerSchema,
  type AgentAction,
  type AgentTrigger,
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

const allowedByTrigger: Record<AgentTrigger['type'], readonly AgentAction['type'][]> = {
  user_message: ['RESPOND', 'NOOP', 'CREATE_SKILL', 'PROPOSE_PLUGIN'],
  foreground_heartbeat: ['MESSAGE_USER', 'NOOP', 'CREATE_SKILL', 'PROPOSE_PLUGIN', 'REFLECT'],
  background_heartbeat: ['NOOP', 'REFLECT', 'CREATE_SKILL', 'PROPOSE_PLUGIN'],
  schedule: ['MESSAGE_USER', 'NOOP', 'CREATE_SKILL', 'PROPOSE_PLUGIN', 'REFLECT'],
  system: ['MESSAGE_USER', 'NOOP', 'CREATE_SKILL', 'PROPOSE_PLUGIN', 'REFLECT'],
};

export function assertActionAllowed(trigger: unknown, action: unknown): AgentAction {
  const parsedTrigger = AgentTriggerSchema.safeParse(trigger);
  if (!parsedTrigger.success) {
    throw new PolicyViolation(`Invalid agent trigger: ${parsedTrigger.error.message}`, trigger, action);
  }
  const parsedAction = AgentActionSchema.safeParse(action);
  if (!parsedAction.success) {
    throw new PolicyViolation(`Invalid agent action: ${parsedAction.error.message}`, trigger, action);
  }
  const allowed = allowedByTrigger[parsedTrigger.data.type];
  if (!allowed.includes(parsedAction.data.type)) {
    throw new PolicyViolation(
      `Action ${parsedAction.data.type} is not allowed for ${parsedTrigger.data.type}`,
      trigger,
      action,
    );
  }
  return parsedAction.data;
}

export function isActionAllowed(trigger: unknown, action: unknown): action is AgentAction {
  try {
    assertActionAllowed(trigger, action);
    return true;
  } catch {
    return false;
  }
}

