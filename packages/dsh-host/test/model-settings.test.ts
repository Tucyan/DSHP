import { describe, expect, it } from 'vitest'
import { createDshModelSettings } from '../src/admin/model-settings.js'

function context() {
  let selection: { provider: string; model: string; reasoningEffort?: string } = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
  let revision = 3
  const writes: unknown[] = []
  return {
    ctx: {
      agentDefaultModel: { currentSelection: () => ({ ...selection }) },
      settings: {
        documentPath: '/opt/dshp/runtime/dsh-home/settings.yaml',
        describe: () => [{ ns: 'agent-default-model', value: { ...selection }, revision, applies: 'live' }],
        async replace(namespace: string, next: typeof selection, expectedRevision: number) {
          writes.push({ namespace, next, expectedRevision })
          selection = { ...next }
          revision += 1
        },
      },
    },
    writes,
  }
}

describe('DSH model settings adapter', () => {
  it('reads and revision-checks the file-backed default model selection', async () => {
    const fixture = context()
    const applied: string[] = []
    const models = createDshModelSettings(fixture.ctx as never, async selection => { applied.push(selection.model) })

    expect(models.view()).toEqual({
      selection: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      revision: 3,
      configPath: '/opt/dshp/runtime/dsh-home/settings.yaml',
      applies: 'live',
    })

    const updated = await models.update({ provider: 'deepseek-official', model: 'deepseek-v4.1-flash-expires-on-0910', reasoningEffort: 'high' }, 3)
    expect(fixture.writes).toEqual([{ namespace: 'agent-default-model', next: { provider: 'deepseek-official', model: 'deepseek-v4.1-flash-expires-on-0910', reasoningEffort: 'high' }, expectedRevision: 3 }])
    expect(updated).toMatchObject({ selection: { model: 'deepseek-v4.1-flash-expires-on-0910' }, revision: 4 })
    expect(applied).toEqual(['deepseek-v4.1-flash-expires-on-0910'])
    expect(JSON.stringify(updated)).not.toMatch(/api.?key|secret/i)
  })

  it('maps a stale settings revision to the admin conflict boundary', async () => {
    const fixture = context()
    fixture.ctx.settings.replace = async () => { throw Object.assign(new Error('internal settings detail'), { code: 'SETTINGS_CONFLICT' }) }
    const models = createDshModelSettings(fixture.ctx as never)

    await expect(models.update({ provider: 'deepseek-official', model: 'next-model' }, 2)).rejects.toMatchObject({ statusCode: 409, code: 'model_conflict' })
  })

  it('fails closed when the registered namespace or writable settings service is unavailable', () => {
    expect(() => createDshModelSettings({ agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) } } as never)).toThrow(/settings service/)
    const fixture = context()
    fixture.ctx.settings.describe = () => []
    expect(() => createDshModelSettings(fixture.ctx as never).view()).toThrow(/agent-default-model/)
  })
})
