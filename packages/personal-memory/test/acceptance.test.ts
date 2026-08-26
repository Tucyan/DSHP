import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Context } from '@deepseek-ai/cordis';
import { MemoryService, ProposalSchema, apply } from '../src/index.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function makeRoot() { const root = await mkdtemp(join(tmpdir(), 'personal-memory-')); roots.push(root); return root; }

describe('controlled memory acceptance', () => {
  it('preserves source evidence on update and ignores without revision', async () => {
    const service = new MemoryService({ workspace: await makeRoot() });
    const created = await service.apply(ProposalSchema.parse({ action: 'CREATE', path: 'preferences/tea.md', summary: 'Tea', content: 'Likes tea.', sourceEvidence: ['history:1'], importance: 'high', frequency: 'high' }));
    await service.apply(ProposalSchema.parse({ action: 'UPDATE', path: 'preferences/tea.md', summary: 'Tea', content: 'Likes green tea.', sourceEvidence: ['history:2'], expectedHash: created.revision!.afterHash }));
    expect((await service.read('preferences/tea.md')).metadata.sources).toEqual(['history:1', 'history:2']);
    const ignored = await service.apply(ProposalSchema.parse({ action: 'IGNORE', reason: 'recomputable statistic', sourceEvidence: ['history:3'] }));
    expect(ignored.trace.result).toBe('ignored');
    expect((await readFile(service.paths.revisions, 'utf8')).trim().split(/\r?\n/)).toHaveLength(2);
  });

  it('supports explicit remember through the same writer and default plugin configuration', async () => {
    const workspace = await makeRoot();
    const service = new MemoryService({ workspace });
    const result = await service.rememberExplicit({ path: 'preferences/writing.md', summary: 'Writing', content: 'Prefers concise writing.', sourceEvidence: ['explicit:user'], importance: 'high', frequency: 'high' });
    expect(result.accepted).toBe(true);
    const context = new Context();
    await context.plugin((ctx) => apply(ctx));
    expect((context as unknown as { personalMemory?: unknown }).personalMemory).toBeDefined();
    await context.fiber.dispose();
  });
});
