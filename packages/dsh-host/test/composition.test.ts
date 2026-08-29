import { describe, expect, it } from 'vitest'
import { composeEntries } from '@deepseek-ai/dsh-app-boot'
import { buildHostPatch, assertRequiredComposition } from '../src/composition.js'

describe('DSH host composition contract', () => {
  it('uses an insert patch for schedule and host, preserving public DSH composition semantics', () => {
    const patch = buildHostPatch({ hostName: '@personal-growth/dsh-host' })
    const entries = composeEntries([[patch as never]])
    expect(entries.map(entry => entry.id)).toEqual(['schedule', 'personal-growth-host'])
    expect(entries.find(entry => entry.id === 'schedule')?.name).toBe('@deepseek-ai/dsh-schedule')
    expect(entries.find(entry => entry.id === 'personal-growth-host')?.name).toBe('@personal-growth/dsh-host')
  })

  it('fails closed when the schedule row is absent', () => {
    expect(() => assertRequiredComposition([{ id: 'personal-growth-host', name: '@personal-growth/dsh-host' }])).toThrow(/schedule/)
  })
})
