import type { SourceRef } from './bridge.js'
import type { HistoryRecord } from '@personal-growth/personal-memory'

export interface VisibleMessage { id: string; role: 'user' | 'assistant'; text: string; at: string; source?: SourceRef }
export interface ActivityEvent { seq?: number; type: string; time?: number | string; data?: unknown }

export interface ActivityQuery { date: string; timeZone: string; asOf: string; limit: number; cursor?: string }
export type ActivityCoverage = 'complete' | 'partial' | 'unavailable'
export interface ActivityMessage { id: string; role: 'user' | 'assistant'; text: string; at: string; origin: ActivityOrigin | 'user'; source: SourceRef; delivery?: 'sent' | 'pending' | 'unknown' }
export interface ActivitySnapshot {
  date: string; timeZone: string; asOf: string; coverage: ActivityCoverage; reasons: string[]
  counts: { user: number; sent: number; pending: number; unknown: number; last60mUser: number; last60mSent: number }
  hourly: Array<{ hour: string; user: number; sent: number }>
  lastUserAt: string | null; lastSentAt: string | null
  histories: Array<{ id: string; text: string; sources: SourceRef[] }>
  recent: ActivityMessage[]; truncated: boolean; nextCursor?: string
}
export type ActivityOrigin = 'user_reply' | 'heartbeat' | 'schedule' | 'fallback' | 'legacy_unknown'

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
      const eventTime = typeof event.time === 'string' ? Date.parse(event.time) : event.time
      if (Number.isFinite(eventTime)) result.push({ id, role: 'assistant', text, at: new Date(eventTime!).toISOString(), source: { kind: 'outbound', id } })
      continue
    }
    if (event.type !== 'user/message') continue
    const message = Array.isArray(data.content) ? data as MessageLike : data.message
    const source = message?.source
    if (source?.kind !== 'user' && (!includePluginUsers || source?.kind !== 'plugin' || source.plugin === 'personal-growth-dsh-host' || !/schedule/i.test(source.plugin ?? ''))) continue
    if (source?.kind === 'plugin' && source.plugin === 'personal-growth-dsh-host') continue
    const text = message?.content?.filter(block => block.type === 'text').map(block => block.text ?? '').join('') ?? ''
    const eventTime = typeof event.time === 'string' ? Date.parse(event.time) : event.time
    if (!text.trim() || !Number.isFinite(eventTime)) continue
    const id = `${sessionId}:${event.seq ?? result.length}`
    result.push({ id, role: 'user', text, at: new Date(eventTime!).toISOString(), ...(typeof event.seq === 'number' ? { source: { kind: 'session', sessionId, seq: event.seq } } : {}) })
  }
  return result
}

export function localDate(at: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(at))
  const part = (name: string) => parts.find(item => item.type === name)?.value
  if (!part('year') || !part('month') || !part('day')) throw new Error(`Invalid time zone or date: ${timeZone}`)
  return `${part('year')}-${part('month')}-${part('day')}`
}

export function sourceKey(source: SourceRef): string { return source.kind === 'session' ? JSON.stringify(['session', source.sessionId, source.seq]) : JSON.stringify(['outbound', source.id]) }

type ActivityHistory = Pick<HistoryRecord, 'id' | 'summary' | 'activitySources' | 'occurredFrom' | 'occurredTo'> & { sources?: SourceRef[] }
export interface ActivityAggregateInput { messages: readonly ActivityMessage[]; histories?: readonly ActivityHistory[]; coverage?: ActivityCoverage; reasons?: readonly string[]; revision?: string }

function hourKey(at: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'shortOffset' }).formatToParts(new Date(at))
  const hour = parts.find(item => item.type === 'hour')?.value ?? '00'
  const offset = parts.find(item => item.type === 'timeZoneName')?.value ?? 'GMT'
  return `${hour}:00 ${offset}`
}

function encodeCursor(value: unknown): string { return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url') }
function decodeCursor(value: string): unknown { try { return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) } catch { throw new Error('Invalid activity cursor') } }

