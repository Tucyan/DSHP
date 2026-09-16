import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConversationEvent, CursorConsolidator, HistoryRecordSchema } from '../src/index.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function root(): Promise<string> { const value = await mkdtemp(join(tmpdir(), 'personal-memory-restart-')); roots.push(value); return value }

describe('conversation provenance history', () => {
  it('records real activity sources and occurrence bounds independently of memory sequence', async () => {
    const workspace = await root()
    const compressor = { compress: (events: readonly ConversationEvent[]) => events.map(event => event.content).join(' | ') }
    const events: ConversationEvent[] = [
      { sessionId: 'memory-session', seq: 1, role: 'user', content: 'before midnight', at: '2026-09-15T23:59:59.000Z', source: { kind: 'session', sessionId: 'dsh-session', seq: 25_397 } },
      { sessionId: 'memory-session', seq: 2, role: 'assistant', content: 'after midnight', at: '2026-09-16T00:00:01.000Z', source: { kind: 'outbound', id: 'outbound-1' } },
    ]

    const written = await new CursorConsolidator({ workspace, compressor, clock: () => '2026-09-16T00:01:00.000Z' }).consume(events)
    expect(written).toMatchObject({
      sourceRefs: ['memory-session:1', 'memory-session:2'],
      activitySources: [events[0].source, events[1].source],
      occurredFrom: '2026-09-15T23:59:59.000Z',
      occurredTo: '2026-09-16T00:00:01.000Z',
      at: '2026-09-16T00:01:00.000Z',
    })

    const reopened = new CursorConsolidator({ workspace, compressor })
    expect(await reopened.consume(events)).toBeNull()
    const persisted = HistoryRecordSchema.parse(JSON.parse((await readFile(join(workspace, 'memory/history.jsonl'), 'utf8')).trim()))
    expect(persisted.activitySources).toEqual([events[0].source, events[1].source])
  })

  it('continues to parse history written by the old schema', () => {
    expect(HistoryRecordSchema.parse({
      id: 'legacy:1-1', sessionId: 'legacy', fromSeq: 1, toSeq: 1,
      sourceRefs: ['legacy:1'], summary: 'legacy summary', at: '2026-01-01T00:00:00.000Z',
    })).toEqual({
      id: 'legacy:1-1', sessionId: 'legacy', fromSeq: 1, toSeq: 1,
      sourceRefs: ['legacy:1'], summary: 'legacy summary', at: '2026-01-01T00:00:00.000Z',
    })
  })
})
