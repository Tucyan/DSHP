import process from 'node:process'
import console from 'node:console'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL, URL } from 'node:url'

// Explicitly opt-in: uses the configured model, but never instantiates a QQ transport.
if (process.env.DSHP_LIVE_SMOKE !== '1' || !process.env.DEEPSEEK_API_KEY) {
  console.error('Set DSHP_LIVE_SMOKE=1 and configure DEEPSEEK_API_KEY to run isolated model acceptance.')
  process.exitCode = 1
} else {
  const root = await mkdtemp(join(tmpdir(), 'dsh-live-smoke-'))
  const previousCwd = process.cwd()
  let ctx, phase = 'initialize'
  const disposeContext = async () => {
    if (!ctx) return
    const current = ctx; ctx = undefined
    if (typeof current.dispose === 'function') await current.dispose()
    else await current.fiber.dispose()
  }
  try {
    const workspace = join(root, 'workspace'), runtime = join(root, 'runtime'), agentsHome = join(runtime, 'agents-home')
    const configPath = join(runtime, 'dsh-home', 'profiles', 'personal-growth', 'cordis.yml')
    await mkdir(workspace, { recursive: true }); await mkdir(join(configPath, '..'), { recursive: true })
    await writeFile(configPath, '[]\n')
    Object.assign(process.env, { DSH_HOME: join(runtime, 'dsh-home'), DSH_AGENTS_HOME: agentsHome, PGA_REPO_ROOT: root, PERSONAL_GROWTH_WORKSPACE: workspace, DSH_WORKSPACE: workspace })
    process.chdir(workspace)
    const { bootPersonalGrowth } = await import('../packages/dsh-host/dist/composition.js')
    const { createReadOnlyHiddenAgentSetup, resolveDefaultAgentOptions } = await import('../packages/dsh-host/dist/plugin.js')
    const { DREAM_PROPOSAL_CONTRACT, DreamBatchStore } = await import('../packages/dsh-host/dist/dream-batch.js')
    const { requestHiddenAction } = await import('../packages/dsh-host/dist/hidden-action.js')
    const { executeSkillAction } = await import('../packages/dsh-host/dist/skill-action.js')
    const { MemoryService } = await import('../packages/personal-memory/dist/index.js')
    const { ExtensionWriter } = await import('../packages/runtime/dist/index.js')
    const hostRequire = createRequire(new URL('../packages/dsh-host/package.json', import.meta.url))
    const { SessionId } = await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-session')).href)
    const { createUserMessage } = await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-llm')).href)
    phase = 'boot'
    ctx = await bootPersonalGrowth(configPath, { appId: 'isolated-fixture', appSecret: 'isolated-fixture', allowedPeerId: 'isolated-fixture', workspaceRoot: workspace, runtimeRoot: runtime, agentsHome, admin: false, cadence: {}, bot: { onMessage() {}, async start() {}, async stop() {}, async sendText() { throw new Error('QQ sends forbidden') } } })
    const options = resolveDefaultAgentOptions(ctx)
    const handles = []
    async function generator(id) {
      const handle = await ctx.agents.create({ sessionId: SessionId(id), agentOptions: options, setup: createReadOnlyHiddenAgentSetup() })
      handles.push(handle)
      return async prompt => {
        const start = handle.agent.session.events.length
        handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'plugin', plugin: 'isolated-model-smoke', form: 'snapshot', sections: [{ name: 'fixture', text: prompt }] } }))
        await handle.agent.whenIdle()
        const events = handle.agent.session.events.slice(start)
        const end = events.findLast(event => event.type === 'turn/end')
        if (end?.data.reason.kind !== 'completed') throw new Error('model turn did not complete')
        return events.filter(event => event.type === 'assistant/message').at(-1)?.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('') ?? ''
      }
    }
    phase = 'dream-model'
    const dream = await generator('isolated-dream-smoke')
    const memory = new MemoryService({ workspaceRoot: workspace })
    const batches = new DreamBatchStore(workspace)
    await batches.run('isolated-fixture', async () => JSON.parse(await dream(`${DREAM_PROPOSAL_CONTRACT}\n本次只处理明确指定的虚构验收事实，输出恰好三项 CREATE，路径分别为 preferences/sleep.md、preferences/study.md、preferences/exercise.md。事实：测试用户长期偏好22点前睡觉、每天早上复习、周末散步。这些都是高频稳定偏好。没有已有记忆。`)), proposal => memory.apply(proposal))
    const revisionCount = (await memory.revisions()).length
    if (revisionCount !== 3) throw new Error('expected three independent facts')
    phase = 'skill-model'
    const maintenance = await generator('isolated-maintenance-smoke')
    const action = await requestHiddenAction('maintenance', { type: 'background_heartbeat', occurrenceId: 'isolated-skill', at: new Date().toISOString() }, '隔离验收要求：必须提出 CREATE_SKILL，name 为 isolated-review，instructions 描述如何复习用户提供的笔记。不要输出任何个人事实、不要执行工具。', maintenance)
    if (action.type !== 'CREATE_SKILL') throw new Error('model did not propose requested skill')
    const skill = await executeSkillAction(new ExtensionWriter(agentsHome, runtime), action)
    phase = 'skill-catalog'
    // Public catalog queries prove visibility through the booted DSH registry.
    const catalog = await ctx.skills.list({ cwd: workspace })
    const found = catalog.find(item => item.name === action.name)
    if (!found) throw new Error('generated skill not in catalog')
    const loaded = await ctx.skills.get(action.name, { cwd: workspace })
    if (!loaded?.content) throw new Error('generated skill did not load')
    phase = 'restart'
    for (const handle of handles) await handle.dispose()
    await disposeContext()
    const restored = new MemoryService({ workspaceRoot: workspace })
    await new DreamBatchStore(workspace).run('isolated-fixture', async () => { throw new Error('unexpected regeneration') }, proposal => restored.apply(proposal))
    if ((await restored.revisions()).length !== 3) throw new Error('recovery duplicated memory')
    console.log(JSON.stringify({ ok: true, modelMemoryFacts: revisionCount, modelSkillCreated: skill.created, sdkCatalogLoaded: true, memoryReplay: 'passed', qqSends: 0 }))
  } catch (error) {
    console.error(JSON.stringify({ ok: false, phase, errorType: error?.constructor?.name ?? 'unknown' }))
    process.exitCode = 1
  } finally {
    await disposeContext()
    process.chdir(previousCwd)
    await rm(root, { recursive: true, force: true })
  }
}
