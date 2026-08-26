import { createHash } from 'node:crypto';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appendJsonl, writeJsonAtomic } from '@personal-growth/shared';
import { ConversationEvent, CursorConsolidator, MemoryService, ProposalSchema, renderIndex, renderProfile, RevisionSchema, workspacePaths } from '../src/index.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function root() { const value = await mkdtemp(join(tmpdir(), 'personal-memory-hardening-')); roots.push(value); return value; }
const e = (seq: number): ConversationEvent => ({ sessionId: 's', seq, role: 'user', content: `c${seq}`, at: '2026-01-01T00:00:00Z' });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

describe('critical hardening', () => {
  it('replays history by covered source events, not exact range ids', async () => {
    const workspace = await root(); const paths = workspacePaths(workspace);
    await mkdir(paths.memory, { recursive: true });
    await appendJsonl(paths.history, { id: 'old', sessionId: 's', fromSeq: 1, toSeq: 2, sourceRefs: ['s:1', 's:2'], summary: 'old', at: '2026-01-01T00:00:00Z' });
    await writeJsonAtomic(paths.state, { memoryCursor: {} });
    const result = await new CursorConsolidator({ workspace, compressor: { compress: (events) => `only ${events.map((event) => event.seq).join(',')}` } }).consume([e(1), e(2), e(3)]);
    expect(result?.fromSeq).toBe(3); expect(result?.toSeq).toBe(3);
  });

  it('serializes consume and apply through one writer boundary', async () => {
    const service = new MemoryService({ workspace: await root(), compressor: { compress: async () => { await new Promise((resolve) => setTimeout(resolve, 10)); return 'summary'; } } });
    const consume = service.consume([e(1)]);
    const apply = service.apply(ProposalSchema.parse({ action: 'CREATE', path: 'preferences/p.md', summary: 'P', content: 'p', sourceEvidence: ['h'] }));
    await Promise.all([consume, apply]);
    expect((await service.read('preferences/p.md')).content).toBe('p');
    expect(JSON.parse((await readFile(service.paths.state, 'utf8'))).memoryCursor.s).toBe(1);
  });

  it('coordinates two service instances on one workspace', async () => {
    const workspace = await root(); const first = new MemoryService({ workspace }); const second = new MemoryService({ workspace });
    await Promise.all([
      first.apply(ProposalSchema.parse({ action: 'CREATE', path: 'preferences/one.md', summary: 'One', content: 'one', sourceEvidence: ['1'] })),
      second.apply(ProposalSchema.parse({ action: 'CREATE', path: 'preferences/two.md', summary: 'Two', content: 'two', sourceEvidence: ['2'] })),
    ]);
    expect(await first.read('preferences/one.md')).toBeDefined(); expect(await second.read('preferences/two.md')).toBeDefined();
    expect((await readFile(first.paths.revisions, 'utf8')).trim().split(/\r?\n/)).toHaveLength(2);
  });

  it('fails closed on malformed history and revision lines', async () => {
    const workspace = await root(); const paths = workspacePaths(workspace);
    await mkdir(paths.memory, { recursive: true });
    await writeFile(paths.history, '{bad}\n');
    await expect(new CursorConsolidator({ workspace, compressor: { compress: () => 'x' } }).consume([e(1)])).rejects.toThrow();
    const service = new MemoryService({ workspace: await root() });
    await service.apply(ProposalSchema.parse({ action: 'CREATE', path: 'preferences/p.md', summary: 'P', content: 'p', sourceEvidence: ['h'] }));
    await writeFile(service.paths.revisions, '{bad}\n');
    await expect(service.apply(ProposalSchema.parse({ action: 'CREATE', path: 'preferences/q.md', summary: 'Q', content: 'q', sourceEvidence: ['h'] }))).rejects.toThrow();
  });

  it('rejects symlinked memory roots and archive targets', async () => {
    const workspace = await root(); const paths = workspacePaths(workspace); const outside = await root();
    await mkdir(paths.memory, { recursive: true }); await rm(paths.memory, { recursive: true, force: true });
    try { await symlink(outside, paths.memory, 'junction'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EACCES' || (error as NodeJS.ErrnoException).code === 'EPERM') return; throw error; }
    await expect(new MemoryService({ workspace }).list()).rejects.toThrow();
    const safe = new MemoryService({ workspace: await root() });
    expect(() => ProposalSchema.parse({ action: 'CREATE', path: 'archive/x.md', summary: 'x', content: 'x', sourceEvidence: ['x'] })).toThrow();
    expect(() => ProposalSchema.parse({ action: 'UPDATE', path: 'archive/x.md', summary: 'x', content: 'x', sourceEvidence: ['x'], expectedHash: 'a'.repeat(64) })).toThrow();
    expect(() => ProposalSchema.parse({ action: 'MERGE', path: 'preferences/x.md', targetPath: 'archive/x.md', summary: 'x', content: 'x', sourceEvidence: ['x'], expectedHash: 'a'.repeat(64) })).toThrow();
    await safe.readProfile();
  });

  it('uses deterministic escaping and code-unit ordering in projections', () => {
    const docs = [{ path: 'preferences/a.md', metadata: { category: 'preferences', summary: 'A]\nInjected', importance: 'normal', frequency: 'high', sources: [] }, content: '# body\nnext', raw: '', hash: hash('') }];
    const profile = renderProfile(docs); const index = renderIndex(docs);
    expect(profile).not.toContain('A]\nInjected'); expect(index).not.toContain('A]\nInjected');
  });

  it('recovers CREATE and UPDATE journals idempotently', async () => {
    const workspace = await root(); const service = new MemoryService({ workspace });
    const createRaw = '<!-- personal-memory:v1 {"category":"preferences","summary":"Created","importance":"normal","frequency":"normal","sources":["h"]} -->\n\ncreated\n';
    const createRevision = RevisionSchema.parse({ revisionId: 'create-recovery', time: '2026-01-01T00:00:00Z', actor: 'test', action: 'CREATE', path: 'preferences/created.md', source: ['h'], afterHash: hash(createRaw) });
    await writeJsonAtomic(service.paths.state, { memoryCursor: {}, pendingMutation: { action: 'CREATE', path: 'preferences/created.md', beforeHash: null, afterHash: hash(createRaw), afterRaw: createRaw, revision: createRevision } });
    const restarted = new MemoryService({ workspace }); await expect(restarted.read('preferences/created.md')).resolves.toBeDefined();
    const current = await restarted.read('preferences/created.md'); const updateRaw = current.raw.replace('created', 'updated');
    const updateRevision = RevisionSchema.parse({ revisionId: 'update-recovery', time: '2026-01-01T00:00:00Z', actor: 'test', action: 'UPDATE', path: 'preferences/created.md', source: ['u'], beforeHash: current.hash, afterHash: hash(updateRaw) });
    await writeJsonAtomic(restarted.paths.state, { memoryCursor: {}, pendingMutation: { action: 'UPDATE', path: 'preferences/created.md', beforeHash: current.hash, afterHash: hash(updateRaw), afterRaw: updateRaw, revision: updateRevision } });
    const second = new MemoryService({ workspace }); await expect(second.read('preferences/created.md')).resolves.toMatchObject({ content: 'updated' }); await expect(second.read('preferences/created.md')).resolves.toMatchObject({ content: 'updated' });
  });
});
