import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { MemoryReader, type MemoryDocument } from './reader.js';
import { workspacePaths, type WorkspacePaths } from './paths.js';

export function renderProfile(documents: readonly MemoryDocument[]): string {
  const active = documents.filter((document) => document.metadata.category !== 'archive' && (document.metadata.frequency === 'high' || document.metadata.importance === 'high')).sort((a, b) => a.path.localeCompare(b.path));
  const lines = ['# Profile', '', 'High-frequency or high-importance active memories:', ''];
  for (const document of active) lines.push(`## ${document.metadata.summary}`, `<!-- source: ${document.path} -->`, '', document.content, '');
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}

export async function buildProfile(pathsOrWorkspace: WorkspacePaths | string): Promise<string> {
  const paths = typeof pathsOrWorkspace === 'string' ? workspacePaths(pathsOrWorkspace) : pathsOrWorkspace;
  const rendered = renderProfile(await new MemoryReader(paths).list());
  await mkdir(dirname(paths.profile), { recursive: true });
  await writeAtomic(paths.profile, rendered);
  return rendered;
}

async function writeAtomic(path: string, value: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try { await writeFile(temporary, value, { encoding: 'utf8', flag: 'wx' }); await rename(temporary, path); }
  catch (error) { await rm(temporary, { force: true }).catch(() => undefined); throw error; }
}
