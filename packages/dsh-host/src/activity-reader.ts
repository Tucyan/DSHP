import { readJsonl } from '@personal-growth/shared'
import { HistoryRecordSchema, type HistoryRecord, type MemoryService } from '@personal-growth/personal-memory'
import type { DshSessionPersistence } from './plugin.js'
import type { ActivityEvent, ActivityMessage, ActivityQuery, ActivitySnapshot } from './activity.js'
import { aggregateActivity, normalizeVisibleMessages } from './activity.js'
import type { ActivityOrigin, DeliveryMetadata, SourceRef } from './bridge.js'

export interface SessionPersistenceReader extends DshSessionPersistence {
  inspect(id: unknown): Promise<{ events?: readonly ActivityEvent[]; revision?: unknown }>
}
export interface OutboundRecordReader {
  readOutboundRecords(): Promise<readonly { key: string; status: 'pending' | 'sent' | 'unknown'; text?: string; metadata?: DeliveryMetadata }[]>
}
export interface ActivityReaderOptions {
  sessionPersistence: SessionPersistenceReader
  bridgeState?: OutboundRecordReader
  memory?: Pick<MemoryService, 'paths'>
  histories?: () => Promise<readonly HistoryRecord[]>
  maxEvents?: number
}

function sessionIdOf(snapshot: { header: { id: string | { toString(): string } } }): string { return String(snapshot.header.id) }
function atForMetadata(metadata: DeliveryMetadata | undefined): string | undefined { return metadata?.confirmedAt ?? metadata?.firstAttemptAt }

export class ActivityReader {
  private readonly maxEvents: number
  constructor(private readonly options: ActivityReaderOptions) { this.maxEvents = options.maxEvents ?? 10_000 }

  async read(query: ActivityQuery): Promise<ActivitySnapshot> {
    const reasons: string[] = []
    let coverage: 'complete' | 'partial' | 'unavailable' = 'complete'
    const messages: ActivityMessage[] = []
    let revisionParts: unknown[] = []
    let snapshots: readonly { header: { id: string | { toString(): string } } }[]
    try { snapshots = await this.options.sessionPersistence.listSnapshots() }
    catch { return aggregateActivity(query, { messages: [], coverage: 'unavailable', reasons: ['session_persistence_unavailable'], revision: 'unavailable' }) }
    let scanned = 0
    for (const snapshot of snapshots) {
      const sessionId = sessionIdOf(snapshot)
      try {
        const inspected = await this.options.sessionPersistence.inspect(sessionId)
        const events = inspected.events ?? []
        scanned += events.length
        if (scanned > this.maxEvents) { coverage = 'partial'; reasons.push('session_scan_bound_exceeded'); break }
        revisionParts.push([sessionId, inspected.revision ?? events.length])
        for (const message of normalizeVisibleMessages(events, { sessionId })) {
          if (!message.source) continue
          messages.push({ ...message, origin: 'user', source: message.source })
        }
      } catch { coverage = 'partial'; reasons.push(`session_unavailable:${sessionId}`) }
    }
    if (this.options.bridgeState) {
      try {
        for (const record of await this.options.bridgeState.readOutboundRecords()) {
          const at = atForMetadata(record.metadata)
          if (!at || !record.text?.trim()) {
            if (record.status === 'sent') { coverage = 'partial'; reasons.push('legacy_outbound_missing_time') }
            continue
          }
          const source: SourceRef = { kind: 'outbound', id: record.key }
          const origin: ActivityOrigin = record.metadata?.origin ?? 'legacy_unknown'
          messages.push({ id: record.key, role: 'assistant', text: record.text, at, origin, source, delivery: record.status })
        }
      } catch { coverage = 'partial'; reasons.push('outbound_unavailable') }
    }
    let histories: readonly HistoryRecord[] = []
    try {
      if (this.options.histories) histories = await this.options.histories()
      else if (this.options.memory) {
        const result = await readJsonl(this.options.memory.paths.history, HistoryRecordSchema)
        histories = result.records
        if (result.errors.length) { coverage = 'partial'; reasons.push('history_malformed') }
      }
    } catch { coverage = coverage === 'complete' ? 'partial' : coverage; reasons.push('history_unavailable') }
    if (histories.some(history => !history.activitySources)) reasons.push('legacy_history_unmapped')
    const revision = JSON.stringify(revisionParts)
    return aggregateActivity(query, { messages, histories, coverage, reasons: [...new Set(reasons)], revision })
  }
}

export async function readActivity(options: ActivityReaderOptions, query: ActivityQuery): Promise<ActivitySnapshot> { return new ActivityReader(options).read(query) }
