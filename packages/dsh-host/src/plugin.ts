import { QQBot, type QQBotInboundMessage, type QQBotOptions } from '@tencent-connect/qqbot-nodejs'
import type { Context } from '@deepseek-ai/cordis'
import { Agent, type AgentHandle } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { PersonalGrowthBridge, sessionIdForPeer, type BridgeAgent, type BridgeAgentRegistry, type BridgeInbound, type BridgeMemory, type BridgeBot, type BridgeDream, type BridgeHeartbeat } from './bridge.js'
import { MemoryService } from '@personal-growth/personal-memory'
import { FileBridgeState } from './state.js'
import { resolve } from 'node:path'

export const name = 'personal-growth-dsh-host'
export const inject = ['agents', 'sessions', 'sessionPersistence', 'agentDefaultModel']

export interface DshHostConfig {
  appId?: string
  appSecret?: string
  allowedPeerId?: string
  accountId?: string
  memory?: BridgeMemory
  dream?: BridgeDream
  heartbeat?: BridgeHeartbeat
  cadence?: { foregroundMs?: number; backgroundMs?: number }
  /** Injectable only for contract tests; deployment uses the public QQBot. */
  bot?: BridgeBot
  /** Injectable only for contract tests; deployment uses ctx.agents. */
  registry?: BridgeAgentRegistry
}

export interface DshSessionPersistence {
  listSnapshots(signal?: AbortSignal): Promise<readonly { header: { id: string | { toString(): string } } }[]>
}

export interface DshAgentOptions {
  provider: string
  model: string
  reasoningEffort?: string
}

export function resolveDefaultAgentOptions(ctx: Context): DshAgentOptions {
  const selection = (ctx as unknown as { agentDefaultModel?: { currentSelection?: () => DshAgentOptions | undefined } }).agentDefaultModel?.currentSelection?.()
  if (!selection?.provider || !selection.model) throw new Error('personal-growth-dsh-host requires a public DSH default model selection')
  return { provider: selection.provider, model: selection.model, ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}) }
}

export const REQUIRED_AGENT_TOOLS = [
  'schedule_create', 'schedule_list', 'schedule_delete',
  'get_goal', 'create_goal', 'update_goal',
  'read', 'write', 'edit', 'glob', 'grep', 'skill', 'pwsh',
] as const

/** Setup callback for the hidden maintenance root; restriction happens before publication. */
export function createBackgroundAgentSetup(): (agentCtx: Context) => void {
  return (agentCtx: Context) => {
    const tools = (agentCtx as unknown as { tools?: { restrict?: (options: { allow: string[] }) => unknown } }).tools
    if (!tools?.restrict) throw new Error('personal-growth-dsh-host requires public tool restriction for background agent')
    tools.restrict({ allow: ['skill'] })
  }
}

export function assertRequiredAgentTools(available: readonly string[]): void {
  const missing = REQUIRED_AGENT_TOOLS.filter(name => !available.includes(name))
  if (missing.length) throw new Error(`personal-growth-dsh-host missing required DSH tools: ${missing.join(', ')}`)
}

function inbound(message: QQBotInboundMessage): BridgeInbound {
  return {
    peerId: message.senderId,
    context: message.kind === 'c2c' ? 'private' : 'group',
    groupId: message.groupOpenid,
    messageId: message.messageId,
    text: message.content,
    at: message.timestamp,
  }
}

interface CompletionTracker {
  begin(agentId: string): void
  assistant(agentId: string, text: string): void
  complete(agentId: string, ok: boolean): string | undefined
  wait(agentId: string): Promise<string | undefined>
}

function completionTracker(): CompletionTracker {
  const pending = new Map<string, { text?: string; promise: Promise<string | undefined>; resolve: (text: string | undefined) => void }>()
  return {
    begin(agentId) {
      if (pending.has(agentId)) throw new Error(`agent ${agentId} already has a pending turn`)
      let resolve!: (text: string | undefined) => void
      const promise = new Promise<string | undefined>(done => { resolve = done })
      pending.set(agentId, { promise, resolve })
    },
    assistant(agentId, text) {
      const turn = pending.get(agentId)
      if (turn) turn.text = text
    },
    complete(agentId, ok) {
      const turn = pending.get(agentId)
      if (!turn) return undefined
      pending.delete(agentId)
      const text = ok ? turn.text : undefined
      turn.resolve(text)
      return text
    },
    wait(agentId) {
      return pending.get(agentId)?.promise ?? Promise.resolve(undefined)
    },
  }
}

