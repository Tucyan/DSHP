import { createHash } from 'node:crypto'

export interface BridgeInbound {
  peerId: string
  context: 'private' | 'group'
  groupId?: string
  messageId: string
  text: string
  at?: string
}

export interface BridgeTarget { peerId: string; messageId?: string }
export interface OutboundEnvelope { target: BridgeTarget; text: string }

export interface BridgeBot {
  onMessage(handler: (message: BridgeInbound) => Promise<void>): void
  sendText(target: BridgeTarget, text: string): Promise<void>
  start(signal?: AbortSignal): Promise<void>
  stop(): void | Promise<void>
}

export interface BridgeAgentMessage { text: string; source?: string; messageId?: string }

export interface BridgeAgent {
  id: string
  inject(message: BridgeAgentMessage): void
  followup(message: BridgeAgentMessage): void
  whenIdle(): Promise<void>
  /** Production adapters expose the session event log. Test doubles may omit it. */
  events?: () => readonly BridgeSessionEvent[]
  /** Test-only fallback. Production output is observed through the host plugin. */
  reply?: string
  dispose?: () => Promise<void>
}

export interface BridgeAgentRegistry {
  resume(options: { sessionId: string }): Promise<BridgeAgent>
  create(options: { sessionId: string; setup?: (agent: BridgeAgent) => void }): Promise<BridgeAgent>
}

export interface BridgeMemory {
  readProfile(): Promise<string>
  search(query: string, limit?: number): Promise<readonly string[]>
  consume(events: readonly ConversationEvent[]): Promise<unknown>
  readIndex(): Promise<string>
  apply(proposal: unknown): Promise<unknown>
}

export interface BridgeDream {
  propose(input: { newHistory: readonly unknown[]; profile: string; index: string; relevantMemories: readonly string[] }): Promise<readonly unknown[]>
}

export type MemoryTurnClaim = 'claimed' | 'completed' | 'pending'
export type MemoryTurnInput = Omit<ConversationEvent, 'seq'>

/** Durable state is supplied by the production host; this prevents restart races. */
export interface BridgeState {
  acceptInbound(messageId: string): Promise<boolean>
  claimInbound?(messageId: string): Promise<'claimed' | 'completed' | 'pending'>
  renewInbound?(messageId: string): Promise<void>
  completeInbound?(messageId: string): Promise<void>
  failInbound?(messageId: string): Promise<void>
  claimMemoryTurn?(key: string, events: readonly ConversationEvent[]): Promise<MemoryTurnClaim>
  claimMemoryTurnBatch?(key: string, sessionId: string, events: readonly MemoryTurnInput[]): Promise<{ status: MemoryTurnClaim; events: ConversationEvent[] }>
  listPendingMemoryTurns?(): Promise<Array<{ key: string; events: ConversationEvent[]; leaseUntil?: string }>>
  completeMemoryTurn?(key: string): Promise<void>
  failMemoryTurn?(key: string): Promise<void>
  claimHistory?(historyId: string): Promise<boolean>
  renewHistory?(historyId: string): Promise<void>
  completeHistory?(historyId: string): Promise<void>
  failHistory?(historyId: string): Promise<void>
  nextSequence(sessionId: string): Promise<number>
  acceptOutbound(key: string): Promise<boolean>
  claimOutbound?(key: string, envelope?: OutboundEnvelope): Promise<'claimed' | 'sent' | 'pending' | 'unknown'>
  listPendingOutbound?(): Promise<Array<{ key: string } & OutboundEnvelope>>
  markOutboundDispatched?(key: string): Promise<void>
  completeOutbound?(key: string): Promise<void>
  markOutboundUnknown?(key: string): Promise<void>
  reconcileOutbound?(key: string, decision: 'retry' | 'sent'): Promise<void>
  failOutbound?(key: string): Promise<void>
  trace?(record: { type: string; at: string; key?: string; status?: string; reason?: string }): Promise<void>
}

export interface BridgeHeartbeat {
  wakeForeground(input: { occurrenceId: string; at?: string; importance?: number }): Promise<unknown>
  wakeBackground(input: { occurrenceId: string; at?: string }): Promise<unknown>
}

export interface BridgeSessionEvent {
  sessionId: string
  seq?: number
  type: 'user/message' | 'assistant/message'
  text: string
  at?: string
  /** The inbound QQ message currently owning this turn, when one exists. */
  messageId?: string
  /** Production adapters set this only after a completed turn boundary. */
  completed?: boolean
  /** Stable durable key for proactive messages whose source turn is hidden. */
  stableKey?: string
  /** Only the host's verified QQ/schedule policy paths may request delivery. */
  source?: 'user' | 'heartbeat'
}

