import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ConversationEvent,
  CursorConsolidator,
  MemoryReader,
  MemoryService,
  ProposalSchema,
} from '../src/index.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function root() { const value = await mkdtemp(join(tmpdir(), 'personal-memory-')); roots.push(value); return value; }

describe('memory reader', () => {
  it('reads only allowed memory documents and treats missing roots as empty', async () => {
    const reader = new MemoryReader(await root());
    expect(await reader.list()).toEqual([]);
    await expect(reader.read('../PROFILE.md')).rejects.toThrow();
  });
});

describe('cursor consolidator', () => {
  it('consumes each session range once and reconstructs from disk', async () => {
    const workspace = await root();
    const compressor = { compress: (events: readonly ConversationEvent[]) => `summary ${events[0].seq}-${events.at(-1)?.seq}` };
    const events = Array.from({ length: 10 }, (_, i) => ({ sessionId: 's', seq: i + 1, role: 'user' as const, content: `c${i + 1}`, at: new Date(2026, 0, i + 1).toISOString() }));
    const first = new CursorConsolidator({ workspace, compressor });
    expect((await first.consume(events)).fromSeq).toBe(1);
    const second = new CursorConsolidator({ workspace, compressor });
    expect(await second.consume(events)).toBeNull();
    expect((await second.consume(events.concat(Array.from({ length: 5 }, (_, i) => ({ ...events[0], seq: i + 11 }))))).toSeq).toBe(15);
  });
});

describe('memory service', () => {
  it('validates proposals and writes an auditable document and projections', async () => {
    const workspace = await root();
    const service = new MemoryService({ workspace });
    const proposal = ProposalSchema.parse({ action: 'CREATE', path: 'preferences/coffee.md', summary: 'Coffee preference', content: 'Prefers coffee.', sourceEvidence: ['h:1'], importance: 'high', frequency: 'high' });
    const result = await service.apply(proposal);
    expect(result.accepted).toBe(true);
    expect((await service.read('preferences/coffee.md')).content).toContain('Prefers coffee.');
    expect(await service.readProfile()).toContain('Coffee preference');
    await expect(service.apply(ProposalSchema.parse({ action: 'UPDATE', path: 'preferences/coffee.md', summary: 'stale', content: 'no', sourceEvidence: ['h:2'], expectedHash: '0'.repeat(64) }))).rejects.toThrow();
  });
});
