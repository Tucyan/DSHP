import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { bootPersonalGrowth } from './composition.js'
import { resolveIsolatedPaths, validateIsolatedPathsAsync } from '@personal-growth/dsh-adapter'

export function resolveProjectRoot(env: NodeJS.ProcessEnv = process.env, moduleUrl = import.meta.url): string {
  const configured = env.PGA_REPO_ROOT?.trim()
  return configured ? resolve(configured) : resolve(dirname(fileURLToPath(moduleUrl)), '..', '..', '..')
}

export function resolvePersonalGrowthWorkspace(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PERSONAL_GROWTH_WORKSPACE?.trim() || env.DSH_WORKSPACE?.trim()
  return resolve(configured || join(resolveProjectRoot(env), 'workspace'))
}

export function getPersonalGrowthConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const dshHome = resolve(env.DSH_HOME?.trim() || join(resolveProjectRoot(env), 'runtime', 'dsh-home'))
  return join(dshHome, 'profiles', 'personal-growth', 'cordis.yml')
}

export function normalizeLiveQqConfig(input: { peerId?: string; appId?: string; appSecret?: string }): { peerId: string; appId: string; appSecret: string } {
  const peerId = input.peerId
  const normalizedPeerId = peerId?.trim()
  const appId = input.appId?.trim()
  const appSecret = input.appSecret?.trim()
  const hasControl = peerId ? [...peerId].some(character => {
    const code = character.codePointAt(0) ?? 0
    return code <= 0x1f || code === 0x7f
  }) : false
  if (!peerId || !normalizedPeerId || peerId !== normalizedPeerId || hasControl || /[\s:[\]"\\]/u.test(peerId)) {
    throw new Error('Live QQ requires one safe PeerId or QQ_PEER_ID.')
  }
  if (!appId || !appSecret) {
    throw new Error('Live QQ requires QQBOT_APPID and QQBOT_SECRET in the process environment; no credential file is read.')
  }
  return { peerId: normalizedPeerId, appId, appSecret }
}

export function assertLiveQqConfig(input: { peerId?: string; appId?: string; appSecret?: string }): void {
  normalizeLiveQqConfig(input)
}

export function createIdempotentShutdown(dispose: () => Promise<void> | void, report: (error: unknown) => void = error => {
  console.error(error instanceof Error ? error.message : 'personal growth host shutdown failed')
}): () => Promise<void> {
  let closing: Promise<void> | undefined
  return () => {
    closing ??= Promise.resolve().then(dispose).catch(error => {
      try { report(error) } catch { /* reporting must not create an unhandled rejection */ }
    })
    return closing
  }
}

export async function runPersonalGrowthHost(env: NodeJS.ProcessEnv = process.env, options: { liveQq?: boolean } = {}): Promise<void> {
  const liveQq = options.liveQq ?? process.argv.includes('--live-qq')
  if (!liveQq) throw new Error('Personal growth host CLI requires --live-qq; non-live mode is not supported.')
  const projectRoot = resolveProjectRoot(env)
  const isolated = resolveIsolatedPaths(projectRoot)
  // Validate before creating any profile/config file. This rejects home
  // defaults, external paths and symlink/junction escapes at the CLI boundary.
  await validateIsolatedPathsAsync(isolated)
  env.DSH_HOME = isolated.dshHome
  env.DSH_AGENTS_HOME = isolated.agentsHome
  const workspace = isolated.workspace
  env.PERSONAL_GROWTH_WORKSPACE = workspace
  env.DSH_WORKSPACE = workspace
  const qqConfig = normalizeLiveQqConfig({ peerId: env.QQBOT_ALLOWED_PEER_ID, appId: env.QQBOT_APP_ID, appSecret: env.QQBOT_APP_SECRET })
  const adminPort = Number(env.PGA_ADMIN_PORT ?? 3182)
  if (!Number.isInteger(adminPort) || adminPort < 1024 || adminPort > 65535) throw new Error('PGA_ADMIN_PORT must be an integer from 1024 to 65535')
  const configPath = join(isolated.dshHome, 'profiles', 'personal-growth', 'cordis.yml')
  await mkdir(resolve(configPath, '..'), { recursive: true })
  await writeFile(configPath, '[]\n', { flag: 'wx' }).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  })
  const ctx = await bootPersonalGrowth(configPath, {
    appId: qqConfig.appId,
    appSecret: qqConfig.appSecret,
    allowedPeerId: qqConfig.peerId,
    accountId: env.QQBOT_ACCOUNT_ID,
    workspaceRoot: isolated.workspace,
    agentsHome: isolated.agentsHome,
    runtimeRoot: join(isolated.root, 'runtime'),
    admin: { port: adminPort },
  })
  const bootContext = ctx as unknown as {
    dispose?: () => Promise<void>
    fiber?: { dispose?: () => Promise<void> }
  }
  const dispose = bootContext.dispose ?? bootContext.fiber?.dispose
  if (!dispose) throw new Error('DSH boot context does not expose public dispose()')
  const shutdown = createIdempotentShutdown(() => dispose.call(bootContext.dispose ? ctx : bootContext.fiber))
  process.once('SIGINT', () => { void shutdown() })
  process.once('SIGTERM', () => { void shutdown() })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runPersonalGrowthHost().catch(error => {
    console.error(error instanceof Error ? error.message : 'personal growth host failed')
    process.exitCode = 1
  })
}
