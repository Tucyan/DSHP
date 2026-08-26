import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CursorConsolidator, MemoryService, MemoryReader, ProposalSchema, renderIndex, renderProfile } from '../src/index.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function root() { const value = await mkdtemp(join(tmpdir(), 'personal-memory-review-')); roots.push(value); return value; }
const event = (seq: number) => ({ sessionId: 's', seq, role: 'user' as const, content: `secret-${seq}`, at: '2026-01-01T00:00:00Z' });

describe('reviewed memory invariants', () => {
  it('includes only frequency-high active entries in PROFILE', async () => {
    const service = new MemoryService({ workspace: await root() });
    await service.apply(ProposalSchema.parse({ action: 'CREATE', path: 'preferences/high.md', summary: 'High frequency', content: 'yes', sourceEvidence: ['h'], frequency: 'high', importance: 'normal' }));
    await service.apply(ProposalSchema.parse({ action: 'CREATE', path: 'preferences/important.md', summary: 'Important only', content: 'no', sourceEvidence: ['i'], frequency: 'normal', importance: 'high' }));
    expect(await service.readProfile()).toContain('High frequency');
    expect(await service.readProfile()).not.toContain('Important only');
  });

  it('derives sourceRefs from consumed events and serializes concurrent consumes', async () => {
    const workspace = await root();
    const compressor = { compress: async () => { await new Promise((resolve) => setTimeout(resolve, 10)); return { summary: 'compressed', sourceRefs: ['forged'] }; } };
    const consolidator = new CursorConsolidator({ workspace, compressor });
    const [one, two] = await Promise.all([consolidator.consume([event(1), event(2)]), consolidator.consume([event(1), event(2)])]);
    expect([one, two].filter(Boolean)).toHaveLength(1);
    const history = JSON.parse((await readFile(join(workspace, 'memory/history.jsonl'), 'utf8')).trim());
    expect(history.sourceRefs).toEqual(['s:1', 's:2']);
  });

  it('rejects malformed hashes, extra fields, reserved targets, and invalid search limits', async () => {
    expect(() => ProposalSchema.parse({ action: 'CREATE', path: 'preferences/a.md', summary: 'a', content: 'a', sourceEvidence: ['x'], expectedHash: 'z'.repeat(64) })).toThrow();
    expect(() => ProposalSchema.parse({ action: 'CREATE', path: 'preferences/a.md', summary: 'a', content: 'a', sourceEvidence: ['x'], extra: true })).toThrow();
    expect(() => ProposalSchema.parse({ action: 'CREATE', path: 'preferences/INDEX.MD', summary: 'a', content: 'a', sourceEvidence: ['x'] })).toThrow();
    expect(() => ProposalSchema.parse({ action: 'CREATE', path: 'preferences/profile.md', summary: 'a', content: 'a', sourceEvidence: ['x'] })).toThrow();
    await expect(new MemoryReader(await root()).search('a', Infinity)).rejects.toThrow();
    await expect(new MemoryReader(await root()).search('a', 101)).rejects.toThrow();
  });

  it('archives by atomic move while preserving original semantic document', async () => {
    const workspace = await root();
    const service = new MemoryService({ workspace });
    const created = await service.apply(ProposalSchema.parse({ action: 'CREATE', path: 'preferences/a.md', summary: 'Keep this', content: 'original body', sourceEvidence: ['evidence'], frequency: 'high' }));
    const result = await service.apply(ProposalSchema.parse({ action: 'ARCHIVE', path: 'preferences/a.md', sourceEvidence: ['archive-reason'], expectedHash: created.revision!.afterHash, reason: 'temporary' }));
    expect(result.accepted).toBe(true);
    const archived = await service.read('archive/a.md');
    expect(archived.metadata.summary).toBe('Keep this');
    expect(archived.content).toBe('original body');
    await expect(service.read('preferences/a.md')).rejects.toThrow();
  });

  it('keeps projection builders pure and does not expose filesystem writers', async () => {
    expect(typeof renderIndex).toBe('function');
    expect(typeof renderProfile).toBe('function');
    const exported = await import('../src/index.js');
    expect('buildIndex' in exported).toBe(false);
    expect('buildProfile' in exported).toBe(false);
  });
});
