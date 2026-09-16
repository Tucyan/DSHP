import { describe, it, expect } from 'vitest'
import { PersonalGrowthBridge, sessionIdForPeer, type BridgeAgentMessage, type BridgeInbound, type PersonalGrowthBridgeOptions } from '../src/bridge.js'

async function fixture(onIdle: (bridge: PersonalGrowthBridge, round: number) => Promise<void>, extra: Partial<PersonalGrowthBridgeOptions> = {}) {
  let receive!: (input: BridgeInbound) => Promise<void>
  const sent: string[] = [], followed: BridgeAgentMessage[] = []
  let round = 0
  const agent = { id: sessionIdForPeer('peer'), inject() {}, followup(message: BridgeAgentMessage) { followed.push(message) }, async whenIdle() { await onIdle(bridge, ++round) }, reply: 'internal text must not be forwarded' }
  const bridge = new PersonalGrowthBridge({
    allowedPeerId: 'peer', processMemory: false,
    bot: { onMessage(handler) { receive = handler }, async start() {}, stop() {}, async sendText(_target, text) { sent.push(text) } },
    registry: { async resume() { return agent }, async create() { return agent } },
    memory: { async readProfile() { return '' }, async search() { return [] }, async consume() {}, async readIndex() { return '' }, async apply() {} },
    ...extra,
  })
  await bridge.start()
  return { bridge, sent, followed, receive: () => receive({ peerId: 'peer', context: 'private', messageId: 'in-1', text: 'hello' }) }
}
const input = { agentId: sessionIdForPeer('peer'), callId: 'call-1', text: 'visible reply' }

describe('foreground delivery guarantees', () => {
  it('corrects one omitted tool delivery and uses the same active user owner', async () => {
    const f = await fixture(async (bridge, round) => { if (round === 2) await bridge.sendActiveMessage(input) })
    await f.receive()
    expect(f.followed.map(x => x.source)).toEqual(['user', 'delivery-repair'])
    expect(f.sent).toEqual(['visible reply'])
    await f.bridge.stop()
  })

  it('passes explicit delivery origin metadata to the outbound claim', async () => {
    const claims: unknown[] = []
    const f = await fixture(async bridge => { await bridge.sendActiveMessage(input) }, {
      state: {
        async acceptInbound() { return true },
        async claimOutbound(key, envelope) { claims.push({ key, envelope }); return 'claimed' },
        async completeOutbound() {},
        async nextSequence() { return 1 },
      },
    })
    await f.receive()
    const envelope = (claims[0] as { envelope: { metadata: Record<string, unknown> } }).envelope
    expect(envelope.metadata).toMatchObject({ origin: 'user_reply', purpose: 'final', inboundId: 'in-1', sessionId: sessionIdForPeer('peer') })
    await f.bridge.stop()
  })
  it('uses fixed public fallback after exactly one failed correction', async () => {
    const f = await fixture(async () => {})
    await f.receive()
    expect(f.followed).toHaveLength(2)
    expect(f.sent).toEqual(['这次回复未能正常完成，请再发一条消息，我会继续处理。'])
    await f.bridge.stop()
  })
  it('does not duplicate an already sent reply', async () => {
    const f = await fixture(async bridge => { await bridge.sendActiveMessage(input) })
    await f.receive()
    expect(f.followed).toHaveLength(1)
    expect(f.sent).toEqual(['visible reply'])
    await f.bridge.stop()
  })
  it('refuses a schedule tool call during an active user owner', async () => {
    let rejected = false
    const f = await fixture(async bridge => {
      await bridge.sendActiveMessage({ ...input, executionSource: 'other' }).catch(() => { rejected = true })
      await bridge.sendActiveMessage(input)
    })
    await f.receive()
    expect(rejected).toBe(true)
    expect(f.sent).toEqual(['visible reply'])
    await f.bridge.stop()
  })
  it('requires a final reply after a progress-only send', async () => {
    const f = await fixture(async (bridge, round) => { await bridge.sendActiveMessage({ ...input, callId: `call-${round}`, purpose: round === 1 ? 'progress' : 'final', text: round === 1 ? 'working' : 'done' }) })
    await f.receive()
    expect(f.followed).toHaveLength(2)
    expect(f.sent).toEqual(['working', 'done'])
    await f.bridge.stop()
  })
  it('does not repair or retry an uncertain transport', async () => {
    let attempts = 0
    const f = await fixture(async bridge => { await bridge.sendActiveMessage(input).catch(() => {}) })
    // Simulate a public transport failing after it might have dispatched.
    const original = (f.bridge as unknown as { options: PersonalGrowthBridgeOptions }).options.bot
    original.sendText = async () => { attempts++; throw new Error('connection lost') }
    await f.receive()
    expect(attempts).toBe(1)
    expect(f.followed).toHaveLength(1)
    await f.bridge.stop()
  })
  it('runs and coalesces heartbeat work through the main agent without reply repair', async () => {
    const f = await fixture(async () => {}, { foregroundWake: { prompt: async () => 'check goals', run: async (_input, execute) => execute(), deliver: async (_key, send) => send() } })
    await Promise.all([f.bridge.runForegroundWake({ occurrenceId: 'a' }), f.bridge.runForegroundWake({ occurrenceId: 'b' })])
    expect(f.followed).toEqual([{ text: 'check goals', source: 'heartbeat' }])
    expect(f.sent).toEqual([])
    await f.bridge.stop()
  })
  it('waits for the user request before running a queued heartbeat', async () => {
    const gate = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const f = await fixture(async (bridge, round) => { if (round === 1) { entered.resolve(); await gate.promise; await bridge.sendActiveMessage(input) } }, { foregroundWake: { prompt: async () => 'wake', run: async (_input, execute) => execute(), deliver: async (_key, send) => send() } })
    const user = f.receive()
    await entered.promise
    const wake = f.bridge.runForegroundWake({ occurrenceId: 'waiting' })
    expect(f.followed.map(x => x.source)).toEqual(['user'])
    gate.resolve()
    await Promise.all([user, wake])
    expect(f.followed.map(x => x.source)).toEqual(['user', 'heartbeat'])
    await f.bridge.stop()
  })
  it('does not use a QQ reply message id when sending from a heartbeat', async () => {
    let checks = 0
    const f = await fixture(async bridge => { await bridge.sendActiveMessage(input) }, { foregroundWake: { prompt: async () => 'wake', run: async (_input, execute) => execute(), deliver: async (_key, send) => { checks++; return send() } } })
    const targets: unknown[] = []
    const original = (f.bridge as unknown as { options: PersonalGrowthBridgeOptions }).options.bot
    original.sendText = async target => { targets.push(target) }
    await f.bridge.runForegroundWake({ occurrenceId: 'wake' })
    expect(targets).toEqual([{ peerId: 'peer' }])
    expect(checks).toBe(1)
    await f.bridge.stop()
  })
})
