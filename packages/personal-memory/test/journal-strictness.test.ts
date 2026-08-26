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

it('rejects a MERGE journal with null or inconsistent target hash', async () => {
  const workspace = await root(); const service = new MemoryService({ workspace });
  const sourceResult = await service.apply(ProposalSchema.parse({ action: 'CREATE', path: 'preferences/source.md', summary: 'S', content: 'source', sourceEvidence: ['h'] }));
  const targetResult = await service.apply(ProposalSchema.parse({ action: 'CREATE', path: 'preferences/target.md', summary: 'T', content: 'target', sourceEvidence: ['h'] }));
  const source = await service.read('preferences/source.md'); const target = await service.read('preferences/target.md');
  const revision = RevisionSchema.parse({ revisionId: 'merge-null', time: '2026-01-01T00:00:00Z', actor: 'test', action: 'MERGE', path: 'preferences/target.md', source: ['crash'], beforeHash: source.hash, afterHash: target.hash });
  await writeJsonAtomic(service.paths.state, { memoryCursor: {}, pendingMutation: { action: 'MERGE', path: 'preferences/source.md', writePath: 'preferences/target.md', targetPath: 'archive/source.md', targetBeforeHash: null, source: ['crash'], beforeHash: source.hash, archiveHash: source.hash, afterHash: target.hash, afterRaw: target.raw, archiveRaw: source.raw, revision } });
  await expect(new MemoryService({ workspace }).read('preferences/source.md')).rejects.toThrow();
  expect(sourceResult.revision).toBeDefined(); expect(targetResult.revision).toBeDefined();
});

it('rejects CREATE revisions and journals with a non-null beforeHash', async () => {
  const hash = 'a'.repeat(64);
  expect(() => RevisionSchema.parse({ revisionId: 'create-before', time: '2026-01-01T00:00:00Z', actor: 'test', action: 'CREATE', path: 'preferences/a.md', source: ['x'], beforeHash: hash, afterHash: hash })).toThrow(/beforeHash/i);
  const workspace = await root(); const service = new MemoryService({ workspace });
  const raw = '<!-- personal-memory:v1 {"category":"preferences","summary":"A","importance":"normal","frequency":"normal","sources":["x"]} -->\n\na\n';
  const revision = RevisionSchema.parse({ revisionId: 'create-journal', time: '2026-01-01T00:00:00Z', actor: 'test', action: 'CREATE', path: 'preferences/a.md', source: ['x'], beforeHash: null, afterHash: hash });
  await writeJsonAtomic(service.paths.state, { memoryCursor: {}, pendingMutation: { action: 'CREATE', path: 'preferences/a.md', source: ['x'], beforeHash: hash, afterHash: hash, afterRaw: raw, revision } });
  await expect(new MemoryService({ workspace }).read('preferences/a.md')).rejects.toThrow(/beforeHash|CREATE/i);
});
