import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { MemoryReader, type MemoryDocument } from './reader.js';
import { workspacePaths, type WorkspacePaths } from './paths.js';

export function renderIndex(documents: readonly MemoryDocument[]): string {
  const active = documents.filter((document) => document.metadata.category !== 'archive').sort((a, b) => a.path.localeCompare(b.path));
  const lines = ['# Memory Index', '', 'Active semantic memory documents:', ''];
  for (const document of active) lines.push(`- [${document.metadata.summary}](./${document.path}) — ${document.metadata.category}`);
  return `${lines.join('\n')}\n`;
}

export async function buildIndex(pathsOrWorkspace: WorkspacePaths | string): Promise<string> {
  const paths = typeof pathsOrWorkspace === 'string' ? workspacePaths(pathsOrWorkspace) : pathsOrWorkspace;
  const documents = await new MemoryReader(paths).list();
  const rendered = renderIndex(documents);
  await mkdir(dirname(paths.index), { recursive: true });
  await writeAtomic(paths.index, rendered);
  return rendered;
}

async function writeAtomic(path: string, value: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try { await writeFile(temporary, value, { encoding: 'utf8', flag: 'wx' }); await rename(temporary, path); }
  catch (error) { await rm(temporary, { force: true }).catch(() => undefined); throw error; }
}
