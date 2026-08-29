import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve, join } from 'node:path'
import { bootPersonalGrowth } from './composition.js'

export function resolvePersonalGrowthWorkspace(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  const configured = env.PERSONAL_GROWTH_WORKSPACE?.trim() || env.DSH_WORKSPACE?.trim()
  return resolve(configured || join(cwd, 'workspace'))
}

export function getPersonalGrowthConfigPath(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  const dshHome = resolve(env.DSH_HOME?.trim() || join(cwd, 'runtime', 'dsh-home'))
  return join(dshHome, 'profiles', 'personal-growth', 'cordis.yml')
}

export function assertLiveQqConfig(input: { peerId?: string; appId?: string; appSecret?: string }): void {
  const peerId = input.peerId?.trim()
  const hasControl = peerId ? [...peerId].some(character => {
    const code = character.codePointAt(0) ?? 0
    return code <= 0x1f || code === 0x7f
  }) : false
  if (!peerId || hasControl || /[\s:[\]"\\]/u.test(peerId)) {
    throw new Error('Live QQ requires one safe PeerId or QQ_PEER_ID.')
  }
  if (!input.appId || !input.appSecret) {
    throw new Error('Live QQ requires QQBOT_APPID and QQBOT_SECRET in the process environment; no credential file is read.')
  }
}

export async function runPersonalGrowthHost(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const workspace = resolvePersonalGrowthWorkspace(env)
  env.PERSONAL_GROWTH_WORKSPACE = workspace
  env.DSH_WORKSPACE ??= workspace
  if (env.QQBOT_ALLOWED_PEER_ID || env.QQBOT_APP_ID || env.QQBOT_APP_SECRET) {
    assertLiveQqConfig({ peerId: env.QQBOT_ALLOWED_PEER_ID, appId: env.QQBOT_APP_ID, appSecret: env.QQBOT_APP_SECRET })
  }
  const configPath = getPersonalGrowthConfigPath(env)
  await mkdir(resolve(configPath, '..'), { recursive: true })
  await writeFile(configPath, '[]\n', { flag: 'wx' }).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  })
  const ctx = await bootPersonalGrowth(configPath, {
    appId: env.QQBOT_APP_ID,
    appSecret: env.QQBOT_APP_SECRET,
    allowedPeerId: env.QQBOT_ALLOWED_PEER_ID,
    accountId: env.QQBOT_ACCOUNT_ID,
  })
  const dispose = (ctx as unknown as { dispose?: () => Promise<void> }).dispose
  if (!dispose) throw new Error('DSH boot context does not expose public dispose()')
  process.once('SIGINT', () => { void dispose.call(ctx) })
  process.once('SIGTERM', () => { void dispose.call(ctx) })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runPersonalGrowthHost().catch(error => {
    console.error(error instanceof Error ? error.message : 'personal growth host failed')
    process.exitCode = 1
  })
}
