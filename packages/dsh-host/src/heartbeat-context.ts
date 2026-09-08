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
  const result: RecentMessage[] = []
  let userTurn = false
  for (const raw of events) {
    const event = raw as { type: string; time: number; data: { source?: { kind?: string }; content?: Array<{ type: string; text?: string }>; message?: { content?: Array<{ type: string; text?: string }> } } }
    if (event.type === 'turn/start' || event.type === 'turn/end') userTurn = false
    if (event.type === 'user/message' && event.data.source?.kind === 'user') userTurn = true
    if (!userTurn) continue
    const isUser = event.type === 'user/message' && event.data.source?.kind === 'user'
    if (!isUser && event.type !== 'assistant/message') continue
    const content = isUser ? event.data.content : event.data.message?.content
    const text = content?.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
    if (text && Number.isFinite(event.time)) result.push({ role: isUser ? 'user' : 'assistant', text: text.slice(0, 1000), at: new Date(event.time).toISOString() })
  }
  return result.slice(-12)
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
