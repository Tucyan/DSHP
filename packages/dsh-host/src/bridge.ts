import { createHash } from 'node:crypto'
import { DELIVERY_FALLBACK, DELIVERY_REPAIR_PROMPT, type SendMessageInput, type SendMessageResult, type SendMessageStatus } from './send-message.js'

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
  /** Test-only fallback. Production turn completion is tracked by the host plugin. */
  reply?: string
  dispose?: () => Promise<void>
  recordSent?: (id: string, text: string) => Promise<void>
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
  foregroundWake?: {
    prompt(): Promise<string>
    run(input: { occurrenceId: string; at?: string }, execute: () => Promise<void>): Promise<unknown>
    deliver(key: string, send: () => Promise<SendMessageStatus>): Promise<SendMessageStatus>
  }
  allowedPeerId: string
  now?: () => string
  cadence?: { foregroundMs?: number; backgroundMs?: number }
  /** Reports a late bot-start failure to the owning host lifecycle. */
  onStartError?: (error: unknown) => void
  /** Production DSH session observers own the single consume/Dream pipeline. */
  processMemory?: boolean
  recordFallback?: (id: string, text: string) => Promise<void>
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
  private foregroundTimer?: ReturnType<typeof setInterval>
  private backgroundTimer?: ReturnType<typeof setInterval>
  private started = false
  private botStart?: Promise<void>
  private botStartSettled = false
  private botStartError?: unknown
  private readonly workerTasks = new Set<Promise<unknown>>()
  private readonly activeMessageIds = new Map<string, string>()
  private activeDelivery?: { kind: 'user' | 'heartbeat'; sent: number; finalSent: boolean; uncertain: boolean }
  private pendingWake?: Promise<unknown>
  private repairing = false

  isRepairingDelivery(): boolean { return this.repairing }

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
    if ((this.options.heartbeat || this.options.foregroundWake) && cadence?.foregroundMs && cadence.foregroundMs > 0) {
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
    if (this.options.foregroundWake) {
      if (!this.started) return
      if (this.pendingWake) return this.pendingWake
      const wake = this.options.foregroundWake
      const operation = this.processing.then(async () => {
        if (!this.started) return
        return wake.run(input, async () => {
          const agent = await this.getForeground()
          const prompt = await wake.prompt()
          agent.inject({ text: `长期用户上下文\n${await this.options.memory.readProfile()}\n${(await this.options.memory.search('recent goals progress follow-up', 8)).join('\n')}`, source: 'personal-memory' })
          this.activeMessageIds.set(agent.id, `heartbeat:${input.occurrenceId}`)
          this.activeDelivery = { kind: 'heartbeat', sent: 0, finalSent: false, uncertain: false }
          try {
            agent.followup({ text: prompt, source: 'heartbeat' })
            await agent.whenIdle()
            await this.emitTrace({ type: 'heartbeat', at: new Date().toISOString(), key: input.occurrenceId, status: 'completed', reason: this.activeDelivery.uncertain ? 'delivery_unknown' : this.activeDelivery.sent ? 'message_sent' : 'silent' })
          } finally {
            this.activeMessageIds.delete(agent.id)
            this.activeDelivery = undefined
          }
        })
      })
      this.processing = operation.then(() => undefined, () => undefined)
      this.pendingWake = operation
      try { return await operation } finally { this.pendingWake = undefined }
    }
    return this.deliverScheduleWake(input)
  }

  /** Official schedule completion keeps its separate admission and delivery path. */
  async deliverScheduleWake(input: { occurrenceId: string; at?: string; importance?: number }): Promise<unknown> {
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

  /** Drain and release the cached foreground so its next resume captures new model settings. */
  async reloadForeground(): Promise<void> {
    const task = this.processing.then(async () => {
      const current = this.foreground
      if (!current) return
      await current.whenIdle()
      if (this.foreground === current) this.foreground = undefined
      await current.dispose?.()
    })
    this.processing = task.catch(() => undefined)
    return task
  }

  /** Deliver one tool-authored message for the currently-owned foreground user turn. */
  async sendActiveMessage(input: SendMessageInput): Promise<SendMessageResult> {
    const sessionId = sessionIdForPeer(this.options.allowedPeerId)
    const inboundId = this.activeMessageIds.get(sessionId)
    if (!inboundId || input.agentId !== sessionId || this.foreground?.id !== input.agentId) throw new Error('send_message requires the active foreground user turn')
    if (input.executionSource !== undefined) {
      const expected = this.repairing ? 'delivery-repair' : this.activeDelivery?.kind
      if (input.executionSource !== expected) throw new Error('send_message source does not own the active foreground turn')
    }
    if (!input.callId || input.callId.length > 512) throw new Error('send_message call identity is invalid')
    if (!input.text.trim() || input.text.length > 4_096) throw new Error('send_message text must contain 1 to 4096 characters')
    const callDigest = createHash('sha256').update(input.callId, 'utf8').digest('hex').slice(0, 32)
    const id = `${sessionId}:turn:${inboundId}:send:${callDigest}`
    const delivery = this.activeDelivery
    if (delivery?.uncertain) return { id, status: 'unknown' }
    let status: SendMessageStatus
    try {
      const send = () => this.sendOutbound(id, { peerId: this.options.allowedPeerId, ...(delivery?.kind === 'heartbeat' ? {} : { messageId: inboundId }) }, input.text)
      status = delivery?.kind === 'heartbeat' ? await this.options.foregroundWake!.deliver(id, send) : await send()
    } catch (error) { if (delivery) delivery.uncertain = true; throw error }
    if (delivery) {
      if (status === 'sent' || status === 'already_sent') { delivery.sent++; if (input.purpose !== 'progress') delivery.finalSent = true }
      if (status === 'pending' || status === 'unknown') delivery.uncertain = true
    }
    return { id, status }
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
      this.activeMessageIds.set(sessionId, message.messageId)
      this.activeDelivery = { kind: 'user', sent: 0, finalSent: false, uncertain: false }
      agent.followup({ text: message.text, source: 'user', messageId: message.messageId })
      let executionFailed = false
      try { await agent.whenIdle() } catch {
        executionFailed = true
        await this.emitTrace({ type: 'inbound', at: new Date().toISOString(), key: message.messageId, status: 'execution_failed', reason: 'agent_failure' })
      }
      await ensureLease()
      if (!this.activeDelivery.finalSent && !this.activeDelivery.uncertain) {
        await this.emitTrace({ type: 'inbound', at: new Date().toISOString(), key: message.messageId, status: 'repairing', reason: this.activeDelivery.sent ? 'no_final_reply' : 'no_message_sent' })
        try {
          if (!executionFailed) {
            this.repairing = true
            agent.followup({ text: DELIVERY_REPAIR_PROMPT, source: 'delivery-repair' })
            await agent.whenIdle()
          }
        } catch { /* A failed correction still gets a fixed public fallback, unless transport is uncertain. */ }
        finally { this.repairing = false }
        await ensureLease()
        if (!this.activeDelivery.finalSent && !this.activeDelivery.uncertain) {
          const id = `${sessionId}:turn:${message.messageId}:fallback`
          const delivery = await this.sendOutbound(id, { peerId: this.options.allowedPeerId, messageId: message.messageId }, DELIVERY_FALLBACK)
          if (delivery === 'sent' || delivery === 'already_sent') {
            await agent.recordSent?.(id, DELIVERY_FALLBACK)
            if (this.options.recordFallback) await this.options.recordFallback(id, DELIVERY_FALLBACK)
            else await this.options.memory.consume([{ sessionId, seq: await this.nextSequence(sessionId), role: 'assistant', content: DELIVERY_FALLBACK, at: new Date().toISOString() }])
          }
          await this.emitTrace({ type: 'inbound', at: new Date().toISOString(), key: message.messageId, status: 'delivery_fallback', reason: delivery })
        }
      }
      if (this.activeDelivery.uncertain) await this.emitTrace({ type: 'inbound', at: new Date().toISOString(), key: message.messageId, status: 'delivery_unknown', reason: 'transport_unconfirmed' })
      const after = agent.events?.() ?? []
      const assistantText = textFromEvents(after.slice(before.length), 'assistant/message') ?? agent.reply
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
      this.activeDelivery = undefined
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

  private async sendOutbound(key: string, target: BridgeTarget, text: string): Promise<SendMessageStatus> {
    const state = this.options.state
    const envelope = { target, text }
    if (target.peerId !== this.options.allowedPeerId) {
      const status = state?.claimOutbound ? await state.claimOutbound(key, envelope) : 'unknown'
      if (status === 'claimed') await state?.markOutboundUnknown?.(key)
      await this.emitTrace({ type: 'outbound', at: new Date().toISOString(), key, status: 'quarantined', reason: 'peer_mismatch' })
      return 'unknown'
    }
    const status = state?.claimOutbound ? await state.claimOutbound(key, envelope) : ((await state?.acceptOutbound(key)) ?? true ? 'claimed' : 'sent')
    if (status !== 'claimed') {
      await this.emitTrace({ type: 'outbound', at: new Date().toISOString(), key, status })
      return status === 'sent' ? 'already_sent' : status
    }
    await this.emitTrace({ type: 'outbound', at: new Date().toISOString(), key, status: 'pending' })
    try {
      if (state?.markOutboundDispatched) await state.markOutboundDispatched(key)
      await this.options.bot.sendText(target, text)
      if (state?.completeOutbound) await state.completeOutbound(key)
      await this.emitTrace({ type: 'outbound', at: new Date().toISOString(), key, status: 'sent' })
      return 'sent'
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
