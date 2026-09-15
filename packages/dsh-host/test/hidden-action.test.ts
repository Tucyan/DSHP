import { describe, expect, it } from 'vitest'
import { requestHiddenAction, HiddenActionError } from '../src/hidden-action.js'

const trigger = { type: 'background_heartbeat' as const, occurrenceId: 'regression', at: '2026-09-07T14:39:22.933Z' }
describe('hidden action output contract', () => {
  it('corrects the production action:NOOP response once with a complete schema', async () => {
    const prompts: string[] = []
    const action = await requestHiddenAction('maintenance', trigger, 'context', async prompt => {
      prompts.push(prompt)
      return prompts.length === 1 ? '{"action":"NOOP"}' : '{"type":"NOOP","reason":"nothing to maintain"}'
    })
    expect(action.type).toBe('NOOP')
    expect(prompts).toHaveLength(2)
    expect(prompts[0]).toContain('"type":"NOOP","reason":')
    expect(prompts[0]).toContain('capabilityGap')
    expect(prompts[1]).toContain('格式')
  })
  it('rejects repeated malformed output without performing or inventing an action', async () => {
    let calls = 0
    await expect(requestHiddenAction('maintenance', trigger, '', async () => { calls++; return '{"action":"NOOP"}' })).rejects.toMatchObject({ code: 'heartbeat_invalid_action' })
    expect(calls).toBe(2)
  })
  it('cannot repair its way into a forbidden background message', async () => {
    await expect(requestHiddenAction('maintenance', trigger, '', async () => '{"type":"MESSAGE_USER","text":"hello","importance":"normal"}')).rejects.toBeInstanceOf(HiddenActionError)
  })
  it('does not retry provider failures or leak exception text', async () => {
    let calls = 0
    await expect(requestHiddenAction('maintenance', trigger, '', async () => { calls++; throw new Error('secret-provider-payload') })).rejects.toMatchObject({ message: 'heartbeat_model_failed', code: 'heartbeat_model_failed' })
    expect(calls).toBe(1)
  })
})