export interface ConversationEvent {
  sessionId: string
  seq: number
  role: 'user' | 'assistant'
  content: string
  at: string
}

export interface PersonalGrowthBridgeOptions {
  bot: BridgeBot
  registry: BridgeAgentRegistry
  memory: BridgeMemory
  state?: BridgeState
  dream?: BridgeDream
  heartbeat?: BridgeHeartbeat
  allowedPeerId: string
  now?: () => string
  cadence?: { foregroundMs?: number; backgroundMs?: number }
  /** Reports a late bot-start failure to the owning host lifecycle. */
  onStartError?: (error: unknown) => void
  /** Production DSH session observers own the single consume/Dream pipeline. */
  processMemory?: boolean
  trace?: (record: { type: string; at: string; key?: string; status?: string; reason?: string }) => void | Promise<void>
}

export function sessionIdForPeer(peerId: string): string {
  const digest = createHash('sha256').update(peerId, 'utf8').digest('hex').slice(0, 24)
  return `personal-growth-foreground-${digest}`
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  return (error as { code?: unknown }).code === 'NOT_FOUND'
}

function textFromEvents(events: readonly BridgeSessionEvent[], type: BridgeSessionEvent['type']): string | undefined {
  const matches = events.filter(event => event.type === type && event.text.trim())
  return matches.at(-1)?.text
}

export class PersonalGrowthBridge {
  private readonly options: PersonalGrowthBridgeOptions
  private foreground?: BridgeAgent
  private processing: Promise<void> = Promise.resolve()
  private readonly observed = new Map<string, string>()
  private foregroundTimer?: ReturnType<typeof setInterval>
  private backgroundTimer?: ReturnType<typeof setInterval>
  private started = false
  private botStart?: Promise<void>
  private botStartSettled = false
  private botStartError?: unknown
  private readonly workerTasks = new Set<Promise<unknown>>()
  private readonly activeMessageIds = new Map<string, string>()

