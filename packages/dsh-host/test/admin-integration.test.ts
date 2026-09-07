import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PersonalGrowthBridge, sessionIdForPeer } from '../src/bridge.js'
import { createDshAgentRegistry } from '../src/plugin.js'
import { SafeAdminFiles } from '../src/admin/files.js'
import { PromptStore } from '../src/admin/prompts.js'
import { adminSchedule, adminSessions, installManagedPrompt } from '../src/admin/integration.js'

describe('admin Host integration', () => {
  it('uses read-only persistence for browsing and official fixed-session tools for schedule writes', async () => {
    const calls: Array<{ name: string; arguments: unknown; agent: unknown }> = []
    let prepared = 0
    const id = sessionIdForPeer('peer')
    const agent = { ctx: { tools: { async execute(call: { name: string; arguments: unknown; agent: unknown }) { calls.push(call); return { isError: false, value: { deleted: true } } } } } }
    const ctx = {
      sessionPersistence: {
        async listSnapshots() { return [{ header: { id } }] },
        async inspect(requested: string) { expect(requested).toBe(id); return { events: [], meta: {} } },
        async readFrom(requested: string, from: number) { expect(requested).toBe(id); expect(from).toBe(8); return { events: [] } },
        async load() { throw new Error('browsing must not load') },
      },
      agents: { get(requested: string) { expect(requested).toBe(id); return agent } },
    } as never
    await adminSessions(ctx).read(id, 8)
    const schedule = adminSchedule(ctx, id, async () => { prepared++ })
    expect(await schedule('list', {})).toEqual([]); expect(prepared).toBe(0)
    await schedule('create', { prompt: 'check in', every_seconds: 300 })
    await schedule('delete', { id: 'schedule-1' })
    expect(prepared).toBe(2)
    expect(calls.map(call => [call.name, call.arguments, call.agent === agent])).toEqual([
      ['schedule_create', { prompt: 'check in', every_seconds: 300 }, true],
      ['schedule_delete', { id: 'schedule-1' }, true],
    ])
  })
  it('returns foreground policy outcomes and sends accepted output once', async () => {
    const sent: string[] = []
    const bridge = new PersonalGrowthBridge({ allowedPeerId: 'peer', bot: { onMessage() {}, async start() {}, async stop() {}, async sendText(_target, text) { sent.push(text) } }, registry: {} as never, memory: {} as never, heartbeat: { async wakeForeground() { return { status: 'completed', action: { type: 'MESSAGE_USER', text: 'check in' } } }, async wakeBackground() {} } })
    await bridge.start()
    expect(await bridge.runForegroundWake({ occurrenceId: 'admin-test' })).toMatchObject({ status: 'completed' })
    expect(sent).toEqual(['check in']); await bridge.stop()
  })
  it('registers literal-safe prompt variables in scoped unpublished agent setup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pga-admin-prompt-')); await mkdir(join(root, 'workspace'))
    try {
      const prompts = new PromptStore(new SafeAdminFiles(root)); await prompts.initialize()
      const sections: unknown[] = []; let value: (() => string) | undefined
      const agentCtx = { systemPrompt: { section(v: unknown) { sections.push(v) }, variable(_key: string, v: () => string) { value = v } } }
      let setupRan = false
      const registry = createDshAgentRegistry({ sessionPersistence: { async listSnapshots() { return [] } }, agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) }, agents: { async create(options: { setup?: (ctx: unknown) => void }) { options.setup?.(agentCtx); setupRan = true; return { agent: { id: sessionIdForPeer('peer') }, async dispose() {} } } } } as never, undefined, undefined, (ctx, id) => installManagedPrompt(ctx, id, prompts))
      await registry.create({ sessionId: sessionIdForPeer('peer') })
      expect(setupRan).toBe(true); expect(sections).toContainEqual(expect.objectContaining({ text: '{{personal_growth_identity}}' })); expect(value?.()).toContain('MISSION')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
