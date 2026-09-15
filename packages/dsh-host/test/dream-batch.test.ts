import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryService, type MemoryProposal } from '@personal-growth/personal-memory'
import { DreamBatchStore } from '../src/dream-batch.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const facts = (): MemoryProposal[] => ['sleep', 'study', 'exercise'].map(name => ({ action: 'CREATE', path: `preferences/${name}.md`, summary: name, content: `Stable ${name} preference`, sourceEvidence: ['conversation:user'], frequency: 'high' }))
async function fixture() { const root = await mkdtemp(join(tmpdir(), 'pga-batch-')); roots.push(root); return { root, store: new DreamBatchStore(root), memory: new MemoryService({ workspaceRoot: root }) } }

describe('recoverable multi-fact Dream', () => {
  it('writes three facts from one history once and refreshes projections', async () => {
    const { store, memory } = await fixture(); let generations = 0
    const propose = async () => { generations++; return facts() }
    await store.run('history-one', propose, proposal => memory.apply(proposal))
    await store.run('history-one', propose, proposal => memory.apply(proposal))
    expect(generations).toBe(1); expect(await memory.revisions()).toHaveLength(3)
    expect(await memory.readProfile()).toContain('exercise')
  })
  it('replays the frozen batch after a commit-before-ack crash without regenerating', async () => {
    const { root, store, memory } = await fixture(); let writes = 0
    await expect(store.run('crash', async () => facts(), async proposal => {
      await memory.apply(proposal); if (++writes === 2) throw new Error('crash after memory commit')
    })).rejects.toThrow('crash')
    const reopened = new DreamBatchStore(root)
    await reopened.run('crash', async () => { throw new Error('must not regenerate') }, proposal => memory.apply(proposal))
    expect(await memory.revisions()).toHaveLength(3)
  })
  it('validates every proposal before any write and rejects intersecting target paths', async () => {
    const { store } = await fixture(); let writes = 0
    const proposals = facts(); proposals.push({ ...facts()[0], content: 'conflicting' } as MemoryProposal)
    await expect(store.run('conflict', async () => proposals, async () => { writes++ })).rejects.toThrow(/overlap/)
    expect(writes).toBe(0)
    await expect(store.run('invalid', async () => [...facts(), { action: 'CREATE' }], async () => { writes++ })).rejects.toThrow()
    expect(writes).toBe(0)
  })
  it('deduplicates identical proposals and accepts an all-IGNORE batch', async () => {
    const { store, memory } = await fixture()
    await store.run('duplicates', async () => [facts()[0], facts()[0]], proposal => memory.apply(proposal))
    await store.run('ignore', async () => [{ action: 'IGNORE', reason: 'temporary', sourceEvidence: ['conversation:user'] }], proposal => memory.apply(proposal))
    expect(await memory.revisions()).toHaveLength(1)
  })
  it('rejects changed payloads reusing an already applied identity', async () => {
    const { store, memory } = await fixture(); let captured!: MemoryProposal
    await store.run('identity', async () => [facts()[0]], async proposal => { captured = proposal; return memory.apply(proposal) })
    await expect(memory.apply({ ...captured, content: 'tampered' } as MemoryProposal)).rejects.toThrow('Invalid memory batch identity')
    expect(await memory.revisions()).toHaveLength(1)
  })
  it('leaves a stale update blocked without overwriting a later explicit edit', async () => {
    const { store, memory } = await fixture()
    await memory.apply(facts()[0])
    const before = await memory.read('preferences/sleep.md')
    const update = { ...facts()[0], action: 'UPDATE', expectedHash: before.hash, content: 'proposed' } as MemoryProposal
    await expect(store.run('stale', async () => [update], async () => { throw new Error('interruption') })).rejects.toThrow('interruption')
    await memory.rememberExplicit({ path: before.path, summary: 'sleep', content: 'later human edit' })
    await expect(store.run('stale', async () => [], proposal => memory.apply(proposal))).rejects.toThrow('Stale memory proposal')
    expect((await memory.read(before.path)).content).toContain('later human edit')
  })
})
