import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MemoryService } from '@personal-growth/personal-memory'
import { AdminBackend, HostStatus } from '../src/admin/backend.js'
import { SafeAdminFiles } from '../src/admin/files.js'
import { PromptStore } from '../src/admin/prompts.js'
import { HeartbeatController } from '../src/admin/heartbeat.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'pga-admin-api-')); roots.push(root); await mkdir(join(root, 'workspace'))
  const files = new SafeAdminFiles(root); const memory = new MemoryService({ workspaceRoot: join(root, 'workspace') })
  const prompts = new PromptStore(files); await prompts.initialize()
  const heartbeat = new HeartbeatController(files, { timeZone: 'Asia/Singapore', quietHours: { start: '23:00', end: '07:00' }, cooldownMinutes: 120, maxContactsPerDay: 4 }); await heartbeat.initialize()
  let inspections = 0
  const backend = new AdminBackend({ files, memory, prompts, heartbeat, status: new HostStatus(), sessionIds: ['fg', 'fg-hidden-dream'], sessions: {
    async list() { return [{ id: 'fg' }, { id: 'other' }, { id: 'fg-hidden-dream' }] },
    async read(id, from) { inspections++; return { events: [{ seq: from, type: 'user/message', time: Date.parse('2026-09-07T12:00:00Z'), data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'api_key=secret-example' }] } }], id } },
  }, schedule: async () => [], pending: async () => ({ memory: 0, outbound: 0 }) })
  const call = (method: string, path: string, body?: unknown, query = '') => backend.handle({ method, path, body, query: new URLSearchParams(query) })
  return { call, inspections: () => inspections, memory }
}
describe('Host admin boundary', () => {
  it('counts only actual foreground user messages as recent interaction', () => {
    const status = new HostStatus('fg')
    status.event('fg-hidden-dream', { type: 'user/message', time: '', data: { source: { kind: 'user' } } })
    status.event('fg', { type: 'user/message', time: '', data: { source: { kind: 'plugin' } } })
    expect(status.lastInteraction).toBeNull()
    status.event('fg', { type: 'user/message', time: '', data: { source: { kind: 'user' } } })
    expect(status.lastInteraction).not.toBeNull()
  })
  it('browses only owned sessions using the read-only port and redacts content', async () => {
    const { call, inspections } = await setup()
    expect(await call('GET', '/api/sessions')).toMatchObject({ items: [{ id: 'fg' }, { id: 'fg-hidden-dream' }] })
    await expect(call('GET', '/api/session', undefined, 'id=other')).rejects.toMatchObject({ statusCode: 404 })
    expect(inspections()).toBe(0)
    expect(JSON.stringify(await call('GET', '/api/session', undefined, 'id=fg'))).not.toContain('secret-example')
    expect(inspections()).toBe(1)
    await expect(call('POST', '/api/session', { text: 'send' })).rejects.toThrow()
  })
  it('writes memory through proposals with admin provenance and stale conflict checks', async () => {
    const { call, memory } = await setup()
    await call('POST', '/api/memory', { action: 'CREATE', path: 'preferences/test.md', summary: 'test', content: 'evening study', frequency: 'high' })
    const doc = await memory.read('preferences/test.md')
    expect(doc.metadata.sources).toContain('explicit:admin')
    expect(await memory.readProfile()).toContain('test')
    await expect(call('POST', '/api/memory', { action: 'UPDATE', path: doc.path, summary: 'new', content: 'changed', expectedHash: '0'.repeat(64) })).rejects.toMatchObject({ statusCode: 409 })
    await call('POST', '/api/memory', { action: 'ARCHIVE', path: doc.path, expectedHash: doc.hash })
    expect((await memory.list('archive')).length).toBe(1)
    expect(await call('GET', '/api/memory/revisions')).toMatchObject({ items: [{ actor: 'web-admin' }, { actor: 'web-admin' }] })
    await expect(call('POST', '/api/memory', { action: 'MERGE' })).rejects.toThrow()
  })
})
