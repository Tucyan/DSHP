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

  it('uses durable outbound pending and sent states with explicit reconcile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pga-host-outbound-'))
    try {
      const file = join(root, 'bridge.json')
      const first = new FileBridgeState(file)
      const second = new FileBridgeState(file)
      expect(await first.claimOutbound('o1')).toBe('claimed')
      expect(await second.claimOutbound('o1')).toBe('pending')
      await first.markOutboundUnknown('o1')
      expect(await second.claimOutbound('o1')).toBe('unknown')
      await second.reconcileOutbound('o1', 'retry')
      expect(await second.claimOutbound('o1')).toBe('claimed')
      await second.completeOutbound('o1')
      expect(await first.claimOutbound('o1')).toBe('sent')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('reclaims only a proven expired lock owner before operating', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pga-host-lock-'))
    try {
      const file = join(root, 'bridge.json')
      const lock = `${file}.lock`
      await mkdir(lock, { recursive: true })
      await writeFile(join(lock, 'owner.json'), JSON.stringify({ token: '00000000-0000-4000-8000-000000000001', pid: 1, leaseUntil: '2020-01-01T00:00:00.000Z' }))
      expect(await new FileBridgeState(file).nextSequence('s')).toBe(1)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