/** Pure, deterministic activity projection. All filtering happens before rendering limits. */
export function aggregateActivity(query: ActivityQuery, input: ActivityAggregateInput): ActivitySnapshot {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(query.date) || !Number.isInteger(query.limit) || query.limit < 1 || query.limit > 50) throw new Error('Invalid activity query')
  const asOfMs = Date.parse(query.asOf)
  if (!Number.isFinite(asOfMs)) throw new Error('Invalid activity asOf')
  if (query.cursor) {
    const cursor = decodeCursor(query.cursor) as { date?: string; timeZone?: string; asOf?: string; revision?: string }
    if (cursor.date !== query.date || cursor.timeZone !== query.timeZone || cursor.asOf !== query.asOf || cursor.revision !== input.revision) throw new Error('Activity cursor does not match query')
  }
  const deduped = new Map<string, ActivityMessage>()
  for (const message of input.messages) {
    const at = Date.parse(message.at)
    if (!Number.isFinite(at) || at > asOfMs || localDate(message.at, query.timeZone) !== query.date) continue
    const source = message.source
    const key = sourceKey(source)
    if (!deduped.has(key)) deduped.set(key, { ...message, at: new Date(at).toISOString() })
  }
  const messages = [...deduped.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id))
  const users = messages.filter(message => message.role === 'user')
  const isSent = (message: ActivityMessage) => message.delivery === 'sent' || (message.role === 'assistant' && message.source.kind === 'outbound' && !message.delivery)
  const sent = messages.filter(isSent)
  const pending = messages.filter(message => message.delivery === 'pending')
  const unknown = messages.filter(message => message.delivery === 'unknown')
  const cutoff = asOfMs - 60 * 60 * 1000
  const hourly = new Map<string, { hour: string; user: number; sent: number }>()
  for (const message of messages) {
    const key = hourKey(message.at, query.timeZone)
    const bucket = hourly.get(key) ?? { hour: key, user: 0, sent: 0 }
    if (message.role === 'user') bucket.user++
    if (isSent(message)) bucket.sent++
    hourly.set(key, bucket)
  }
  const recentAll = messages.slice(-20).reverse()
  const selectedRecent = recentAll.slice(0, query.limit)
  const selectedKeys = new Set(recentAll.map(message => sourceKey(message.source)))
  const histories: ActivitySnapshot['histories'] = []
  for (const history of input.histories ?? []) {
    const sources = history.activitySources ?? history.sources
    if (!sources?.length) continue
    const mapped = sources.map(source => deduped.get(sourceKey(source)))
    if (mapped.some(message => !message) || mapped.some(message => localDate(message!.at, query.timeZone) !== query.date)) continue
    if (mapped.some(message => selectedKeys.has(sourceKey(message!.source)))) continue
    histories.push({ id: history.id, text: history.summary, sources })
  }
  const truncated = messages.length > selectedRecent.length || histories.length > query.limit
  const revision = input.revision ?? 'unknown'
  return {
    date: query.date, timeZone: query.timeZone, asOf: query.asOf,
    coverage: input.coverage ?? 'complete', reasons: [...(input.reasons ?? [])],
    counts: { user: users.length, sent: sent.length, pending: pending.length, unknown: unknown.length, last60mUser: users.filter(message => Date.parse(message.at) >= cutoff).length, last60mSent: sent.filter(message => Date.parse(message.at) >= cutoff).length },
    hourly: [...hourly.values()].sort((a, b) => a.hour.localeCompare(b.hour)),
    lastUserAt: users.at(-1)?.at ?? null, lastSentAt: sent.at(-1)?.at ?? null,
    histories: histories.slice(0, query.limit), recent: selectedRecent,
    truncated, ...(truncated ? { nextCursor: encodeCursor({ date: query.date, timeZone: query.timeZone, asOf: query.asOf, revision }) } : {}),
  }
}
