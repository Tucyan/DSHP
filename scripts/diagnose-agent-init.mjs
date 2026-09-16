import { mkdtemp, mkdir, writeFile, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import console from 'node:console'
const repo = process.cwd()
const root = await mkdtemp(join(tmpdir(), 'dshp-init-diagnostic-'))
const workspace = join(root, 'workspace'), runtime = join(root, 'runtime')
await mkdir(join(runtime, 'dsh-home', 'profiles', 'personal-growth'), { recursive: true })
await cp(join(repo, 'workspace'), workspace, { recursive: true })
await cp(join(repo, 'runtime', 'dsh-home', 'sessions'), join(runtime, 'dsh-home', 'sessions'), { recursive: true })
await cp(join(repo, 'runtime', 'dsh-home', 'settings.yaml'), join(runtime, 'dsh-home', 'settings.yaml'))
const config = join(runtime, 'dsh-home', 'profiles', 'personal-growth', 'cordis.yml')
await writeFile(config, '[]\n')
Object.assign(process.env, { DSH_HOME: join(runtime, 'dsh-home'), DSH_AGENTS_HOME: join(runtime, 'agents-home'), PGA_REPO_ROOT: root, PERSONAL_GROWTH_WORKSPACE: workspace, DSH_WORKSPACE: workspace })
delete process.env.DEEPSEEK_API_KEY
globalThis.fetch = async () => { throw new Error('diagnostic forbids network requests') }
const { bootPersonalGrowth } = await import('../packages/dsh-host/dist/composition.js')
const { createDshAgentRegistry, installForegroundMessageDelivery } = await import('../packages/dsh-host/dist/plugin.js')
let ctx, agent
try {
  process.chdir(workspace)
  ctx = await bootPersonalGrowth(config, { appId: 'fixture', appSecret: 'fixture', allowedPeerId: 'fixture', workspaceRoot: workspace, runtimeRoot: runtime, agentsHome: join(runtime, 'agents-home'), admin: false, cadence: {}, bot: { onMessage() {}, async start() {}, async stop() {}, async sendText() { throw new Error('diagnostic forbids QQ sends') } } })
  const snapshots = await ctx.sessionPersistence.listSnapshots()
  const sessionId = snapshots.find(s => !String(s.header.id).includes('hidden'))?.header.id
  const registry = createDshAgentRegistry(ctx, undefined, undefined, scoped => {
    installForegroundMessageDelivery(scoped, async () => { throw new Error('diagnostic forbids send') })
    scoped.tools.guard(() => undefined)
  })
  agent = await registry.resume({ sessionId: String(sessionId) })
  console.log(JSON.stringify({ ok: true, phase: 'resume-with-production-tool-setup', root }))
} catch (error) {
  console.error(error.stack)
  process.exitCode = 1
} finally {
  await agent?.dispose?.()
  if (ctx) await ctx.fiber.dispose()
}
