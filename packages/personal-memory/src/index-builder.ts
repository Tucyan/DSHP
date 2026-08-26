import type { MemoryDocument } from './reader.js';

export function renderIndex(documents: readonly MemoryDocument[]): string {
  const active = documents.filter((document) => !document.path.toLocaleLowerCase().startsWith('archive/')).sort((a, b) => a.path.localeCompare(b.path));
  const lines = ['# Memory Index', '', 'Active semantic memory documents:', ''];
  for (const document of active) lines.push(`- [${document.metadata.summary}](./${document.path}) — ${document.metadata.category}`);
  return `${lines.join('\n')}\n`;
}

export const buildIndex = renderIndex;
