import { describe, expect, it } from 'vitest'
import { registerActivityTool } from '../src/activity-tool.js'

describe('get_activity tool', () => {
  it('uses fixed defaults and forwards only read-only query fields', async () => {
    let definition: any
    const disposer = registerActivityTool({ register(value) { definition = value; return () => undefined } }, async query => ({ query } as any), { date: () => '2026-09-07', timeZone: () => 'UTC', asOf: () => '2026-09-07T13:00:00.000Z' })
    expect(disposer).toBeTypeOf('function')
    const result = await definition.execute({ limit: 5 }, {} as never)
    expect(result.query).toEqual({ date: '2026-09-07', timeZone: 'UTC', asOf: '2026-09-07T13:00:00.000Z', limit: 5 })
  })
})
