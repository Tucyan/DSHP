import { z } from 'zod'
import { MEMORY_CATEGORIES, MemoryService, ProposalSchema } from '@personal-growth/personal-memory'
import { AdminError, SafeAdminFiles, redactAdmin } from './files.js'
import type { PromptStore } from './prompts.js'
import type { HeartbeatController } from './heartbeat.js'
import type { ModelSettingsPort } from './model-settings.js'

export interface AdminRequest { method: string; path: string; query: URLSearchParams; body: unknown }
export interface AdminSessions {
  list(): Promise<Array<{ id: string; [key: string]: unknown }>>
  read(id: string, from: number): Promise<{ events: Array<{ seq: number; type: string; [key: string]: unknown }>; [key: string]: unknown }>
}
export class HostStatus {
  constructor(private foregroundId?: string) {}
  lifecycle = 'starting'
  qq: 'connecting' | 'ready' | 'unknown' | 'error' | 'stopped' = 'unknown'
  readonly startedAt = new Date().toISOString()
  model: unknown = null
  lastInteraction: string | null = null
  tasks = new Map<string, { turn: number; startedAt: string }>()
  private recent: Array<Record<string, unknown>> = []
  event(id: string, event: { type: string; time: unknown; data: unknown }) {
    const data = event.data as { turn?: number; reason?: { kind?: string }; source?: { kind?: string } }
    if (event.type === 'turn/start') this.tasks.set(id, { turn: data.turn ?? 0, startedAt: new Date().toISOString() })
    if (event.type === 'user/message' && id === this.foregroundId && data.source?.kind === 'user') this.lastInteraction = new Date().toISOString()
    if (event.type === 'turn/end') { this.tasks.delete(id); if (data.reason?.kind !== 'completed') this.trace({ type: 'turn', status: data.reason?.kind ?? 'error', at: new Date().toISOString() }) }
  }
  trace(record: Record<string, unknown>) { this.recent.push(redactAdmin(record) as Record<string, unknown>); this.recent = this.recent.slice(-100) }
  snapshot() { return { lifecycle: this.lifecycle, qq: this.qq, startedAt: this.startedAt, model: this.model, lastInteraction: this.lastInteraction, tasks: [...this.tasks].map(([sessionId, value]) => ({ sessionId, ...value })), recent: this.recent.slice(-20) } }
}
interface Options {
  files: SafeAdminFiles; memory: MemoryService; prompts: PromptStore; heartbeat: HeartbeatController; status: HostStatus
  sessionIds: string[]; sessions: AdminSessions; schedule: (operation: 'list' | 'create' | 'delete', args: unknown) => Promise<unknown>
  pending: () => Promise<{ memory: number; outbound: number }>; models: ModelSettingsPort; internalPrompts?: Record<string, string>; secrets?: string[]
}
const positiveLimit = (input: string | null, fallback: number, max: number) => z.coerce.number().int().min(1).max(max).parse(input ?? fallback)
const createSchedule = z.object({ prompt: z.string().trim().min(1).max(8000), after_seconds: z.number().int().min(1).max(365 * 86400).optional(), every_seconds: z.number().int().min(300).max(365 * 86400).optional(), at: z.string().datetime({ offset: true }).optional() }).strict().refine(value => [value.after_seconds, value.every_seconds, value.at].filter(item => item !== undefined).length === 1)
const modelIdentifier = z.string().trim().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u)
const modelSelection = z.object({ provider: modelIdentifier, model: modelIdentifier, reasoningEffort: z.string().trim().min(1).max(32).regex(/^[A-Za-z0-9_-]+$/u).optional() }).strict()
const auditSchema = z.array(z.object({ at: z.string(), method: z.string(), path: z.string(), result: z.enum(['ok', 'error']) }).strict()).max(1000)
export class AdminBackend {
  constructor(private options: Options) {}
  async handle(request: AdminRequest): Promise<unknown> {
    const write = request.method !== 'GET'
    try {
      const result = await this.route(request)
      if (write) await this.audit(request, 'ok')
      return result
    } catch (error) {
      if (write) await this.audit(request, 'error')
      if (error instanceof AdminError) throw error
      if (error instanceof z.ZodError) throw new AdminError(400, 'invalid_input')
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new AdminError(404, 'not_found')
      if (error instanceof Error && /Stale memory|already exists/.test(error.message)) throw new AdminError(409, 'memory_conflict')
      throw new AdminError(500, 'operation_failed')
    }
  }
  private async audit(request: AdminRequest, result: 'ok' | 'error') {
    await this.options.files.change('runtime/admin/audit.json', auditSchema, [], state => { state.push({ at: new Date().toISOString(), method: request.method, path: request.path, result }); if (state.length > 1000) state.splice(0, state.length - 1000) })
  }
  private async route({ method, path, query, body }: AdminRequest): Promise<unknown> {
    const { memory, files, prompts, heartbeat, sessions } = this.options
    const route = `${method} ${path}`
    if (route === 'GET /api/status') return { ...this.options.status.snapshot(), model: this.options.models.view().selection, pending: await this.options.pending(), heartbeat: heartbeat.view(), foregroundSessionId: this.options.sessionIds[0] }
    if (route === 'GET /api/model') return this.options.models.view()
    if (route === 'PUT /api/model') { const input = z.object({ selection: modelSelection, expectedRevision: z.number().int().min(0) }).strict().parse(body); return this.options.models.update(input.selection, input.expectedRevision) }
    if (route === 'GET /api/sessions') return { items: (await sessions.list()).filter(item => this.options.sessionIds.includes(item.id)).map(item => ({ ...item, hidden: item.id !== this.options.sessionIds[0] })) }
    if (route === 'GET /api/session') {
      const id = query.get('id') ?? ''; if (!this.options.sessionIds.includes(id)) throw new AdminError(404, 'session_not_found')
      const from = z.coerce.number().int().min(0).max(10000000).parse(query.get('from') ?? 0)
      const limit = positiveLimit(query.get('limit'), 100, 200)
      const view = await sessions.read(id, from); const events = view.events.filter(event => event.seq >= from).slice(0, limit)
      return redactAdmin({ id, events, next: events.length ? events.at(-1)!.seq + 1 : from, hasMore: view.events.length > events.length }, this.options.secrets)
    }
    if (route === 'GET /api/memory') {
      const category = query.get('category'); const q = z.string().max(500).parse(query.get('q') ?? '')
      let items = await memory.list(category ? z.enum(MEMORY_CATEGORIES).parse(category) : undefined)
      if (q.trim()) items = items.filter(item => `${item.metadata.summary}\n${item.content}`.toLocaleLowerCase().includes(q.toLocaleLowerCase()))
      const offset = z.coerce.number().int().min(0).max(100000).parse(query.get('offset') ?? 0)
      return { items: items.slice(offset, offset + 100).map(({ path, metadata, hash }) => ({ path, metadata, hash })), total: items.length, profile: await memory.readProfile(), index: await memory.readIndex() }
    }
    if (route === 'GET /api/memory/document') return memory.read(z.string().min(1).max(500).parse(query.get('path')))
    if (route === 'GET /api/memory/revisions') { const path = query.get('path'); return { items: (await memory.revisions()).filter(item => !path || item.path === path).slice(-200) } }
    if (route === 'POST /api/memory') {
      const input = z.object({ action: z.enum(['CREATE', 'UPDATE', 'ARCHIVE']), path: z.string().max(500), summary: z.string().trim().min(1).max(500).optional(), content: z.string().trim().min(1).max(64000).optional(), expectedHash: z.string().length(64).optional(), importance: z.enum(['low', 'normal', 'high']).optional(), frequency: z.enum(['low', 'normal', 'high']).optional(), reason: z.string().max(1000).optional() }).strict().parse(body)
      return memory.apply(ProposalSchema.parse({ ...input, sourceEvidence: ['explicit:admin'] }), { actor: 'web-admin' })
    }
    if (route === 'GET /api/prompts') return { ...prompts.view(), internal: this.options.internalPrompts ?? {} }
    if (route === 'PUT /api/prompts') return prompts.update(body)
    if (route === 'GET /api/heartbeat') return heartbeat.view()
    if (route === 'PUT /api/heartbeat') { const input = z.object({ settings: z.unknown(), expectedRevision: z.string().length(64) }).strict().parse(body); return heartbeat.update(input.settings, input.expectedRevision) }
    if (route === 'POST /api/heartbeat/run') { const input = z.object({ role: z.enum(['foreground', 'background']), requestId: z.string().min(1).max(100) }).strict().parse(body); return heartbeat.run(input.role, input.requestId) }
    if (route === 'GET /api/jobs') return { items: heartbeat.jobs() }
    if (route === 'GET /api/schedules') return { items: await this.options.schedule('list', {}) }
    if (route === 'POST /api/schedules') return this.options.schedule('create', createSchedule.parse(body))
    if (route === 'DELETE /api/schedules') return this.options.schedule('delete', z.object({ id: z.string().min(1).max(200).regex(/^[\w-]+$/) }).strict().parse(body))
    if (route === 'GET /api/diagnostics') {
      const records = [...await files.tail('workspace/.personal-growth/trace.jsonl'), ...await files.tail('runtime/extension-trace.jsonl'), ...await files.json('runtime/admin/audit.json', auditSchema, [])] as Array<Record<string, unknown>>
      const items = records.filter(item => (!query.get('type') || item.type === query.get('type')) && (!query.get('status') || item.status === query.get('status') || item.result === query.get('status')) && (!query.get('from') || String(item.at) >= query.get('from')!)).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 300)
      return { items: redactAdmin(items, this.options.secrets) }
    }
    if (route === 'GET /api/extensions') {
      const paths = [...await files.list('runtime/agents-home/skills'), ...await files.list('runtime/plugin-proposals')]
      const selected = query.get('path')
      if (selected && !paths.includes(selected)) throw new AdminError(404, 'extension_not_found')
      return { items: paths.map(path => ({ path, kind: path.includes('/skills/') ? 'skill' : 'proposal' })), ...(selected ? { path: selected, content: redactAdmin(await files.read(selected), this.options.secrets) } : {}) }
    }
    throw new AdminError(404, 'not_found')
  }
}
