import { describe, expect, it } from 'vitest'
import { apply, captureCompletedTurn, registerPersonalGrowthTools, type DshToolRegistrar } from '../src/plugin.js'
import { sessionIdForPeer } from '../src/bridge.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
    expect(names).toEqual(['personal_skill_create', 'personal_plugin_propose', 'personal_memory_apply'])
  })

  it('consumes only the fixed foreground session while retaining schedule plugin prompts', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'pga-host-events-'))
    try {
    const consumed: unknown[][] = []
    let listener: ((session: { id: string }, event: unknown) => void) | undefined
    let cleanup: (() => Promise<void>) | undefined
    const bot = { onMessage() {}, async sendText() {}, async start() {}, async stop() {} }
    apply({
      tools: { register() { return () => undefined } },
      sessionPersistence: { async listSnapshots() { return [] } },
      agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
      on(_name: string, callback: typeof listener) { listener = callback },
      effect(factory: () => () => Promise<void>) { cleanup = factory() },
    } as never, {
      appId: 'app', appSecret: 'secret', allowedPeerId: 'peer', bot,
      workspaceRoot,
      registry: { async resume() { throw new Error('not used') }, async create() { throw new Error('not used') } },
      memory: {
        async readProfile() { return '' }, async search() { return [] }, async readIndex() { return '' },
        async consume(events) { consumed.push(events as unknown[]); return null }, async apply() {},
      },
      heartbeat: { async wakeForeground() {}, async wakeBackground() {} }, cadence: {},
    })
    const fg = sessionIdForPeer('peer')
    const emit = (sessionId: string, type: string, data: unknown, seq: number) => listener?.({ id: sessionId }, { type, data, seq, time: '2026-01-01T12:00:00.000Z' })
    emit(fg, 'turn/start', { turn: 1 }, 1)
    emit(fg, 'user/message', { turn: 1, message: { source: { kind: 'plugin', plugin: 'dsh-schedule' }, content: [{ type: 'text', text: 'scheduled prompt' }] } }, 2)
    emit(fg, 'assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'scheduled reply' }] } }, 3)
    emit(fg, 'turn/end', { turn: 1, reason: { kind: 'completed' } }, 4)
    emit('unrelated-root', 'turn/start', { turn: 1 }, 1)
    emit('unrelated-root', 'user/message', { turn: 1, message: { source: { kind: 'user' }, content: [{ type: 'text', text: 'must not persist' }] } }, 2)
    emit('unrelated-root', 'assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'unrelated reply' }] } }, 3)
    emit('unrelated-root', 'turn/end', { turn: 1, reason: { kind: 'completed' } }, 4)
    await new Promise(resolve => setTimeout(resolve, 1_000))
    expect(consumed.flat().map(event => (event as { content: string }).content)).toEqual(['scheduled prompt', 'scheduled reply'])
    await cleanup?.()
    } finally { await rm(workspaceRoot, { recursive: true, force: true }) }
  })
})
