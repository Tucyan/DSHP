export interface RecentMessage { role: 'user' | 'assistant'; text: string; at: string }
export interface HeartbeatContextSources {
  identity(): Promise<{ soul: string; mission: string }>
  profile(): Promise<string>
  memories(): Promise<readonly string[]>
  recent(): Promise<readonly RecentMessage[]>
  goal(): Promise<unknown>
  schedules(): Promise<readonly unknown[]>
  lastContact(): Promise<string | null>
}

/** Caller supplies events from the fixed foreground session only. */
export function recentUserConversation(events: readonly unknown[]): RecentMessage[] {
  return normalizeVisibleMessages(events as never[], { includePluginUsers: false }).slice(-12).map(message => ({ role: message.role, text: message.text, at: message.at }))
}

/** Immutable per-wake snapshot. Error payloads and internal prompts never become context. */
export async function buildHeartbeatContext(sources: HeartbeatContextSources, trigger: { at: string; timeZone: string; triggerId: string }) {
  const entries = await Promise.all(Object.entries(sources).map(async ([name, read]) => {
    try { return [name, { status: 'available', value: await read() }] as const }
    catch { return [name, { status: 'unavailable', value: null }] as const }
  }))
  const snapshot = { ...trigger, sources: Object.fromEntries(entries), truncated: false }
  let truncated = false
  const bound = (value: unknown, limit: number): unknown => {
    if (typeof value === 'string') { if (value.length > limit) truncated = true; return value.slice(0, limit) }
    if (Array.isArray(value)) { if (value.length > 20) truncated = true; return value.slice(0, 20).map(item => bound(item, limit)) }
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, bound(item, limit)]))
    return value
  }
  let limit = 1000
  let prompt: string
  do {
    const bounded = { ...snapshot, sources: Object.fromEntries(entries.map(([name, entry]) => [name, { ...entry, value: bound(entry.value, limit) }])), truncated: truncated || limit < 1000 }
    bounded.truncated = truncated || limit < 1000
    prompt = JSON.stringify(bounded)
    limit = Math.floor(limit / 2)
  } while (Buffer.byteLength(prompt) > 12000 && limit > 0)
  if (Buffer.byteLength(prompt) > 12000) throw new Error('heartbeat_context_exceeds_budget')
  return { ready: entries.every(([, entry]) => entry.status === 'available'), prompt, truncated: truncated || snapshot.truncated, sources: entries.map(([name, entry]) => ({ name, status: entry.status })) }
}
import { normalizeVisibleMessages } from './activity.js'
