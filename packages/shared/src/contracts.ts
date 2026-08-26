import { z } from 'zod';

const text = z.string().min(1);

export const AgentTriggerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('user_message'), sessionId: text, text, at: text }),
  z.object({ type: z.literal('foreground_heartbeat'), occurrenceId: text, at: text }),
  z.object({ type: z.literal('background_heartbeat'), occurrenceId: text, at: text }),
  z.object({ type: z.literal('schedule'), scheduleId: text, prompt: text, at: text }),
  z.object({ type: z.literal('system'), reason: text, at: text }),
]);

export type AgentTrigger = z.infer<typeof AgentTriggerSchema>;

export const AgentActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('NOOP'), reason: text }),
  z.object({ type: z.literal('RESPOND'), text }),
  z.object({ type: z.literal('MESSAGE_USER'), text, importance: z.enum(['low', 'normal', 'high']) }),
  z.object({ type: z.literal('CREATE_SKILL'), name: text, instructions: text }),
  z.object({ type: z.literal('PROPOSE_PLUGIN'), name: text, capabilityGap: text, design: text }),
  z.object({ type: z.literal('REFLECT'), summary: text }),
]);

export type AgentAction = z.infer<typeof AgentActionSchema>;

export const AgentTriggerActionMatrix = {
  user_message: ['RESPOND', 'NOOP', 'CREATE_SKILL', 'PROPOSE_PLUGIN'],
  foreground_heartbeat: ['MESSAGE_USER', 'NOOP', 'CREATE_SKILL', 'PROPOSE_PLUGIN', 'REFLECT'],
  background_heartbeat: ['NOOP', 'REFLECT', 'CREATE_SKILL', 'PROPOSE_PLUGIN'],
  schedule: ['MESSAGE_USER', 'NOOP', 'CREATE_SKILL', 'PROPOSE_PLUGIN', 'REFLECT'],
  system: ['MESSAGE_USER', 'NOOP', 'CREATE_SKILL', 'PROPOSE_PLUGIN', 'REFLECT'],
} as const satisfies Record<AgentTrigger['type'], readonly AgentAction['type'][]>;

/** Returns false for malformed actions and for actions outside the frozen trigger matrix. */
export function isActionAllowedForTrigger(trigger: unknown, action: unknown): action is AgentAction {
  const parsedTrigger = AgentTriggerSchema.safeParse(trigger);
  if (!parsedTrigger.success) return false;
  const parsed = AgentActionSchema.safeParse(action);
  return parsed.success && (AgentTriggerActionMatrix[parsedTrigger.data.type] as readonly AgentAction['type'][]).includes(parsed.data.type);
}

/** Validates and applies the trigger-aware action policy. */
export function assertActionAllowedForTrigger(trigger: unknown, action: unknown): AgentAction {
  const parsedTrigger = AgentTriggerSchema.safeParse(trigger);
  if (!parsedTrigger.success) throw new Error(`Invalid agent trigger: ${parsedTrigger.error.message}`);
  const parsedAction = AgentActionSchema.safeParse(action);
  if (!parsedAction.success) throw new Error(`Invalid agent action: ${parsedAction.error.message}`);
  if (!(AgentTriggerActionMatrix[parsedTrigger.data.type] as readonly AgentAction['type'][]).includes(parsedAction.data.type)) {
    throw new Error(`Action ${parsedAction.data.type} is not allowed for ${parsedTrigger.data.type}`);
  }
  return parsedAction.data;
}

export function validateActionForTrigger(trigger: unknown, action: unknown): AgentAction {
  return assertActionAllowedForTrigger(trigger, action);
}

export const assertActionAllowed = assertActionAllowedForTrigger;
