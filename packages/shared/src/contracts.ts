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

const isBackgroundTrigger = (trigger: AgentTrigger): boolean => trigger.type === 'background_heartbeat';

const isUserVisibleAction = (action: AgentAction): boolean =>
  action.type === 'RESPOND' || action.type === 'MESSAGE_USER';

/** Returns false for malformed actions and for user-visible background actions. */
export function isActionAllowedForTrigger(trigger: unknown, action: unknown): action is AgentAction {
  const parsedTrigger = AgentTriggerSchema.safeParse(trigger);
  if (!parsedTrigger.success) return false;
  const parsed = AgentActionSchema.safeParse(action);
  return parsed.success && !(isBackgroundTrigger(parsedTrigger.data) && isUserVisibleAction(parsed.data));
}

/** Validates and applies the trigger-aware action policy. */
export function assertActionAllowedForTrigger(trigger: unknown, action: unknown): AgentAction {
  const parsedTrigger = AgentTriggerSchema.safeParse(trigger);
  if (!parsedTrigger.success) throw new Error(`Invalid agent trigger: ${parsedTrigger.error.message}`);
  const parsedAction = AgentActionSchema.safeParse(action);
  if (!parsedAction.success) throw new Error(`Invalid agent action: ${parsedAction.error.message}`);
  if (isBackgroundTrigger(parsedTrigger.data) && isUserVisibleAction(parsedAction.data)) {
    throw new Error('Background heartbeat cannot produce user-visible actions');
  }
  return parsedAction.data;
}

export function validateActionForTrigger(trigger: unknown, action: unknown): AgentAction {
  return assertActionAllowedForTrigger(trigger, action);
}

export const assertActionAllowed = assertActionAllowedForTrigger;
