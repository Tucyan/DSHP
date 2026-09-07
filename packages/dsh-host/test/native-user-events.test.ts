import { describe, expect, it } from 'vitest'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/plugin.js'
import { sessionIdForPeer } from '../src/bridge.js'

async function until(check: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('condition not reached')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

describe('native DSH user events', () => {
  it('consumes direct UserMessage data and distinguishes schedule turns from user turns', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'pga-native-events-'))
    const workspaceRoot = join(projectRoot, 'workspace')
    const runtimeRoot = join(projectRoot, 'runtime')
    const agentsHome = join(runtimeRoot, 'agents-home')
    await mkdir(workspaceRoot, { recursive: true })
    const consumed: unknown[][] = []
    const wakes: unknown[] = []
    const cleanups: Array<() => void | Promise<void>> = []
    let listener: ((session: { id: string }, event: unknown) => void) | undefined
    let started = false
    try {
      apply({
        tools: { register() { return () => undefined } },
        sessionPersistence: { async listSnapshots() { return [] } },
        agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
        on(_name: string, callback: typeof listener) { listener = callback },
        effect(factory: () => (() => void | Promise<void>)) { cleanups.push(factory()) },
      } as never, {
        appId: 'app', appSecret: 'secret', allowedPeerId: 'peer', workspaceRoot, runtimeRoot, agentsHome, admin: false,
        bot: { onMessage() {}, async sendText() {}, async start() { started = true }, async stop() {} },
        registry: { async resume() { throw new Error('not used') }, async create() { throw new Error('not used') } },
        memory: {
          async readProfile() { return '' }, async search() { return [] }, async readIndex() { return '' }, async apply() {},
          async consume(events) { consumed.push([...events]); return null },
        },
        heartbeat: {
          async wakeForeground(input) { wakes.push(input); return {} },
          async wakeBackground() {},
        },
        cadence: {},
      })
      await until(() => started)

      const foreground = sessionIdForPeer('peer')
      let seq = 0
      const emit = (type: string, data: unknown) => listener?.({ id: foreground }, { type, data, seq: ++seq, time: Date.parse('2026-09-07T12:00:00.000Z') })
      const turn = (number: number, source: { kind: 'user' } | { kind: 'plugin'; plugin: string }, userText: string, assistantText: string) => {
        emit('turn/start', { turn: number })
        emit('user/message', createUserMessage({ source, content: [{ type: 'text', text: userText }] }))
        emit('assistant/message', { turn: number, step: 1, message: createAssistantMessage({ source: { provider: 'p', model: 'm' }, content: [{ type: 'text', text: assistantText }] }) })
        emit('turn/end', { turn: number, reason: { kind: 'completed' } })
      }

      turn(1, { kind: 'plugin', plugin: 'dsh-schedule' }, 'scheduled prompt', 'scheduled reply')
      turn(2, { kind: 'user' }, 'direct user prompt', 'direct user reply')
      await until(() => consumed.length === 2 && wakes.length === 1)

      expect(consumed.map(events => events.map(event => (event as { content: string }).content))).toEqual([
        ['scheduled prompt', 'scheduled reply'],
        ['direct user prompt', 'direct user reply'],
      ])
      expect(wakes).toHaveLength(1)
    } finally {
      for (const cleanup of cleanups.reverse()) await cleanup()
      await rm(projectRoot, { recursive: true, force: true })
    }
  })
})
