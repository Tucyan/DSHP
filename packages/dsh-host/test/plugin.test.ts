import { describe, expect, it } from 'vitest'
import { apply, assertRequiredAgentTools, createDshAgentRegistry, normalizeHostPaths, resolveDefaultAgentOptions, createBackgroundAgentSetup, createReadOnlyHiddenAgentSetup, type DshSessionPersistence } from '../src/plugin.js'
import { join, resolve } from 'node:path'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

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

  it('disposes an agent when capabilities are unavailable after synchronous creation', async () => {
    let disposed = 0
    let assertions = 0
    const ctx = {
      sessionPersistence: { async listSnapshots() { return [{ header: { id: 'capability-test' } }] } },
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
      agents: {
        async resume() { return { agent: { id: 'capability-test', ctx: { tools: { schemas: () => [] } } }, async dispose() { disposed++ } } },
        async create() { throw new Error('must not create') },
      },
    }
    const registry = createDshAgentRegistry(ctx as never, undefined, () => { assertions++; assertRequiredAgentTools([]) })
    await expect(registry.resume({ sessionId: 'capability-test' })).rejects.toThrow(/schedule_create/)
    expect(disposed).toBe(1)
    expect(assertions).toBe(1)
  })

  it('restricts the hidden maintenance agent at unpublished setup time', () => {
    const calls: unknown[] = []
    createBackgroundAgentSetup()({ tools: { restrict(value: unknown) { calls.push(value); return () => undefined } } } as never)
    expect(calls).toEqual([{ allow: ['skill', 'personal_skill_create', 'personal_plugin_propose', 'personal_memory_apply'] }])
  })

  it('restricts decision and Dream agents to read-only skill lookup', () => {
    const calls: unknown[] = []
    createReadOnlyHiddenAgentSetup()({ tools: { restrict(value: unknown) { calls.push(value); return () => undefined } } } as never)
    expect(calls).toEqual([{ allow: ['skill'] }])
  })

  it('normalizes only the project workspace/runtime layout and rejects home defaults', () => {
    const root = resolve('isolated-host-root')
    expect(normalizeHostPaths({ workspaceRoot: join(root, 'workspace'), runtimeRoot: join(root, 'runtime'), agentsHome: join(root, 'runtime', 'agents-home') }, { USERPROFILE: resolve('unrelated-user') }).workspaceRoot).toBe(join(root, 'workspace'))
    expect(() => normalizeHostPaths({ workspaceRoot: resolve('other', 'workspace'), runtimeRoot: join(root, 'runtime'), agentsHome: join(root, 'runtime', 'agents-home') }, { USERPROFILE: resolve('unrelated-user') })).toThrow(/project isolated/)
    const home = resolve('isolated-user')
    expect(() => normalizeHostPaths({ workspaceRoot: join(home, '.dsh', 'workspace'), runtimeRoot: join(home, '.dsh', 'runtime'), agentsHome: join(home, '.dsh', 'runtime', 'agents-home') }, { USERPROFILE: home })).toThrow(/default home/)
  })

  it('rejects dangerous apply configuration synchronously before creating host state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pga-apply-boundary-'))
    try {
      const outside = join(root, 'outside')
      expect(() => apply({} as never, { appId: 'a', appSecret: 's', allowedPeerId: 'p', workspaceRoot: outside, runtimeRoot: join(root, 'runtime'), agentsHome: join(root, 'runtime', 'agents-home') })).toThrow(/project isolated/)
      expect(await readdir(root)).toEqual([])
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