  constructor(options: PersonalGrowthBridgeOptions) {
    this.options = options
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    this.options.bot.onMessage(message => this.enqueue(message))
    this.botStart = this.options.bot.start()
    void this.botStart.then(() => { this.botStartSettled = true }, error => { this.botStartSettled = true; this.botStartError = error })
    await Promise.resolve()
    if (this.botStartError) {
      this.started = false
      throw this.botStartError
    }
    await this.recoverPendingOutbound()
    void this.botStart.catch(error => {
      this.botStartError = error
      this.options.onStartError?.(error)
    })
    const cadence = this.options.cadence
    if (this.options.heartbeat && cadence?.foregroundMs && cadence.foregroundMs > 0) {
      this.foregroundTimer = setInterval(() => this.trackWorker(this.runForegroundWake({ occurrenceId: this.occurrenceId('foreground'), importance: 0 })), cadence.foregroundMs)
    }
    if (this.options.heartbeat && cadence?.backgroundMs && cadence.backgroundMs > 0) {
      this.backgroundTimer = setInterval(() => this.trackWorker(this.options.heartbeat!.wakeBackground({ occurrenceId: this.occurrenceId('background') })), cadence.backgroundMs)
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return
    this.started = false
    if (this.foregroundTimer) clearInterval(this.foregroundTimer)
    if (this.backgroundTimer) clearInterval(this.backgroundTimer)
    await this.processing.catch(() => undefined)
    await Promise.allSettled([...this.workerTasks])
    await this.options.bot.stop()
    await this.foreground?.dispose?.()
    if (this.botStart && this.botStartSettled) await this.botStart.catch(() => undefined)
  }

  /** Run one foreground proactive turn through the same durable foreground agent. */
  async runForegroundWake(input: { occurrenceId: string; at?: string; importance?: number }): Promise<unknown> {
    if (!this.started || !this.options.heartbeat) return
    const result = await this.options.heartbeat.wakeForeground(input) as { action?: { type?: string; text?: string } } | undefined
    if (result?.action?.type === 'MESSAGE_USER' && result.action.text?.trim()) {
      await this.sendOutbound(`${sessionIdForPeer(this.options.allowedPeerId)}:heartbeat:${input.occurrenceId}`, { peerId: this.options.allowedPeerId }, result.action.text)
    }
    return result
  }

  /** Opens the fixed foreground owner for explicit management operations only. */
  async ensureForeground(): Promise<void> {
    if (!this.started) throw new Error('bridge is stopped')
    const task = this.processing.then(async () => { await this.getForeground() })
    this.processing = task.catch(() => undefined)
    return task
  }

  /** Sends only the assistant reply for the currently-owned QQ turn. */
  observeActiveUserReply(event: { sessionId: string; seq?: number; text: string; at?: string; messageId?: string; completed?: boolean }): Promise<void> {
    const isCurrentUserTurn = typeof event.messageId === 'string' && event.messageId === this.activeMessageIds.get(event.sessionId)
    if (isCurrentUserTurn && event.completed !== false && event.text.trim() && event.sessionId === sessionIdForPeer(this.options.allowedPeerId)) {
      this.observed.set(event.sessionId, event.text)
      const key = `${event.sessionId}:turn:${event.messageId}`
      const task = this.sendOutbound(key, { peerId: this.options.allowedPeerId, messageId: event.messageId }, event.text)
      this.trackWorker(task)
      return task
    }
    return Promise.resolve()
  }


  private enqueue(message: BridgeInbound): Promise<void> {
    const operation = this.processing.then(async () => {
      try { await this.process(message) }
      catch (error) { await this.options.state?.failInbound?.(message.messageId); await this.emitTrace({ type: 'inbound', at: new Date().toISOString(), key: message.messageId, status: 'failure', reason: 'processing_failure' }); throw error }
    })
    this.processing = operation.catch(() => undefined)
    return operation
  }

  private async getForeground(): Promise<BridgeAgent> {
    if (this.foreground) return this.foreground
    const sessionId = sessionIdForPeer(this.options.allowedPeerId)
    try {
      this.foreground = await this.options.registry.resume({ sessionId })
    } catch (error) {
      if (!isNotFound(error)) throw error
      this.foreground = await this.options.registry.create({ sessionId })
    }
    return this.foreground
  }

  private async process(message: BridgeInbound): Promise<void> {
    if (!this.started || message.context !== 'private' || message.peerId !== this.options.allowedPeerId || !message.text.trim()) return
    const sessionId = sessionIdForPeer(this.options.allowedPeerId)
    const inboundState = this.options.state?.claimInbound
      ? await this.options.state.claimInbound(message.messageId)
      : (this.options.state && !await this.options.state.acceptInbound(message.messageId) ? 'completed' : 'claimed')
    await this.emitTrace({ type: 'inbound', at: new Date().toISOString(), key: message.messageId, status: inboundState })
    if (inboundState && inboundState !== 'claimed') return
    let lost = false
    let renewalInFlight: Promise<void> | undefined
    const renew = () => {
      if (renewalInFlight || lost || !this.options.state?.renewInbound) return
      renewalInFlight = this.options.state.renewInbound(message.messageId).catch(async error => {
        lost = true
        await this.emitTrace({ type: 'inbound', at: new Date().toISOString(), key: message.messageId, status: 'lease-lost', reason: 'renewal_failure' }).catch(() => undefined)
        throw error
      }).finally(() => { renewalInFlight = undefined })
      // The timer owns this promise; keep rejection handled and let the process check lost.
      void renewalInFlight.catch(() => undefined)
    }
    const renewal = setInterval(renew, 10_000)
    const ensureLease = async () => {
      await renewalInFlight?.catch(() => undefined)
      if (lost) throw new Error('bridge inbound ownership lost')
    }
    try {
      const agent = await this.getForeground()
      await ensureLease()
      const profile = await this.options.memory.readProfile()
      await ensureLease()
      const relevant = await this.options.memory.search(message.text, 8)
      await ensureLease()
      agent.inject({ text: `长期用户上下文\nPROFILE:\n${profile}\nRELEVANT MEMORY:\n${relevant.join('\n')}`, source: 'personal-memory' })
      const before = agent.events?.() ?? []
      this.observed.delete(sessionId)
      this.activeMessageIds.set(sessionId, message.messageId)
    agent.followup({ text: message.text, source: 'user', messageId: message.messageId })
      await agent.whenIdle()
      await ensureLease()
      const after = agent.events?.() ?? []
      const assistantText = this.observed.get(sessionId) ?? textFromEvents(after.slice(before.length), 'assistant/message') ?? agent.reply
      if (assistantText?.trim() && !this.observed.has(sessionId)) {
        await ensureLease()
        const key = `${sessionId}:turn:${message.messageId}`
        await this.sendOutbound(key, { peerId: message.peerId, messageId: message.messageId }, assistantText)
        await ensureLease()
      }
      if (this.options.processMemory === false) {
        await ensureLease()
        await this.options.state?.completeInbound?.(message.messageId)
        await this.emitTrace({ type: 'inbound', at: new Date().toISOString(), key: message.messageId, status: 'completed' })
        return
      }
      const at = message.at ?? this.options.now?.() ?? new Date().toISOString()
      const events: ConversationEvent[] = [
        { sessionId, seq: await this.nextSequence(sessionId), role: 'user', content: message.text, at },
      ]
      await ensureLease()
      if (assistantText?.trim()) events.push({ sessionId, seq: await this.nextSequence(sessionId), role: 'assistant', content: assistantText, at: this.options.now?.() ?? at })
      await ensureLease()
      const history = await this.options.memory.consume(events)
      await ensureLease()
      if (history && this.options.dream) {
        const proposals = await this.options.dream.propose({ newHistory: [history], profile, index: await this.options.memory.readIndex(), relevantMemories: relevant })
        await ensureLease()
        for (const proposal of proposals) {
          await this.options.memory.apply(proposal)
          await ensureLease()
        }
      }
      await ensureLease()
      await this.options.state?.completeInbound?.(message.messageId)
      await this.emitTrace({ type: 'inbound', at: new Date().toISOString(), key: message.messageId, status: 'completed' })
    } finally {
      clearInterval(renewal)
      await renewalInFlight?.catch(() => undefined)
      this.activeMessageIds.delete(sessionId)
    }
  }

  private async nextSequence(sessionId: string): Promise<number> {
    if (this.options.state) return this.options.state.nextSequence(sessionId)
    // Pure unit-test fallback. Production plugin always supplies durable state.
    const next = (this as unknown as { localSequence?: Map<string, number> }).localSequence ?? new Map<string, number>()
    ;(this as unknown as { localSequence: Map<string, number> }).localSequence = next
    const value = (next.get(sessionId) ?? 0) + 1
    next.set(sessionId, value)
    return value
  }

  private occurrenceId(prefix: string): string {
    const now = this.options.now?.() ?? new Date().toISOString()
    return `${prefix}-${now.slice(0, 16)}`
  }

  private trackWorker(task: Promise<unknown>): void {
    this.workerTasks.add(task)
    void task.finally(() => this.workerTasks.delete(task)).catch(() => undefined)
  }

  private async sendOutbound(key: string, target: BridgeTarget, text: string): Promise<void> {
    const state = this.options.state
    const envelope = { target, text }
    if (target.peerId !== this.options.allowedPeerId) {
      const status = state?.claimOutbound ? await state.claimOutbound(key, envelope) : 'unknown'
      if (status === 'claimed') await state?.markOutboundUnknown?.(key)
      await this.emitTrace({ type: 'outbound', at: new Date().toISOString(), key, status: 'quarantined', reason: 'peer_mismatch' })
      return
    }
    const status = state?.claimOutbound ? await state.claimOutbound(key, envelope) : ((await state?.acceptOutbound(key)) ?? true ? 'claimed' : 'sent')
    if (status !== 'claimed') {
      await this.emitTrace({ type: 'outbound', at: new Date().toISOString(), key, status })
      return
    }
    await this.emitTrace({ type: 'outbound', at: new Date().toISOString(), key, status: 'pending' })
    try {
      if (state?.markOutboundDispatched) await state.markOutboundDispatched(key)
      await this.options.bot.sendText(target, text)
      if (state?.completeOutbound) await state.completeOutbound(key)
      await this.emitTrace({ type: 'outbound', at: new Date().toISOString(), key, status: 'sent' })
    } catch (error) {
      if (state?.markOutboundUnknown) await state.markOutboundUnknown(key)
      else await state?.failOutbound?.(key)
      await this.emitTrace({ type: 'outbound', at: new Date().toISOString(), key, status: 'unknown', reason: 'transport_failure' })
      throw error
    }
  }

  private async recoverPendingOutbound(): Promise<void> {
    const pending = await this.options.state?.listPendingOutbound?.() ?? []
    for (const item of pending) {
      try { await this.sendOutbound(item.key, item.target, item.text) }
      catch { /* unknown is durably retained; startup must not retry it blindly */ }
    }
  }

  private emitTrace(record: { type: string; at: string; key?: string; status?: string; reason?: string }): Promise<void> {
    const safe = { ...record, key: record.key ? createHash('sha256').update(record.key, 'utf8').digest('hex').slice(0, 16) : undefined }
    return Promise.resolve(this.options.trace?.(safe)).then(() => {
      if (this.options.trace) return undefined
      return this.options.state?.trace?.(safe)
    }).then(() => undefined)
  }
}
