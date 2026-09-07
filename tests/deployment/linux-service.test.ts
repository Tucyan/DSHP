import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('Linux server deployment', () => {
  it('renders a bounded systemd unit without touching nginx', () => {
    const unit = execFileSync(process.execPath, [
      'scripts/render-systemd.mjs',
      '--repo', '/opt/dshp',
      '--node', '/root/.nvm/versions/node/v24.11.0/bin/node',
    ], { encoding: 'utf8' })

    expect(unit).toContain('EnvironmentFile=/etc/dshp/dshp.env')
    expect(unit).toContain('WorkingDirectory=/opt/dshp/workspace')
    expect(unit).toContain('ExecStart=/root/.nvm/versions/node/v24.11.0/bin/node /opt/dshp/packages/dsh-host/dist/cli.js --live-qq')
    expect(unit).toContain('MemoryMax=1200M')
    expect(unit).toContain('CPUQuota=150%')
    expect(unit).toContain('ReadWritePaths=/opt/dshp/runtime /opt/dshp/workspace')
    expect(unit).not.toMatch(/nginx/i)
  })

  it('rejects paths that systemd could parse as extra directives', () => {
    expect(() => execFileSync(process.execPath, [
      'scripts/render-systemd.mjs',
      '--repo', '/opt/dshp\nExecStart=/bin/false',
      '--node', '/usr/bin/node',
    ], { encoding: 'utf8', stdio: 'pipe' })).toThrow()
  })

  it('documents every required secret and keeps admin on loopback port 3182', () => {
    const template = readFileSync('.env.server.example', 'utf8')
    const gitignore = readFileSync('.gitignore', 'utf8')
    expect(template).toContain('QQBOT_APP_ID=')
    expect(template).toContain('QQBOT_APP_SECRET=')
    expect(template).toContain('QQBOT_ALLOWED_PEER_ID=')
    expect(template).toContain('DEEPSEEK_API_KEY=')
    expect(template).toContain('PGA_ADMIN_PORT=3182')
    expect(template).toContain('DSH_PERMISSION_MODE=workspace-write')
    expect(template).not.toMatch(/replace-with|provided-at-process/i)
    expect(gitignore).toContain('!.env.server.example')
  })
})
