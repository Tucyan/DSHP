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

export interface BridgeBot {
  onMessage(handler: (message: BridgeInbound) => Promise<void>): void
  sendText(target: BridgeTarget, text: string): Promise<void>
  start(signal?: AbortSignal): Promise<void>
  stop(): void | Promise<void>
}

export interface BridgeAgentMessage { text: string; source?: string }

export interface BridgeAgent {
  id: string
  inject(message: BridgeAgentMessage): void
  followup(message: BridgeAgentMessage): void
  whenIdle(): Promise<void>
  /** Production adapters expose the session event log. Test doubles may omit it. */
  events?: () => readonly BridgeSessionEvent[]
  /** Test-only fallback. Production output is observed through observeAgentEvent. */
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

/** Durable state is supplied by the production host; this prevents restart races. */
export interface BridgeState {
  acceptInbound(messageId: string): Promise<boolean>
  claimInbound?(messageId: string): Promise<'claimed' | 'completed' | 'pending'>
  completeInbound?(messageId: string): Promise<void>
  failInbound?(messageId: string): Promise<void>
  nextSequence(sessionId: string): Promise<number>
  acceptOutbound(key: string): Promise<boolean>
  failOutbound?(key: string): Promise<void>
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
  source?: 'user' | 'agent' | 'plugin'
  /** The inbound QQ message currently owning this turn, when one exists. */
  messageId?: string
  /** Production adapters set this only after a completed turn boundary. */
  completed?: boolean
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
    void this.botStart.catch(error => {
      this.botStartError = error
      this.options.onStartError?.(error)
    })
    const cadence = this.options.cadence
    if (this.options.heartbeat && cadence?.foregroundMs && cadence.foregroundMs > 0) {
      this.foregroundTimer = setInterval(() => this.trackWorker(this.options.heartbeat!.wakeForeground({ occurrenceId: this.occurrenceId('foreground'), importance: 0 })), cadence.foregroundMs)
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
  async runForegroundWake(input: { occurrenceId: string; at?: string; importance?: number }): Promise<void> {
    if (!this.started) return
    const agent = await this.getForeground()
    const sessionId = sessionIdForPeer(this.options.allowedPeerId)
    const profile = await this.options.memory.readProfile()
    const relevant = await this.options.memory.search('recent goals progress follow-up', 8)
    agent.inject({ text: `前台主动跟进 ${input.occurrenceId}\nPROFILE:\n${profile}\nRELEVANT MEMORY:\n${relevant.join('\n')}`, source: 'personal-memory' })
    this.activeMessageIds.delete(sessionId)
    agent.followup({ text: '请根据当前上下文判断是否需要联系用户；若不需要请保持安静。', source: 'heartbeat' })
    await agent.whenIdle()
  }

  /** Called by the host's public session/event listener. Background IDs are never registered. */
  observeAgentEvent(event: BridgeSessionEvent): void {
    if (event.type === 'assistant/message' && event.completed !== false && event.text.trim() && event.sessionId === sessionIdForPeer(this.options.allowedPeerId)) {
      this.observed.set(event.sessionId, event.text)
      const key = `${event.sessionId}:${event.seq ?? event.text}`
      void (this.options.state?.acceptOutbound(key) ?? Promise.resolve(true)).then(accepted => {
        if (accepted) void this.options.bot.sendText({ peerId: this.options.allowedPeerId, messageId: event.messageId ?? this.activeMessageIds.get(event.sessionId) }, event.text).catch(() => this.options.state?.failOutbound?.(key))
      })
    }
  }

  private enqueue(message: BridgeInbound): Promise<void> {
    const operation = this.processing.then(async () => {
      try { await this.process(message) }
      catch (error) { await this.options.state?.failInbound?.(message.messageId); throw error }
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
    const agent = await this.getForeground()
    const sessionId = sessionIdForPeer(this.options.allowedPeerId)
    const inboundState = this.options.state?.claimInbound
      ? await this.options.state.claimInbound(message.messageId)
      : (this.options.state && !await this.options.state.acceptInbound(message.messageId) ? 'completed' : 'claimed')
    if (inboundState && inboundState !== 'claimed') return
    const profile = await this.options.memory.readProfile()
    const relevant = await this.options.memory.search(message.text, 8)
    agent.inject({ text: `长期用户上下文\nPROFILE:\n${profile}\nRELEVANT MEMORY:\n${relevant.join('\n')}`, source: 'personal-memory' })
    const before = agent.events?.() ?? []
    this.observed.delete(sessionId)
    this.activeMessageIds.set(sessionId, message.messageId)
    try {
      agent.followup({ text: message.text, source: 'user' })
      await agent.whenIdle()
    } finally {
      this.activeMessageIds.delete(sessionId)
    }
    const after = agent.events?.() ?? []
    const assistantText = this.observed.get(sessionId) ?? textFromEvents(after.slice(before.length), 'assistant/message') ?? agent.reply
    if (assistantText?.trim() && !this.observed.has(sessionId)) {
      const key = `${sessionId}:turn:${message.messageId}`
      const accepted = await (this.options.state?.acceptOutbound(key) ?? true)
      if (accepted) {
        try { await this.options.bot.sendText({ peerId: message.peerId, messageId: message.messageId }, assistantText) }
        catch (error) { await this.options.state?.failOutbound?.(key); throw error }
      }
    }
    const at = message.at ?? this.options.now?.() ?? new Date().toISOString()
    const events: ConversationEvent[] = [
      { sessionId, seq: await this.nextSequence(sessionId), role: 'user', content: message.text, at },
    ]
    if (assistantText?.trim()) events.push({ sessionId, seq: await this.nextSequence(sessionId), role: 'assistant', content: assistantText, at: this.options.now?.() ?? at })
    const history = await this.options.memory.consume(events)
    if (history && this.options.dream) {
      const proposals = await this.options.dream.propose({ newHistory: [history], profile, index: await this.options.memory.readIndex(), relevantMemories: relevant })
      for (const proposal of proposals) await this.options.memory.apply(proposal)
    }
    await this.options.state?.completeInbound?.(message.messageId)
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
}
