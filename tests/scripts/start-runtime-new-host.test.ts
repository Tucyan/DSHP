import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import path from 'node:path'

describe('new host runtime launcher', () => {
  it('dry-runs live QQ with the built host and no legacy web profile', () => {
    const result = execFileSync('pwsh', [
      '-NoProfile', '-File', path.resolve('scripts/start-runtime.ps1'), '-DryRun', '-LiveQQ', '-PeerId', '12345',
    ], { encoding: 'utf8', env: { ...process.env, QQ_PEER_ID: '' } })
    const launch = JSON.parse(result) as { command: string; args: string[]; cwd: string; env: Record<string, string> }
    expect(launch.command).toBe('node')
    expect(launch.args).toEqual(['node', path.resolve('packages/dsh-host/dist/cli.js'), '--live-qq'])
    expect(launch.cwd).toBe(path.resolve('.'))
    expect(launch.env.DSH_WORKSPACE).toBe(path.resolve('workspace'))
    expect(launch.env.PERSONAL_GROWTH_WORKSPACE).toBe(path.resolve('workspace'))
    expect(launch.env.QQBOT_ALLOWED_PEER_ID).toBe('12345')
    expect(result).not.toContain('corepack')
  })
})
