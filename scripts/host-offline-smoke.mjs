import { mkdtemp, readFile, rm } from 'node:fs/promises'
import process from 'node:process'
import console from 'node:console'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { basePatchPath } from '../packages/dsh-host/dist/composition.js'
import { requestHiddenAction } from '../packages/dsh-host/dist/hidden-action.js'
import { DreamBatchStore } from '../packages/dsh-host/dist/dream-batch.js'
import { buildHeartbeatContext, recentUserConversation } from '../packages/dsh-host/dist/heartbeat-context.js'
import { executeSkillAction } from '../packages/dsh-host/dist/skill-action.js'
import { ExtensionWriter } from '../packages/runtime/dist/index.js'
import { MemoryService } from '../packages/personal-memory/dist/index.js'

const check = (condition, message) => {
  if (!condition) throw new Error(message)
}

const facts = () => ['sleep', 'study', 'exercise'].map(name => ({
  action: 'CREATE',
  path: `preferences/${name}.md`,
  summary: `offline ${name}`,
  content: `Stable offline ${name} preference`,
  sourceEvidence: ['conversation:offline-history'],
  frequency: 'high',
}))

let root
try {
  root = await mkdtemp(join(tmpdir(), 'dsh-host-offline-'))
  const workspace = join(root, 'workspace')
  const agentsHome = join(root, 'agents-home')
  const runtimeRoot = join(root, 'runtime')

  const malformedPrompts = []
  const action = await requestHiddenAction(
    'maintenance',
    { type: 'background_heartbeat', occurrenceId: 'offline-noop', at: '2026-09-08T00:00:00.000Z' },
    'offline fixture',
    async prompt => {
      malformedPrompts.push(prompt)
      return malformedPrompts.length === 1 ? '{"action":"NOOP"}' : '{"type":"NOOP","reason":"offline smoke"}'
    },
  )
  check(action.type === 'NOOP' && malformedPrompts.length === 2, 'malformed NOOP was not corrected exactly once')

  const memory = new MemoryService({ workspaceRoot: workspace })
  const batch = new DreamBatchStore(workspace)
  let generations = 0
  let writesBeforeCrash = 0
  try {
    await batch.run('offline-history', async () => { generations++; return facts() }, async proposal => {
      await memory.apply(proposal)
      writesBeforeCrash++
      if (writesBeforeCrash === 2) throw new Error('offline simulated commit-before-ack crash')
    })
    throw new Error('offline batch unexpectedly completed before simulated crash')
  } catch (error) {
    check(error instanceof Error && error.message.includes('commit-before-ack'), 'offline batch did not exercise the crash boundary')
  }
  await new DreamBatchStore(workspace).run('offline-history', async () => { throw new Error('frozen batch regenerated') }, proposal => memory.apply(proposal))
  const revisions = await memory.revisions()
  check(revisions.length === 3 && generations === 1, 'frozen memory batch did not replay three facts once')

  const writer = new ExtensionWriter(agentsHome, runtimeRoot)
  const skillRequest = { type: 'CREATE_SKILL', name: 'offline-review', instructions: 'Review the offline fixture.' }
  const skill = await executeSkillAction(writer, skillRequest)
  const skillReplay = await executeSkillAction(writer, skillRequest)
  const skillText = await readFile(skill.path, 'utf8')
  const discoverable = skill.created === true && skillReplay.created === false && skill.path === skillReplay.path
    && skillText.includes('name: offline-review')
    && skillText.includes('description: Use when the user explicitly requests the offline-review workflow.')
    && skillText.includes('Input:') && skillText.includes('Output:') && skillText.includes('Stop:')
  check(discoverable, 'skill was not created and replayed in DSH-discoverable format')
  const baseRequire = createRequire(basePatchPath())
  const { FileSystemSkillProvider } = await import(pathToFileURL(baseRequire.resolve('@deepseek-ai/dsh-skill-filesystem')).href)
  const provider = new FileSystemSkillProvider({ get() { return undefined }, logger: { warn() {} } }, { signal: new globalThis.AbortController().signal, invalidate() {} }, { includeDefaultRoots: false, dshHome: join(root, 'dsh-home'), agentsHome, customSkillDirs: [join(agentsHome, 'skills')], watch: false })
  let catalogLoaded = false
  try {
    const observation = await provider.list({ cwd: workspace })
    const candidates = Array.isArray(observation) ? observation : observation.candidates
    const candidate = candidates.find(item => item.name === 'offline-review')
    check(candidate, 'locked DSH provider did not discover generated skill')
    const loaded = await provider.get(candidate, { cwd: workspace })
    catalogLoaded = loaded?.invocation.modelInvocable === true && loaded.content.includes('Review the offline fixture.')
    check(catalogLoaded, 'locked DSH provider could not load generated skill')
  } finally { await provider.dispose() }

  const contact = '2026-09-07T12:00:00.000Z'
  const events = [
    { type: 'user/message', time: Date.parse('2026-09-08T00:00:00.000Z'), data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'recent offline message' }] } },
    { type: 'assistant/message', time: Date.parse('2026-09-08T00:00:01.000Z'), data: { message: { content: [{ type: 'text', text: 'offline response' }] } } },
  ]
  const heartbeat = await buildHeartbeatContext({
    identity: async () => ({ soul: 'offline soul', mission: 'offline mission' }),
    profile: () => memory.readProfile(),
    memories: async () => (await memory.search('offline', 8)).map(item => item.raw),
    recent: async () => recentUserConversation(events),
    goal: async () => ({ objective: 'offline fixture goal' }),
    schedules: async () => [{ id: 'offline schedule', prompt: 'offline reminder' }],
    lastContact: async () => contact,
  }, { at: '2026-09-08T00:00:00.000Z', timeZone: 'UTC', triggerId: 'offline-heartbeat' })
  const fixtureFields = {
    goal: heartbeat.prompt.includes('offline fixture goal'),
    schedule: heartbeat.prompt.includes('offline schedule'),
    recent: heartbeat.prompt.includes('recent offline message'),
    contact: heartbeat.prompt.includes(contact),
  }
  check(heartbeat.ready && Object.values(fixtureFields).every(Boolean), 'heartbeat context missed an offline fixture field')

  console.log(JSON.stringify({
    ok: true,
    malformedAction: { type: action.type, attempts: malformedPrompts.length },
    memory: { revisions: revisions.length, generations, writesBeforeCrash },
    skill: { created: skill.created, replayCreated: skillReplay.created, version: skill.version, path: relative(root, skill.path), discoverable, catalogLoaded },
    heartbeat: { ready: heartbeat.ready, fixtureFields },
  }))
} catch (error) {
  console.error(`host-offline-smoke failed: ${error instanceof Error ? error.message : 'unknown error'}`)
  process.exitCode = 1
} finally {
  if (root) await rm(root, { recursive: true, force: true })
}