function wrapAgent(handle: AgentHandle, tracker?: CompletionTracker): BridgeAgent {
  const agent = handle.agent as Agent
  return {
    id: String(agent.id),
    dispose: () => handle.dispose(),
    inject(message) {
      agent.inject(createUserMessage({ content: [{ type: 'text', text: message.text }], source: { kind: 'plugin', plugin: 'personal-growth-dsh-host', form: 'snapshot', sections: [{ name: 'context', text: message.text }] } }))
    },
    followup(message) {
      tracker?.begin(String(agent.id))
      agent.followup(createUserMessage({ content: [{ type: 'text', text: message.text }], source: { kind: 'user' } }))
    },
    whenIdle: async () => {
      if (tracker) {
        const text = await tracker.wait(String(agent.id))
        if (text !== undefined) return
      }
      await agent.whenIdle()
    },
  }
}

export function createDshAgentRegistry(ctx: Context, tracker?: CompletionTracker, assertCapabilities?: (agent: Agent) => void): BridgeAgentRegistry {
  const persistence = (ctx as unknown as { sessionPersistence?: DshSessionPersistence }).sessionPersistence
  if (!persistence || typeof persistence.listSnapshots !== 'function') throw new Error('personal-growth-dsh-host requires public session persistence.listSnapshots')
  const agents = (ctx as unknown as { agents: { resume(options: { resumeSessionId: SessionId; agentOptions?: DshAgentOptions }): Promise<AgentHandle>; create(options: { sessionId: SessionId; agentOptions?: DshAgentOptions; setup?: (agentCtx: Context) => void }): Promise<AgentHandle> } }).agents
  const model = resolveDefaultAgentOptions(ctx)
  const agentOptions = { provider: model.provider, model: model.model, ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}) }
  return {
    async resume({ sessionId }) {
      const id = SessionId(sessionId)
      const snapshots = await persistence.listSnapshots()
      const exists = snapshots.some(snapshot => String(snapshot.header.id) === sessionId)
      if (!exists) return this.create({ sessionId })
      const handle = await agents.resume({ resumeSessionId: id, agentOptions })
      assertCapabilities?.(handle.agent as Agent)
      return wrapAgent(handle, tracker)
    },
    async create({ sessionId }) {
      const handle = await agents.create({ sessionId: SessionId(sessionId), agentOptions })
      assertCapabilities?.(handle.agent as Agent)
      return wrapAgent(handle, tracker)
    },
  }
}

function createBot(config: DshHostConfig): BridgeBot {
  const qq = new QQBot({ appId: config.appId!, appSecret: config.appSecret!, accountId: config.accountId } satisfies QQBotOptions)
  return {
    onMessage(handler) {
      qq.on('message', async (_ctx, message) => handler(inbound(message)))
    },
    sendText(target, text) {
      return qq.sendText({ scope: 'c2c', targetId: target.peerId, msgId: target.messageId }, text).then(() => undefined)
    },
    start: signal => qq.start(signal),
    stop: () => qq.stop(),
  }
}

