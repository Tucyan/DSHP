import { mkdir, readFile, rm as removeFile, writeFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { writeJsonAtomic } from '@personal-growth/shared';
import { MemoryService, ProposalSchema, RevisionSchema } from '../src/index.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function root() { const value = await mkdtemp(join(tmpdir(), 'personal-memory-journal-')); roots.push(value); return value; }

it('fails closed when source is absent but an existing archive target is corrupt', async () => {
  const workspace = await root(); const service = new MemoryService({ workspace });
  const created = await service.apply(ProposalSchema.parse({ action: 'CREATE', path: 'preferences/a.md', summary: 'A', content: 'body', sourceEvidence: ['h'] }));
  const source = await service.read('preferences/a.md'); await removeFile(service.paths.categories.preferences + '/a.md');
  await mkdir(service.paths.categories.archive, { recursive: true });
  await writeFile(service.paths.categories.archive + '/a.md', 'corrupt archive');
  const revision = RevisionSchema.parse({ revisionId: 'archive-corrupt', time: '2026-01-01T00:00:00Z', actor: 'test', action: 'ARCHIVE', path: 'preferences/a.md', source: ['crash'], beforeHash: created.revision!.afterHash, afterHash: source.hash });
  await writeJsonAtomic(service.paths.state, { memoryCursor: {}, pendingMutation: { action: 'ARCHIVE', path: 'preferences/a.md', targetPath: 'archive/a.md', targetBeforeHash: null, source: ['crash'], beforeHash: source.hash, archiveHash: source.hash, afterHash: source.hash, afterRaw: source.raw, archiveRaw: source.raw, revision } });
  const restarted = new MemoryService({ workspace }); await expect(restarted.read('archive/a.md')).rejects.toThrow();
  expect(await readFile(service.paths.categories.archive + '/a.md', 'utf8')).toBe('corrupt archive');
});

it('rejects a malformed MERGE journal missing targetBeforeHash', async () => {
  const workspace = await root(); const service = new MemoryService({ workspace });
  const created = await service.apply(ProposalSchema.parse({ action: 'CREATE', path: 'preferences/a.md', summary: 'A', content: 'body', sourceEvidence: ['h'] }));
  const source = await service.read('preferences/a.md');
  const revision = RevisionSchema.parse({ revisionId: 'merge-malformed', time: '2026-01-01T00:00:00Z', actor: 'test', action: 'MERGE', path: 'preferences/a.md', source: ['crash'], beforeHash: created.revision!.afterHash, afterHash: created.revision!.afterHash });
  await writeJsonAtomic(service.paths.state, { memoryCursor: {}, pendingMutation: { action: 'MERGE', path: 'preferences/a.md', writePath: 'preferences/a.md', targetPath: 'archive/a.md', source: ['crash'], beforeHash: source.hash, archiveHash: source.hash, afterHash: source.hash, afterRaw: source.raw, archiveRaw: source.raw, revision } });
  const restarted = new MemoryService({ workspace }); await expect(restarted.read('preferences/a.md')).rejects.toThrow();
  expect(await readFile(service.paths.categories.preferences + '/a.md', 'utf8')).toBe(source.raw);
});
