import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { BridgeState } from './bridge.js'

interface InboundRecord { status: 'pending' | 'completed'; owner?: string; leaseUntil?: string }
interface StateFile { inbound: Record<string, InboundRecord>; outbound: string[]; sequences: Record<string, number> }

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
    return this.update(state => { const record = state.inbound[messageId]; if (record?.owner === this.owner || record?.status === 'pending') delete state.inbound[messageId] })
  }

  nextSequence(sessionId: string): Promise<number> {
    return this.update(state => { const next = (state.sequences[sessionId] ?? 0) + 1; state.sequences[sessionId] = next; return next })
  }

  acceptOutbound(key: string): Promise<boolean> {
    return this.update(state => { if (state.outbound.includes(key)) return false; state.outbound.push(key); return true })
  }

  failOutbound(key: string): Promise<void> {
    return this.update(state => { state.outbound = state.outbound.filter(candidate => candidate !== key) })
  }

  private update<T>(operation: (state: StateFile) => T): Promise<T> {
    const run = this.queue.then(async () => {
      const lock = await this.acquireLock()
      try {
        const state = await this.read()
        const result = operation(state)
        await mkdir(dirname(this.filename), { recursive: true })
        const temporary = `${this.filename}.tmp-${process.pid}-${randomUUID()}`
        try { await writeFile(temporary, JSON.stringify(state) + '\n', { encoding: 'utf8', flag: 'wx' }); await rename(temporary, this.filename) }
        finally { await rm(temporary, { force: true }).catch(() => undefined) }
        return result
      } finally { await rm(lock, { recursive: true, force: true }).catch(() => undefined) }
    })
    this.queue = run.catch(() => undefined)
    return run
  }

  private async acquireLock(): Promise<string> {
    const lock = `${this.filename}.lock`; const deadline = Date.now() + this.lockTimeoutMs
    while (true) {
      try { await mkdir(lock); return lock }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; if (Date.now() >= deadline) throw new Error('bridge state lock timeout'); await new Promise(resolve => setTimeout(resolve, 25)) }
    }
  }

  private async read(): Promise<StateFile> {
    try {
      const parsed = JSON.parse(await readFile(this.filename, 'utf8')) as Partial<StateFile> & { inbound?: unknown }
      const inbound: Record<string, InboundRecord> = {}
      if (Array.isArray(parsed.inbound)) {
        for (const id of parsed.inbound) if (typeof id === 'string' && id) inbound[id] = { status: 'completed' }
      } else if (parsed.inbound && typeof parsed.inbound === 'object') {
        for (const [id, value] of Object.entries(parsed.inbound as Record<string, unknown>)) if (value && typeof value === 'object' && ((value as InboundRecord).status === 'pending' || (value as InboundRecord).status === 'completed')) inbound[id] = value as InboundRecord
      }
      const outbound = Array.isArray(parsed.outbound) ? parsed.outbound.filter((value): value is string => typeof value === 'string' && value.length > 0) : []
      const sequences = parsed.sequences && typeof parsed.sequences === 'object' ? Object.fromEntries(Object.entries(parsed.sequences).filter(([, value]) => Number.isInteger(value) && (value as number) >= 0)) as Record<string, number> : {}
      return { inbound, outbound, sequences }
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { inbound: {}, outbound: [], sequences: {} }; throw error }
  }
}