export function apply(ctx: Context, config: DshHostConfig): void {
  const appId = config?.appId ?? process.env.QQBOT_APP_ID
  const appSecret = config?.appSecret ?? process.env.QQBOT_APP_SECRET
  const allowedPeerId = config?.allowedPeerId ?? process.env.QQBOT_ALLOWED_PEER_ID
  if (!appId || !appSecret || !allowedPeerId) throw new Error('personal-growth-dsh-host requires QQ credentials and allowedPeerId')
  const service = new MemoryService({
    workspaceRoot: process.env.PERSONAL_GROWTH_WORKSPACE ?? process.cwd(),
    compressor: { compress: events => events.map(event => `${event.role}: ${event.content}`).join(' | ') },
  })
  const memory: BridgeMemory = config.memory ?? {
    readProfile: () => service.readProfile(),
    search: async (query, limit) => (await service.search(query, limit)).map(document => document.raw),
    consume: events => service.consume(events),
    readIndex: () => service.readIndex(),
    apply: proposal => service.apply(proposal as Parameters<MemoryService['apply']>[0]),
  }
  const dream: BridgeDream = config.dream ?? { async propose() { return [] } }
  let background: BridgeAgent | undefined
  const backgroundSessionId = sessionIdForPeer(allowedPeerId).replace('foreground', 'background')
  const heartbeat: BridgeHeartbeat = config.heartbeat ?? {
    wakeForeground: async input => { await bridge?.runForegroundWake(input) },
    wakeBackground: async input => {
      if (!background) {
        const agents = (ctx as unknown as { agents: { create(options: { sessionId: SessionId; agentOptions: DshAgentOptions; setup: (agentCtx: Context) => void }): Promise<AgentHandle>; resume(options: { resumeSessionId: SessionId; agentOptions: DshAgentOptions; setup: (agentCtx: Context) => void }): Promise<AgentHandle> } }).agents
        const model = resolveDefaultAgentOptions(ctx)
        const setup = createBackgroundAgentSetup()
        const snapshots = await (ctx as unknown as { sessionPersistence: DshSessionPersistence }).sessionPersistence.listSnapshots()
        const exists = snapshots.some(snapshot => String(snapshot.header.id) === backgroundSessionId)
        const handle = exists
          ? await agents.resume({ resumeSessionId: SessionId(backgroundSessionId), agentOptions: { provider: model.provider, model: model.model }, setup })
          : await agents.create({ sessionId: SessionId(backgroundSessionId), agentOptions: { provider: model.provider, model: model.model }, setup })
        background = wrapAgent(handle, tracker)
      }
      background.followup({ text: `后台维护唤醒 ${input.occurrenceId}：整理长期记忆、反思辅助效果并记录能力缺口。不得向用户发送消息。`, source: 'heartbeat' })
      await background.whenIdle()
    },
  }
  const tracker = completionTracker()
  const bridgeRegistry = config.registry ?? createDshAgentRegistry(ctx, tracker, agent => {
    const tools = (agent.ctx as unknown as { tools?: { schemas?: (scope?: unknown) => readonly { name: string }[] } }).tools
    const schemas = tools?.schemas?.(agent) ?? []
    assertRequiredAgentTools(schemas.map(schema => schema.name))
  })
  let bridge: PersonalGrowthBridge | undefined
  ctx.on('session/event', (session, event) => {
    const sessionId = String(session.id)
    if (event.type === 'assistant/message') {
      const text = event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('')
      tracker.assistant(sessionId, text)
      return
    }
    if (event.type !== 'turn/end') return
    const completed = event.data.reason.kind === 'completed'
    const text = tracker.complete(sessionId, completed)
    if (completed && bridge && text?.trim() && sessionId === sessionIdForPeer(allowedPeerId)) {
      bridge.observeAgentEvent({ sessionId, type: 'assistant/message', text, seq: event.seq, completed: true, at: new Date(event.time).toISOString() })
    }
  })
  ctx.effect(() => {
    bridge = new PersonalGrowthBridge({ bot: config.bot ?? createBot({ ...config, appId, appSecret }), registry: bridgeRegistry, memory, state: new FileBridgeState(resolve(process.env.PERSONAL_GROWTH_WORKSPACE ?? process.cwd(), '.personal-growth', 'bridge-state.json')), dream, heartbeat, allowedPeerId, cadence: config.cadence ?? { foregroundMs: 60 * 60 * 1000, backgroundMs: 30 * 60 * 1000 }, onStartError: error => { process.nextTick(() => { throw error }) } })
    const started = bridge.start()
    void started.catch(error => { process.nextTick(() => { throw error }) })
    return async () => { await bridge?.stop(); await background?.dispose?.(); background = undefined; bridge = undefined }
  })
}
