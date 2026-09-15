import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildSkillDraft, ExtensionWriter } from '@personal-growth/runtime'
import { executeSkillAction } from '../src/skill-action.js'
import { registerPersonalGrowthTools, type DshToolRegistrar } from '../src/plugin.js'
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

describe('Host skill creation', () => {
  it('builds a bounded draft with a discoverable default trigger', () => {
    expect(buildSkillDraft({ name: 'specific-workflow', instructions: 'Do the workflow.' })).toEqual({
      name: 'specific-workflow',
      description: 'Use when the user explicitly requests the specific-workflow workflow.',
      instructions: expect.stringContaining('Input:'),
      positiveTriggers: ['specific-workflow'],
      negativeTriggers: ['unrelated request'],
    })
    const draft = buildSkillDraft({ name: 'specific-workflow', instructions: 'Do the workflow.' })
    expect(draft.instructions).toContain('Output:')
    expect(draft.instructions).toContain('Stop:')
  })

  it('preserves a valid foreground description while rejecting unsafe drafts', () => {
    const draft = buildSkillDraft({
      name: 'study-review',
      description: 'Use when the user asks for a study review.',
      instructions: 'Review the supplied study notes.',
    })
    expect(draft.description).toBe('Use when the user asks for a study review.')
    expect(() => buildSkillDraft({ name: 'study-review', description: 'Use when working on study-review.', instructions: 'Review notes.' })).toThrow(/trigger|broad/i)
  })

  it('registers a real skill through ExtensionWriter using the shared action path', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pga-host-skill-'))
    roots.push(root)
    const writer = new ExtensionWriter(path.join(root, 'agents-home'), path.join(root, 'runtime'))
    const result = await executeSkillAction(writer, { type: 'CREATE_SKILL', name: 'focus-session', instructions: 'Guide the focus session.' })
    const content = await readFile(result.path, 'utf8')
    expect(content).toContain('description: Use when the user explicitly requests the focus-session workflow.')
    expect(content).toContain('Input:')
    expect(content).toContain('Output:')
    expect(content).toContain('Stop:')
  })

  it('executes the registered foreground tool with the actual writer and preserves its description', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pga-host-skill-tool-')); roots.push(root)
    const writer = new ExtensionWriter(path.join(root, 'agents-home'), path.join(root, 'runtime'))
    const definitions: Parameters<DshToolRegistrar['register']>[0][] = []
    registerPersonalGrowthTools({ register(tool) { definitions.push(tool); return () => undefined } }, { agentsHome: path.join(root, 'agents-home'), proposals: path.join(root, 'proposals'), extensionWriter: writer })
    const result = await definitions.find(tool => tool.name === 'personal_skill_create')!.execute({ name: 'review-notes', description: 'Use when the user asks to review notes.', instructions: 'Review the supplied notes.' }, {} as never) as { accepted: boolean; path: string }
    expect(result.accepted).toBe(true)
    expect(await readFile(result.path, 'utf8')).toContain('Use when the user asks to review notes.')
  })
})
