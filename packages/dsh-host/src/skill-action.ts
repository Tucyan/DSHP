import { buildSkillDraft, type ExtensionWriter, type SkillDraftInput, type SkillResult } from '@personal-growth/runtime'

export type SkillCreationRequest = SkillDraftInput & { type?: 'CREATE_SKILL' }

/** Validate and persist either Host foreground or background skill actions. */
export async function executeSkillAction(writer: ExtensionWriter, input: SkillCreationRequest): Promise<SkillResult> {
  if (input.type !== undefined && input.type !== 'CREATE_SKILL') throw new Error('unsupported skill action')
  return writer.createSkill(buildSkillDraft(input))
}

