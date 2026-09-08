import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MemoryService } from '@personal-growth/personal-memory'
import { apply } from '../src/plugin.js'
import { sessionIdForPeer } from '../src/bridge.js'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
describe('production Host wake composition', () => {
  it('runs real background memory batches and Skill effects, then supplies real foreground context', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pga-production-wake-')); roots.push(root)
    const workspace = join(root, 'workspace'), runtime = join(root, 'runtime')
    await mkdir(workspace)
    await writeFile(join(workspace, 'SOUL.md'), 'fixed soul')
    await writeFile(join(workspace, 'AGENT.md'), 'fixed mission')
    const memory = new MemoryService({ workspaceRoot: workspace, compressor: { compress: events => events.map(item => item.content).join('\n') } })
    await memory.consume([{ sessionId: 'fixture', seq: 1, role: 'user', content: 'Three stable preferences', at: '2026-09-08T00:00:00Z' }])
    const timers = new Map<number, () => void>()
    const cadenceReady = Promise.withResolvers<void>()
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void, ms: number) => { timers.set(ms, callback); if (ms === 60002) cadenceReady.resolve(); return { unref() {} } }) as never)
    vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined)
    const cleanups: Array<() => unknown> = []
    let eventListener!: (session: { id: string }, event: unknown) => void
    const prompts: string[] = [], sent: string[] = []
    const foregroundId = sessionIdForPeer('fixture-peer')
    const agents = new Map<string, unknown>()
    const availableTools = ['schedule_create', 'schedule_list', 'schedule_delete', 'get_goal', 'create_goal', 'update_goal', 'read', 'write', 'edit', 'glob', 'grep', 'skill', process.platform === 'win32' ? 'pwsh' : 'bash']
    const ready = Promise.withResolvers<void>()
    const completed = Promise.withResolvers<void>()
    const foreground = Promise.withResolvers<void>()
    apply({
      tools: { register() { return () => undefined } },
      on(name: string, listener: typeof eventListener) { if (name === 'session/event') eventListener = listener },
      effect(factory: () => () => unknown) { cleanups.push(factory()) },
      agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'fixture' }) },
      goals: { get() { return { objective: 'prepare exam', phase: 'active' } } },
      sessionPersistence: {
        async listSnapshots() { return [{ header: { id: foregroundId } }] },
        async inspect(id: string) { expect(id).toBe(foregroundId); return { meta: {}, events: [{ type: 'user/message', seq: 1, time: 1788825600000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'recent exam update' }] } }] } },
      },
      agents: {
        get(id: string) { return agents.get(id) },
        async resume(options: { resumeSessionId: string; setup?: (ctx: unknown) => void }) { return this.create({ sessionId: options.resumeSessionId, setup: options.setup }) },
        async create(options: { sessionId: string; setup?: (ctx: unknown) => void }) {
          const id = String(options.sessionId)
          const ctx = { tools: { restrict() {}, guard() {}, schemas: () => availableTools.map(name => ({ name })) } }
          options.setup?.(ctx)
          const agent = { id, ctx, async whenIdle() {}, followup(message: { content: Array<{ text: string }> }) {
            prompts.push(message.content.map(block => block.text).join(''))
            queueMicrotask(() => {
              const text = id.endsWith('maintenance') ? '{"type":"CREATE_SKILL","name":"exam-review","instructions":"Review supplied notes."}' : '{"type":"NOOP","reason":"no unsolicited contact needed"}'
              eventListener({ id }, { type: 'assistant/message', time: Date.now(), data: { message: { content: [{ type: 'text', text }] } } })
              eventListener({ id }, { type: 'turn/end', time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } })
              if (id.endsWith('maintenance')) completed.resolve(); else foreground.resolve()
            })
          } }
          agents.set(id, agent)
          return { agent, async dispose() {} }
        },
      },
    } as never, {
      appId: 'fixture', appSecret: 'fixture', allowedPeerId: 'fixture-peer', admin: false,
      workspaceRoot: workspace, runtimeRoot: runtime, agentsHome: join(runtime, 'agents-home'),
      bot: { onMessage() {}, async start() { ready.resolve() }, async stop() {}, async sendText(_target, text) { sent.push(text) } },
      cadence: { foregroundMs: 60001, backgroundMs: 60002 },
      heartbeatConfig: { quietHours: { start: '00:00', end: '00:00' }, cooldownMinutes: 0 },
      dream: { async propose() { return ['sleep', 'study', 'exercise'].map(name => ({ action: 'CREATE', path: `preferences/${name}.md`, summary: name, content: 'stable preference', sourceEvidence: ['user'], frequency: 'high' })) } },
    })
    try {
      await ready.promise
      await cadenceReady.promise
      timers.get(60002)!()
      await completed.promise
      // Draining Host waits for the actual extension effect, not merely model output.
      timers.get(60001)!()
      await foreground.promise
    } finally { for (const cleanup of cleanups.reverse()) await cleanup() }
    expect(await memory.revisions()).toHaveLength(3)
    const skillDirs = await readdir(join(runtime, 'agents-home', 'skills'))
    expect(skillDirs).toContain('exam-review-v1')
    expect(await readFile(join(runtime, 'agents-home', 'skills', 'exam-review-v1', 'SKILL.md'), 'utf8')).toContain('explicitly requests')
    expect(prompts.at(-1)).toContain('prepare exam')
    expect(prompts.at(-1)).toContain('recent exam update')
    expect(sent).toEqual([])
  })
})
