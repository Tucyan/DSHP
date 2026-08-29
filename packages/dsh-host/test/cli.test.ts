import { describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../src/composition.js', () => ({
  bootPersonalGrowth: vi.fn().mockResolvedValue({ dispose: vi.fn().mockResolvedValue(undefined) }),
}))
import * as cli from '../src/cli.js'

type CliConfig = {
  assertLiveQqConfig: (input: { peerId: string; appId: string; appSecret: string }) => void
  getPersonalGrowthConfigPath: (env: NodeJS.ProcessEnv, cwd: string) => string
  resolvePersonalGrowthWorkspace: (env: NodeJS.ProcessEnv, cwd: string) => string
}
const configuredCli = cli as unknown as CliConfig

describe('personal growth host CLI configuration', () => {
  it('uses the configured DSH workspace without nesting it under the current directory', () => {
    const workspace = resolve('isolated-workspace')
    expect(configuredCli.resolvePersonalGrowthWorkspace({ DSH_WORKSPACE: workspace }, workspace)).toBe(workspace)
    expect(configuredCli.resolvePersonalGrowthWorkspace({ PERSONAL_GROWTH_WORKSPACE: workspace }, resolve(workspace, 'nested'))).toBe(workspace)
  })

  it('keeps the generated profile configuration inside the isolated DSH home', () => {
    const dshHome = resolve('isolated-dsh-home')
    expect(configuredCli.getPersonalGrowthConfigPath({ DSH_HOME: dshHome }, resolve('fallback'))).toBe(
      resolve(dshHome, 'profiles', 'personal-growth', 'cordis.yml'),
    )
  })

  it('validates live QQ peer and credentials without reading credential files', () => {
    expect(() => configuredCli.assertLiveQqConfig({ peerId: '12345', appId: 'appid', appSecret: 'secret' })).not.toThrow()
    expect(() => configuredCli.assertLiveQqConfig({ peerId: '12:345', appId: 'appid', appSecret: 'secret' })).toThrow(/PeerId/)
    expect(() => configuredCli.assertLiveQqConfig({ peerId: '12345', appId: '', appSecret: 'secret' })).toThrow(/QQBOT_APPID/)
  })
})
