import { describe, it, expect } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HeartbeatService } from '@personal-growth/personal-heartbeat'
import { ForegroundWakeRunner } from '../src/foreground-wake.js'

describe('durable main agent heartbeat', () => {
  it('allows quiet work, denies contact, and deduplicates after reopening', async () => {
    const root = await mkdtemp(join(tmpdir(), 'main-wake-'))
    try {
      const service = new HeartbeatService({ workspace: root, config: { timeZone: 'Asia/Singapore' } })
      const runner = new ForegroundWakeRunner(service, () => '2026-09-15T16:30:00Z')
      let runs = 0, sends = 0
      await runner.run({ occurrenceId: 'wake' }, async () => { runs++; expect(await runner.deliver('message', async () => { sends++; return 'sent' })).toBe('denied') })
      const reopened = new ForegroundWakeRunner(new HeartbeatService({ workspace: root }))
      expect(await reopened.run({ occurrenceId: 'wake' }, async () => { runs++ })).toMatchObject({ status: 'duplicate' })
      expect({ runs, sends }).toEqual({ runs: 1, sends: 0 })
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('records confirmed contacts and does not retry unknown delivery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'main-wake-'))
    try {
      const service = new HeartbeatService({ workspace: root, config: { cooldownMinutes: 0 } })
      const runner = new ForegroundWakeRunner(service, () => '2026-09-15T08:30:00Z')
      expect(await runner.deliver('one', async () => 'sent')).toBe('sent')
      let attempts = 0
      await expect(runner.deliver('two', async () => { attempts++; throw new Error('timeout') })).rejects.toThrow('timeout')
      expect(await runner.deliver('two', async () => { attempts++; return 'sent' })).toBe('unknown')
      expect(attempts).toBe(1)
      const state = await service.ledger.read()
      expect(state.contacts).toHaveLength(1)
      expect(state.reservations).toHaveLength(1)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
