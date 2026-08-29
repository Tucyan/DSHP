import { describe, expect, it } from 'vitest'
import {
  PersonalGrowthBridge,
  createVerifiedAgentObserver,
  sessionIdForPeer,
  type BridgeAgent,
  type BridgeAgentRegistry,
  type BridgeBot,
  type BridgeInbound,
  type BridgeMemory,
} from '../src/bridge.js'
import { FileBridgeState } from '../src/state.js'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function inbound(overrides: Partial<BridgeInbound> = {}): BridgeInbound {
  return {
    peerId: 'user-1',
    context: 'private',
    messageId: 'message-1',
    text: '今天完成了学习',
    at: '2026-08-27T10:00:00.000Z',
    ...overrides,
  }
}

function agent(id: string, reply = '收到，我会继续跟进。'): BridgeAgent & { injected: string[]; followed: string[] } {
  const injected: string[] = []
  const followed: string[] = []
  return {
    id,
    injected,
    followed,
    inject(message) {
      injected.push(message.text)
    },
    followup(message) {
      followed.push(message.text)
    },
    async whenIdle() {
      await Promise.resolve()
    },
    reply,
  }
}

function bot(): BridgeBot & { handler?: (message: BridgeInbound) => Promise<void>; sent: string[]; stopped: boolean } {
  const result: BridgeBot & { handler?: (message: BridgeInbound) => Promise<void>; sent: string[]; stopped: boolean } = {
    sent: [],
    stopped: false,
    onMessage(handler) {
      result.handler = handler
    },
    async sendText(_target, text) {
      result.sent.push(text)
    },
    async start() {},
    stop() {
      result.stopped = true
    },
  }
  return result
}

function memory(): BridgeMemory & { consumed: Array<readonly unknown[]>; applied: unknown[] } {
  return {
    consumed: [],
    applied: [],
    async readProfile() {
      return '用户适合晚上进行高强度学习。'
    },
    async search() {
      return ['用户正在准备个人成长 Agent。']
    },
    async consume(events) {
      this.consumed.push(events)
      return { id: 'history-1' }
    },
    async readIndex() {
      return '# Memory Index'
    },
    async apply(proposal) {
      this.applied.push(proposal)
    },
  }
}

function state(): import('../src/bridge.js').BridgeState & { seen: Set<string>; sequences: Map<string, number> } {
  return {
    seen: new Set(),
    sequences: new Map(),
    async acceptInbound(id) {
      if (this.seen.has(`in:${id}`)) return false
      this.seen.add(`in:${id}`)
      return true
    },
    async nextSequence(sessionId) {
      const value = (this.sequences.get(sessionId) ?? 0) + 1
      this.sequences.set(sessionId, value)
      return value
    },
    async acceptOutbound(key) {
      if (this.seen.has(`out:${key}`)) return false
      this.seen.add(`out:${key}`)
      return true
    },
  }
}

