import { describe, expect, it } from 'vitest'
import { captureCompletedTurn, registerPersonalGrowthTools, type DshToolRegistrar } from '../src/plugin.js'

describe('production host critical contracts', () => {
  it('captures every completed foreground root turn at the turn boundary', () => {
    const events = [
      { seq: 1, type: 'assistant/message', data: { turn: 4, step: 1, message: { content: [{ type: 'text', text: 'reply' }] } } },
      { seq: 2, type: 'turn/end', data: { turn: 4, reason: { kind: 'completed' } } },
    ] as never[]
    expect(captureCompletedTurn(events, 4)).toEqual({ text: 'reply', seq: 2 })
  })

  it('registers strictly-scoped skill and plugin proposal tools through public registration', () => {
    const names: string[] = []
    const registrar: DshToolRegistrar = { register(tool) { names.push(tool.name); return () => undefined } }
    registerPersonalGrowthTools(registrar, { agentsHome: 'C:/isolated/agents-home', proposals: 'C:/isolated/proposals' })
    expect(names).toEqual(['personal_skill_create', 'personal_plugin_propose'])
  })
})
