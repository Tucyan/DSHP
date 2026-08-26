import { readFile, writeFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { writeJsonAtomic } from '@personal-growth/shared';
import { MemoryService, ProposalSchema, RevisionSchema } from '../src/index.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function root() { const value = await mkdtemp(join(tmpdir(), 'personal-memory-target-recovery-')); roots.push(value); return value; }

it('fails closed when a pending MERGE target changes after journaling', async () => {
  const workspace = await root(); const service = new MemoryService({ workspace });
  await service.apply(ProposalSchema.parse({ action: 'CREATE', path: 'preferences/source.md', summary: 'Source', content: 'source', sourceEvidence: ['s'] }));
  const targetResult = await service.apply(ProposalSchema.parse({ action: 'CREATE', path: 'preferences/target.md', summary: 'Target', content: 'target', sourceEvidence: ['t'] }));
  const source = await service.read('preferences/source.md'); const target = await service.read('preferences/target.md');
  const changedTarget = target.raw.replace('target', 'changed-target'); await writeFile(service.paths.categories.preferences + '/target.md', changedTarget);
  const revision = RevisionSchema.parse({ revisionId: 'merge-target-changed', time: '2026-01-01T00:00:00Z', actor: 'test', action: 'MERGE', path: 'preferences/target.md', source: ['m'], beforeHash: targetResult.revision!.afterHash, afterHash: targetResult.revision!.afterHash });
  await writeJsonAtomic(service.paths.state, { memoryCursor: {}, pendingMutation: { action: 'MERGE', path: 'preferences/source.md', writePath: 'preferences/target.md', targetPath: 'archive/source.md', source: ['m'], beforeHash: source.hash, targetBeforeHash: target.hash, archiveHash: source.hash, afterHash: targetResult.revision!.afterHash, afterRaw: target.raw, archiveRaw: source.raw, revision } });
  const restarted = new MemoryService({ workspace });
  await expect(restarted.read('preferences/target.md')).rejects.toThrow();
  expect(await readFile(service.paths.categories.preferences + '/target.md', 'utf8')).toBe(changedTarget);
  expect(await readFile(service.paths.categories.preferences + '/source.md', 'utf8')).toBe(source.raw);
});
