import { AgentActionSchema, type AgentAction } from '@personal-growth/shared';
import { z } from 'zod';

const text = z.string().min(1);

export const CapabilityGapInputSchema = z.object({
  name: text,
  gap: text,
  canUseExistingTools: z.boolean().optional(),
  expressibleAsInstructions: z.boolean().optional(),
  canExpressAsInstructions: z.boolean().optional(),
  instructions: text.optional(),
  design: text.optional(),
});

export type CapabilityGapInput = z.infer<typeof CapabilityGapInputSchema>;

/** Routes a capability gap to the smallest extension mechanism that can satisfy it. */
export function routeCapabilityGap(input: CapabilityGapInput): Extract<AgentAction, { type: 'CREATE_SKILL' | 'PROPOSE_PLUGIN' }> {
  const parsed = CapabilityGapInputSchema.parse(input);
  const canCreateSkill = parsed.canUseExistingTools === true
    || parsed.expressibleAsInstructions === true
    || parsed.canExpressAsInstructions === true;
  if (canCreateSkill && parsed.instructions) {
    return AgentActionSchema.parse({
      type: 'CREATE_SKILL',
      name: parsed.name,
      instructions: parsed.instructions,
    }) as Extract<AgentAction, { type: 'CREATE_SKILL' }>;
  }
  if (!parsed.design) {
    throw new z.ZodError([{ code: 'custom', path: ['design'], message: 'Plugin design is required' }]);
  }
  return AgentActionSchema.parse({
    type: 'PROPOSE_PLUGIN',
    name: parsed.name,
    capabilityGap: parsed.gap,
    design: parsed.design,
  }) as Extract<AgentAction, { type: 'PROPOSE_PLUGIN' }>;
}
