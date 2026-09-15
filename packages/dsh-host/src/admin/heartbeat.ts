import { randomUUID, createHash } from 'node:crypto'
import { z } from 'zod'
import { HeartbeatConfigSchema, type HeartbeatConfig } from '@personal-growth/personal-heartbeat'
import { AdminError, SafeAdminFiles, redactAdmin } from './files.js'
import { HiddenActionError } from '../hidden-action.js'

export const AdminHeartbeatSettingsSchema = z.object({
  policy: HeartbeatConfigSchema,
  foregroundMs: z.number().int().min(60_000).max(7 * 86400_000), backgroundMs: z.number().int().min(60_000).max(7 * 86400_000),
  foregroundPaused: z.boolean(), backgroundPaused: z.boolean(),
}).strict()
export type AdminHeartbeatSettings = z.infer<typeof AdminHeartbeatSettingsSchema>
type Role = 'foreground' | 'background'
interface Job { id: string; role: Role; requestId: string; status: 'running' | 'completed' | 'failed'; startedAt: string; endedAt?: string; result?: unknown; error?: string }
export class HeartbeatController {
  private settings: AdminHeartbeatSettings
  private revision = ''
  private timer?: ReturnType<typeof setInterval>
  private stopped = true
  private next: Record<Role, number> = { foreground: 0, background: 0 }
  private pending = new Map<Role, Promise<void>>()
  private records: Job[] = []
  private execute?: (role: Role, id: string) => Promise<unknown>
  private onSettings?: (settings: AdminHeartbeatSettings) => void
  constructor(private files: SafeAdminFiles, policy: HeartbeatConfig, cadence?: { foregroundMs?: number; backgroundMs?: number }) {
    this.settings = AdminHeartbeatSettingsSchema.parse({ policy, foregroundMs: cadence?.foregroundMs || 3600000, backgroundMs: cadence?.backgroundMs || 1800000, foregroundPaused: false, backgroundPaused: false })
  }
  async initialize() { this.settings = AdminHeartbeatSettingsSchema.parse(await this.files.json('runtime/admin/heartbeat.json', AdminHeartbeatSettingsSchema, this.settings)); this.setRevision() }
  private setRevision() { this.revision = createHash('sha256').update(JSON.stringify(this.settings)).digest('hex') }
  view() { return { settings: structuredClone(this.settings), revision: this.revision, next: { foreground: this.settings.foregroundPaused || this.stopped ? null : new Date(this.next.foreground).toISOString(), background: this.settings.backgroundPaused || this.stopped ? null : new Date(this.next.background).toISOString() }, jobs: this.jobs() } }
  jobs() { return structuredClone(this.records).reverse() }
  start(execute: (role: Role, id: string) => Promise<unknown>, onSettings?: (settings: AdminHeartbeatSettings) => void) {
    if (!this.stopped) return
    this.stopped = false; this.execute = execute; this.onSettings = onSettings; onSettings?.(this.settings)
    this.resetNext()
    this.timer = setInterval(() => {
      for (const role of ['foreground', 'background'] as const) {
        if (!this.settings[`${role}Paused`] && Date.now() >= this.next[role] && !this.pending.has(role)) {
          this.next[role] = Date.now() + this.settings[`${role}Ms`]
          this.run(role, randomUUID())
        }
      }
    }, 1000)
  }
  private resetNext() { for (const role of ['foreground', 'background'] as const) this.next[role] = Date.now() + this.settings[`${role}Ms`] }
  async update(input: unknown, expectedRevision: string) {
    const parsed = AdminHeartbeatSettingsSchema.parse(input)
    const changed = await this.files.change('runtime/admin/heartbeat.json', AdminHeartbeatSettingsSchema, this.settings, state => {
      const current = createHash('sha256').update(JSON.stringify(state)).digest('hex')
      if (current !== expectedRevision) throw new AdminError(409, 'heartbeat_conflict')
      Object.assign(state, parsed)
    })
    this.settings = AdminHeartbeatSettingsSchema.parse(changed.state); this.setRevision(); this.resetNext(); this.onSettings?.(this.settings); return this.view()
  }
  run(role: Role, requestId: string) {
    if (this.stopped || !this.execute) throw new AdminError(503, 'heartbeat_stopped')
    z.enum(['foreground', 'background']).parse(role); z.string().min(1).max(100).regex(/^[\w-]+$/).parse(requestId)
    const duplicate = this.records.find(job => job.requestId === requestId && job.role === role)
    if (duplicate) return structuredClone(duplicate)
    if (this.pending.has(role)) throw new AdminError(409, 'heartbeat_busy')
    const job: Job = { id: `admin-${randomUUID()}`, role, requestId, status: 'running', startedAt: new Date().toISOString() }
    this.records.push(job); if (this.records.length > 200) this.records.splice(0, this.records.length - 200)
    const task = Promise.resolve().then(() => this.execute!(role, job.id)).then(result => { job.result = redactAdmin(result); job.status = 'completed' }, error => { job.error = error instanceof HiddenActionError ? error.code : 'heartbeat_failed'; job.status = 'failed' }).finally(() => { job.endedAt = new Date().toISOString(); this.pending.delete(role) })
    this.pending.set(role, task); return structuredClone(job)
  }
  async drain() { await Promise.allSettled([...this.pending.values()]) }
  async close() { this.stopped = true; if (this.timer) clearInterval(this.timer); await this.drain() }
}
