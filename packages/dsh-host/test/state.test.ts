import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileBridgeState } from '../src/state.js'

describe('FileBridgeState', () => {
  it('keeps inbound dedupe and sequence allocation across instances', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pga-host-state-'))
    try {
      const file = join(root, 'bridge.json')
      const first = new FileBridgeState(file)
      expect(await first.claimInbound('m1')).toBe('claimed')
      await first.completeInbound('m1')
      expect(await first.nextSequence('session')).toBe(1)
      const second = new FileBridgeState(file)
      expect(await second.claimInbound('m1')).toBe('completed')
      expect(await second.nextSequence('session')).toBe(2)
      expect(JSON.parse(await readFile(file, 'utf8')).sequences.session).toBe(2)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('claims each history record once across restarts and preserves non-owner safety', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pga-host-history-'))
    try {
      const file = join(root, 'bridge.json')
      const first = new FileBridgeState(file)
      const second = new FileBridgeState(file)
      expect(await first.claimHistory('h1')).toBe(true)
      expect(await second.claimHistory('h1')).toBe(false)
      await first.completeHistory('h1')
      expect(await second.claimHistory('h1')).toBe(false)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('creates a fresh nested state parent before the first operation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pga-host-fresh-'))
    try {
      const file = join(root, 'nested', 'bridge.json')
      expect(await new FileBridgeState(file).nextSequence('s')).toBe(1)
      expect(JSON.parse(await readFile(file, 'utf8')).sequences.s).toBe(1)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('rejects unknown and out-of-bound persisted state instead of silently filtering it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pga-host-schema-'))
    try {
      const file = join(root, 'bridge.json')
      await mkdir(root, { recursive: true })
      await writeFile(file, JSON.stringify({ inbound: {}, outbound: [], sequences: { s: 1000001 }, histories: {}, extra: true }))
      await expect(new FileBridgeState(file).nextSequence('s')).rejects.toThrow(/state|sequence|schema|bound/i)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('rejects array-shaped maps and non-string legacy identifiers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pga-host-strict-shapes-'))
    try {
      const file = join(root, 'bridge.json')
      await writeFile(file, JSON.stringify({ inbound: [1], outbound: [], sequences: [], histories: {} }))
      await expect(new FileBridgeState(file).nextSequence('s')).rejects.toThrow(/malformed/i)
      await writeFile(file, JSON.stringify({ inbound: [], outbound: [null], sequences: {}, histories: [] }))
      await expect(new FileBridgeState(file).nextSequence('s')).rejects.toThrow(/malformed/i)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('rejects sent outbound records carrying stale lease or payload metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pga-host-sent-shape-'))
    try {
      const file = join(root, 'bridge.json')
      await writeFile(file, JSON.stringify({ inbound: {}, outbound: { o1: { status: 'sent', target: { peerId: 'p' }, text: 'stale' } }, sequences: {}, histories: {} }))
      await expect(new FileBridgeState(file).nextSequence('s')).rejects.toThrow(/sent|lease|payload|malformed/i)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('rejects sequence overflow before persisting the increment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pga-host-seq-'))
    try {
      const file = join(root, 'bridge.json')
      await writeFile(file, JSON.stringify({ inbound: {}, outbound: [], sequences: { s: 1000000 }, histories: {}, traces: [] }))
      await expect(new FileBridgeState(file).nextSequence('s')).rejects.toThrow(/sequence|bound/i)
      expect(JSON.parse(await readFile(file, 'utf8')).sequences.s).toBe(1000000)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('uses an atomic single-file owner lock without an owner-file gap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pga-host-lock-file-'))
    try {
      const file = join(root, 'bridge.json')
      const state = new FileBridgeState(file)
      expect(await state.nextSequence('s')).toBe(1)
      await expect(readFile(`${file}.lock-owner`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(`${file}.lock`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('renews an inbound claim only for its owning instance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pga-host-renew-'))
    try {
      const file = join(root, 'bridge.json')
      const first = new FileBridgeState(file)
      const second = new FileBridgeState(file)
      expect(await first.claimInbound('m1')).toBe('claimed')
      await expect(first.renewInbound('m1')).resolves.toBeUndefined()
      await expect(second.renewInbound('m1')).rejects.toThrow(/ownership/i)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('persists pending memory turns and recovers them across state instances', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pga-host-memory-turn-'))
    try {
      const file = join(root, 'bridge.json')
      const first = new FileBridgeState(file)
      const events = [{ sessionId: 's', seq: 1, role: 'user' as const, content: 'hello', at: '2026-01-01T00:00:00.000Z' }]
      expect(await first.claimMemoryTurn('s:turn:1', events)).toBe('claimed')
      const second = new FileBridgeState(file)
      expect(await second.listPendingMemoryTurns()).toEqual([{ key: 's:turn:1', events }])
      await first.completeMemoryTurn('s:turn:1')
      expect(await second.listPendingMemoryTurns()).toEqual([])
      expect(await second.claimMemoryTurn('s:turn:1', events)).toBe('completed')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('allocates a contiguous memory-turn batch and claims it atomically', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pga-host-memory-batch-'))
    try {
      const state = new FileBridgeState(join(root, 'bridge.json'))
      const inputs = [
        { sessionId: 's', role: 'user' as const, content: 'one', at: '2026-01-01T00:00:00.000Z' },
        { sessionId: 's', role: 'assistant' as const, content: 'two', at: '2026-01-01T00:00:01.000Z' },
      ]
      const first = await state.claimMemoryTurnBatch('s:turn:1', 's', inputs)
      expect(first.status).toBe('claimed')
      expect(first.events.map(event => event.seq)).toEqual([1, 2])
      const duplicate = await state.claimMemoryTurnBatch('s:turn:1', 's', inputs)
      expect(duplicate.status).toBe('pending')
      expect(duplicate.events).toEqual(first.events)
      expect(await state.nextSequence('s')).toBe(3)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('uses durable outbound pending and sent states with explicit reconcile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pga-host-outbound-'))
    try {
      const file = join(root, 'bridge.json')
      const first = new FileBridgeState(file)
      const second = new FileBridgeState(file)
      const payload = { target: { peerId: 'peer-1', messageId: 'msg-1' }, text: 'pending text' }
      expect(await first.claimOutbound('o1', payload)).toBe('claimed')
      expect(await first.listPendingOutbound()).toEqual([{ key: 'o1', ...payload }])
      expect(await second.claimOutbound('o1')).toBe('pending')
      await first.markOutboundUnknown('o1')
      expect(await second.claimOutbound('o1')).toBe('unknown')
      await second.reconcileOutbound('o1', 'retry')
      expect(await second.claimOutbound('o1', payload)).toBe('claimed')
      await second.completeOutbound('o1')
      expect(await first.claimOutbound('o1')).toBe('sent')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('reclaims only a proven expired lock owner before operating', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pga-host-lock-'))
    try {
      const file = join(root, 'bridge.json')
      const lock = `${file}.lock-owner`
      await writeFile(lock, JSON.stringify({ token: '00000000-0000-4000-8000-000000000001', pid: 1, leaseUntil: '2020-01-01T00:00:00.000Z' }))
      expect(await new FileBridgeState(file).nextSequence('s')).toBe(1)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