describe('PersonalGrowthBridge', () => {
  it('propagates an immediate bot start failure', async () => {
    const qq = bot()
    const failure = new Error('qq unavailable')
    qq.start = async () => { throw failure }
    const bridge = new PersonalGrowthBridge({ bot: qq, registry: { async resume() { return agent('foreground') }, async create() { return agent('foreground') } }, memory: memory(), allowedPeerId: 'user-1' })
    await expect(bridge.start()).rejects.toBe(failure)
  })

  it('accepts only authorized private non-empty messages', async () => {
    const qq = bot()
    const userAgent = agent('foreground')
    const registry: BridgeAgentRegistry = {
      async resume() { return userAgent },
      async create() { return userAgent },
    }
    const bridge = new PersonalGrowthBridge({ bot: qq, registry, memory: memory(), allowedPeerId: 'user-1' })
    await bridge.start()

    await qq.handler?.(inbound({ peerId: 'intruder' }))
    await qq.handler?.(inbound({ context: 'group' }))
    await qq.handler?.(inbound({ text: '   ' }))
    expect(qq.sent).toEqual([])
    expect(userAgent.followed).toEqual([])
    await bridge.stop()
  })

  it('resumes stable session and falls back to create only on NOT_FOUND', async () => {
    const qq = bot()
    const userAgent = agent('foreground')
    let resumed = 0
    let created = 0
    const registry: BridgeAgentRegistry = {
      async resume(options) {
        resumed++
        if (options.sessionId === sessionIdForPeer('user-1')) throw Object.assign(new Error('gone'), { code: 'NOT_FOUND' })
        return userAgent
      },
      async create() {
        created++
        return userAgent
      },
    }
    const bridge = new PersonalGrowthBridge({ bot: qq, registry, memory: memory(), allowedPeerId: 'user-1' })
    await bridge.start()
    await qq.handler?.(inbound())
    expect(resumed).toBe(1)
    expect(created).toBe(1)
    expect(userAgent.id).toBe('foreground')
    await bridge.stop()
  })

  it('does not convert arbitrary resume errors into create', async () => {
    const qq = bot()
    let created = 0
    const error = new Error('provider unavailable')
    const registry: BridgeAgentRegistry = {
      async resume() { throw error },
      async create() { created++; throw new Error('must not create') },
    }
    const bridge = new PersonalGrowthBridge({ bot: qq, registry, memory: memory(), allowedPeerId: 'user-1' })
    await bridge.start()
    await expect(qq.handler?.(inbound())).rejects.toBe(error)
    expect(created).toBe(0)
    await bridge.stop()
  })

  it('injects profile and relevant memory, then emits one final assistant message', async () => {
    const qq = bot()
    const userAgent = agent('foreground', '这是最终答复。')
    const mem = memory()
    const registry: BridgeAgentRegistry = {
      async resume() { return userAgent },
      async create() { return userAgent },
    }
    const bridge = new PersonalGrowthBridge({ bot: qq, registry, memory: mem, allowedPeerId: 'user-1' })
    await bridge.start()
    await qq.handler?.(inbound())
    expect(userAgent.injected[0]).toContain('用户适合晚上')
    expect(userAgent.injected[0]).toContain('正在准备')
    expect(userAgent.followed).toEqual(['今天完成了学习'])
    expect(qq.sent).toEqual(['这是最终答复。'])
    await bridge.stop()
  })

  it('serializes inbound turns and records only real user and final assistant events', async () => {
    const qq = bot()
    const mem = memory()
    let release!: () => void
    let entered = false
    let holdFirstTurn = true
    const userAgent = agent('foreground')
    userAgent.whenIdle = async () => {
      if (!holdFirstTurn) return
      holdFirstTurn = false
      entered = true
      await new Promise<void>(resolve => { release = resolve })
    }
    const registry: BridgeAgentRegistry = {
      async resume() { return userAgent },
      async create() { return userAgent },
    }
    const bridge = new PersonalGrowthBridge({ bot: qq, registry, memory: mem, allowedPeerId: 'user-1' })
    await bridge.start()
    const first = qq.handler?.(inbound({ messageId: '1', text: 'first' }))
    while (!entered) await Promise.resolve()
    let secondDone = false
    const second = qq.handler?.(inbound({ messageId: '2', text: 'second' })).then(() => { secondDone = true })
    await Promise.resolve()
    expect(secondDone).toBe(false)
    release()
    await first
    await second
    expect(userAgent.followed).toEqual(['first', 'second'])
    expect(mem.consumed.every(events => events.every(event => {
      const value = event as { role?: string; content?: string }
      return (value.role === 'user' || value.role === 'assistant') && value.content !== 'injected context'
    }))).toBe(true)
    await bridge.stop()
  })

  it('never sends background work to QQ and cancels workers on stop', async () => {
    const qq = bot()
    let foregroundWakes = 0
    let backgroundWakes = 0
    const bridge = new PersonalGrowthBridge({
      bot: qq,
      registry: {
        async resume() { return agent('foreground') },
        async create() { return agent('foreground') },
      },
      memory: memory(),
      allowedPeerId: 'user-1',
      cadence: { foregroundMs: 5, backgroundMs: 5 },
      heartbeat: {
        async wakeForeground() { foregroundWakes++ },
        async wakeBackground() { backgroundWakes++ },
      },
    })
    await bridge.start()
    await new Promise(resolve => setTimeout(resolve, 20))
    await bridge.stop()
    const before = [foregroundWakes, backgroundWakes]
    await new Promise(resolve => setTimeout(resolve, 15))
    expect(foregroundWakes).toBeGreaterThan(0)
    expect(backgroundWakes).toBeGreaterThan(0)
    expect([foregroundWakes, backgroundWakes]).toEqual(before)
    expect(qq.sent).toEqual([])
    expect(qq.stopped).toBe(true)
  })

  it('delegates explicit foreground wakes to the heartbeat policy instead of bypassing it', async () => {
    const qq = bot(); let wakes = 0
    const userAgent = agent('foreground')
    const bridge = new PersonalGrowthBridge({ bot: qq, registry: { async resume() { return userAgent }, async create() { return userAgent } }, memory: memory(), allowedPeerId: 'user-1', heartbeat: { async wakeForeground() { wakes++ }, async wakeBackground() {} } })
    await bridge.start()
    await bridge.runForegroundWake({ occurrenceId: 'occurrence-1' })
    expect(wakes).toBe(1)
    expect(userAgent.followed).toEqual([])
    expect(qq.sent).toEqual([])
    await bridge.stop()
  })

  it('routes a real foreground assistant event once, including proactive events without a reply id', async () => {
    const qq = bot()
    const bridge = new PersonalGrowthBridge({ bot: qq, registry: { async resume() { return agent('foreground') }, async create() { return agent('foreground') } }, memory: memory(), state: state(), allowedPeerId: 'user-1' })
    await bridge.start()
    const observe = createVerifiedAgentObserver(bridge)
    observe({ sessionId: sessionIdForPeer('user-1'), seq: 3, type: 'assistant/message', text: '主动跟进', source: 'heartbeat' })
    observe({ sessionId: sessionIdForPeer('user-1'), seq: 3, type: 'assistant/message', text: '主动跟进', source: 'heartbeat' })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(qq.sent).toEqual(['主动跟进'])
    await bridge.stop()
  })

  it('does not expose a generic observer or allow an unverified event to send', async () => {
    const qq = bot()
    const bridge = new PersonalGrowthBridge({
      bot: qq,
      registry: { async resume() { return agent('foreground') }, async create() { return agent('foreground') } },
      memory: memory(),
      allowedPeerId: 'user-1',
    })
    await bridge.start()
    expect('observeAgentEvent' in bridge).toBe(false)
    const observe = createVerifiedAgentObserver(bridge)
    await observe({ sessionId: sessionIdForPeer('user-1'), type: 'assistant/message', text: '未经验证', completed: true, source: 'user' })
    expect(qq.sent).toEqual([])
    await bridge.stop()
  })

  it('exposes outbound failure and persists an unknown outcome for explicit reconciliation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pga-host-outbound-'))
    try {
      const qq = bot(); qq.sendText = async () => { throw new Error('transport result unknown') }
      const bridgeState = new FileBridgeState(join(root, 'bridge.json'))
      const bridge = new PersonalGrowthBridge({ bot: qq, registry: { async resume() { return agent('foreground') }, async create() { return agent('foreground') } }, memory: memory(), state: bridgeState, allowedPeerId: 'user-1' })
      await bridge.start()
      const observe = createVerifiedAgentObserver(bridge)
      await expect(observe({ sessionId: sessionIdForPeer('user-1'), seq: 7, type: 'assistant/message', text: '一次主动消息', source: 'heartbeat' })).rejects.toThrow(/unknown/)
      expect(await new FileBridgeState(join(root, 'bridge.json')).claimOutbound(`${sessionIdForPeer('user-1')}:7`)).toBe('unknown')
      await bridge.stop()
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('recovers an expired safe pending outbound on startup but never auto-sends unknown', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pga-host-recover-'))
    try {
      const stateFile = join(root, 'bridge.json')
      await writeFile(stateFile, JSON.stringify({ inbound: {}, outbound: {
        safe: { status: 'pending', owner: 'old-owner', leaseUntil: '2020-01-01T00:00:00.000Z', target: { peerId: 'user-1', messageId: 'm-safe' }, text: 'safe pending' },
        uncertain: { status: 'unknown', owner: 'old-owner', leaseUntil: '2020-01-01T00:00:00.000Z', target: { peerId: 'user-1', messageId: 'm-uncertain' }, text: 'must reconcile' },
      }, sequences: {}, histories: {}, traces: [] }))
      const qq = bot()
      const bridge = new PersonalGrowthBridge({ bot: qq, registry: { async resume() { return agent('foreground') }, async create() { return agent('foreground') } }, memory: memory(), state: new FileBridgeState(stateFile), allowedPeerId: 'user-1' })
      await bridge.start()
      expect(qq.sent).toEqual(['safe pending'])
      await bridge.stop()
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('quarantines a pending outbound addressed to another peer without sending', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pga-host-peer-isolation-'))
    try {
      const stateFile = join(root, 'bridge.json')
      await writeFile(stateFile, JSON.stringify({ inbound: {}, outbound: { foreign: { status: 'pending', owner: 'old-owner', leaseUntil: '2020-01-01T00:00:00.000Z', target: { peerId: 'other-peer' }, text: 'must not leak' } }, sequences: {}, histories: {}, traces: [] }))
      const qq = bot()
      const bridge = new PersonalGrowthBridge({ bot: qq, registry: { async resume() { return agent('foreground') }, async create() { return agent('foreground') } }, memory: memory(), state: new FileBridgeState(stateFile), allowedPeerId: 'user-1' })
      await bridge.start()
      expect(qq.sent).toEqual([])
      expect(await new FileBridgeState(stateFile).claimOutbound('foreign')).toBe('unknown')
      await bridge.stop()
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('deduplicates inbound message ids and uses persisted sequence allocation', async () => {
    const qq = bot()
    const mem = memory()
    const bridgeState = state()
    const userAgent = agent('foreground')
    const bridge = new PersonalGrowthBridge({ bot: qq, registry: { async resume() { return userAgent }, async create() { return userAgent } }, memory: mem, state: bridgeState, allowedPeerId: 'user-1' })
    await bridge.start()
    await qq.handler?.(inbound({ messageId: 'same' }))
    await qq.handler?.(inbound({ messageId: 'same' }))
    expect(userAgent.followed).toHaveLength(1)
    expect(bridgeState.sequences.get(sessionIdForPeer('user-1'))).toBe(2)
    await bridge.stop()
  })
})
