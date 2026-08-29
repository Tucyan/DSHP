import { mkdir, readFile, rename, writeFile, rm, lstat, realpath } from 'node:fs/promises'
import { dirname, resolve, parse, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { BridgeState } from './bridge.js'

const MAX_ENTRIES = 10_000
const MAX_ID = 512
const MAX_SEQ = 1_000_000
const MAX_TRACES = 1_000
interface TraceRecord { type: string; at: string; key?: string; status?: string; reason?: string }
type InboundRecord = { status: 'pending' | 'completed'; owner?: string; leaseUntil?: string }
type HistoryRecordState = InboundRecord
type OutboundRecord = { status: 'pending' | 'sent' | 'unknown'; owner?: string; leaseUntil?: string }
interface StateFile { inbound: Record<string, InboundRecord>; outbound: Record<string, OutboundRecord>; sequences: Record<string, number>; histories: Record<string, HistoryRecordState>; traces: TraceRecord[] }
export type OutboundClaim = 'claimed' | 'sent' | 'pending' | 'unknown'
interface LockOwner { token: string; pid: number; leaseUntil: string }
function strictObject(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Malformed bridge state record')
  const result = value as Record<string, unknown>
  if (Object.keys(result).some(key => !allowed.includes(key))) throw new Error('Malformed bridge state: unknown field')
  return result
}
function parseLease(value: unknown): OutboundRecord {
  const object = strictObject(value, ['status', 'owner', 'leaseUntil'])
  if (!['pending', 'sent', 'unknown'].includes(String(object.status))) throw new Error('Malformed outbound state')
  validateLeaseFields(object)
  return object as OutboundRecord
}
function parseInbound(value: unknown): InboundRecord {
  const object = strictObject(value, ['status', 'owner', 'leaseUntil'])
  if (object.status !== 'pending' && object.status !== 'completed') throw new Error('Malformed inbound state')
  validateLeaseFields(object)
  return object as InboundRecord
}
function validateLeaseFields(object: Record<string, unknown>): void {
  if (object.owner !== undefined && (typeof object.owner !== 'string' || object.owner.length < 1 || object.owner.length > 128)) throw new Error('Malformed bridge lease owner')
  if (object.leaseUntil !== undefined && (typeof object.leaseUntil !== 'string' || !Number.isFinite(Date.parse(object.leaseUntil)))) throw new Error('Malformed bridge lease expiry')
}
function parseTrace(value: unknown): TraceRecord {
  const object = strictObject(value, ['type', 'at', 'key', 'status', 'reason'])
  if (typeof object.type !== 'string' || !object.type || object.type.length > 64 || typeof object.at !== 'string' || !Number.isFinite(Date.parse(object.at)) || (object.key !== undefined && (typeof object.key !== 'string' || object.key.length > MAX_ID)) || (object.status !== undefined && (typeof object.status !== 'string' || object.status.length > 64)) || (object.reason !== undefined && (typeof object.reason !== 'string' || object.reason.length > 256))) throw new Error('Malformed bridge trace')
  return object as unknown as TraceRecord
}
function parseLockOwner(value: unknown): LockOwner {
  const object = strictObject(value, ['token', 'pid', 'leaseUntil'])
  if (typeof object.token !== 'string' || !/^[0-9a-f-]{36}$/i.test(object.token) || typeof object.pid !== 'number' || !Number.isInteger(object.pid) || object.pid < 1 || typeof object.leaseUntil !== 'string') throw new Error('Malformed lock owner')
  return object as unknown as LockOwner
}

/** Crash-safe, cross-process ledger for the single-user bridge. */
export class FileBridgeState implements BridgeState {
  private queue: Promise<unknown> = Promise.resolve()
  private readonly owner = randomUUID()
  private readonly lockTimeoutMs: number
  constructor(private readonly filename: string, lockTimeoutMs = 30_000) {
    if (!Number.isFinite(lockTimeoutMs) || lockTimeoutMs < 30_000) throw new Error('bridge state lock timeout must be at least 30000ms')
    this.lockTimeoutMs = lockTimeoutMs
  }

  acceptInbound(messageId: string): Promise<boolean> {
    return this.claimInbound(messageId).then(async result => {
      if (result !== 'claimed') return false
      await this.completeInbound(messageId)
      return true
    })
  }

  claimInbound(messageId: string): Promise<'claimed' | 'completed' | 'pending'> {
    return this.update(state => {
      const record = state.inbound[messageId]
      if (record?.status === 'completed') return 'completed' as const
      const now = Date.now()
      if (record?.status === 'pending' && record.leaseUntil && Date.parse(record.leaseUntil) > now && record.owner !== this.owner) return 'pending' as const
      state.inbound[messageId] = { status: 'pending', owner: this.owner, leaseUntil: new Date(now + this.lockTimeoutMs).toISOString() }
      return 'claimed' as const
    })
  }

  completeInbound(messageId: string): Promise<void> {
    return this.update(state => {
      const record = state.inbound[messageId]
      if (record?.owner !== this.owner && record?.status === 'pending') throw new Error('bridge inbound ownership lost')
      state.inbound[messageId] = { status: 'completed' }
    })
  }

  failInbound(messageId: string): Promise<void> {
    return this.update(state => { const record = state.inbound[messageId]; if (record?.owner === this.owner) delete state.inbound[messageId] })
  }

  claimHistory(historyId: string): Promise<boolean> {
    return this.update(state => {
      const record = state.histories[historyId]
      if (record?.status === 'completed') return false
      const now = Date.now()
      if (record?.status === 'pending' && record.leaseUntil && Date.parse(record.leaseUntil) > now && record.owner !== this.owner) return false
      state.histories[historyId] = { status: 'pending', owner: this.owner, leaseUntil: new Date(now + this.lockTimeoutMs).toISOString() }
      return true
    })
  }

  completeHistory(historyId: string): Promise<void> {
    return this.update(state => {
      const record = state.histories[historyId]
      if (record?.owner !== this.owner && record?.status === 'pending') throw new Error('history ownership lost')
      state.histories[historyId] = { status: 'completed' }
    })
  }

  renewHistory(historyId: string): Promise<void> {
    return this.update(state => {
      const record = state.histories[historyId]
      if (record?.status !== 'pending' || record.owner !== this.owner) throw new Error('history ownership lost')
      record.leaseUntil = new Date(Date.now() + this.lockTimeoutMs).toISOString()
    })
  }

  failHistory(historyId: string): Promise<void> {
    return this.update(state => { if (state.histories[historyId]?.owner === this.owner) delete state.histories[historyId] })
  }

  trace(record: TraceRecord): Promise<void> {
    if (!record.type || record.type.length > 64 || !record.at || (record.key && record.key.length > MAX_ID) || (record.reason && record.reason.length > 256)) throw new Error('Malformed bridge trace')
    const parsed = { ...record, key: record.key?.slice(0, MAX_ID), reason: record.reason?.slice(0, 256) }
    return this.update(state => { state.traces.push(parsed); if (state.traces.length > MAX_TRACES) state.traces.splice(0, state.traces.length - MAX_TRACES) })
  }

  nextSequence(sessionId: string): Promise<number> {
    return this.update(state => { const next = (state.sequences[sessionId] ?? 0) + 1; state.sequences[sessionId] = next; return next })
  }

  acceptOutbound(key: string): Promise<boolean> {
    return this.claimOutbound(key).then(result => result === 'claimed')
  }

  claimOutbound(key: string): Promise<OutboundClaim> {
    this.assertId(key)
    return this.update(state => {
      const current = state.outbound[key]
      if (current?.status === 'sent') return 'sent'
      if (current?.status === 'unknown') return 'unknown'
      const now = Date.now()
      if (current?.status === 'pending' && current.owner !== this.owner && current.leaseUntil && Date.parse(current.leaseUntil) > now) return 'pending'
      state.outbound[key] = { status: 'pending', owner: this.owner, leaseUntil: new Date(now + this.lockTimeoutMs).toISOString() }
      return 'claimed'
    })
  }

  completeOutbound(key: string): Promise<void> {
    return this.update(state => {
      const current = state.outbound[key]
      if (current?.status === 'pending' && current.owner !== this.owner) throw new Error('bridge outbound ownership lost')
      state.outbound[key] = { status: 'sent' }
    })
  }

  markOutboundUnknown(key: string): Promise<void> {
    return this.update(state => {
      const current = state.outbound[key]
      if (current?.status === 'pending' && current.owner !== this.owner) throw new Error('bridge outbound ownership lost')
      state.outbound[key] = { status: 'unknown' }
    })
  }

  reconcileOutbound(key: string, decision: 'retry' | 'sent'): Promise<void> {
    return this.update(state => {
      const current = state.outbound[key]
      if (current?.status !== 'unknown') throw new Error('outbound reconciliation requires unknown outcome')
      if (decision === 'retry') delete state.outbound[key]
      else state.outbound[key] = { status: 'sent' }
    })
  }

  failOutbound(key: string): Promise<void> {
    return this.markOutboundUnknown(key)
  }

  private update<T>(operation: (state: StateFile) => T): Promise<T> {
    const run = this.queue.then(async () => {
      await this.assertSafePath()
      const lock = await this.acquireLock()
      try {
        const state = await this.read()
        const result = operation(state)
        await mkdir(dirname(this.filename), { recursive: true })
        const temporary = `${this.filename}.tmp-${process.pid}-${randomUUID()}`
        try { await writeFile(temporary, JSON.stringify(state) + '\n', { encoding: 'utf8', flag: 'wx' }); await rename(temporary, this.filename) }
        finally { await rm(temporary, { force: true }).catch(() => undefined) }
        return result
      } finally { await this.releaseLock(lock) }
    })
    this.queue = run.catch(() => undefined)
    return run
  }

  private async acquireLock(): Promise<string> {
    const lock = `${this.filename}.lock`; const deadline = Date.now() + this.lockTimeoutMs
    await mkdir(dirname(this.filename), { recursive: true })
    while (true) {
      try { await mkdir(lock); await writeFile(join(lock, 'owner.json'), JSON.stringify({ token: this.owner, pid: process.pid, leaseUntil: new Date(Date.now() + this.lockTimeoutMs).toISOString() }) + '\n', { encoding: 'utf8', flag: 'wx' }); return lock }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        if (await this.reclaimStaleLock(lock)) continue
        if (Date.now() >= deadline) throw new Error('bridge state lock timeout')
        await new Promise(resolve => setTimeout(resolve, 25))
      }
    }
  }

  private async reclaimStaleLock(lock: string): Promise<boolean> {
    let owner: LockOwner
    try { owner = parseLockOwner(JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8'))) } catch { return false }
    if (Date.parse(owner.leaseUntil) > Date.now()) return false
    const tombstone = `${lock}.${randomUUID()}.stale`
    try { await rename(lock, tombstone) } catch { return false }
    try {
      const current = parseLockOwner(JSON.parse(await readFile(join(tombstone, 'owner.json'), 'utf8')))
      if (current.token !== owner.token || Date.parse(current.leaseUntil) > Date.now()) return false
      await rm(tombstone, { recursive: true, force: true }); return true
    } finally {
      try { await lstat(tombstone); await rename(tombstone, lock) } catch { /* reclaimed or already replaced */ }
    }
  }

  private async releaseLock(lock: string): Promise<void> {
    try {
      const owner = parseLockOwner(JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')))
      if (owner.token === this.owner) await rm(lock, { recursive: true, force: true })
    } catch { /* preserve locks whose ownership cannot be proven */ }
  }

  private assertId(value: string): void {
    if (typeof value !== 'string' || value.length < 1 || value.length > MAX_ID) throw new Error('bridge state id exceeds bounds')
  }

  private async assertSafePath(): Promise<void> {
    const filename = resolve(this.filename)
    let current = filename
    while (true) {
      try {
        const stat = await lstat(current)
        if (stat.isSymbolicLink()) throw new Error(`bridge state path may not contain symlink: ${current}`)
        if (resolve(await realpath(current)) !== current) throw new Error(`bridge state path is not canonical: ${current}`)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      const parent = parse(current).root === current ? current : resolve(current, '..')
      if (parent === current) break
      current = parent
    }
  }

  private async read(): Promise<StateFile> {
    try {
      const parsed = JSON.parse(await readFile(this.filename, 'utf8')) as Record<string, unknown>
      const allowed = new Set(['inbound', 'outbound', 'sequences', 'histories', 'traces'])
      if (Object.keys(parsed).some(key => !allowed.has(key))) throw new Error('Malformed bridge state: unknown field')
      const inbound: Record<string, InboundRecord> = {}
      if (Array.isArray(parsed.inbound)) {
        for (const id of parsed.inbound) { this.assertId(String(id)); inbound[String(id)] = { status: 'completed' } }
      } else if (parsed.inbound && typeof parsed.inbound === 'object') {
        for (const [id, value] of Object.entries(parsed.inbound as Record<string, unknown>)) { this.assertId(id); inbound[id] = parseInbound(value) }
      } else if (parsed.inbound !== undefined) throw new Error('Malformed bridge state: inbound')
      const outbound: Record<string, OutboundRecord> = {}
      if (Array.isArray(parsed.outbound)) for (const key of parsed.outbound) { this.assertId(String(key)); outbound[String(key)] = { status: 'sent' } }
      else if (parsed.outbound && typeof parsed.outbound === 'object') for (const [key, value] of Object.entries(parsed.outbound as Record<string, unknown>)) { this.assertId(key); outbound[key] = parseLease(value) }
      else if (parsed.outbound !== undefined) throw new Error('Malformed bridge state: outbound')
      const sequences = parsed.sequences && typeof parsed.sequences === 'object' ? Object.fromEntries(Object.entries(parsed.sequences).map(([key, value]) => { this.assertId(key); if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > MAX_SEQ) throw new Error('bridge sequence exceeds bounds'); return [key, value] })) as Record<string, number> : {}
      const histories: Record<string, HistoryRecordState> = {}
      if (parsed.histories && typeof parsed.histories === 'object') {
        for (const [id, value] of Object.entries(parsed.histories as Record<string, unknown>)) { this.assertId(id); histories[id] = parseInbound(value) }
      }
      const traces = Array.isArray(parsed.traces) ? parsed.traces.map(value => parseTrace(value)) : parsed.traces === undefined ? [] : (() => { throw new Error('Malformed bridge state: traces') })()
      if (traces.length > MAX_TRACES) throw new Error('bridge trace state exceeds bounds')
      if (Object.keys(inbound).length > MAX_ENTRIES || Object.keys(outbound).length > MAX_ENTRIES || Object.keys(sequences).length > MAX_ENTRIES || Object.keys(histories).length > MAX_ENTRIES) throw new Error('bridge state exceeds entry bounds')
      return { inbound, outbound, sequences, histories, traces }
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { inbound: {}, outbound: {}, sequences: {}, histories: {}, traces: [] }; throw error }
  }
}
