import { describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  default: {
    realpath: vi.fn().mockImplementation(async (value: string) => value),
    lstat: vi.fn().mockResolvedValue({ isSymbolicLink: () => false }),
  },
}))
vi.mock('../src/composition.js', () => ({
  bootPersonalGrowth: vi.fn().mockResolvedValue({ dispose: vi.fn().mockResolvedValue(undefined) }),
}))
import * as cli from '../src/cli.js'
import { bootPersonalGrowth } from '../src/composition.js'

type CliConfig = {
  createIdempotentShutdown: (dispose: () => Promise<void> | void, report?: (error: unknown) => void) => () => Promise<void>
  assertLiveQqConfig: (input: { peerId: string; appId: string; appSecret: string }) => void
  normalizeLiveQqConfig: (input: { peerId?: string; appId?: string; appSecret?: string }) => { peerId: string; appId: string; appSecret: string }
  getPersonalGrowthConfigPath: (env: NodeJS.ProcessEnv) => string
  resolveProjectRoot: (env?: NodeJS.ProcessEnv, moduleUrl?: string) => string
  resolvePersonalGrowthWorkspace: (env: NodeJS.ProcessEnv) => string
  runPersonalGrowthHost: (env: NodeJS.ProcessEnv, options?: { liveQq?: boolean }) => Promise<void>
}
const configuredCli = cli as unknown as CliConfig

describe('personal growth host CLI configuration', () => {
  it('uses the configured DSH workspace without nesting it under the current directory', () => {
    const workspace = resolve('isolated-workspace')
    expect(configuredCli.resolvePersonalGrowthWorkspace({ DSH_WORKSPACE: workspace })).toBe(workspace)
    expect(configuredCli.resolvePersonalGrowthWorkspace({ PERSONAL_GROWTH_WORKSPACE: workspace })).toBe(workspace)
    expect(configuredCli.resolvePersonalGrowthWorkspace({})).toBe(resolve('workspace'))
    expect(configuredCli.getPersonalGrowthConfigPath({})).toBe(
      resolve('runtime', 'dsh-home', 'profiles', 'personal-growth', 'cordis.yml'),
    )
  })

  it('derives the project root from the CLI module instead of the caller cwd', () => {
    expect(configuredCli.resolveProjectRoot({})).toBe(resolve('.'))
  })

  it('keeps the generated profile configuration inside the isolated DSH home', () => {
    const dshHome = resolve('isolated-dsh-home')
    expect(configuredCli.getPersonalGrowthConfigPath({ DSH_HOME: dshHome })).toBe(
      resolve(dshHome, 'profiles', 'personal-growth', 'cordis.yml'),
    )
    expect(configuredCli.getPersonalGrowthConfigPath({ DSH_HOME: '   ' })).toBe(
      resolve('runtime', 'dsh-home', 'profiles', 'personal-growth', 'cordis.yml'),
    )
  })

  it('validates live QQ peer and credentials without reading credential files', () => {
    expect(() => configuredCli.assertLiveQqConfig({ peerId: '12345', appId: 'appid', appSecret: 'secret' })).not.toThrow()
    expect(() => configuredCli.assertLiveQqConfig({ peerId: '12:345', appId: 'appid', appSecret: 'secret' })).toThrow(/PeerId/)
    expect(() => configuredCli.assertLiveQqConfig({ peerId: '12345', appId: '', appSecret: 'secret' })).toThrow(/QQBOT_APPID/)
    expect(() => configuredCli.assertLiveQqConfig({ peerId: ' 12345', appId: 'appid', appSecret: 'secret' })).toThrow(/PeerId/)
    expect(() => configuredCli.assertLiveQqConfig({ peerId: '12345 ', appId: 'appid', appSecret: 'secret' })).toThrow(/PeerId/)
    expect(() => configuredCli.assertLiveQqConfig({ peerId: '12345', appId: '   ', appSecret: 'secret' })).toThrow(/QQBOT_APPID/)
    expect(() => configuredCli.assertLiveQqConfig({ peerId: '12345', appId: 'appid', appSecret: '   ' })).toThrow(/QQBOT_SECRET/)
    expect(configuredCli.normalizeLiveQqConfig({ peerId: '12345', appId: ' appid ', appSecret: ' secret ' })).toEqual({
      peerId: '12345', appId: 'appid', appSecret: 'secret',
    })
  })

  it('replaces blank runtime paths with project-local isolated defaults before boot', async () => {
    const env: NodeJS.ProcessEnv = { DSH_HOME: '  ', DSH_AGENTS_HOME: '\t', DSH_WORKSPACE: '  ', PERSONAL_GROWTH_WORKSPACE: '', QQBOT_ALLOWED_PEER_ID: '12345' }
    await expect(configuredCli.runPersonalGrowthHost(env, { liveQq: true })).rejects.toThrow(/QQBOT_APPID/)
    expect(env.DSH_HOME).toBe(resolve('runtime', 'dsh-home'))
    expect(env.DSH_AGENTS_HOME).toBe(resolve('runtime', 'agents-home'))
    expect(env.DSH_WORKSPACE).toBe(resolve('workspace'))
    expect(env.PERSONAL_GROWTH_WORKSPACE).toBe(resolve('workspace'))
  })

  it('passes normalized QQ credentials to the boot composition', async () => {
    const boot = vi.mocked(bootPersonalGrowth)
    boot.mockClear()
    await configuredCli.runPersonalGrowthHost({
      QQBOT_ALLOWED_PEER_ID: '12345', QQBOT_APP_ID: ' appid ', QQBOT_APP_SECRET: ' secret ',
    }, { liveQq: true })
    expect(boot).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      appId: 'appid', appSecret: 'secret', allowedPeerId: '12345',
      workspaceRoot: resolve('workspace'),
      agentsHome: resolve('runtime', 'agents-home'),
      runtimeRoot: resolve('runtime'),
    }))
  })

  it('requires explicit live mode before booting the QQ host', async () => {
    await expect(configuredCli.runPersonalGrowthHost({ DSH_HOME: resolve('isolated-dsh-home') }, { liveQq: false })).rejects.toThrow(/--live-qq/)
  })

  it('closes at most once and absorbs shutdown rejection', async () => {
    let calls = 0
    const errors: unknown[] = []
    const shutdown = configuredCli.createIdempotentShutdown(async () => {
      calls += 1
      throw new Error('close failed')
    }, error => errors.push(error))
    await Promise.all([shutdown(), shutdown()])
    expect(calls).toBe(1)
    expect(errors).toHaveLength(1)
  })
})
