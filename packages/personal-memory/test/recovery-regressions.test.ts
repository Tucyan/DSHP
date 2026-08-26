import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeJsonAtomic } from '@personal-growth/shared';
import { MemoryService, ProposalSchema, RevisionSchema } from '../src/index.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function root() { const value = await mkdtemp(join(tmpdir(), 'personal-memory-recovery-')); roots.push(value); return value; }

describe('fail-closed pending recovery', () => {
  it('preserves changed source and target for ARCHIVE recovery', async () => {
    const workspace = await root(); const service = new MemoryService({ workspace });
    const created = await service.apply(ProposalSchema.parse({ action: 'CREATE', path: 'preferences/a.md', summary: 'A', content: 'old', sourceEvidence: ['h'] }));
    const source = await service.read('preferences/a.md'); const hash = created.revision!.afterHash!;
    await writeFile(service.paths.categories.archive + '/a.md', source.raw).catch(async () => { await service.apply(ProposalSchema.parse({ action: 'ARCHIVE', path: 'preferences/a.md', sourceEvidence: ['seed'], expectedHash: hash })); await writeFile(service.paths.categories.preferences + '/a.md', source.raw); });
    const archiveRaw = await readFile(service.paths.categories.archive + '/a.md', 'utf8');
    await writeFile(service.paths.categories.preferences + '/a.md', source.raw.replace('old', 'changed'));
    const revision = RevisionSchema.parse({ revisionId: 'archive-changed', time: '2026-01-01T00:00:00Z', actor: 'test', action: 'ARCHIVE', path: 'preferences/a.md', source: ['crash'], beforeHash: hash, afterHash: hash });
    await writeJsonAtomic(service.paths.state, { memoryCursor: {}, pendingMutation: { action: 'ARCHIVE', path: 'preferences/a.md', targetPath: 'archive/a.md', source: ['crash'], beforeHash: hash, archiveHash: hash, afterHash: hash, afterRaw: archiveRaw, revision } });
    const restarted = new MemoryService({ workspace });
    await expect(restarted.read('archive/a.md')).rejects.toThrow();
    expect(await readFile(service.paths.categories.preferences + '/a.md', 'utf8')).toContain('changed');
    expect(await readFile(service.paths.categories.archive + '/a.md', 'utf8')).toBe(archiveRaw);
  });

  it('preserves changed source and target for MERGE recovery', async () => {
    const workspace = await root(); const service = new MemoryService({ workspace });
    await service.apply(ProposalSchema.parse({ action: 'CREATE', path: 'preferences/source.md', summary: 'Source', content: 'source', sourceEvidence: ['s'] }));
    const targetResult = await service.apply(ProposalSchema.parse({ action: 'CREATE', path: 'preferences/target.md', summary: 'Target', content: 'target', sourceEvidence: ['t'] }));
    const source = await service.read('preferences/source.md'); const target = await service.read('preferences/target.md');
    const mergedRaw = target.raw.replace('Target', 'Merged').replace('target', 'merged');
    await mkdir(service.paths.categories.archive, { recursive: true });
    await writeFile(service.paths.categories.archive + '/source.md', source.raw);
    await writeFile(service.paths.categories.preferences + '/target.md', mergedRaw);
    await writeFile(service.paths.categories.preferences + '/source.md', source.raw.replace('source', 'changed'));
    const merged = await service.read('preferences/target.md');
    const revision = RevisionSchema.parse({ revisionId: 'merge-changed', time: '2026-01-01T00:00:00Z', actor: 'test', action: 'MERGE', path: 'preferences/target.md', source: ['crash'], beforeHash: targetResult.revision!.afterHash, afterHash: merged.hash });
    await writeJsonAtomic(service.paths.state, { memoryCursor: {}, pendingMutation: { action: 'MERGE', path: 'preferences/source.md', writePath: 'preferences/target.md', targetPath: 'archive/source.md', source: ['crash'], beforeHash: source.hash, targetBeforeHash: targetResult.revision!.afterHash, archiveHash: source.hash, afterHash: merged.hash, afterRaw: mergedRaw, revision } });
    const restarted = new MemoryService({ workspace });
    await expect(restarted.read('archive/source.md')).rejects.toThrow();
    expect(await readFile(service.paths.categories.preferences + '/source.md', 'utf8')).toContain('changed');
    expect(await readFile(service.paths.categories.archive + '/source.md', 'utf8')).toBe(source.raw);
  });
});
