import { describe, expect, it } from 'vitest'
import { assertRequiredAgentTools, createDshAgentRegistry, resolveDefaultAgentOptions, createBackgroundAgentSetup, type DshSessionPersistence } from '../src/plugin.js'

describe('production DSH host adapter', () => {
  it('fails closed when the public agent tool surface is incomplete', () => {
    expect(() => assertRequiredAgentTools(['read', 'write', 'edit'])).toThrow(/schedule_create/)
    expect(() => assertRequiredAgentTools([
      'schedule_create', 'schedule_list', 'schedule_delete', 'get_goal', 'create_goal', 'update_goal',
      'read', 'write', 'edit', 'glob', 'grep', 'skill', 'pwsh',
    ])).not.toThrow()
  })

  it('uses persistence existence before resume/create and never converts resume errors', async () => {
    const calls: string[] = []
    const failure = new Error('resume failed')
    const persistence: DshSessionPersistence = {
      async listSnapshots() { calls.push('listSnapshots'); return [{ header: { id: 'personal-growth-foreground-test' } }] },
    }
    const ctx = {
      sessionPersistence: persistence,
      agentDefaultModel: { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) },
      agents: {
        async resume() { calls.push('resume'); throw failure },
        async create() { calls.push('create'); throw new Error('must not create') },
      },
    }
    const registry = createDshAgentRegistry(ctx as never)
    await expect(registry.resume({ sessionId: 'personal-growth-foreground-test' })).rejects.toBe(failure)
    expect(calls).toEqual(['listSnapshots', 'resume'])
  })

  it('takes provider and model from the public DSH default-model selection', () => {
    const options = resolveDefaultAgentOptions({ agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-v4-flash' }) } } as never)
    expect(options).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-flash' })
    expect(() => resolveDefaultAgentOptions({} as never)).toThrow(/default model/)
  })

  it('restricts the hidden maintenance agent at unpublished setup time', () => {
    const calls: unknown[] = []
    createBackgroundAgentSetup()({ tools: { restrict(value: unknown) { calls.push(value); return () => undefined } } } as never)
    expect(calls).toEqual([{ allow: ['skill', 'personal_skill_create', 'personal_plugin_propose'] }])
  })
})
