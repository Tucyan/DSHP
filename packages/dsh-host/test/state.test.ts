import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
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
})
