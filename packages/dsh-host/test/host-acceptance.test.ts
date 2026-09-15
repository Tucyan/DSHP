import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'

const run = promisify(execFile)
const repoRoot = path.resolve(import.meta.dirname, '../../..')

describe('offline Host acceptance', () => {
  it('runs the built no-credentials smoke workflow in an isolated temporary root', async () => {
    const { stdout } = await run(process.execPath, [path.join(repoRoot, 'scripts', 'host-offline-smoke.mjs')], {
      cwd: repoRoot,
      env: { ...process.env, CI: '1' },
      maxBuffer: 1024 * 1024,
    })
    const result = JSON.parse(stdout) as {
      ok: boolean
      malformedAction: { type: string; attempts: number }
      memory: { revisions: number; generations: number }
      skill: { created: boolean; replayCreated: boolean; discoverable: boolean }
      heartbeat: { ready: boolean; fixtureFields: Record<string, boolean> }
    }
    expect(result.ok).toBe(true)
    expect(result.malformedAction).toEqual({ type: 'NOOP', attempts: 2 })
    expect(result.memory).toMatchObject({ revisions: 3, generations: 1 })
    expect(result.skill).toMatchObject({ created: true, replayCreated: false, discoverable: true, catalogLoaded: true })
    expect(result.heartbeat).toMatchObject({ ready: true, fixtureFields: { goal: true, schedule: true, recent: true, contact: true } })
  })
})
