import type { SourceRef } from './bridge.js'

export interface VisibleMessage { id: string; role: 'user' | 'assistant'; text: string; at: string; source?: SourceRef }
export interface ActivityEvent { seq?: number; type: string; time?: number; data?: unknown }

type Source = { kind?: string; plugin?: string; form?: string }
type Block = { type?: string; text?: string }
type MessageLike = { source?: Source; content?: Block[] }

export function normalizeVisibleMessages(events: readonly ActivityEvent[], options: { includePluginUsers?: boolean; sessionId?: string } = {}): VisibleMessage[] {
  const includePluginUsers = options.includePluginUsers ?? false
  const sessionId = options.sessionId ?? 'session'
  const result: VisibleMessage[] = []
  const sentIds = new Set<string>()
  for (const event of events) {
    const data = event.data && typeof event.data === 'object' && !Array.isArray(event.data)
      ? event.data as { source?: Source; content?: Block[]; message?: MessageLike }
      : {}
    if (event.type === 'personal-growth/message-sent') {
      const id = (data as { id?: unknown }).id
      const text = (data as { text?: unknown }).text
      if (typeof id !== 'string' || sentIds.has(id) || typeof text !== 'string' || !text.trim()) continue
      sentIds.add(id)
      if (Number.isFinite(event.time)) result.push({ id, role: 'assistant', text, at: new Date(event.time!).toISOString(), source: { kind: 'outbound', id } })
      continue
    }
    if (event.type !== 'user/message') continue
    const message = Array.isArray(data.content) ? data as MessageLike : data.message
    const source = message?.source
    if (source?.kind !== 'user' && (!includePluginUsers || source?.kind !== 'plugin' || source.plugin === 'personal-growth-dsh-host')) continue
    if (source?.kind === 'plugin' && source.plugin === 'personal-growth-dsh-host') continue
    const text = message?.content?.filter(block => block.type === 'text').map(block => block.text ?? '').join('') ?? ''
    if (!text.trim() || !Number.isFinite(event.time)) continue
    const id = `${sessionId}:${event.seq ?? result.length}`
    result.push({ id, role: 'user', text, at: new Date(event.time!).toISOString(), ...(typeof event.seq === 'number' ? { source: { kind: 'session', sessionId, seq: event.seq } } : {}) })
  }
  return result
}
